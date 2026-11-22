import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkCommand, checkPath, resolveConfig, categoryAllowed, needsApproval, defaultsFor } from "../src/policy.js";

const root = path.resolve("C:/Work/Projects");

test("scoped: path inside allowed root is ok", () => {
  const cfg = resolveConfig({ profile: "scoped", allowedRoots: [root] }, "x.jsonl");
  const d = checkPath(cfg, path.join(root, "app", "main.ts"), "read");
  assert.equal(d.ok, true);
});

test("scoped: sibling prefix is NOT inside root", () => {
  const cfg = resolveConfig({ profile: "scoped", allowedRoots: [root] }, "x.jsonl");
  const d = checkPath(cfg, root + "Evil\\file.txt", "read");
  assert.equal(d.ok, false);
});

test("scoped: deny pattern blocks .env and keys", () => {
  const cfg = resolveConfig({ profile: "scoped", allowedRoots: [root] }, "x.jsonl");
  assert.equal(checkPath(cfg, path.join(root, ".env"), "read").ok, false);
  assert.equal(checkPath(cfg, path.join(root, "keys", "server.pem"), "read").ok, false);
});

test("readonly: blocks write, move, delete, exec, kill", () => {
  assert.equal(categoryAllowed("readonly", "read"), true);
  for (const c of ["write", "move", "delete", "exec", "kill"] as const) {
    assert.equal(categoryAllowed("readonly", c), false, c);
  }
});

test("full: ignores allowedRoots and allows anywhere", () => {
  const cfg = resolveConfig({ profile: "full" }, "x.jsonl");
  assert.equal(checkPath(cfg, path.resolve("D:/anything/at/all.txt"), "write").ok, true);
});

test("delete refuses filesystem root in every profile", () => {
  const cfg = resolveConfig({ profile: "full" }, "x.jsonl");
  const driveRoot = path.parse(process.cwd()).root;
  assert.equal(checkPath(cfg, driveRoot, "delete").ok, false);
});

test("approval defaults: scoped requires approval for writes and exec, full does not", () => {
  const scoped = resolveConfig({ profile: "scoped", allowedRoots: [root] }, "x.jsonl");
  const full = resolveConfig({ profile: "full" }, "x.jsonl");
  assert.equal(needsApproval(scoped, "write"), true);
  assert.equal(needsApproval(scoped, "read"), false);
  assert.equal(needsApproval(full, "delete"), false);
});

test("allowlist blocks unknown command and chained commands", () => {
  const cfg = resolveConfig({ profile: "scoped", allowedRoots: [root] }, "x.jsonl");
  assert.equal(checkCommand(cfg, "git status").ok, true);
  assert.equal(checkCommand(cfg, "rm -rf /").ok, false);
  assert.equal(checkCommand(cfg, "git status && del x").ok, false);
});

test("full allows any command", () => {
  const cfg = resolveConfig({ profile: "full" }, "x.jsonl");
  assert.equal(checkCommand(cfg, "anything --at-all").ok, true);
});

test("invalid profile and invalid regex are rejected", () => {
  assert.throws(() => resolveConfig({ profile: "god" as any }, "x"));
  assert.throws(() => resolveConfig({ profile: "full", denyPatterns: ["([bad"] }, "x"));
});

test("scoped without allowedRoots is rejected", () => {
  assert.throws(() => resolveConfig({ profile: "scoped", allowedRoots: [] }, "x"));
});

test("macOS readonly allowlist uses unix commands, not PowerShell ones", () => {
  const list = defaultsFor("readonly", "darwin").commandAllowlist;
  for (const c of ["ls", "cat", "pwd", "whoami"]) assert.ok(list.includes(c), `missing ${c}`);
  assert.ok(!list.includes("Get-ChildItem"));
});

test("macOS scoped allowlist includes dev tools, Windows scoped is unchanged", () => {
  const mac = defaultsFor("scoped", "darwin").commandAllowlist;
  for (const c of ["git", "npm", "python3", "ls"]) assert.ok(mac.includes(c), `missing ${c}`);
  assert.ok(defaultsFor("scoped", "win32").commandAllowlist.includes("Get-ChildItem"));
});

test("approvalMode dialog is a valid mode", () => {
  const cfg = resolveConfig({ profile: "full", approvalMode: "dialog" }, "x.jsonl");
  assert.equal(cfg.approvalMode, "dialog");
});
