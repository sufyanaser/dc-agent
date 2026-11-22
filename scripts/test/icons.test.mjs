// Run: node --test scripts/test/icons.test.mjs   (from project/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ICO = path.join(PROJECT, "assets", "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("assets/icon.ico is a valid multi-size PNG-in-ICO", () => {
  const buf = readFileSync(ICO);
  assert.equal(buf.readUInt16LE(0), 0, "reserved");
  assert.equal(buf.readUInt16LE(2), 1, "type = icon");
  assert.equal(buf.readUInt16LE(4), SIZES.length, "image count");
  SIZES.forEach((size, i) => {
    const e = 6 + i * 16;
    const w = buf[e] === 0 ? 256 : buf[e];
    const h = buf[e + 1] === 0 ? 256 : buf[e + 1];
    assert.deepEqual([w, h], [size, size], `entry ${i} size`);
    const bytes = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    assert.ok(offset + bytes <= buf.length, `entry ${i} inside file`);
    assert.ok(buf.subarray(offset, offset + 8).equals(PNG_SIG), `entry ${i} is a PNG`);
  });
});

test("the macOS iconset has every size iconutil expects", () => {
  const names = ["16x16", "32x32", "128x128", "256x256", "512x512"].flatMap((s) => [`icon_${s}.png`, `icon_${s}@2x.png`]);
  for (const n of names) assert.ok(existsSync(path.join(PROJECT, "assets", "icon.iconset", n)), `missing ${n}`);
});

test("relay serves the real icon at /favicon.ico and keeps png/svg", async () => {
  const { iconResponse } = await import("../../relay/src/icon.ts");
  const ico = iconResponse("/favicon.ico", "GET");
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.ok(Buffer.from(await ico.arrayBuffer()).equals(readFileSync(ICO)), "served bytes differ from assets/icon.ico");
  assert.equal(iconResponse("/icon.png", "GET").headers.get("content-type"), "image/png");
  assert.equal(iconResponse("/icon.svg", "GET").headers.get("content-type"), "image/svg+xml");
  assert.equal(iconResponse("/nope", "GET"), null);
  assert.equal(await iconResponse("/icon.png", "HEAD").text(), "");
});
