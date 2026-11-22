import type { DeviceHub } from "./device-hub.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  DEVICE_TOKEN: string;
  ALLOWED_GITHUB_LOGIN: string;
  PUBLIC_ORIGIN: string;
}
