import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { CALL_TIMEOUT_MS, type BridgeTool, type CallMessage, type DeviceInfo, type DeviceReply, type HelloMessage, type ResultMessage } from "./protocol.js";

interface Pending {
  resolve: (r: DeviceReply) => void;
  timer: ReturnType<typeof setTimeout>;
  deviceId: string;
}

interface Attachment {
  deviceId: string;
}

const HELLO_PREFIX = "hello:";
const BRIDGES_PREFIX = "bridges:";

/**
 * One Durable Object per owner. Holds one hibernatable WebSocket per device
 * (keyed by the `deviceId` from its hello) and forwards tool calls to the
 * chosen device. Devices dial out, so no inbound port is needed on the PC.
 */
export class DeviceHub extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/status" || url.pathname === "/devices") {
      const devices = await this.devices();
      if (url.pathname === "/devices") return Response.json(devices);
      return Response.json({ online: devices.some((d) => d.online), devices });
    }

    return new Response("not found", { status: 404 });
  }

  /** Every device that ever said hello, with whether its socket is currently open. */
  async devices(): Promise<DeviceInfo[]> {
    const liveIds = new Set(this.live().map((d) => d.deviceId));
    const stored = await this.ctx.storage.list<HelloMessage>({ prefix: HELLO_PREFIX });
    const bridges = await this.storedBridges();
    return [...stored.values()]
      .map((h) => ({
        deviceId: h.deviceId,
        online: liveIds.has(h.deviceId),
        profile: h.profile,
        version: h.version,
        tools: h.tools,
        bridges: Object.fromEntries(Object.entries(bridges.get(h.deviceId) ?? {}).map(([name, tools]) => [name, tools.length])),
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /** Tool list of a bridge, from an online device that runs it if possible, else the last one seen. */
  async bridgeTools(bridge: string): Promise<BridgeTool[]> {
    const liveIds = new Set(this.live().map((d) => d.deviceId));
    let fallback: BridgeTool[] = [];
    for (const [deviceId, bridges] of await this.storedBridges()) {
      const tools = bridges[bridge];
      if (!tools) continue;
      if (liveIds.has(deviceId)) return tools;
      fallback = tools;
    }
    return fallback;
  }

  private async storedBridges(): Promise<Map<string, Record<string, BridgeTool[]>>> {
    const out = new Map<string, Record<string, BridgeTool[]>>();
    for (const [key, value] of await this.ctx.storage.list<Record<string, BridgeTool[]>>({ prefix: BRIDGES_PREFIX })) {
      out.set(key.slice(BRIDGES_PREFIX.length), value);
    }
    return out;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let msg: { type?: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const hello = msg as unknown as HelloMessage;
      if (typeof hello.deviceId !== "string" || hello.deviceId.length === 0 || hello.deviceId.length > 100) return;
      ws.serializeAttachment({ deviceId: hello.deviceId } satisfies Attachment);
      // A reconnect of the same device replaces only that device's older socket.
      for (const old of this.ctx.getWebSockets()) {
        if (old !== ws && this.deviceIdOf(old) === hello.deviceId) old.close(4001, "replaced by newer device connection");
      }
      const { bridges, ...core } = hello;
      await this.ctx.storage.put(HELLO_PREFIX + hello.deviceId, core);
      await this.ctx.storage.put(BRIDGES_PREFIX + hello.deviceId, bridges ?? {});
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
      return;
    }
    if (msg.type === "result") {
      const r = msg as unknown as ResultMessage;
      const p = this.pending.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      p.resolve({ ok: r.ok, result: r.result, error: r.error });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.failFor(ws, "device disconnected");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.failFor(ws, "device connection error");
  }

  /** Called from the MCP handler over RPC. `device` picks the target; optional when exactly one is online. */
  async call(tool: string, args: unknown, device?: string, bridge?: string): Promise<DeviceReply> {
    let live = this.live();
    if (live.length === 0) return { ok: false, error: "device offline: start dc-custom on the computer" };
    if (bridge) {
      const bridges = await this.storedBridges();
      live = live.filter((d) => bridges.get(d.deviceId)?.[bridge]);
      if (live.length === 0) {
        return { ok: false, error: `No online computer is running the "${bridge}" bridge. Check that ${bridge} is installed there and dc-custom is running.` };
      }
    }

    const names = live.map((d) => d.deviceId).sort().join(", ");
    let target: { ws: WebSocket; deviceId: string } | undefined;
    if (device) {
      target = live.find((d) => d.deviceId === device);
      if (!target) return { ok: false, error: `device "${device}" is not online. Online devices: ${names}` };
    } else if (live.length === 1) {
      target = live[0];
    } else {
      return { ok: false, error: `Several devices are online (${names}). Pass the "device" argument to choose one.` };
    }

    const id = crypto.randomUUID();
    const message: CallMessage = bridge ? { type: "call", id, tool, args, bridge } : { type: "call", id, tool, args };
    const body = JSON.stringify(message);
    const { ws, deviceId } = target;

    return new Promise<DeviceReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `device did not answer within ${CALL_TIMEOUT_MS / 1000}s` });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, deviceId });
      try {
        ws.send(body);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `send failed: ${(err as Error).message}` });
      }
    });
  }

  private deviceIdOf(ws: WebSocket): string | undefined {
    return (ws.deserializeAttachment() as Attachment | null)?.deviceId;
  }

  private live(): { ws: WebSocket; deviceId: string }[] {
    const out: { ws: WebSocket; deviceId: string }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const deviceId = this.deviceIdOf(ws);
      if (deviceId) out.push({ ws, deviceId });
    }
    return out;
  }

  /** Fail the pending calls of the closed socket's device, unless a replacement socket for it is still open. */
  private failFor(ws: WebSocket, reason: string): void {
    const deviceId = this.deviceIdOf(ws);
    if (!deviceId) return;
    if (this.live().some((d) => d.deviceId === deviceId && d.ws !== ws)) return;
    for (const [id, p] of this.pending) {
      if (p.deviceId !== deviceId) continue;
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason });
      this.pending.delete(id);
    }
  }
}
