import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeManager, DEFAULT_BRIDGES, launchSpec, resolveBridges, type BridgeSession, type Connector } from "../src/bridges.js";
import { dispatchBridge } from "../src/dispatch.js";
import { Approver } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { resolveConfig } from "../src/policy.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeConnector(opts: { failFirst?: number } = {}) {
  let attempts = 0;
  const sessions: { close: () => void }[] = [];
  const connect: Connector = async (name) => {
    attempts++;
    if (attempts <= (opts.failFirst ?? 0)) throw new Error("spawn figwright-mcp ENOENT");
    let onClose = () => {};
    const s: BridgeSession = {
      tools: [{ name: "ping", description: `ping ${name}`, inputSchema: { type: "object", properties: {} } }],
      call: async (tool, args) => ({ content: [{ type: "text", text: `${name}:${tool}:${JSON.stringify(args)}` }] }),
      close: async () => {},
      onClose: (cb) => (onClose = cb),
    };
    sessions.push({ close: () => onClose() });
    return s;
  };
  return { connect, attempts: () => attempts, sessions };
}

test("bridges start, expose their tools, and report the change", async () => {
  const f = fakeConnector();
  let changes = 0;
  const m = new BridgeManager({ figwright: { command: "x" } }, { log: () => {}, onChange: () => changes++, connect: f.connect });
  m.start();
  await wait(20);
  assert.deepEqual(Object.keys(m.tools()), ["figwright"]);
  assert.equal(m.tools().figwright[0].name, "ping");
  assert.ok(changes >= 1);
  m.stop();
});

test("a call goes to the named bridge and returns its raw MCP result", async () => {
  const f = fakeConnector();
  const m = new BridgeManager({ figwright: { command: "x" } }, { log: () => {}, onChange: () => {}, connect: f.connect });
  m.start();
  await wait(20);
  assert.deepEqual(await m.call("figwright", "ping", { a: 1 }), { content: [{ type: "text", text: 'figwright:ping:{"a":1}' }] });
  await assert.rejects(m.call("resolve", "ping", {}), /bridge "resolve" is not available/);
  m.stop();
});

test("a bridge that fails to start or exits is retried with backoff", async () => {
  const f = fakeConnector({ failFirst: 1 });
  const m = new BridgeManager({ figwright: { command: "x" } }, { log: () => {}, onChange: () => {}, connect: f.connect, minBackoffMs: 30, maxBackoffMs: 30 });
  m.start();
  await wait(10);
  assert.deepEqual(m.tools(), {}, "failed bridge must not expose tools");
  await wait(80);
  assert.equal(f.attempts(), 2);
  assert.ok(m.tools().figwright);
  f.sessions[0].close(); // the server process exits
  assert.deepEqual(m.tools(), {});
  await wait(80);
  assert.equal(f.attempts(), 3);
  assert.ok(m.tools().figwright, "bridge was not restarted");
  m.stop();
});

test("resolveBridges: Figwright by default, config can replace or disable it", () => {
  assert.deepEqual(resolveBridges(undefined, undefined), DEFAULT_BRIDGES);
  assert.ok(DEFAULT_BRIDGES.figwright);
  assert.deepEqual(resolveBridges({}, undefined), {});
  assert.deepEqual(resolveBridges(undefined, { other: { command: "o" } }), { other: { command: "o" } });
  assert.deepEqual(resolveBridges({ a: { command: "a" } }, { b: { command: "b" } }), { a: { command: "a" } });
});

test("launchSpec: Windows runs the command directly, macOS through a login shell so launchd finds it on PATH", () => {
  assert.deepEqual(launchSpec({ command: "figwright-mcp" }, "win32"), { command: "figwright-mcp", args: [] });
  assert.deepEqual(launchSpec({ command: "figwright-mcp", args: ["--x", "a b"] }, "darwin"), { command: "/bin/zsh", args: ["-lc", "'figwright-mcp' '--x' 'a b'"] });
  assert.deepEqual(launchSpec({ command: "/opt/bin/fw" }, "darwin"), { command: "/opt/bin/fw", args: [] });
});

test("bridge calls are audited and honour a per-bridge approval setting", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dc-br-"));
  const logFile = path.join(dir, "audit.jsonl");
  const cfg = resolveConfig({ profile: "readonly", auditLog: logFile }, logFile);
  const f = fakeConnector();
  const m = new BridgeManager({ figwright: { command: "x" }, guarded: { command: "x", approval: "dialog" } }, { log: () => {}, onChange: () => {}, connect: f.connect });
  m.start();
  await wait(20);
  const deps = { cfg, approver: new Approver("deny", 1), audit: new AuditLog(logFile, false), bridges: m };
  const ok = await dispatchBridge(deps, "figwright", "ping", {});
  assert.equal(ok.ok, true, "readonly profile must not block an enabled bridge");
  const denied = await dispatchBridge(deps, "guarded", "ping", {});
  assert.equal(denied.ok, false);
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].tool, "figwright/ping");
  assert.equal(lines[0].category, "bridge");
  assert.equal(lines[1].decision, "rejected");
  m.stop();
});
