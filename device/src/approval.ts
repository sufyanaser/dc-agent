import readline from "node:readline";
import { showApprovalDialog } from "./dialog.js";

export interface ApprovalRequest {
  tool: string;
  summary: string;
}

/** Shows a native prompt and resolves true only if the owner pressed Allow. */
export type DialogRunner = (req: ApprovalRequest, timeoutSec: number, signal?: AbortSignal) => Promise<boolean>;

export class Approver {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param maxWaitSec hard cap measured from when the request arrives. It stays below the relay's 90s call
   *   timeout, so an Allow can never run a command the AI was already told had failed.
   */
  constructor(
    private readonly mode: "console" | "deny" | "dialog",
    private readonly timeoutSec: number,
    private readonly runner: DialogRunner = showApprovalDialog,
    private readonly maxWaitSec = 80,
  ) {}

  request(req: ApprovalRequest): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.timeoutSec, this.maxWaitSec) * 1000;
    const run = this.queue.then(() => this.ask(req, deadline));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ask(req: ApprovalRequest, deadline: number): Promise<boolean> {
    const remainingMs = deadline - Date.now();
    if (this.mode === "deny" || remainingMs <= 0) return Promise.resolve(false); // expired while queued
    if (this.mode === "dialog") return this.askDialog(req, remainingMs);
    if (!process.stdin.isTTY) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const timer = setTimeout(() => {
        rl.close();
        process.stdout.write("\n[approval] timed out, denied\n");
        resolve(false);
      }, remainingMs);
      process.stdout.write(`\n[APPROVAL] ${req.tool}: ${req.summary}\n`);
      rl.question("Allow? (y/N): ", (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  }

  /** The timer is the hard cap: a dialog that never answers is aborted and counts as a denial. */
  private askDialog(req: ApprovalRequest, remainingMs: number): Promise<boolean> {
    const controller = new AbortController();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, remainingMs);
      timer.unref();
      this.runner(req, Math.max(1, Math.floor(remainingMs / 1000)), controller.signal).then(
        (answer) => {
          clearTimeout(timer);
          resolve(answer === true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }
}
