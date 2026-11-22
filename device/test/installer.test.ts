import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, installedExePath, status, uninstall, type PlatformOps } from "../src/installer/install.js";
import { acquireInstance, instanceAddress } from "../src/instance.js";
import { dcHome } from "../src/home.js";

const TOKEN = "k".repeat(48);
const EMBEDDED = { relayUrl: "wss://relay.example/device", deviceToken: TOKEN, policy: { profile: "readonly" as const } };

/** Runs fn with DC_HOME pointing at a fresh temp folder (optionally with a tricky name). */
async function withHome<T>(folder: string, fn: (home: string) => Promise<T>): Promise<T> {
  const saved = process.env.DC_HOME;
  const home = path.join(mkdtempSync(path.join(os.tmpdir(), "dc-inst-")), folder);
  process.env.DC_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (saved === undefined) delete process.env.DC_HOME;
    else process.env.DC_HOME = saved;
  }
}

function fakeOps(opts: { started?: boolean; restrictFails?: boolean; typedToken?: string } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec = (op: string) => async (...args: unknown[]) => void calls.push({ op, args });
  const ops: PlatformOps = {
    stopAgent: rec("stopAgent"),
    copySelf: async (dest: string) => {
      calls.push({ op: "copySelf", args: [dest] });
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, "exe");
    },
    restrictFile: async (file: string) => {
      calls.push({ op: "restrictFile", args: [file] });
      if (opts.restrictFails) throw new Error("icacls could not map the account");
    },
    agentStarted: async () => opts.started ?? true,
    promptToken: async () => {
      calls.push({ op: "promptToken", args: [] });
      return opts.typedToken ?? null;
    },
    registerAutostart: rec("registerAutostart"),
    unregisterAutostart: rec("unregisterAutostart"),
    registerUninstallEntry: rec("registerUninstallEntry"),
    removeUninstallEntry: rec("removeUninstallEntry"),
    startHidden: rec("startHidden"),
    removeFile: rec("removeFile"),
    notify: rec("notify"),
  };
  const names = () => calls.map((c) => c.op);
  const find = (op: string) => calls.filter((c) => c.op === op);
  return { ops, calls, names, find };
}

test("first install writes config from the embedded build and wires everything in order", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps();
    const r = await install(f.ops, { embedded: EMBEDDED, exe: "C:\\downloads\\setup.exe" });
    assert.equal(r.ok, true);
    assert.equal(r.configWritten, true);
    const cfg = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(cfg.deviceToken, TOKEN);
    assert.equal(cfg.relayUrl, "wss://relay.example/device");
    assert.equal(cfg.policy.profile, "readonly");
    const order = f.names();
    const idx = (n: string) => order.indexOf(n);
    assert.ok(idx("stopAgent") < idx("copySelf"), "agent must be stopped before the exe is replaced");
    assert.ok(idx("copySelf") < idx("registerAutostart"));
    assert.ok(idx("registerAutostart") < idx("startHidden"));
    assert.ok(idx("registerUninstallEntry") < idx("startHidden"));
    assert.equal(order[order.length - 1], "notify");
    assert.equal(f.find("restrictFile").length, 1);
  });
});

test("re-running keeps the existing config and token untouched", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps();
    await install(f.ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe" });
    const before = readFileSync(path.join(home, "config.json"));
    const f2 = fakeOps();
    const r = await install(f2.ops, { embedded: { ...EMBEDDED, deviceToken: "z".repeat(48) }, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, true);
    assert.equal(r.configWritten, false);
    assert.equal(r.tokenKept, true);
    assert.ok(readFileSync(path.join(home, "config.json")).equals(before));
  });
});

test("no token anywhere: one error dialog, nothing installed or registered", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps();
    const r = await install(f.ops, { embedded: { relayUrl: "wss://relay.example/device" }, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /token/i);
    const notices = f.find("notify");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].args[2], "error");
    for (const op of ["copySelf", "registerAutostart", "startHidden", "stopAgent"]) assert.equal(f.find(op).length, 0, op);
    assert.equal(existsSync(path.join(home, "config.json")), false);
  });
});

test("paths with spaces and Arabic letters pass through unmodified", async () => {
  await withHome("مجلد dc custom", async (home) => {
    const f = fakeOps();
    const r = await install(f.ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, true);
    const expected = installedExePath();
    assert.ok(expected.startsWith(home));
    assert.equal(f.find("registerAutostart")[0].args[0], expected);
    assert.equal(f.find("startHidden")[0].args[0], expected);
  });
});

test("running the installer from the installed location does not copy the exe onto itself", async () => {
  await withHome("dc-custom", async () => {
    const f = fakeOps();
    await install(f.ops, { embedded: EMBEDDED, exe: installedExePath() });
    assert.equal(f.find("copySelf").length, 0);
    assert.equal(f.find("registerAutostart").length, 1);
  });
});

test("assets (icons) are written next to the config and used for the uninstall entry", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps();
    await install(f.ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe", assets: { "icon.ico": Buffer.from("ICO") } });
    assert.equal(readFileSync(path.join(home, "icon.ico"), "utf8"), "ICO");
    assert.equal(f.find("registerUninstallEntry")[0].args[1], path.join(home, "icon.ico"));
  });
});

test("status reports installed and running", async () => {
  await withHome("dc-custom", async () => {
    assert.deepEqual(await status(), { installed: false, running: false });
    await install(fakeOps().ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe" });
    assert.deepEqual(await status(), { installed: true, running: false });
    const inst = await acquireInstance(instanceAddress(dcHome()));
    assert.equal((await status()).running, true);
    if (inst.ok) inst.release();
  });
});

test("if locking down config.json fails, the config just written is removed so the next run retries", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps({ restrictFails: true });
    const r = await install(f.ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, false);
    assert.equal(existsSync(path.join(home, "config.json")), false);
    assert.equal(f.find("registerAutostart").length, 0);
    assert.equal(f.find("notify")[0].args[2], "error");
  });
});

test("an embedded config the agent would reject fails the install before anything is registered", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps();
    const r = await install(f.ops, { embedded: { ...EMBEDDED, policy: { profile: "scoped" as const } }, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /allowedRoots/);
    assert.equal(f.find("registerAutostart").length, 0);
    assert.equal(existsSync(path.join(home, "config.json")), false);
  });
});

test("if the agent does not come up after install, the owner is told and pointed at the log", async () => {
  await withHome("dc-custom", async () => {
    const f = fakeOps({ started: false });
    const r = await install(f.ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe" });
    assert.equal(r.ok, false);
    const notice = f.find("notify").at(-1)!;
    assert.equal(notice.args[2], "error");
    assert.match(String(notice.args[1]), /agent\.log/);
  });
});

test("uninstall removes registration and config but keeps the audit log unless purged", async () => {
  await withHome("dc-custom", async (home) => {
    await install(fakeOps().ops, { embedded: EMBEDDED, exe: "C:\\a\\setup.exe", assets: { "icon.ico": Buffer.from("ICO") } });
    writeFileSync(path.join(home, "audit.jsonl"), "{}\n");
    const f = fakeOps();
    await uninstall(f.ops);
    assert.deepEqual(["stopAgent", "unregisterAutostart", "removeUninstallEntry"].every((n) => f.names().includes(n)), true);
    assert.equal(f.find("removeFile")[0].args[0], installedExePath());
    assert.equal(existsSync(path.join(home, "config.json")), false);
    assert.equal(existsSync(path.join(home, "icon.ico")), false);
    assert.equal(existsSync(path.join(home, "audit.jsonl")), true);
    await uninstall(fakeOps().ops, { purge: true });
    assert.equal(existsSync(path.join(home, "audit.jsonl")), false);
  });
});

const PUBLIC_BUILD = { relayUrl: "wss://relay.example/device", policy: { profile: "readonly" as const } }; // no token inside

test("a public (token-free) installer asks for the token once and stores it", async () => {
  await withHome("dc-custom", async (home) => {
    const f = fakeOps({ typedToken: "  " + TOKEN + "  " });
    const r = await install(f.ops, { embedded: PUBLIC_BUILD, exe: "C:\a\setup.exe" });
    assert.equal(r.ok, true);
    assert.equal(f.find("promptToken").length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).deviceToken, TOKEN, "token must be trimmed");
  });
});

test("cancelling or pasting a too-short token stops the install before anything is registered", async () => {
  await withHome("dc-custom", async (home) => {
    for (const typed of [undefined, "short"]) {
      const f = fakeOps({ typedToken: typed });
      const r = await install(f.ops, { embedded: PUBLIC_BUILD, exe: "C:\a\setup.exe" });
      assert.equal(r.ok, false);
      assert.equal(f.find("registerAutostart").length, 0);
      assert.equal(existsSync(path.join(home, "config.json")), false);
    }
  });
});

test("DC_DEVICE_TOKEN answers the question for automated installs", async () => {
  await withHome("dc-custom", async (home) => {
    process.env.DC_DEVICE_TOKEN = TOKEN;
    try {
      const f = fakeOps();
      const r = await install(f.ops, { embedded: PUBLIC_BUILD, exe: "C:\a\setup.exe" });
      assert.equal(r.ok, true);
      assert.equal(f.find("promptToken").length, 0);
      assert.equal(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).deviceToken, TOKEN);
    } finally {
      delete process.env.DC_DEVICE_TOKEN;
    }
  });
});

test("an upgrade keeps the stored token and never asks again", async () => {
  await withHome("dc-custom", async () => {
    await install(fakeOps({ typedToken: TOKEN }).ops, { embedded: PUBLIC_BUILD, exe: "C:\a\setup.exe" });
    const f = fakeOps();
    const r = await install(f.ops, { embedded: PUBLIC_BUILD, exe: "C:\a\setup.exe" });
    assert.equal(r.ok, true);
    assert.equal(r.tokenKept, true);
    assert.equal(f.find("promptToken").length, 0);
  });
});
