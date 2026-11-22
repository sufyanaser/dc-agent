import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import type { DeviceReply } from "./protocol.js";
import type { DeviceHub } from "./device-hub.js";

interface AuthProps {
  login: string;
  userId: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function asText(r: DeviceReply): ToolResult {
  if (!r.ok) return { isError: true, content: [{ type: "text", text: `Error: ${r.error ?? "unknown error"}` }] };
  const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
  return { content: [{ type: "text", text: text ?? "" }] };
}

/** Every device tool takes this optional argument; the relay consumes it and never forwards it. */
const DEVICE_ARG = {
  device: z.string().optional().describe('Which computer to use when several are online (its name, see device_status). Optional when only one is online.'),
};

function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "dc-custom",
    title: "dc-custom",
    version: "0.2.0",
    icons: [
      { src: `${env.PUBLIC_ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["256x256"] },
      { src: `${env.PUBLIC_ORIGIN}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });

  const hub = () => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName("owner"));

  const readOnly = { readOnlyHint: true };
  const writes = { destructiveHint: true };

  /** Registers a tool that is forwarded to a device. */
  const deviceTool = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean },
  ) => {
    server.registerTool(name, { description, inputSchema: { ...inputSchema, ...DEVICE_ARG }, annotations }, async (args: Record<string, unknown>) => {
      const { device, ...forwarded } = args as { device?: string } & Record<string, unknown>;
      return asText(await hub().call(name, forwarded, device));
    });
  };

  deviceTool("fs_list", "List files and folders at a path on the computer. Set recursive for a tree.",
    { path: z.string(), recursive: z.boolean().optional(), maxEntries: z.number().int().optional() }, readOnly);
  deviceTool("fs_stat", "Get size and modified time for a path on the computer.", { path: z.string() }, readOnly);
  deviceTool("fs_read", "Read a file on the computer. Text as utf8, binaries as base64.",
    { path: z.string(), encoding: z.enum(["utf8", "base64"]).optional(), maxBytes: z.number().int().optional() }, readOnly);
  deviceTool("fs_write", "Write a file on the computer (atomic overwrite, or append).",
    { path: z.string(), content: z.string(), append: z.boolean().optional(), createDirs: z.boolean().optional() }, writes);
  deviceTool("fs_edit", "Replace exactly one occurrence of oldText with newText in a file on the computer.",
    { path: z.string(), oldText: z.string(), newText: z.string() }, writes);
  deviceTool("fs_move", "Move or rename a file or folder on the computer.", { from: z.string(), to: z.string() }, writes);
  deviceTool("fs_delete", "Delete a file, or a folder with recursive=true, on the computer.",
    { path: z.string(), recursive: z.boolean().optional() }, writes);
  deviceTool("fs_search", "Search text files under a folder on the computer for a substring or regex.", {
    path: z.string(),
    pattern: z.string(),
    regex: z.boolean().optional(),
    maxResults: z.number().int().optional(),
    maxFiles: z.number().int().optional(),
  }, readOnly);
  deviceTool("exec", "Run a command on the computer: PowerShell (default) or cmd on Windows, sh on macOS. Returns exit code, stdout, stderr.", {
    command: z.string(),
    cwd: z.string().optional(),
    shell: z.enum(["powershell", "cmd", "sh"]).optional(),
    timeoutMs: z.number().int().optional(),
  }, writes);
  deviceTool("proc_list", "List running processes on the computer with id, name and memory.", {}, readOnly);
  deviceTool("proc_kill", "Terminate a process on the computer by id.", { pid: z.number().int() }, writes);

  server.registerTool("device_status", {
    description: "List your computers: name, whether each is online, its profile, version and enabled tools.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await hub().devices(), null, 2) }] }));

  return server;
}

const BRIDGE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** "figwright" -> "Figwright" */
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A bridged MCP server on the owner's computer (e.g. Figwright), as its own connector at /mcp/<bridge>.
 * Tools and their JSON schemas come from the device's hello and are passed through untouched, plus an
 * optional `device` argument; results (text, images) are returned exactly as the bridged server gave them.
 */
function buildBridgeServer(env: Env, bridge: string): Server {
  // The RPC stub types JSON-schema-shaped return values as `never`; the runtime values are plain JSON.
  const hub = () => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName("owner")) as unknown as Pick<DeviceHub, "bridgeTools" | "call">;
  const server = new Server(
    {
      name: `dc-custom-${bridge}`,
      title: `${titleCase(bridge)} (dc-custom)`,
      version: "0.3.0",
      icons: [
        { src: `${env.PUBLIC_ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["256x256"] },
        { src: `${env.PUBLIC_ORIGIN}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await hub().bridgeTools(bridge);
    return {
      tools: tools.map((t) => ({
        ...t,
        inputSchema: {
          ...t.inputSchema,
          type: "object",
          properties: {
            ...(t.inputSchema.properties ?? {}),
            device: { type: "string", description: "Which computer to use when several run this bridge (see device_status). Optional." },
          },
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { device, ...args } = (req.params.arguments ?? {}) as { device?: string } & Record<string, unknown>;
    const reply = await hub().call(req.params.name, args, device, bridge);
    if (!reply.ok) return { isError: true, content: [{ type: "text" as const, text: `Error: ${reply.error ?? "unknown error"}` }] };
    const result = reply.result as { content?: unknown[] } | null;
    if (result && Array.isArray(result.content)) return result as any;
    return { content: [{ type: "text" as const, text: typeof reply.result === "string" ? reply.result : JSON.stringify(reply.result) }] };
  });

  return server;
}

/**
 * Stateless MCP endpoint. A fresh server per request keeps the Worker simple
 * and avoids session state. OAuthProvider has already verified the token.
 */
export const McpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: AuthProps }): Promise<Response> {
    const props = ctx.props;
    if (!props || props.login !== env.ALLOWED_GITHUB_LOGIN) {
      return new Response("forbidden", { status: 403 });
    }
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    let server: { connect(t: WebStandardStreamableHTTPServerTransport): Promise<void> };
    if (path === "/mcp") {
      server = buildServer(env);
    } else {
      const bridge = path.slice("/mcp/".length);
      if (!BRIDGE_NAME.test(bridge)) return new Response("not found", { status: 404 });
      server = buildBridgeServer(env, bridge);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
