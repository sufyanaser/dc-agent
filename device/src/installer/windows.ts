import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { showNotice, showTokenPrompt } from "../dialog.js";
import { waitForAgent, type PlatformOps } from "./install.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dc-custom";
import { VERSION } from "../version.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve({ code: null, out }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const regAdd = (key: string, name: string, type: "REG_SZ" | "REG_DWORD", data: string) =>
  run("reg.exe", ["add", key, "/v", name, "/t", type, "/d", data, "/f"]);

/** Extracts the SID from `whoami /user /fo csv /nh` output. The SID is ASCII whatever the account name is. */
export function parseWhoamiSid(out: string): string | null {
  return out.match(/"(S-1-[\d-]+)"/)?.[1] ?? null;
}

// The pre-installer agent (scripts\run.ps1) ran as `node ...\dc-custom\device\dist\src\index.js`; it would
// fight the new agent for the same device name, so it is stopped too.
const STOP_LEGACY_AGENT =
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*\\dc-custom\\device\\dist\\src\\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";

export function windowsOps(): PlatformOps {
  return {
    async stopAgent(exe) {
      // By image name, never our own pid, so running the installer from the installed copy is safe.
      await run("taskkill.exe", ["/F", "/IM", path.basename(exe), "/FI", `PID ne ${process.pid}`]);
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", STOP_LEGACY_AGENT]);
      await sleep(600); // let Windows release the file handle
    },
    agentStarted: () => waitForAgent(),
    promptToken: async () => (process.env.DC_NO_UI === "1" ? null : showTokenPrompt()),
    async copySelf(dest) {
      mkdirSync(path.dirname(dest), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try {
          copyFileSync(process.execPath, dest);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (attempt >= 10 || (code !== "EBUSY" && code !== "EPERM")) throw err;
          await sleep(300);
        }
      }
    },
    async restrictFile(file) {
      // Grant by SID: an account name with non-ASCII letters is garbled through the console code page.
      const sid = parseWhoamiSid((await run("whoami.exe", ["/user", "/fo", "csv", "/nh"])).out);
      if (!sid) throw new Error("Could not read the current user's SID (whoami /user).");
      const r = await run("icacls.exe", [file, "/inheritance:r", "/grant:r", `*${sid}:(R,W)`]);
      if (r.code !== 0) throw new Error(`Could not restrict permissions on ${file} (icacls exit ${r.code}); it holds the device token.`);
    },
    async registerAutostart(exe) {
      const r = await regAdd(RUN_KEY, "dc-custom", "REG_SZ", `"${exe}" --run`);
      if (r.code !== 0) throw new Error("Could not register autostart (reg add failed)");
    },
    async unregisterAutostart() {
      await run("reg.exe", ["delete", RUN_KEY, "/v", "dc-custom", "/f"]);
    },
    async registerUninstallEntry(exe, icon) {
      await regAdd(UNINSTALL_KEY, "DisplayName", "REG_SZ", "dc-custom");
      await regAdd(UNINSTALL_KEY, "DisplayIcon", "REG_SZ", existsSync(icon) ? icon : `${exe},0`);
      await regAdd(UNINSTALL_KEY, "DisplayVersion", "REG_SZ", VERSION);
      await regAdd(UNINSTALL_KEY, "Publisher", "REG_SZ", "dc-custom");
      await regAdd(UNINSTALL_KEY, "InstallLocation", "REG_SZ", path.dirname(exe));
      await regAdd(UNINSTALL_KEY, "UninstallString", "REG_SZ", `"${exe}" --uninstall`);
      await regAdd(UNINSTALL_KEY, "NoModify", "REG_DWORD", "1");
      await regAdd(UNINSTALL_KEY, "NoRepair", "REG_DWORD", "1");
    },
    async removeUninstallEntry() {
      await run("reg.exe", ["delete", UNINSTALL_KEY, "/f"]);
    },
    async startHidden(exe) {
      spawn(exe, ["--run"], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    },
    async removeFile(file) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Our own exe is locked while we run: delete it a moment after we exit. The path goes through an env var,
        // not the command line. cmd, not PowerShell: a detached PowerShell never starts from a windowless parent.
        const child = spawn("cmd.exe", ["/d", "/s", "/c", '"ping -n 4 127.0.0.1 >nul & del /f /q "%DC_DELETE%""'], {
          detached: true, windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true, env: { ...process.env, DC_DELETE: file },
        });
        child.on("error", () => undefined);
        child.unref();
      }
    },
    async notify(title, text, kind) {
      if (process.env.DC_NO_UI === "1") return;
      await showNotice(title, text, kind);
    },
  };
}
