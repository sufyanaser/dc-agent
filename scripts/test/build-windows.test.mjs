// Run after building: node scripts/build-windows.mjs && node --test scripts/test/build-windows.test.mjs   (from project/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = path.join(PROJECT, "dist", "dc-custom-setup.exe");
const require = createRequire(path.join(PROJECT, "device", "package.json"));
const { NtExecutable, NtExecutableResource } = require("pe-library");
const { Resource } = require("resedit");

/** Same token source the build uses: env first, then the existing install's config. */
function buildToken() {
  if (process.env.DC_DEVICE_TOKEN) return process.env.DC_DEVICE_TOKEN;
  try {
    const cfg = path.join(process.env.LOCALAPPDATA ?? "", "dc-custom", "config.json");
    return JSON.parse(readFileSync(cfg, "utf8").replace(/^﻿/, "")).deviceToken ?? null;
  } catch {
    return null;
  }
}

function loadExe() {
  const buf = readFileSync(EXE);
  const exe = NtExecutable.from(buf, { ignoreCert: true });
  return { buf, exe, res: NtExecutableResource.from(exe) };
}

test("the installer exe exists", () => {
  assert.ok(existsSync(EXE), "dist/dc-custom-setup.exe is missing: run node scripts/build-windows.mjs");
});

test("PE subsystem is GUI (2), so Windows never opens a console window", () => {
  assert.equal(loadExe().exe.newHeader.optionalHeader.subsystem, 2);
});

test("the exe carries the app icon at all 7 sizes", () => {
  const { res } = loadExe();
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  assert.ok(groups.length >= 1, "no icon group");
  const sizes = groups[0].getIconItemsFromEntries(res.entries).map((i) => i.width || 256) /* ICO stores 256 as 0 */.sort((a, b) => a - b);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test("version info names the product dc-custom", () => {
  const { res } = loadExe();
  const info = Resource.VersionInfo.fromEntries(res.entries)[0];
  const strings = info.getAllLanguagesForStringValues()[0] ? info.getStringValues(info.getAllLanguagesForStringValues()[0]) : {};
  assert.equal(strings.ProductName, "dc-custom");
  assert.equal(strings.OriginalFilename, "dc-custom-setup.exe");
});

test("the token is embedded in the exe and appears in no source or doc file outside dist/", () => {
  const token = buildToken();
  if (!token) return; // nothing to compare against on this machine
  const embedded = readFileSync(EXE).includes(Buffer.from(token));
  if (process.env.DC_PUBLIC_BUILD === "1") assert.equal(embedded, false, "a public build must not contain the token");
  else assert.ok(embedded, "token not embedded in the exe");
  const skip = new Set(["node_modules", "dist", ".wrangler", ".git"]);
  const textExt = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".ps1", ".txt", ".sh", ".plist"]);
  // Pre-existing scratch file where the owner once pasted the token for `wrangler secret put`. It is
  // reported to the owner separately; it is not produced by the build, so it must not fail this test.
  const preExisting = new Set(["New Text Document.txt"]);
  const hits = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!skip.has(name)) walk(full);
      } else if (textExt.has(path.extname(name)) && statSync(full).size < 5_000_000 && readFileSync(full, "utf8").includes(token)) {
        if (!preExisting.has(path.relative(PROJECT, full))) hits.push(path.relative(PROJECT, full));
      }
    }
  })(PROJECT);
  assert.deepEqual(hits, [], `token leaked into: ${hits.join(", ")}`);
});
