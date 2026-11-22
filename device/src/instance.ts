import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { dcHome } from "./home.js";

export type InstanceResult = { ok: true; release(): void } | { ok: false };

/**
 * Single-instance address: a named pipe on Windows, a unix socket on macOS. The OS frees it the moment
 * the holder dies (crash, logoff, taskkill, fast startup), so a stale lock can never keep the agent off.
 */
export function instanceAddress(home = dcHome()): string {
  const id = createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\dc-custom-${id}` : path.join(home, "agent.sock");
}

/** True when another process is listening on the address. */
export function isInstanceRunning(addr = instanceAddress()): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(addr);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function listen(addr: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.end());
    server.once("error", () => resolve(null));
    server.listen(addr, () => {
      server.unref();
      resolve(server);
    });
  });
}

export async function acquireInstance(addr = instanceAddress()): Promise<InstanceResult> {
  let server = await listen(addr);
  // A unix socket file survives a crash; if nobody answers on it, it is stale and can be replaced.
  if (!server && process.platform !== "win32" && !(await isInstanceRunning(addr))) {
    rmSync(addr, { force: true });
    server = await listen(addr);
  }
  if (!server) return { ok: false };
  const held = server;
  return { ok: true, release: () => held.close() };
}
