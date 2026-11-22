import { getRawAsset } from "node:sea";
import { install, status, uninstall, type PlatformOps } from "./install.js";
import { macosOps } from "./macos.js";
import { windowsOps } from "./windows.js";

function opsForPlatform(): PlatformOps | null {
  if (process.platform === "win32") return windowsOps();
  if (process.platform === "darwin") return macosOps();
  return null;
}

/** Icons embedded in the build, written next to the config so dialogs and the uninstall entry can use them. */
function embeddedAssets(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const name of ["icon.ico", "icon.icns"]) {
    try {
      out[name] = Buffer.from(getRawAsset(name));
    } catch {
      /* this build has no such asset */
    }
  }
  return out;
}

const print = (text: string) => {
  try {
    process.stdout.write(text + "\n");
  } catch {
    /* windowless: no stdout */
  }
};

/** Runs the installer-side modes. Returns the process exit code. */
export async function runInstallerMode(mode: "install" | "uninstall" | "status", argv: string[]): Promise<number> {
  const ops = opsForPlatform();
  if (!ops) {
    print(`dc-custom installer does not support ${process.platform}`);
    return 1;
  }
  if (mode === "install") return (await install(ops, { assets: embeddedAssets() })).ok ? 0 : 1;
  if (mode === "uninstall") {
    await uninstall(ops, { purge: argv.includes("--purge") });
    await ops.notify("dc-custom", "dc-custom was removed from this computer.", "info");
    return 0;
  }
  const s = await status();
  const text = `Installed: ${s.installed ? "yes" : "no"}. Running: ${s.running ? "yes" : "no"}.`;
  print(text);
  await ops.notify("dc-custom", text, "info");
  return 0;
}
