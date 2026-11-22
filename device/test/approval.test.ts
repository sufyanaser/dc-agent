import { test } from "node:test";
import assert from "node:assert/strict";
import { Approver, type DialogRunner } from "../src/approval.js";

const req = { tool: "fs_write", summary: "write C:\\x.txt" };

test("dialog mode returns the dialog's answer", async () => {
  const yes: DialogRunner = async () => true;
  const no: DialogRunner = async () => false;
  assert.equal(await new Approver("dialog", 5, yes).request(req), true);
  assert.equal(await new Approver("dialog", 5, no).request(req), false);
});

test("dialog mode shows one dialog at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const runner: DialogRunner = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return true;
  };
  const a = new Approver("dialog", 5, runner);
  const results = await Promise.all([a.request(req), a.request(req), a.request(req)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(maxActive, 1);
});

test("a hung dialog is denied at the timeout, aborted, and does not block the next request", async () => {
  let aborted = false;
  let calls = 0;
  const runner: DialogRunner = (_req, _t, signal) => {
    calls++;
    if (calls === 1) {
      signal?.addEventListener("abort", () => (aborted = true));
      return new Promise<boolean>(() => {}); // never answers
    }
    return Promise.resolve(true);
  };
  const a = new Approver("dialog", 1, runner);
  const started = Date.now();
  assert.equal(await a.request(req), false);
  assert.ok(Date.now() - started < 2500, "timeout took too long");
  assert.equal(aborted, true);
  assert.equal(await a.request(req), true);
});

test("a dialog that throws counts as denied", async () => {
  const runner: DialogRunner = async () => {
    throw new Error("powershell not found");
  };
  assert.equal(await new Approver("dialog", 5, runner).request(req), false);
});

test("deny mode never opens a dialog", async () => {
  let called = false;
  const runner: DialogRunner = async () => ((called = true), true);
  assert.equal(await new Approver("deny", 5, runner).request(req), false);
  assert.equal(called, false);
});
