import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  tool: string;
  category: string;
  decision: "allowed" | "denied" | "approved" | "rejected";
  ok?: boolean;
  error?: string;
  durationMs?: number;
  args?: unknown;
}

export class AuditLog {
  private ready: Promise<void> | null = null;
  constructor(private readonly file: string, private readonly includeContent: boolean) {}

  private ensure(): Promise<void> {
    if (!this.ready) this.ready = mkdir(path.dirname(this.file), { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async write(entry: Omit<AuditEntry, "ts" | "args"> & { args?: unknown }): Promise<void> {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry, args: this.redact(entry.args) };
    try {
      await this.ensure();
      await appendFile(this.file, JSON.stringify(full) + "\n", "utf8");
    } catch (err) {
      process.stderr.write(`[audit] write failed: ${(err as Error).message}\n`);
    }
  }

  private redact(args: unknown): unknown {
    if (args === undefined) return undefined;
    if (this.includeContent) return args;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v.length > 200 ? `[${v.length} chars]` : v;
      else out[k] = v;
    }
    return out;
  }
}
