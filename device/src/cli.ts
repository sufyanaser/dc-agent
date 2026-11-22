import type { PolicyConfig } from "./policy.js";

export type Mode = "run" | "install" | "uninstall" | "status" | "check";

/** A built installer (SEA) with no arguments installs; plain `node dist/src/index.js` runs the agent. */
export function parseMode(argv: string[], isSea: boolean): Mode {
  if (argv.includes("--run")) return "run";
  if (argv.includes("--uninstall")) return "uninstall";
  if (argv.includes("--status")) return "status";
  if (argv.includes("--check")) return "check";
  return isSea ? "install" : "run";
}

/** A hidden installed build has no console, so `console` approvals become native dialogs. */
export function approvalModeFor(configured: PolicyConfig["approvalMode"], isSea: boolean): PolicyConfig["approvalMode"] {
  return configured === "console" && isSea ? "dialog" : configured;
}
