import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { embeddedConfig, loadConfig, type EmbeddedConfig } from "../config.js";
import { auditPath, dcHome, logPath } from "../home.js";
import { instanceAddress, isInstanceRunning } from "../instance.js";
import { resolveConfig, type PolicyConfig } from "../policy.js";

/** Everything OS-specific the installer needs. Real implementations: windows.ts, macos.ts. */
export interface PlatformOps {
  stopAgent(exe: string): Promise<void>;
  copySelf(dest: string): Promise<void>;
  restrictFile(file: string): Promise<void>;
  registerAutostart(exe: string): Promise<void>;
  unregisterAutostart(): Promise<void>;
  registerUninstallEntry(exe: string, icon: string): Promise<void>;
  removeUninstallEntry(): Promise<void>;
  startHidden(exe: string): Promise<void>;
  /** Resolves true once the freshly started agent is running (gives it a few seconds). */
  agentStarted(): Promise<boolean>;
  /** Asks the owner to paste the device token (public builds carry none). Null if cancelled. */
  promptToken(): Promise<string | null>;
  removeFile(file: string): Promise<void>;
  notify(title: string, text: string, kind: "info" | "error"): Promise<void>;
}

export interface InstallOptions {
  /** The executable being run (copy source). Defaults to process.execPath. */
  exe?: string;
  /** Build config; defaults to the one embedded in the SEA binary. */
  embedded?: EmbeddedConfig | null;
  /** Files to place next to the config, e.g. `icon.ico`. */
  assets?: Record<string, Buffer>;
}

export interface InstallResult {
  ok: boolean;
  configWritten: boolean;
  tokenKept: boolean;
  error?: string;
}

const TITLE = "dc-custom";
const MIN_TOKEN = 32;
const isWin = process.platform === "win32";

/** Windows: a single exe next to the config. macOS: the whole app bundle in ~/Applications (keeps its signature and privacy grants). */
export function installedExePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return path.join(os.homedir(), "Applications", "dc-custom.app", "Contents", "MacOS", "dc-custom");
  return path.join(dcHome(), platform === "win32" ? "dc-custom.exe" : "dc-custom");
}

const configFile = () => path.join(dcHome(), "config.json");
const iconFileName = () => (isWin ? "icon.ico" : "icon.icns");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function existingToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8").replace(/^﻿/, ""));
    return typeof raw.deviceToken === "string" && raw.deviceToken.length >= MIN_TOKEN ? raw.deviceToken : null;
  } catch {
    return null;
  }
}

const sameFile = (a: string, b: string) => (isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export async function install(ops: PlatformOps, opts: InstallOptions = {}): Promise<InstallResult> {
  const embedded = opts.embedded === undefined ? embeddedConfig() : opts.embedded;
  const source = opts.exe ?? process.execPath;
  const dest = installedExePath();
  const home = dcHome();
  const keepToken = existingToken() !== null;

  const fail = async (error: string, tokenKept = keepToken): Promise<InstallResult> => {
    await ops.notify(TITLE, error, "error");
    return { ok: false, configWritten: false, tokenKept, error };
  };

  // Decide and validate the config before touching a working install.
  let newConfig: { relayUrl: string; deviceToken: string; deviceId: string; policy: Partial<PolicyConfig> } | null = null;
  if (!keepToken) {
    if (!embedded?.relayUrl) return fail("This installer has no relay address. Rebuild it with DC_RELAY_URL.", false);
    // A private build embeds the token; a public build asks for it once (or reads DC_DEVICE_TOKEN for automation).
    const token = (embedded.deviceToken || process.env.DC_DEVICE_TOKEN || (await ops.promptToken()) || "").trim();
    if (token.length < MIN_TOKEN) {
      return fail(
        "No valid device token was given, so nothing was installed. Run the installer again and paste the token. " +
          "If no token window appeared, start the installer from your own desktop session, not from a sandboxed tool.",
        false,
      );
    }
    newConfig = {
      relayUrl: embedded.relayUrl,
      deviceToken: token,
      deviceId: embedded.deviceId || os.hostname(),
      policy: embedded.policy ?? { profile: "readonly" },
    };
  }
  try {
    if (newConfig) resolveConfig(newConfig.policy, auditPath());
    else loadConfig(configFile(), embedded);
  } catch (err) {
    return fail(`The agent would not start with this configuration: ${message(err)}`);
  }

  let configWritten = false;
  try {
    mkdirSync(home, { recursive: true });
    await ops.stopAgent(dest); // a running exe is locked on Windows, so stop it before replacing it
    if (!sameFile(source, dest)) await ops.copySelf(dest);

    for (const [name, data] of Object.entries(opts.assets ?? {})) writeFileSync(path.join(home, name), data);

    if (newConfig) {
      writeFileSync(configFile(), JSON.stringify(newConfig, null, 2), { mode: 0o600 });
      configWritten = true;
      await ops.restrictFile(configFile());
    }

    await ops.registerAutostart(dest);
    await ops.registerUninstallEntry(dest, path.join(home, iconFileName()));
    await ops.startHidden(dest);
  } catch (err) {
    // A config this run wrote but could not finish (e.g. not locked down) is removed, so the next run starts clean.
    if (configWritten) rmSync(configFile(), { force: true });
    return fail(`Install failed: ${message(err)}`);
  }

  if (!(await ops.agentStarted())) {
    await ops.notify(TITLE, `dc-custom was installed but the agent did not start. Details are in ${logPath()}`, "error");
    return { ok: false, configWritten, tokenKept: keepToken, error: "agent did not start" };
  }
  await ops.notify(TITLE, "dc-custom is installed and running in the background.", "info");
  return { ok: true, configWritten, tokenKept: keepToken };
}

export async function uninstall(ops: PlatformOps, opts: { purge?: boolean } = {}): Promise<void> {
  const dest = installedExePath();
  await ops.stopAgent(dest);
  await ops.unregisterAutostart();
  await ops.removeUninstallEntry();
  const home = dcHome();
  const files = [path.join(home, "config.json"), path.join(home, "icon.ico"), path.join(home, "icon.icns"), logPath(), logPath() + ".1"];
  if (opts.purge) files.push(auditPath());
  for (const f of files) rmSync(f, { force: true });
  await ops.removeFile(dest);
}

export async function status(): Promise<{ installed: boolean; running: boolean }> {
  return {
    installed: existsSync(installedExePath()) && existsSync(configFile()),
    running: await isInstanceRunning(instanceAddress()),
  };
}

/** Polls for the agent's single-instance address for up to `seconds`. */
export async function waitForAgent(seconds = 8): Promise<boolean> {
  for (let i = 0; i < seconds * 4; i++) {
    if (await isInstanceRunning(instanceAddress())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
