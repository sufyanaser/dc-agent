// Builds dist/dc-custom-setup.exe: one self-contained, windowless executable that is both the
// installer and the agent (Node SEA). Config (relay URL, token, profile) is embedded at build time.
//
//   node scripts/build-windows.mjs
//
// Config sources, in order: env DC_RELAY_URL / DC_DEVICE_TOKEN / DC_PROFILE / DC_ALLOWED_ROOTS (";" separated),
// then the existing install's %LOCALAPPDATA%\dc-custom\config.json. The token never touches the repo:
// the intermediate build files live in a temp folder that is deleted at the end.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEVICE = path.join(PROJECT, "device");
const DIST = path.join(PROJECT, "dist");
const OUT = path.join(DIST, "dc-custom-setup.exe");
const VERSION = JSON.parse(readFileSync(path.join(DEVICE, "package.json"), "utf8")).version;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const require = createRequire(path.join(DEVICE, "package.json"));
const esbuild = require("esbuild");
const { NtExecutable, NtExecutableResource } = require("pe-library");
const { Data, Resource } = require("resedit");
const { inject } = require("postject");

function existingConfig() {
  try {
    const file = path.join(process.env.LOCALAPPDATA ?? "", "dc-custom", "config.json");
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

/**
 * DC_PUBLIC_BUILD=1: no token inside (safe to publish as a release); the installer asks for it once.
 * Otherwise the token is embedded (a private build for your own machines only).
 */
function buildConfig() {
  const existing = existingConfig();
  const isPublic = process.env.DC_PUBLIC_BUILD === "1";
  const relayUrl = process.env.DC_RELAY_URL || existing.relayUrl;
  const deviceToken = isPublic ? undefined : process.env.DC_DEVICE_TOKEN || existing.deviceToken;
  if (!relayUrl) throw new Error("No relay URL: set DC_RELAY_URL (wss://<worker>/device).");
  if (!isPublic && !deviceToken) {
    throw new Error("No device token: set DC_DEVICE_TOKEN, or use DC_PUBLIC_BUILD=1 for an installer that asks for it.");
  }
  const profile = process.env.DC_PROFILE || existing.policy?.profile || "readonly";
  const allowedRoots = process.env.DC_ALLOWED_ROOTS ? process.env.DC_ALLOWED_ROOTS.split(";").filter(Boolean) : existing.policy?.allowedRoots ?? [];
  const config = { relayUrl, policy: { profile, allowedRoots, approvalMode: "dialog" } };
  return deviceToken ? { ...config, deviceToken } : config;
}

/** Icon, version info and GUI subsystem on a copy of node.exe (the Authenticode signature is dropped: it would be invalid anyway). */
function brandNodeExe() {
  const exe = NtExecutable.from(readFileSync(process.execPath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  exe.newHeader.optionalHeader.subsystem = 2; // IMAGE_SUBSYSTEM_WINDOWS_GUI: no console window, ever

  const ico = Data.IconFile.from(readFileSync(path.join(PROJECT, "assets", "icon.ico")));
  const group = Resource.IconGroupEntry.fromEntries(res.entries)[0];
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, group?.id ?? 1, group?.lang ?? 1033, ico.icons.map((i) => i.data));

  const info = Resource.VersionInfo.fromEntries(res.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const lang = info.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  info.setFileVersion(...VERSION.split(".").map(Number), 0);
  info.setProductVersion(...VERSION.split(".").map(Number), 0);
  info.setStringValues(lang, {
    FileDescription: "dc-custom: lets your AI tools use this computer",
    ProductName: "dc-custom",
    CompanyName: "dc-custom",
    InternalName: "dc-custom",
    OriginalFilename: "dc-custom-setup.exe",
    LegalCopyright: "dc-custom",
    FileVersion: `${VERSION}.0`,
    ProductVersion: `${VERSION}.0`,
  });
  info.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "dc-build-"));
try {
  const config = buildConfig();
  mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(DEVICE, "src", "index.ts")],
    outfile: path.join(tmp, "agent.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"], // optional native speedups of `ws`
    logLevel: "warning",
  });

  const configFile = path.join(tmp, "build-config.json");
  writeFileSync(configFile, JSON.stringify(config));
  const seaConfig = path.join(tmp, "sea-config.json");
  writeFileSync(seaConfig, JSON.stringify({
    main: path.join(tmp, "agent.cjs"),
    output: path.join(tmp, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { "build-config.json": configFile, "icon.ico": path.join(PROJECT, "assets", "icon.ico") },
  }));
  const prep = spawnSync(process.execPath, ["--experimental-sea-config", seaConfig], { encoding: "utf8" });
  if (prep.status !== 0) throw new Error(`SEA blob generation failed:\n${prep.stdout}${prep.stderr}`);

  writeFileSync(OUT, brandNodeExe());
  await inject(OUT, "NODE_SEA_BLOB", readFileSync(path.join(tmp, "sea-prep.blob")), { sentinelFuse: SEA_FUSE });

  console.log(`Built ${path.relative(PROJECT, OUT)} v${VERSION} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB), profile=${config.policy.profile}, token ${config.deviceToken ? "EMBEDDED (private build)" : "not embedded (public build)"}`);
} finally {
  rmSync(tmp, { recursive: true, force: true }); // removes the token-bearing build config
}
