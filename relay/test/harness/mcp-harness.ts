// Test-only Worker: runs the real MCP handler with a stubbed OAuth identity (skips GitHub login).
import { DeviceHub } from "../../src/device-hub.js";
import { McpApiHandler } from "../../src/mcp.js";
export { DeviceHub };

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/device") {
      if (request.headers.get("Authorization") !== `Bearer ${env.DEVICE_TOKEN}`) return new Response("unauthorized", { status: 401 });
      const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName("owner"));
      return hub.fetch(new Request("https://do/connect", request));
    }
    const ctx: any = { props: { login: env.ALLOWED_GITHUB_LOGIN, userId: "1" }, waitUntil() {}, passThroughOnException() {} };
    return McpApiHandler.fetch(request, env, ctx);
  },
};
