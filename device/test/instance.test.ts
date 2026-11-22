import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstance, instanceAddress, isInstanceRunning } from "../src/instance.js";

const uniqueHome = () => path.join(os.tmpdir(), `dc-inst-${process.pid}-${Math.random().toString(36).slice(2)}`);

test("a second instance is refused while the first holds the address; release frees it", async () => {
  const addr = instanceAddress(uniqueHome());
  const a = await acquireInstance(addr);
  assert.equal(a.ok, true);
  assert.equal((await acquireInstance(addr)).ok, false);
  assert.equal(await isInstanceRunning(addr), true);
  if (a.ok) a.release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await isInstanceRunning(addr), false);
  const b = await acquireInstance(addr);
  assert.equal(b.ok, true);
  if (b.ok) b.release();
});

test("different install folders get different addresses", () => {
  assert.notEqual(instanceAddress(uniqueHome()), instanceAddress(uniqueHome()));
});

test("a killed holder releases the instance (no stale lock after crash, logoff or fast startup)", async () => {
  const addr = instanceAddress(uniqueHome());
  const mod = pathToFileURL(path.resolve("dist/src/instance.js")).href;
  const child = spawn(process.execPath, ["-e", `import(${JSON.stringify(mod)}).then(m => m.acquireInstance(${JSON.stringify(addr)})).then(r => { console.log(r.ok ? "held" : "refused"); setInterval(() => {}, 1000); })`], { stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((resolve) => child.stdout.once("data", (b: Buffer) => resolve(b.toString().trim())));
  assert.equal(first, "held");
  assert.equal((await acquireInstance(addr)).ok, false);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  const after = await acquireInstance(addr);
  assert.equal(after.ok, true);
  if (after.ok) after.release();
});
