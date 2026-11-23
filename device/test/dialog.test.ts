import { test } from "node:test";
import assert from "node:assert/strict";
import { runDialog } from "../src/dialog.js";

// A window that can never be seen (for example, an installer started from a sandboxed agent)
// must not hold the installer forever: the dialog process is killed after the timeout.
test("runDialog kills a dialog that never answers and reports the timeout", async () => {
  const started = Date.now();
  const r = await runDialog(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], process.env, 300);
  assert.equal(r.timedOut, true);
  assert.equal(r.code === 0, false, "a killed dialog is never an answer");
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("runDialog returns the exit code and output of a dialog that answers", async () => {
  const r = await runDialog(process.execPath, ["-e", "process.stdout.write('abc')"], process.env, 10_000);
  assert.deepEqual(r, { code: 0, out: "abc", timedOut: false });
});

test("runDialog resolves when the dialog program does not exist", async () => {
  const r = await runDialog("dc-custom-no-such-program-xyz", [], process.env, 10_000);
  assert.equal(r.code, null);
  assert.equal(r.timedOut, false);
});
