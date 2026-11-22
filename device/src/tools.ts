import { randomBytes } from "node:crypto";

import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveShell, runCommand } from "./exec.js";
import { checkPath, type Category, type PolicyConfig } from "./policy.js";

export interface ToolContext {
  cfg: PolicyConfig;
}

export interface ToolDef {
  name: string;
  category: Category;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Argument names that hold filesystem paths to be checked by policy. */
  pathArgs?: string[];
  summarize: (args: Record<string, any>) => string;
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const int = (description: string) => ({ type: "integer", description });

async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.dc-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function walk(root: string, visit: (file: string) => Promise<boolean | void>, maxFiles: number): Promise<void> {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (++seen > maxFiles) return;
        if ((await visit(full)) === false) return;
      }
    }
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: "fs_list",
    category: "read",
    description: "List entries in a directory. Set recursive=true for a tree walk.",
    inputSchema: obj({ path: str("Directory path"), recursive: bool("Walk subdirectories"), maxEntries: int("Max entries, default 500") }, ["path"]),
    pathArgs: ["path"],
    summarize: (a) => `list ${a.path}`,
    run: async (a) => {
      const max = a.maxEntries ?? 500;
      const out: { path: string; type: string; size?: number }[] = [];
      const base = path.resolve(a.path);
      const stack = [base];
      while (stack.length && out.length < max) {
        const dir = stack.shift()!;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (out.length >= max) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            out.push({ path: full, type: "dir" });
            if (a.recursive) stack.push(full);
          } else {
            const s = await stat(full).catch(() => null);
            out.push({ path: full, type: "file", size: s?.size });
          }
        }
      }
      return { count: out.length, truncated: out.length >= max, entries: out };
    },
  },
  {
    name: "fs_stat",
    category: "read",
    description: "Return metadata for a file or directory.",
    inputSchema: obj({ path: str("Path") }, ["path"]),
    pathArgs: ["path"],
    summarize: (a) => `stat ${a.path}`,
    run: async (a) => {
      const s = await stat(path.resolve(a.path));
      return { path: path.resolve(a.path), type: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() };
    },
  },
  {
    name: "fs_read",
    category: "read",
    description: "Read a text file (utf8) or a binary file (base64). Limited by maxBytes.",
    inputSchema: obj({ path: str("File path"), encoding: { enum: ["utf8", "base64"] }, maxBytes: int("Default 5000000") }, ["path"]),
    pathArgs: ["path"],
    summarize: (a) => `read ${a.path}`,
    run: async (a, ctx) => {
      const p = path.resolve(a.path);
      const s = await stat(p);
      const limit = a.maxBytes ?? 5_000_000;
      if (s.size > limit) throw new Error(`file is ${s.size} bytes, above maxBytes ${limit}`);
      const buf = await readFile(p);
      if (a.encoding === "base64" || (!a.encoding && looksBinary(buf))) {
        return { path: p, encoding: "base64", data: buf.toString("base64") };
      }
      return { path: p, encoding: "utf8", data: buf.toString("utf8") };
    },
  },
  {
    name: "fs_write",
    category: "write",
    description: "Write a file atomically (overwrite) or append to it.",
    inputSchema: obj({ path: str("File path"), content: str("Content"), append: bool("Append instead of overwrite"), createDirs: bool("Create parent dirs") }, ["path", "content"]),
    pathArgs: ["path"],
    summarize: (a) => `${a.append ? "append" : "write"} ${a.path} (${String(a.content).length} chars)`,
    run: async (a) => {
      const p = path.resolve(a.path);
      if (a.createDirs) await mkdir(path.dirname(p), { recursive: true });
      if (a.append) await appendFile(p, a.content, "utf8");
      else await atomicWrite(p, a.content);
      return { path: p, bytes: Buffer.byteLength(a.content, "utf8"), mode: a.append ? "append" : "overwrite" };
    },
  },
  {
    name: "fs_edit",
    category: "write",
    description: "Replace exactly one occurrence of oldText with newText in a text file.",
    inputSchema: obj({ path: str("File path"), oldText: str("Exact text to find"), newText: str("Replacement") }, ["path", "oldText", "newText"]),
    pathArgs: ["path"],
    summarize: (a) => `edit ${a.path}`,
    run: async (a) => {
      const p = path.resolve(a.path);
      const text = await readFile(p, "utf8");
      const count = text.split(a.oldText).length - 1;
      if (count !== 1) throw new Error(`oldText must match exactly once, found ${count}`);
      await atomicWrite(p, text.replace(a.oldText, () => a.newText));
      return { path: p, replaced: 1 };
    },
  },
  {
    name: "fs_move",
    category: "move",
    description: "Move or rename a file or directory.",
    inputSchema: obj({ from: str("Source"), to: str("Destination") }, ["from", "to"]),
    pathArgs: ["from", "to"],
    summarize: (a) => `move ${a.from} -> ${a.to}`,
    run: async (a) => {
      const from = path.resolve(a.from);
      const to = path.resolve(a.to);
      try {
        await rename(from, to);
      } catch (err: any) {
        if (err.code !== "EXDEV") throw err;
        await cp(from, to, { recursive: true });
        await rm(from, { recursive: true });
      }
      return { from, to };
    },
  },
  {
    name: "fs_delete",
    category: "delete",
    description: "Delete a file, or a directory with recursive=true. Filesystem roots and the home folder are refused.",
    inputSchema: obj({ path: str("Path"), recursive: bool("Required for directories") }, ["path"]),
    pathArgs: ["path"],
    summarize: (a) => `delete ${a.path}${a.recursive ? " (recursive)" : ""}`,
    run: async (a) => {
      const p = path.resolve(a.path);
      await rm(p, { recursive: !!a.recursive, force: false });
      return { deleted: p };
    },
  },
  {
    name: "fs_search",
    category: "read",
    description: "Search text files under a folder for a substring or regex. Skips node_modules, .git, and binary or large files.",
    inputSchema: obj({
      path: str("Root folder"),
      pattern: str("Substring or regex"),
      regex: bool("Treat pattern as regex"),
      maxResults: int("Default 200"),
      maxFiles: int("Default 20000"),
    }, ["path", "pattern"]),
    pathArgs: ["path"],
    summarize: (a) => `search "${a.pattern}" in ${a.path}`,
    run: async (a, ctx) => {
      const root = path.resolve(a.path);
      const re = a.regex ? new RegExp(a.pattern, "i") : null;
      const hits: { file: string; line: number; text: string }[] = [];
      const max = a.maxResults ?? 200;
      await walk(root, async (file) => {
        if (!checkPath(ctx.cfg, file, "read").ok) return;
        const s = await stat(file).catch(() => null);
        if (!s || s.size > 2_000_000) return;
        const buf = await readFile(file);
        if (looksBinary(buf)) return;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(String(a.pattern).toLowerCase());
          if (hit) {
            hits.push({ file, line: i + 1, text: lines[i].slice(0, 300) });
            if (hits.length >= max) return false;
          }
        }
      }, a.maxFiles ?? 20000);
      return { count: hits.length, hits };
    },
  },
  {
    name: "exec",
    category: "exec",
    description: "Run a command (PowerShell or cmd on Windows, sh on macOS). Returns exit code, stdout and stderr.",
    inputSchema: obj({
      command: str("Command text"),
      cwd: str("Working directory"),
      shell: { enum: ["powershell", "cmd", "sh"] },
      timeoutMs: int("Default 120000"),
    }, ["command"]),
    pathArgs: ["cwd"],
    summarize: (a) => `exec: ${String(a.command).slice(0, 200)}`,
    run: async (a, ctx) => {
      const r = await runCommand({
        command: a.command,
        cwd: a.cwd ? path.resolve(a.cwd) : undefined,
        shell: resolveShell(a.shell),
        timeoutMs: a.timeoutMs ?? 120_000,
        maxOutputBytes: ctx.cfg.maxOutputBytes,
      });
      return r;
    },
  },
  {
    name: "proc_list",
    category: "read",
    description: "List running processes with id, name, and memory.",
    inputSchema: obj({}),
    summarize: () => "list processes",
    run: async () => {
      if (process.platform === "win32") {
        const r = await runCommand({
          command: "Get-Process | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress",
          shell: "powershell", timeoutMs: 30_000, maxOutputBytes: 5_000_000,
        });
        return r.stdout ? JSON.parse(r.stdout) : [];
      }
      const r = await runCommand({ command: "ps -eo pid,comm,rss", timeoutMs: 30_000, maxOutputBytes: 5_000_000 });
      return r.stdout;
    },
  },
  {
    name: "proc_kill",
    category: "kill",
    description: "Terminate a process by id.",
    inputSchema: obj({ pid: int("Process id") }, ["pid"]),
    summarize: (a) => `kill pid ${a.pid}`,
    run: async (a) => {
      const pid = Number(a.pid);
      if (!Number.isInteger(pid) || pid <= 4) throw new Error("refusing to kill system pid");
      if (process.platform === "win32") {
        const r = await runCommand({ command: `taskkill /PID ${pid} /F`, shell: "cmd", timeoutMs: 15_000, maxOutputBytes: 10_000 });
        if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout);
      } else {
        process.kill(pid, "SIGTERM");
      }
      return { killed: pid };
    },
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

