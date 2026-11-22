import WebSocket from "ws";

export interface CallMessage {
  type: "call";
  id: string;
  tool: string;
  args: unknown;
  /** Set when the call targets a bridged MCP server (e.g. "figwright") instead of a core tool. */
  bridge?: string;
}

type Reply = { ok: boolean; result?: unknown; error?: string };

export interface ClientOptions {
  url: string;
  token: string;
  deviceId: string;
  version: string;
  tools: string[];
  profile: string;
  onCall: (msg: CallMessage) => Promise<Reply>;
  log: (line: string) => void;
  /** Current tools of each running bridge, sent with every hello. */
  bridges?: () => Record<string, unknown[]>;
  onBridgeCall?: (msg: CallMessage & { bridge: string }) => Promise<Reply>;
}

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const PING_EVERY = 25_000;
const DEAD_AFTER = 60_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = MIN_BACKOFF;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastSeen = 0;

  constructor(private readonly opts: ClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "device stopping");
  }

  private connect(): void {
    if (this.stopped) return;
    this.opts.log(`connecting to relay ${this.opts.url}`);
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = MIN_BACKOFF;
      this.lastSeen = Date.now();
      this.sendHello();
      this.opts.log("connected");
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > DEAD_AFTER) {
          this.opts.log("relay silent, reconnecting");
          ws.terminate();
          return;
        }
        this.send({ type: "ping", ts: Date.now() });
      }, PING_EVERY);
    });

    ws.on("message", (data) => {
      this.lastSeen = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "call") void this.handleCall(msg as CallMessage);
    });

    ws.on("close", (code, reason) => {
      this.clearTimers();
      this.ws = null;
      this.opts.log(`disconnected (${code}) ${reason.toString()}`);
      if (code === 4001) {
        // Another agent connected with the same device name. Reconnecting at once would kick it off,
        // and it would kick us back, forever. Wait the maximum backoff instead.
        this.opts.log(`another agent is connected with the same device name "${this.opts.deviceId}"; retrying in ${MAX_BACKOFF / 1000}s`);
        this.backoff = MAX_BACKOFF;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.opts.log(`socket error: ${err.message}`);
    });
  }

  /** Re-announces this device, e.g. after a bridge started or stopped. No-op while disconnected. */
  refreshHello(): void {
    this.sendHello();
  }

  private sendHello(): void {
    this.send({
      type: "hello",
      deviceId: this.opts.deviceId,
      version: this.opts.version,
      profile: this.opts.profile,
      tools: this.opts.tools,
      bridges: this.opts.bridges?.() ?? {},
    });
  }

  private async handleCall(msg: CallMessage): Promise<void> {
    let out: Reply;
    try {
      if (msg.bridge) {
        out = this.opts.onBridgeCall
          ? await this.opts.onBridgeCall(msg as CallMessage & { bridge: string })
          : { ok: false, error: "this device has no bridges" };
      } else {
        out = await this.opts.onCall(msg);
      }
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.send({ type: "result", id: msg.id, ...out });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    setTimeout(() => this.connect(), wait);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
