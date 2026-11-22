/** A tool of a bridged MCP server on the device (e.g. Figwright), with its JSON schema. */
export interface BridgeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; [k: string]: unknown };
  annotations?: Record<string, unknown>;
}

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  version: string;
  profile: string;
  tools: string[];
  /** Running bridges and their tools. Stored separately from the hello (it can be a few hundred KB). */
  bridges?: Record<string, BridgeTool[]>;
}

export interface DeviceInfo {
  deviceId: string;
  online: boolean;
  profile: string;
  version: string;
  tools: string[];
  /** Bridge name -> number of tools it exposes. */
  bridges: Record<string, number>;
}

export interface ResultMessage {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CallMessage {
  type: "call";
  id: string;
  tool: string;
  args: unknown;
  bridge?: string;
}

export interface DeviceReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const CALL_TIMEOUT_MS = 90_000;
export const MAX_ARGS_BYTES = 2_000_000;
