import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth.js";
import { McpApiHandler } from "./mcp.js";
import { PUBLIC_ORIGIN } from "./origin.js";

export { DeviceHub } from "./device-hub.js";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:use"],
  requiredScopes: ["mcp:use"],
  resourceMetadata: {
    resource: `${PUBLIC_ORIGIN}/mcp`,
    authorization_servers: [PUBLIC_ORIGIN],
  },
});
