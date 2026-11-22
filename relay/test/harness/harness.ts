// Test-only Worker: exposes DeviceHub over HTTP and runs the real MCP handler with a stubbed
// OAuth identity (skips GitHub login) so the real device agent and the multi-device routing
// can be exercised end to end. Never deployed. Device auth: same DEVICE_TOKEN as production.
import { DeviceHub } from "../../src/device-hub.js";
import { McpApiHandler } from "../../src/mcp.js";
export { DeviceHub };

interface HarnessEnv {
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  DEVICE_TOKEN: string;
  ALLOWED_GITHUB_LOGIN: string;
  PUBLIC_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName("owner"));

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const ctx: any = { props: { login: env.ALLOWED_GITHUB_LOGIN, userId: "1" }, waitUntil() {}, passThroughOnException() {} };
      return McpApiHandler.fetch(request, env as any, ctx);
    }

    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.DEVICE_TOKEN}`) return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/device") return hub.fetch(new Request("https://do/connect", request));
    if (url.pathname === "/status") return hub.fetch(new Request("https://do/status"));
    if (url.pathname === "/devices") return hub.fetch(new Request("https://do/devices"));
    if (url.pathname === "/call" && request.method === "POST") {
      const body = (await request.json()) as { tool: string; args: unknown; device?: string; bridge?: string };
      return Response.json(await hub.call(body.tool, body.args, body.device, body.bridge));
    }
    return new Response("not found", { status: 404 });
  },
};
