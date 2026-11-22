import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import { isSea, getAsset } from "node:sea";
import { resolveBridges, type BridgeConfig } from "./bridges.js";
import { auditPath, configPath } from "./home.js";
import { resolveConfig, type PolicyConfig, type Profile } from "./policy.js";

export interface DeviceConfig {
  relayUrl: string;
  deviceToken: string;
  deviceId: string;
  policy: PolicyConfig;
  bridges: Record<string, BridgeConfig>;
}

/** Values baked into a built installer (SEA asset `build-config.json`). */
export interface EmbeddedConfig {
  relayUrl?: string;
  deviceToken?: string;
  deviceId?: string;
  policy?: Partial<PolicyConfig> & { profile?: Profile };
  bridges?: Record<string, BridgeConfig>;
}

// Kept so older imports keep working.
export const defaultConfigPath = configPath;
export const defaultAuditPath = auditPath;

export function embeddedConfig(): EmbeddedConfig | null {
  try {
    if (!isSea()) return null;
    return JSON.parse(getAsset("build-config.json", "utf8")) as EmbeddedConfig;
  } catch {
    return null;
  }
}

/** Precedence: environment > config file > embedded build config. */
export function loadConfig(file = configPath(), embedded: EmbeddedConfig | null = embeddedConfig()): DeviceConfig {
  let raw: Record<string, any> = {};
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } else if (!embedded) {
    throw new Error(`config not found: ${file} (run the dc-custom installer first)`);
  }
  const relayUrl = process.env.DC_RELAY_URL || raw.relayUrl || embedded?.relayUrl;
  const deviceToken = process.env.DC_DEVICE_TOKEN || raw.deviceToken || embedded?.deviceToken;
  if (!relayUrl || !/^wss?:\/\//.test(relayUrl)) throw new Error("relayUrl must start with wss:// (or ws:// for local tests)");
  if (!deviceToken || deviceToken.length < 32) throw new Error("deviceToken missing or too short (set DC_DEVICE_TOKEN)");
  const policy = resolveConfig(raw.policy ?? embedded?.policy ?? { profile: "scoped" }, auditPath());
  const bridges = resolveBridges(raw.bridges, embedded?.bridges);
  return { relayUrl, deviceToken, deviceId: raw.deviceId || embedded?.deviceId || os.hostname(), policy, bridges };
}
