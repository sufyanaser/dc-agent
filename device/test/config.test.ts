import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configPath, dcHome } from "../src/home.js";
import { loadConfig } from "../src/config.js";

const KEYS = ["DC_HOME", "DC_CONFIG", "DC_DEVICE_TOKEN", "DC_RELAY_URL"] as const;
const TOKEN = "x".repeat(40);
const EMBEDDED_POLICY = { profile: "readonly" as const };

async function withEnv<T>(vars: Partial<Record<(typeof KEYS)[number], string>>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function tmpFile(content: object | null): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dc-cfg-"));
  const file = path.join(dir, "config.json");
  if (content) await writeFile(file, JSON.stringify(content));
  return file;
}

test("DC_HOME relocates the install root and config path", async () => {
  await withEnv({ DC_HOME: "/tmp/dc-home-test" }, () => {
    assert.equal(dcHome(), path.resolve("/tmp/dc-home-test"));
    assert.equal(configPath(), path.join(path.resolve("/tmp/dc-home-test"), "config.json"));
  });
});

test("config file beats embedded config, embedded fills the gaps", async () => {
  const file = await tmpFile({ relayUrl: "wss://a.example/device" });
  const cfg = await withEnv({}, () =>
    loadConfig(file, { relayUrl: "wss://b.example/device", deviceToken: TOKEN, policy: EMBEDDED_POLICY }),
  );
  assert.equal(cfg.relayUrl, "wss://a.example/device");
  assert.equal(cfg.deviceToken, TOKEN);
  assert.equal(cfg.policy.profile, "readonly");
});

test("env token beats file and embedded", async () => {
  const file = await tmpFile({ relayUrl: "wss://a.example/device", deviceToken: "f".repeat(40) });
  const cfg = await withEnv({ DC_DEVICE_TOKEN: "e".repeat(40) }, () =>
    loadConfig(file, { deviceToken: TOKEN, policy: EMBEDDED_POLICY }),
  );
  assert.equal(cfg.deviceToken, "e".repeat(40));
});

test("no token anywhere fails with a clear message", async () => {
  const file = await tmpFile({ relayUrl: "wss://a.example/device" });
  await withEnv({}, () => {
    assert.throws(() => loadConfig(file, { policy: EMBEDDED_POLICY }), /deviceToken missing/);
  });
});

test("missing config file is fine when embedded config is complete", async () => {
  const file = await tmpFile(null);
  const cfg = await withEnv({}, () =>
    loadConfig(file, { relayUrl: "wss://b.example/device", deviceToken: TOKEN, deviceId: "MAC", policy: EMBEDDED_POLICY }),
  );
  assert.equal(cfg.deviceId, "MAC");
});

test("missing config file and no embedded config still reports the file", async () => {
  const file = await tmpFile(null);
  await withEnv({}, () => {
    assert.throws(() => loadConfig(file, null), /config not found/);
  });
});

test("bridges: Figwright by default, a config file can disable them", async () => {
  const file = await tmpFile({ relayUrl: "wss://a.example/device", deviceToken: TOKEN, policy: EMBEDDED_POLICY });
  const cfg = await withEnv({}, () => loadConfig(file, null));
  assert.ok(cfg.bridges.figwright, "figwright bridge missing by default");
  const off = await tmpFile({ relayUrl: "wss://a.example/device", deviceToken: TOKEN, policy: EMBEDDED_POLICY, bridges: {} });
  assert.deepEqual((await withEnv({}, () => loadConfig(off, null))).bridges, {});
});
