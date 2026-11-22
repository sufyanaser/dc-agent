import path from "node:path";

export type Profile = "full" | "scoped" | "readonly";
export type Category = "read" | "write" | "delete" | "move" | "exec" | "kill";

export interface PolicyConfig {
  profile: Profile;
  allowedRoots: string[];
  denyPatterns: string[];
  commandPolicy: "allow_all" | "allowlist";
  commandAllowlist: string[];
  requireApprovalFor: Category[];
  approvalMode: "console" | "deny" | "dialog";
  approvalTimeoutSec: number;
  auditLog: string;
  auditContent: boolean;
  maxOutputBytes: number;
}

const SCOPED_DENY = [
  "(^|[\\\\/])\\.env(\\..*)?$",
  "(^|[\\\\/])\\.ssh([\\\\/]|$)",
  "id_(rsa|ed25519|ecdsa)",
  "\\.(pem|key|pfx|p12)$",
  "(^|[\\\\/])\\.aws([\\\\/]|$)",
  "(^|[\\\\/])\\.git-credentials$",
];

const SCOPED_ALLOWLIST = [
  "git", "npm", "npx", "node", "python", "py", "pip", "dir", "type", "echo",
  "Get-ChildItem", "Get-Content", "Get-Item", "Select-String", "where", "whoami", "ipconfig",
];

const MAC_ALLOWLIST = ["git", "npm", "npx", "node", "python3", "pip3", "ls", "cat", "grep", "pwd", "whoami", "echo", "which"];
const MAC_READONLY_ALLOWLIST = ["ls", "cat", "grep", "pwd", "whoami"];

const APPROVAL_ALL: Category[] = ["write", "delete", "move", "exec", "kill"];

export function defaultsFor(profile: Profile, platform: NodeJS.Platform = process.platform): PolicyConfig {
  const unix = platform !== "win32";
  const base: PolicyConfig = {
    profile,
    allowedRoots: [],
    denyPatterns: [],
    commandPolicy: "allowlist",
    commandAllowlist: unix ? MAC_ALLOWLIST : SCOPED_ALLOWLIST,
    requireApprovalFor: [],
    approvalMode: "console",
    approvalTimeoutSec: 120,
    auditLog: "",
    auditContent: false,
    maxOutputBytes: 1_000_000,
  };
  if (profile === "scoped") {
    base.denyPatterns = [...SCOPED_DENY];
    base.requireApprovalFor = [...APPROVAL_ALL];
  }
  if (profile === "full") {
    base.commandPolicy = "allow_all";
    base.auditContent = true;
  }
  if (profile === "readonly") {
    base.denyPatterns = [...SCOPED_DENY];
    base.commandPolicy = "allowlist";
    base.commandAllowlist = unix ? MAC_READONLY_ALLOWLIST : ["dir", "Get-ChildItem", "Get-Content", "Select-String", "whoami", "ipconfig"];
  }
  return base;
}

const PROFILES: Profile[] = ["full", "scoped", "readonly"];
const CATEGORIES: Category[] = ["read", "write", "delete", "move", "exec", "kill"];

export function resolveConfig(raw: Partial<PolicyConfig> & { profile?: Profile }, auditDefault: string): PolicyConfig {
  const profile = raw.profile ?? "scoped";
  if (!PROFILES.includes(profile)) throw new Error(`Invalid profile: ${String(profile)}`);
  const cfg: PolicyConfig = { ...defaultsFor(profile), ...stripUndefined(raw), profile };
  if (!cfg.auditLog) cfg.auditLog = auditDefault;
  for (const c of cfg.requireApprovalFor) if (!CATEGORIES.includes(c)) throw new Error(`Invalid approval category: ${c}`);
  for (const p of cfg.denyPatterns) new RegExp(p, "i");
  if (profile === "scoped" && cfg.allowedRoots.length === 0) {
    throw new Error("scoped profile requires at least one entry in allowedRoots");
  }
  return cfg;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function categoryAllowed(profile: Profile, cat: Category): boolean {
  if (profile === "readonly") return cat === "read";
  return true;
}

export function needsApproval(cfg: PolicyConfig, cat: Category): boolean {
  return cfg.requireApprovalFor.includes(cat);
}

export type PathDecision = { ok: true; resolved: string } | { ok: false; reason: string };

const isWin = process.platform === "win32";
const norm = (p: string) => (isWin ? p.toLowerCase() : p);

export function checkPath(cfg: PolicyConfig, input: string, cat: Category): PathDecision {
  if (!categoryAllowed(cfg.profile, cat)) return { ok: false, reason: `profile "${cfg.profile}" blocks ${cat}` };
  if (typeof input !== "string" || input.length === 0) return { ok: false, reason: "empty path" };
  const resolved = path.resolve(input);

  if (cfg.profile === "scoped") {
    const inside = cfg.allowedRoots.some((r) => {
      const root = path.resolve(r);
      const a = norm(resolved);
      const b = norm(root);
      return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
    });
    if (!inside) return { ok: false, reason: `path outside allowedRoots: ${resolved}` };
  }

  for (const p of cfg.denyPatterns) {
    if (new RegExp(p, "i").test(resolved)) return { ok: false, reason: `path matches denyPattern: ${p}` };
  }

  if (cat === "delete" && isHardProtected(resolved)) {
    return { ok: false, reason: `refusing to delete protected location: ${resolved}` };
  }
  return { ok: true, resolved };
}

function isHardProtected(p: string): boolean {
  const root = path.parse(p).root;
  if (norm(p) === norm(root)) return true;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home && norm(p) === norm(path.resolve(home))) return true;
  return false;
}

export function checkCommand(cfg: PolicyConfig, command: string): { ok: true } | { ok: false; reason: string } {
  if (typeof command !== "string" || command.trim().length === 0) return { ok: false, reason: "empty command" };
  if (cfg.commandPolicy === "allow_all") return { ok: true };
  if (/[&|;<>`]|\$\(/.test(command)) {
    return { ok: false, reason: "chained or redirected commands are not allowed in allowlist mode" };
  }
  const first = command.trim().split(/\s+/)[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  const allowed = cfg.commandAllowlist.some((c) => c.toLowerCase() === first.toLowerCase());
  return allowed ? { ok: true } : { ok: false, reason: `command "${first}" not in allowlist` };
}
