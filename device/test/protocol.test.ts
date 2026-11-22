import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Approver } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { dispatch } from "../src/dispatch.js";
import { RelayClient } from "../src/relay-client.js";
import { resolveConfig } from "../src/policy.js";
import { TOOLS } from "../src/tools.js";
import { categoryAllowed } from "../src/policy.js";

test("device dials relay, sends hello, answers a call through policy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dc-proto-"));
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(dir, "hello.txt"), "from pc"));

  const token = "t".repeat(40);
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as any).port;

  let helloSeen: any = null;
  let auth = "";
  const results: Record<string, any> = {};
  const replies = new Promise<Record<string, any>>((resolve) => {
    wss.on("connection", (ws: WebSocket, req) => {
      auth = req.headers.authorization ?? "";
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "hello") {
          helloSeen = msg;
          ws.send(JSON.stringify({ type: "call", id: "c1", tool: "fs_read", args: { path: path.join(dir, "hello.txt") } }));
          ws.send(JSON.stringify({ type: "call", id: "c2", tool: "fs_delete", args: { path: path.join(dir, "hello.txt") } }));
        }
        if (msg.type === "result") {
          results[msg.id] = msg;
          if (results.c1 && results.c2) resolve(results);
        }
      });
    });
  });

  const cfg = resolveConfig({ profile: "readonly", auditLog: path.join(dir, "a.jsonl") }, path.join(dir, "a.jsonl"));
  const deps = { cfg, approver: new Approver("deny", 1), audit: new AuditLog(path.join(dir, "a.jsonl"), false) };
  const client = new RelayClient({
    url: `ws://127.0.0.1:${port}/device`,
    token,
    deviceId: "pc-test",
    version: "0.1.0",
    profile: "readonly",
    tools: TOOLS.filter((t) => categoryAllowed("readonly", t.category)).map((t) => t.name),
    log: () => undefined,
    onCall: (m) => dispatch(deps, m.tool, m.args),
  });
  client.start();

  const got = await replies;
  client.stop();
  await new Promise((r) => setTimeout(r, 50));
  wss.close();

  assert.equal(auth, `Bearer ${token}`);
  assert.equal(helloSeen.deviceId, "pc-test");
  assert.equal(helloSeen.profile, "readonly");
  assert.ok(helloSeen.tools.includes("fs_read"));
  assert.ok(!helloSeen.tools.includes("fs_delete"));
  assert.equal(got.c2.ok, false);
  assert.match(got.c2.error, /Blocked by profile/);
  assert.equal(got.c1.ok, true);
  assert.equal(got.c1.result.data, "from pc");
});
