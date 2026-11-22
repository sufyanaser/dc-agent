import type { Approver } from "./approval.js";
import type { AuditLog } from "./audit.js";
import type { BridgeManager } from "./bridges.js";
import { checkCommand, checkPath, categoryAllowed, needsApproval, type PolicyConfig } from "./policy.js";
import { toolByName } from "./tools.js";

export interface Deps {
  cfg: PolicyConfig;
  approver: Approver;
  audit: AuditLog;
}

export type DispatchResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * A call to a bridged MCP server (e.g. Figwright). Bridges are enabled explicitly in config, so the
 * filesystem profile does not apply; each bridge's own `approval` setting does. Every call is audited.
 */
export async function dispatchBridge(
  deps: Deps & { bridges: BridgeManager },
  bridge: string,
  tool: string,
  args: unknown,
): Promise<DispatchResult> {
  const a = (typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const base = { tool: `${bridge}/${tool}`, category: "bridge", args: a };
  const cfg = deps.bridges.config(bridge);
  if (!cfg) {
    await deps.audit.write({ ...base, decision: "denied", ok: false, error: "unknown bridge" });
    return { ok: false, error: `bridge "${bridge}" is not configured on this computer` };
  }
  if (cfg.approval === "dialog") {
    const approved = await deps.approver.request({ tool: `${bridge}/${tool}`, summary: JSON.stringify(a).slice(0, 300) });
    if (!approved) {
      await deps.audit.write({ ...base, decision: "rejected", ok: false, error: "approval not granted" });
      return { ok: false, error: "Approval not granted by device owner" };
    }
  }
  const started = Date.now();
  try {
    const result = await deps.bridges.call(bridge, tool, a);
    await deps.audit.write({ ...base, decision: "allowed", ok: true, durationMs: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.audit.write({ ...base, decision: "allowed", ok: false, error: message, durationMs: Date.now() - started });
    return { ok: false, error: message };
  }
}

export async function dispatch(deps: Deps, name: string, args: unknown): Promise<DispatchResult> {
  const { cfg, approver, audit } = deps;
  const def = toolByName(name);
  if (!def) return { ok: false, error: `unknown tool: ${name}` };
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "arguments must be an object" };
  }
  const a = args as Record<string, any>;
  const base = { tool: name, category: def.category, args: a };

  if (!categoryAllowed(cfg.profile, def.category)) {
    await audit.write({ ...base, decision: "denied", ok: false, error: "profile blocks category" });
    return { ok: false, error: `Blocked by profile "${cfg.profile}": ${name} is not allowed` };
  }

  const pathCategory = name === "exec" ? "read" : def.category;
  for (const p of def.pathArgs ?? []) {
    if (a[p] === undefined) continue;
    const d = checkPath(cfg, a[p], pathCategory);
    if (!d.ok) {
      await audit.write({ ...base, decision: "denied", ok: false, error: d.reason });
      return { ok: false, error: `Denied by policy: ${d.reason}` };
    }
  }

  if (name === "exec") {
    const d = checkCommand(cfg, a.command);
    if (!d.ok) {
      await audit.write({ ...base, decision: "denied", ok: false, error: d.reason });
      return { ok: false, error: `Denied by policy: ${d.reason}` };
    }
  }

  const summary = def.summarize(a);
  if (needsApproval(cfg, def.category)) {
    const approved = await approver.request({ tool: name, summary });
    if (!approved) {
      await audit.write({ ...base, decision: "rejected", ok: false, error: "approval not granted" });
      return { ok: false, error: "Approval not granted by device owner" };
    }
    await audit.write({ ...base, decision: "approved" });
  }

  const started = Date.now();
  try {
    const result = await def.run(a, { cfg });
    await audit.write({ ...base, decision: "allowed", ok: true, durationMs: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit.write({ ...base, decision: "allowed", ok: false, error: message, durationMs: Date.now() - started });
    return { ok: false, error: message };
  }
}
