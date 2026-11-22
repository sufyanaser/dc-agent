import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { showNotice, showTokenPrompt } from "../dialog.js";
import { logPath } from "../home.js";
import { waitForAgent, type PlatformOps } from "./install.js";

export const LAUNCH_AGENT_LABEL = "com.dc-custom.agent";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchAgentPlist(exe: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exe)}</string>
    <string>--run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

const plistFile = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function run(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

export function macosOps(): PlatformOps {
  return {
    async stopAgent() {
      await run("launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]); // fails harmlessly when not loaded
    },
    async copySelf(dest) {
      // Copy the whole signed .app, so the code signature and macOS privacy grants stay attached to one bundle.
      const bundleOf = (exe: string) => (/\.app\/Contents\/MacOS\/[^/]+$/.test(exe) ? path.resolve(exe, "..", "..", "..") : null);
      const srcApp = bundleOf(process.execPath);
      const destApp = bundleOf(dest)!;
      rmSync(destApp, { recursive: true, force: true });
      mkdirSync(path.dirname(destApp), { recursive: true });
      if (srcApp) {
        await run("ditto", [srcApp, destApp]);
      } else {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(process.execPath, dest);
        chmodSync(dest, 0o755);
        await run("codesign", ["--force", "--sign", "-", dest]);
      }
      await run("xattr", ["-cr", destApp]); // no quarantine flag, or launchd cannot start it in the background
    },
    agentStarted: () => waitForAgent(),
    promptToken: async () => (process.env.DC_NO_UI === "1" ? null : showTokenPrompt()),
    async restrictFile(file) {
      chmodSync(file, 0o600);
    },
    async registerAutostart(exe) {
      mkdirSync(path.dirname(plistFile()), { recursive: true });
      mkdirSync(path.dirname(logPath()), { recursive: true }); // launchd does not create the StandardErrorPath folder
      writeFileSync(plistFile(), launchAgentPlist(exe, logPath()));
      await run("launchctl", ["bootstrap", domain(), plistFile()]);
    },
    async unregisterAutostart() {
      await run("launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
      rmSync(plistFile(), { force: true });
    },
    async registerUninstallEntry() {
      /* macOS has no Apps & features list for this */
    },
    async removeUninstallEntry() {
      /* nothing registered */
    },
    async startHidden() {
      await run("launchctl", ["kickstart", "-k", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
    },
    async removeFile(file) {
      const app = /\.app\/Contents\/MacOS\/[^/]+$/.test(file) ? path.resolve(file, "..", "..", "..") : file;
      rmSync(app, { recursive: true, force: true });
    },
    async notify(title, text, kind) {
      if (process.env.DC_NO_UI === "1") return;
      await showNotice(title, text, kind);
    },
  };
}
