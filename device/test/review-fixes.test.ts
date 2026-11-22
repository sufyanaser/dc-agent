import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Approver, type DialogRunner } from "../src/approval.js";
import { parseWhoamiSid } from "../src/installer/windows.js";
import { installedExePath } from "../src/installer/install.js";
import { launchAgentPlist } from "../src/installer/macos.js";

const req = { tool: "fs_write", summary: "x" };

test("approvals never outlive the relay: timeout is clamped below the relay's 90s call timeout", async () => {
  let seen = -1;
  const runner: DialogRunner = async (_r, t) => ((seen = t), true);
  await new Approver("dialog", 120, runner).request(req);
  assert.ok(seen > 0 && seen <= 80, `dialog timeout ${seen}s is not clamped`);
});

test("a queued approval whose deadline passed while waiting is denied without a dialog", async () => {
  let calls = 0;
  const runner: DialogRunner = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  };
  const a = new Approver("dialog", 120, runner, 1); // max wait 1s from arrival
  const [first, second] = await Promise.all([a.request(req), a.request(req)]);
  assert.equal(first, false, "first dialog exceeded its 1s deadline");
  assert.equal(second, false);
  assert.equal(calls, 1, "the expired second request must not open a dialog");
});

test("parseWhoamiSid reads the SID from whoami /user /fo csv /nh, whatever the account name", () => {
  const out = '"خادم\\مستخدم","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n';
  assert.equal(parseWhoamiSid(out), "S-1-5-21-1111111111-2222222222-3333333333-1001");
  assert.equal(parseWhoamiSid("garbage"), null);
});

test("macOS installs the whole app bundle under ~/Applications", () => {
  assert.equal(installedExePath("darwin"), path.join(os.homedir(), "Applications", "dc-custom.app", "Contents", "MacOS", "dc-custom"));
});

test("LaunchAgent restarts only after a crash, not after a clean exit (no restart loop on config errors)", () => {
  const xml = launchAgentPlist("/x/dc-custom", "/x/agent.log");
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
});
