import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/log.js";
import { approvalModeFor, parseMode } from "../src/cli.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "dc-rt-"));

test("logger appends timestamped lines and rotates at maxBytes", () => {
  const file = path.join(tmp(), "agent.log");
  const log = createLogger(file, 300);
  for (let i = 0; i < 30; i++) log(`line number ${i} with some padding text`);
  assert.ok(existsSync(file + ".1"), "rotated file missing");
  assert.ok(statSync(file).size < 300 + 120, "main file did not stay near the cap");
  assert.match(readFileSync(file, "utf8"), /^\[\d{4}-\d\d-\d\dT.*\] line number/m);
});

test("logger swallows write errors", () => {
  const dir = tmp();
  const blocker = path.join(dir, "file");
  writeFileSync(blocker, "x");
  const log = createLogger(path.join(blocker, "sub", "agent.log")); // parent is a file
  assert.doesNotThrow(() => log("hello"));
});

test("parseMode: SEA with no args installs, --run runs, other flags map to modes", () => {
  assert.equal(parseMode([], true), "install");
  assert.equal(parseMode(["--run"], true), "run");
  assert.equal(parseMode(["--uninstall"], true), "uninstall");
  assert.equal(parseMode(["--status"], true), "status");
  assert.equal(parseMode(["--check"], true), "check");
  assert.equal(parseMode([], false), "run");
  assert.equal(parseMode(["--purge"], true), "install");
});

test("approvalModeFor: an installed (hidden) build never uses the console", () => {
  assert.equal(approvalModeFor("console", true), "dialog");
  assert.equal(approvalModeFor("console", false), "console");
  assert.equal(approvalModeFor("deny", true), "deny");
  assert.equal(approvalModeFor("dialog", false), "dialog");
});
