import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Approver } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { dispatch } from "../src/dispatch.js";
import { resolveConfig } from "../src/policy.js";

async function setup(profile: "full" | "scoped" | "readonly", approvalMode: "console" | "deny" = "deny") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dc-test-"));
  const logFile = path.join(dir, "audit.jsonl");
  const cfg = resolveConfig({ profile, allowedRoots: [dir], approvalMode, auditLog: logFile }, logFile);
  const deps = { cfg, approver: new Approver(approvalMode, 1), audit: new AuditLog(logFile, true) };
  return { dir, logFile, deps };
}

test("read tool works in scoped profile without approval", async () => {
  const { dir, deps } = await setup("scoped");
  await writeFile(path.join(dir, "a.txt"), "hello");
  const r = await dispatch(deps, "fs_read", { path: path.join(dir, "a.txt") });
  assert.equal(r.ok, true);
  assert.equal((r as any).result.data, "hello");
});

test("write in scoped is rejected when approval mode is deny", async () => {
  const { dir, deps } = await setup("scoped", "deny");
  const r = await dispatch(deps, "fs_write", { path: path.join(dir, "b.txt"), content: "x" });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /Approval not granted/);
});

test("write in full profile succeeds without approval, atomically", async () => {
  const { dir, deps } = await setup("full");
  const target = path.join(dir, "c.txt");
  const r = await dispatch(deps, "fs_write", { path: target, content: "new" });
  assert.equal(r.ok, true);
  assert.equal(await readFile(target, "utf8"), "new");
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".dc-tmp-"));
  assert.equal(leftovers.length, 0);
});

test("edit requires exactly one match", async () => {
  const { dir, deps } = await setup("full");
  const f = path.join(dir, "e.txt");
  await writeFile(f, "foo foo");
  const r = await dispatch(deps, "fs_edit", { path: f, oldText: "foo", newText: "bar" });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /exactly once/);
});

test("readonly blocks write with clear reason", async () => {
  const { dir, deps } = await setup("readonly");
  const r = await dispatch(deps, "fs_write", { path: path.join(dir, "z.txt"), content: "x" });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /Blocked by profile/);
});

test("exec runs allowlisted command in scoped mode after approval (approve via stub)", async () => {
  const { dir, deps } = await setup("full");
  const r = await dispatch(deps, "exec", { command: process.platform === "win32" ? "Write-Output hi" : "echo hi", cwd: dir });
  assert.equal(r.ok, true);
  assert.match((r as any).result.stdout, /hi/);
});

test("audit log records allowed and denied decisions", async () => {
  const { dir, deps, logFile } = await setup("readonly");
  await dispatch(deps, "fs_read", { path: path.join(dir, "missing.txt") });
  await dispatch(deps, "fs_delete", { path: path.join(dir, "x") });
  const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.tool === "fs_delete" && l.decision === "denied"));
  assert.ok(lines.some((l) => l.tool === "fs_read"));
});

test("unknown tool and non-object args return errors", async () => {
  const { deps } = await setup("full");
  assert.equal((await dispatch(deps, "nope", {})).ok, false);
  assert.equal((await dispatch(deps, "fs_read", "bad" as any)).ok, false);
});
