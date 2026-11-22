import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** File logger for a windowless process. Rotates to `<file>.1` at maxBytes and never throws. */
export function createLogger(file: string, maxBytes = 1_000_000): (line: string) => void {
  return (line: string) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (statSync(file).size >= maxBytes) {
          rmSync(file + ".1", { force: true });
          renameSync(file, file + ".1");
        }
      } catch {
        /* no file yet */
      }
      appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* logging must never take the agent down */
    }
  };
}
