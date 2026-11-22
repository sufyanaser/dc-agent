import os from "node:os";
import path from "node:path";

/** Install root. `DC_HOME` overrides it (used for isolated tests and portable setups). */
export function dcHome(): string {
  if (process.env.DC_HOME) return path.resolve(process.env.DC_HOME);
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA || os.homedir() : os.homedir();
  return path.join(base, "dc-custom");
}

export function configPath(): string {
  return process.env.DC_CONFIG || path.join(dcHome(), "config.json");
}

export function auditPath(): string {
  return path.join(dcHome(), "audit.jsonl");
}

export function logPath(): string {
  if (process.platform === "darwin" && !process.env.DC_HOME) {
    return path.join(os.homedir(), "Library", "Logs", "dc-custom", "agent.log");
  }
  return path.join(dcHome(), "agent.log");
}
