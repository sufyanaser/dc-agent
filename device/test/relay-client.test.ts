import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RelayClient } from "../src/relay-client.js";

test("after being replaced (close 4001) the client waits the maximum backoff instead of fighting back", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    setTimeout(() => ws.close(4001, "replaced by newer device connection"), 20);
  });
  const lines: string[] = [];
  const client = new RelayClient({
    url: `ws://127.0.0.1:${port}`, token: "t".repeat(40), deviceId: "A", version: "x", profile: "readonly", tools: [],
    log: (l) => lines.push(l), onCall: async () => ({ ok: true }),
  });
  client.start();
  await new Promise((r) => setTimeout(r, 2500));
  client.stop();
  wss.close();
  assert.equal(connections, 1, "reconnected too soon after 4001");
  assert.ok(lines.some((l) => /same device name/i.test(l)), "no explanation in the log");
});

test("hello carries bridge tools, refreshHello resends them, and bridge calls are routed separately", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  const hellos: any[] = [];
  const results: any[] = [];
  let sock: any;
  wss.on("connection", (ws) => {
    sock = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "hello") hellos.push(m);
      if (m.type === "result") results.push(m);
    });
  });
  let bridgeTools: Record<string, unknown[]> = {};
  const client = new RelayClient({
    url: `ws://127.0.0.1:${port}`, token: "t".repeat(40), deviceId: "A", version: "x", profile: "readonly", tools: ["fs_list"],
    log: () => {}, onCall: async () => ({ ok: true, result: "core" }),
    bridges: () => bridgeTools as any,
    onBridgeCall: async (m) => ({ ok: true, result: { content: [{ type: "text", text: `${m.bridge}:${m.tool}` }] } }),
  });
  client.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(hellos[0].bridges, {});
  bridgeTools = { figwright: [{ name: "ping", inputSchema: { type: "object" } }] };
  client.refreshHello();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hellos.length, 2);
  assert.equal(hellos[1].bridges.figwright[0].name, "ping");
  sock.send(JSON.stringify({ type: "call", id: "1", bridge: "figwright", tool: "ping", args: {} }));
  sock.send(JSON.stringify({ type: "call", id: "2", tool: "fs_list", args: {} }));
  await new Promise((r) => setTimeout(r, 100));
  client.stop();
  wss.close();
  assert.deepEqual(results.find((r) => r.id === "1").result, { content: [{ type: "text", text: "figwright:ping" }] });
  assert.equal(results.find((r) => r.id === "2").result, "core");
});
