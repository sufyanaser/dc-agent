import { spawn } from "node:child_process";

export type Shell = "powershell" | "cmd" | "sh";

export function defaultShell(platform: NodeJS.Platform = process.platform): Shell {
  return platform === "win32" ? "powershell" : "sh";
}

/** Validates a requested shell against the OS; undefined picks the OS default. */
export function resolveShell(requested: string | undefined, platform: NodeJS.Platform = process.platform): Shell {
  const shell = (requested ?? defaultShell(platform)) as Shell;
  const ok = platform === "win32" ? shell === "powershell" || shell === "cmd" : shell === "sh";
  if (!ok) throw new Error(`shell "${shell}" is not available on ${platform}`);
  return shell;
}

export interface ExecOptions {
  command: string;
  cwd?: string;
  shell?: Shell;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function runCommand(opts: ExecOptions): Promise<ExecResult> {
  const isWin = process.platform === "win32";
  let file: string;
  let args: string[];
  if (isWin) {
    if (opts.shell === "cmd") {
      file = "cmd.exe";
      args = ["/d", "/s", "/c", opts.command];
    } else {
      file = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", opts.command];
    }
  } else {
    file = "/bin/sh";
    args = ["-c", opts.command];
  }

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      windowsHide: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (buf: Buffer, which: "out" | "err") => {
      bytes += buf.length;
      if (bytes > opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      if (which === "out") stdout += buf.toString("utf8");
      else stderr += buf.toString("utf8");
    };
    child.stdout.on("data", (b: Buffer) => collect(b, "out"));
    child.stderr.on("data", (b: Buffer) => collect(b, "err"));

    const killTree = () => {
      if (!child.pid) return;
      if (isWin) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr, truncated });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, stdout, stderr: stderr + String(err), truncated });
    });
  });
}
