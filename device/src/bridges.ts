import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** A local MCP server (stdio) that the agent runs and exposes through the relay, e.g. Figwright. */
export interface BridgeConfig {
  command: string;
  args?: string[];
  cwd?: string;
  /** "none" (default): calls run without a prompt. "dialog": every call asks the owner first. */
  approval?: "none" | "dialog";
}

export interface BridgeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface BridgeSession {
  tools: BridgeTool[];
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  onClose(cb: () => void): void;
}

export type Connector = (name: string, cfg: BridgeConfig) => Promise<BridgeSession>;

/** Figwright is on by default; a `bridges` object in config.json replaces this (use `{}` to disable). */
export const DEFAULT_BRIDGES: Record<string, BridgeConfig> = { figwright: { command: "figwright-mcp" } };

export function resolveBridges(
  fromFile: Record<string, BridgeConfig> | undefined,
  fromEmbedded: Record<string, BridgeConfig> | undefined,
): Record<string, BridgeConfig> {
  return fromFile ?? fromEmbedded ?? DEFAULT_BRIDGES;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Windows: run the command directly (the SDK's cross-spawn resolves npm `.cmd` shims and hides the window).
 * macOS: a bare command goes through a login shell, because launchd starts the agent with a minimal PATH.
 */
export function launchSpec(cfg: BridgeConfig, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const args = cfg.args ?? [];
  if (platform === "win32" || cfg.command.includes("/")) return { command: cfg.command, args };
  return { command: "/bin/zsh", args: ["-lc", [cfg.command, ...args].map(shellQuote).join(" ")] };
}

export const stdioConnector: Connector = async (name, cfg) => {
  const spec = launchSpec(cfg);
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: cfg.cwd, stderr: "ignore" });
  const client = new Client({ name: `dc-custom-bridge-${name}`, version: "1" });
  await client.connect(transport);
  const tools: BridgeTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as BridgeTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  return {
    tools,
    call: (tool, args) => client.callTool({ name: tool, arguments: args }),
    close: () => client.close(),
    onClose: (cb) => {
      client.onclose = cb;
    },
  };
};

interface BridgeState {
  session: BridgeSession | null;
  backoff: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BridgeManager {
  private states = new Map<string, BridgeState>();
  private stopped = false;
  private readonly connect: Connector;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  constructor(
    private readonly configs: Record<string, BridgeConfig>,
    private readonly opts: { log: (line: string) => void; onChange: () => void; connect?: Connector; minBackoffMs?: number; maxBackoffMs?: number },
  ) {
    this.connect = opts.connect ?? stdioConnector;
    this.minBackoff = opts.minBackoffMs ?? 5_000;
    this.maxBackoff = opts.maxBackoffMs ?? 60_000;
  }

  start(): void {
    for (const name of Object.keys(this.configs)) {
      this.states.set(name, { session: null, backoff: this.minBackoff, timer: null });
      void this.launch(name);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      void s.session?.close().catch(() => undefined);
      s.session = null;
    }
  }

  config(name: string): BridgeConfig | undefined {
    return this.configs[name];
  }

  /** Tools of every bridge that is currently running. */
  tools(): Record<string, BridgeTool[]> {
    const out: Record<string, BridgeTool[]> = {};
    for (const [name, s] of this.states) if (s.session) out[name] = s.session.tools;
    return out;
  }

  call(bridge: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.states.get(bridge)?.session;
    if (!session) return Promise.reject(new Error(`bridge "${bridge}" is not available on this computer`));
    return session.call(tool, args);
  }

  private async launch(name: string): Promise<void> {
    const state = this.states.get(name)!;
    if (this.stopped) return;
    try {
      const session = await this.connect(name, this.configs[name]);
      if (this.stopped) {
        await session.close().catch(() => undefined);
        return;
      }
      session.onClose(() => {
        if (state.session !== session) return;
        state.session = null;
        this.opts.log(`bridge ${name}: server exited`);
        this.opts.onChange();
        this.retry(name);
      });
      state.session = session;
      state.backoff = this.minBackoff;
      this.opts.log(`bridge ${name}: ready with ${session.tools.length} tools`);
      this.opts.onChange();
    } catch (err) {
      this.opts.log(`bridge ${name}: could not start (${err instanceof Error ? err.message : String(err)})`);
      this.retry(name);
    }
  }

  private retry(name: string): void {
    const state = this.states.get(name)!;
    if (this.stopped || state.timer) return;
    const wait = state.backoff;
    state.backoff = Math.min(state.backoff * 2, this.maxBackoff);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.launch(name);
    }, wait);
    state.timer.unref?.();
  }
}
