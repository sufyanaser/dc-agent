import { authorizationErrorRedirect, AuthorizationError, OAuthError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";
import { iconResponse } from "./icon.js";


const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dc-custom</title>` +
  `<link rel="icon" type="image/png" sizes="256x256" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">` +
  `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#111">${body}</body></html>`;

function bearerOk(request: Request, token: string): boolean {
  const h = request.headers.get("Authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const given = h.slice(7);
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

async function handleDevice(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.DEVICE_TOKEN || !bearerOk(request, env.DEVICE_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName("owner"));
  if (url.pathname === "/device") return hub.fetch(new Request("https://do/connect", request));
  if (url.pathname === "/status") return hub.fetch(new Request("https://do/status"));
  return new Response("not found", { status: 404 });
}

export const AuthHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { oauth?: OAuthHelpers }): Promise<Response> {
    const url = new URL(request.url);
    const oauth = (env as any).OAUTH_PROVIDER as OAuthHelpers;

    if (url.pathname === "/device" || url.pathname === "/status") return handleDevice(request, env, url);

    const icon = iconResponse(url.pathname, request.method);
    if (icon) return icon;

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(page(`<h1>dc-custom</h1><p>Relay is running. Add this server to ChatGPT as <code>${escapeHtml(env.PUBLIC_ORIGIN)}/mcp</code>.</p>`), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/authorize" && request.method === "GET") {
      try {
        const authRequest = await oauth.parseAuthRequest(request);
        const client = await oauth.lookupClient(authRequest.clientId);
        const consent = await oauth.beginConsent(authRequest);
        const desc = await oauth.describeConsent(authRequest);
        const html = page(`
          <h1>Allow ${escapeHtml(desc.clientName || "an MCP client")}?</h1>
          <p>This client will be able to use your PC through dc-custom. Access is limited by the device profile set on your PC.</p>
          <p>Redirects to: <code>${escapeHtml(desc.redirectHost)}</code></p>
          <form method="POST" action="/authorize">
            <input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
            <button name="action" value="allow" style="padding:10px 18px">Allow</button>
            <button name="action" value="deny" style="padding:10px 18px">Deny</button>
          </form>${client ? "" : "<p>Unknown client.</p>"}`);
        // consent.headers carries only the CSRF cookie; without an explicit content-type the
        // body is served as text/plain and the browser shows raw HTML instead of the page.
        const headers = new Headers(consent.headers);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("cache-control", "no-store");
        headers.set("x-frame-options", "DENY");
        headers.set("content-security-policy", "frame-ancestors 'none'");
        return new Response(html, { headers });
      } catch (err) {
        if (err instanceof AuthorizationError || err instanceof OAuthError) {
          return new Response(page(`<h1>Authorization error</h1><p>${escapeHtml(String((err as Error).message))}</p>`), { status: 400, headers: { "content-type": "text/html" } });
        }
        throw err;
      }
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("action") === "deny") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: { Location: denied.redirectTo } });
      }
      const approved = await oauth.approveConsent(request, handle);
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: {}, headers: approved.headers });
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      gh.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/callback`);
      gh.searchParams.set("scope", "read:user");
      gh.searchParams.set("state", state);
      headers.set("Location", gh.toString());
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === "/callback" && request.method === "GET") {
      const resumed = await oauth.finishUpstream<Record<string, never>>(request);
      if (url.searchParams.get("error")) {
        resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("missing code", { status: 400 });

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_ORIGIN}/callback` }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}`, "User-Agent": "dc-custom-relay" },
      });
      const user = (await userRes.json()) as { id: number; login: string };

      if (user.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
        resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
        return new Response(null, { status: 302, headers: resumed.headers });
      }

      const { redirectTo } = await oauth.completeAuthorization({
        request: resumed.request,
        userId: String(user.id),
        metadata: { login: user.login },
        scope: resumed.request.scope,
        props: { login: user.login, userId: String(user.id) },
      });
      resumed.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: resumed.headers });
    }

    return new Response("not found", { status: 404 });
  },
};


