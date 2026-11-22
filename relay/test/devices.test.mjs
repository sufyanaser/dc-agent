// End-to-end test of the multi-device hub: real DeviceHub Durable Object under `wrangler dev`,
// two fake device agents over real WebSockets, and the real MCP handler.
// Run: node --test test/devices.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "t".repeat(40);

let proc;
let persist;
const sockets = [];

before(async () => {
  persist = mkdtempSync(path.join(os.tmpdir(), "dc-relay-test-"));
  const wrangler = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  proc = spawn(
    process.execPath,
    [wrangler, "dev", "-c", "wrangler.harness.jsonc", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist,
      "--var", `DEVICE_TOKEN:${TOKEN}`, "--var", "ALLOWED_GITHUB_LOGIN:tester", "--var", `PUBLIC_ORIGIN:${BASE}`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not become ready in 90s")), 90_000);
    const onData = (b) => {
      if (/Ready on/.test(b.toString())) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (c) => reject(new Error(`wrangler exited early (${c})`)));
  });
});

after(() => {
  for (const s of sockets) s.terminate();
  proc?.kill();
  setTimeout(() => rmSync(persist, { recursive: true, force: true }), 500).unref();
});

function connectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    sockets.push(ws);
    ws.closedWith = null;
    ws.on("close", (code) => (ws.closedWith = code));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "call") {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { from: deviceId, args: msg.args } }));
      }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", deviceId, version: "9.9.9", profile: "readonly", tools: ["fs_list"] }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

async function devices() {
  return (await (await fetch(`${BASE}/devices`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json());
}

async function waitFor(pred, what) {
  for (let i = 0; i < 50; i++) {
    const d = await devices();
    if (pred(d)) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const online = (d) => d.filter((x) => x.online).map((x) => x.deviceId).sort();

async function callTool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result.content[0].text;
  return { isError: body.result.isError === true, text };
}

test("two devices are online at the same time with their own hello data", async () => {
  await connectDevice("A");
  await connectDevice("B");
  const d = await waitFor((x) => online(x).length === 2, "A and B online");
  assert.deepEqual(online(d), ["A", "B"]);
  const a = d.find((x) => x.deviceId === "A");
  assert.equal(a.profile, "readonly");
  assert.equal(a.version, "9.9.9");
});

test("a call with `device` reaches only that device, and `device` is not forwarded", async () => {
  const a = await callTool("fs_list", { path: "/x", device: "A" });
  assert.equal(a.isError, false);
  assert.deepEqual(JSON.parse(a.text), { from: "A", args: { path: "/x" } });
  const b = await callTool("fs_list", { path: "/y", device: "B" });
  assert.deepEqual(JSON.parse(b.text), { from: "B", args: { path: "/y" } });
});

test("no `device` with two online devices is an error that names both", async () => {
  const r = await callTool("fs_list", { path: "/x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /A/);
  assert.match(r.text, /B/);
  assert.match(r.text, /device/);
});

test("an unknown device is an error that lists the online ones", async () => {
  const r = await callTool("fs_list", { path: "/x", device: "ZZZ" });
  assert.equal(r.isError, true);
  assert.match(r.text, /ZZZ/);
  assert.match(r.text, /A.*B|B.*A/);
});

test("device_status lists every device", async () => {
  const r = await callTool("device_status", {});
  const list = JSON.parse(r.text);
  assert.deepEqual(list.map((x) => x.deviceId).sort(), ["A", "B"]);
  assert.ok(list.every((x) => x.online === true));
});

test("reconnecting A replaces only A's old socket; B stays connected", async () => {
  const oldA = sockets.find((s, i) => i === 0);
  await connectDevice("A");
  await waitFor(() => oldA.closedWith !== null, "old A socket closed");
  assert.equal(oldA.closedWith, 4001);
  const d = await devices();
  assert.deepEqual(online(d), ["A", "B"]);
  const b = await callTool("fs_list", { path: "/y", device: "B" });
  assert.equal(JSON.parse(b.text).from, "B");
});

test("with one device online, calls route to it without `device`", async () => {
  const bSock = sockets.find((s) => s !== sockets[0] && s.readyState === WebSocket.OPEN && s === sockets[1]);
  bSock.close();
  await waitFor((d) => online(d).join() === "A", "only A online");
  const r = await callTool("fs_list", { path: "/z" });
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.text).from, "A");
});

// ---- Bridges (e.g. Figwright) exposed at /mcp/<bridge> ----

function connectBridgeDevice(deviceId, bridges) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    sockets.push(ws);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "call") return;
      const result = msg.bridge
        ? { content: [{ type: "text", text: `${deviceId}:${msg.bridge}:${msg.tool}:${JSON.stringify(msg.args)}` }] }
        : { from: deviceId, args: msg.args };
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", deviceId, version: "9.9.9", profile: "readonly", tools: ["fs_list"], bridges }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

async function rpc(pathname, method, params) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}

const PING = { name: "ping", description: "Figwright ping", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } };

test("/mcp/figwright lists the bridge's tools with an optional device argument", async () => {
  await connectBridgeDevice("F", { figwright: [PING] });
  await waitFor((d) => d.some((x) => x.deviceId === "F" && x.online), "F online");
  const { tools } = await rpc("/mcp/figwright", "tools/list", {});
  assert.deepEqual(tools.map((t) => t.name), ["ping"]);
  assert.equal(tools[0].inputSchema.properties.verbose.type, "boolean");
  assert.equal(tools[0].inputSchema.properties.device.type, "string");
});

test("bridge calls go only to a device that runs the bridge, and return the raw MCP content", async () => {
  // A is online too but has no bridges, so no `device` is needed.
  const r = await rpc("/mcp/figwright", "tools/call", { name: "ping", arguments: { verbose: true } });
  assert.equal(r.isError ?? false, false);
  assert.deepEqual(r.content, [{ type: "text", text: 'F:figwright:ping:{"verbose":true}' }]);
});

test("the main /mcp endpoint does not mix in bridge tools", async () => {
  const { tools } = await rpc("/mcp", "tools/list", {});
  assert.ok(!tools.some((t) => t.name === "ping"));
  assert.ok(tools.some((t) => t.name === "fs_list"));
});

test("a bridge no online device runs is a clear error, and device_status shows bridge tool counts", async () => {
  const r = await rpc("/mcp/resolve", "tools/call", { name: "ping", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /resolve/);
  const f = (await devices()).find((x) => x.deviceId === "F");
  assert.deepEqual(f.bridges, { figwright: 1 });
});
