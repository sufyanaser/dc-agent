import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultShell, resolveShell } from "../src/exec.js";

test("default shell is PowerShell on Windows and sh elsewhere", () => {
  assert.equal(defaultShell("win32"), "powershell");
  assert.equal(defaultShell("darwin"), "sh");
  assert.equal(defaultShell("linux"), "sh");
});

test("resolveShell keeps a valid request and rejects a shell the OS does not have", () => {
  assert.equal(resolveShell(undefined, "win32"), "powershell");
  assert.equal(resolveShell("cmd", "win32"), "cmd");
  assert.equal(resolveShell(undefined, "darwin"), "sh");
  assert.throws(() => resolveShell("powershell", "darwin"), /not available on darwin/);
  assert.throws(() => resolveShell("sh", "win32"), /not available on win32/);
});
