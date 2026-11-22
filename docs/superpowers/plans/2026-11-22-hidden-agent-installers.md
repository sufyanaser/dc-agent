# Hidden agent, one-file installers, two devices, icons: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship dc-custom as a windowless background agent installed by one double-click file per OS, with two devices online at once and the tool icon on every surface.

**Architecture:** The device agent (`device/`) gains hidden-mode plumbing (file log, single-instance lock, native approval dialogs, per-OS defaults) and a platform-neutral installer module driven by a CLI mode switch. A build script bundles it with esbuild, wraps it as a Node SEA executable, patches the PE to the GUI subsystem and embeds the icon. The relay (`relay/`) keeps one socket per `deviceId` and routes by an optional `device` argument.

**Tech Stack:** TypeScript (NodeNext, strict), Node 24 SEA + `postject`, `esbuild`, `resedit`, `sharp` (already in `relay/node_modules`), `ws`, Cloudflare Workers/Durable Objects, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-22-hidden-agent-installers-design.md` (all paths below are relative to `project/`).

**Not a git repo:** there are no commit steps. Each task ends with its tests green instead.

## Global Constraints

- Node: agent supports `>=22.12.0`; the SEA build uses the local Node 24.
- Windows: GUI subsystem (PE Subsystem = 2); no console window at any time; no admin rights needed (autostart in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, entry `dc-custom`).
- Install root: `%LOCALAPPDATA%\dc-custom` (override with env `DC_HOME`); log `agent.log`; config `config.json` (ACL: current user only); macOS config mode `600`, LaunchAgent label `com.dc-custom.agent`.
- Config precedence: env vars > `config.json` > embedded build config (`build-config.json` SEA asset).
- Installer never overwrites an existing `config.json` or its `deviceToken`.
- Approval modes: `console` | `deny` | `dialog`; timeout = `approvalTimeoutSec` (default 120); timeout means deny.
- Default profile of installed builds: `readonly` (owner's current setting).
- Relay: one shared `DEVICE_TOKEN`; sockets tagged by `deviceId`; tool arg `device?: string`; relay strips `device` before forwarding.
- Icon source of truth: `ICON_SVG` in `relay/src/icon.ts` (indigo rounded square, white `>_`). `.ico` sizes 16/24/32/48/64/128/256.
- The built installer embeds the token: build output goes to `dist/` only, never logged or committed.
- macOS artifacts are written but cannot be tested from this machine.

## Review Focus

1. Re-running the installer while the agent is running: the running `.exe` is locked on Windows, so the old process must be stopped before the copy, and the new one started after.
2. No token anywhere (no `config.json`, no embedded config): clear single dialog/log error, no crash loop at every login.
3. Approval dialog when there is no usable desktop (locked screen, RDP disconnected): must time out to deny, never hang the call queue.
4. Install path or hostname with spaces or non-ASCII characters (e.g. an Arabic computer name): quoting in the Run key / plist, and `deviceId` still routable.
5. `device` argument must not reach the device or the audit log, and a reconnect of device A must not drop device B.

---

## File Structure

| File | Responsibility |
|---|---|
| `device/src/home.ts` (new) | `dcHome()`, `logPath()`, `configPath()` path rules |
| `device/src/config.ts` (mod) | precedence env > file > embedded; `embeddedConfig()` |
| `device/src/policy.ts` (mod) | per-platform default allowlists; `approvalMode` includes `dialog` |
| `device/src/tools.ts` (mod) | `shell: "sh"`, platform default shell, macOS `proc_*` |
| `device/src/dialog.ts` (new) | native approval dialog (PowerShell WinForms / `osascript`) |
| `device/src/approval.ts` (mod) | `dialog` mode via injectable runner |
| `device/src/log.ts`, `device/src/lock.ts` (new) | rotating file logger; single-instance lock |
| `device/src/cli.ts` (new) | `parseMode(argv, isSea)` |
| `device/src/installer/{install,windows,macos}.ts` (new) | install/uninstall/status orchestration + OS adapters |
| `device/src/index.ts` (mod) | dispatch on mode; hidden-safe logging |
| `relay/src/{protocol,device-hub,mcp}.ts` (mod) | multi-device registry and routing |
| `relay/src/icon.ts` (mod) | real `ICON_ICO` served at `/favicon.ico` |
| `scripts/make-icons.mjs`, `scripts/build-windows.mjs`, `scripts/build-mac.sh` (new) | icon generation and per-OS builds |
| `installer/macos/{Info.plist,agent.plist.tpl}`, `CONNECT.md` (new) | Mac packaging pieces, connection guide |

---

### Task 1: Home paths and config precedence

**Files:** Create `device/src/home.ts`; modify `device/src/config.ts`; test `device/test/config.test.ts`.

**Interfaces:**
- Produces: `dcHome(): string` (env `DC_HOME` > win32 `%LOCALAPPDATA%\dc-custom` > `~/dc-custom`), `configPath(): string` (`DC_CONFIG` > `dcHome()/config.json`), `logPath(): string` (`dcHome()/agent.log`; darwin: `~/Library/Logs/dc-custom/agent.log`), `embeddedConfig(): Partial<{relayUrl:string; deviceToken:string; deviceId:string; policy:object}> | null` (reads SEA asset `build-config.json`, `null` when not SEA), `loadConfig(file?: string, embedded?: ReturnType<typeof embeddedConfig>): DeviceConfig`.

- [ ] **Step 1: Write failing tests** in `config.test.ts`: (a) `DC_HOME=tmp` makes `configPath()` equal `tmp/config.json`; (b) with file `{relayUrl:"wss://a/device"}` and embedded `{relayUrl:"wss://b/device", deviceToken:"x".repeat(40)}`, `loadConfig` returns relayUrl `wss://a/device` and the embedded token; (c) env `DC_DEVICE_TOKEN` beats both; (d) no token anywhere throws `/deviceToken missing/`; (e) missing file is allowed when embedded config supplies relayUrl and token.
- [ ] **Step 2: Run** `cd device; npm test` -> new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above; keep `defaultConfigPath`/`defaultAuditPath` as thin re-exports so existing imports and the 20 existing tests keep working; `loadConfig` stops requiring the file when the embedded config is complete.
- [ ] **Step 4: Run** `npm test` -> all PASS.

### Task 2: Cross-platform policy and tools

**Files:** Modify `device/src/policy.ts`, `device/src/tools.ts` (exec at ~line 239-265, `proc_kill` ~283), `device/test/policy.test.ts`.

**Interfaces:**
- Produces: `defaultsFor(profile: Profile, platform: NodeJS.Platform = process.platform): PolicyConfig`; `defaultShell(platform): "powershell" | "sh"`; exec `shell` enum `["powershell","cmd","sh"]`; `PolicyConfig.approvalMode: "console" | "deny" | "dialog"`.

- [ ] **Step 1: Write failing tests:** `defaultsFor("readonly","darwin").commandAllowlist` contains `ls`,`cat`,`pwd`,`whoami` and not `Get-ChildItem`; `defaultsFor("scoped","win32")` unchanged (still contains `Get-ChildItem`); `defaultShell("darwin") === "sh"`; `resolveConfig({profile:"full",approvalMode:"dialog"}, "x")` accepts `dialog`.
- [ ] **Step 2: Run** `npm test` -> FAIL.
- [ ] **Step 3: Implement.** macOS allowlist: `git npm npx node python3 ls cat grep pwd whoami echo which`; readonly macOS subset `ls cat grep pwd whoami`. On non-win32, `proc_list` runs `ps -axo pid,comm,rss` and `proc_kill` runs `kill -9 <pid>` through `runCommand` with `shell: "sh"` (pid validated as integer first). Update the relay-facing description strings in Task 5.
- [ ] **Step 4: Run** `npm test` -> PASS (Windows behaviour unchanged).

### Task 3: Native approval dialog

**Files:** Create `device/src/dialog.ts`; modify `device/src/approval.ts`; test `device/test/approval.test.ts`.

**Interfaces:**
- Produces: `type DialogRunner = (req: {tool:string; summary:string}, timeoutSec: number) => Promise<boolean>`; `showApprovalDialog: DialogRunner` (win32: hidden `powershell.exe -NoProfile -WindowStyle Hidden` running a topmost WinForms form titled `dc-custom` with the app icon and Allow/Deny; darwin: `osascript` `display dialog ... giving up after <timeoutSec>`); `new Approver(mode, timeoutSec, runner: DialogRunner = showApprovalDialog)`.

- [ ] **Step 1: Write failing tests** with a fake runner: `dialog` mode returns the runner's boolean; two concurrent requests reach the runner one at a time (serialized); a runner that never resolves yields `false` after `timeoutSec` (use 1s) without blocking the next request; the child process failing to start yields `false`; `deny` still returns `false` and `console` is unchanged.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement.** Wrap the runner in `Promise.race` with a timer so a hung dialog process is killed and counts as deny. Pass tool/summary to PowerShell through environment variables (never string-interpolated into the script) to avoid injection from tool arguments.
- [ ] **Step 4: Run** -> PASS.

### Task 4: Hidden runtime (log, lock, CLI modes)

**Files:** Create `device/src/{log.ts,lock.ts,cli.ts}`; modify `device/src/index.ts`; tests `device/test/{lock,cli}.test.ts`.

**Interfaces:**
- Produces: `createLogger(file: string, maxBytes = 1_000_000): (line: string) => void` (append; rotate to `file + ".1"`; never throws); `acquireLock(file: string): { ok: true; release(): void } | { ok: false; pid: number }` (stale lock = dead PID is taken over); `parseMode(argv: string[], isSea: boolean): "run" | "install" | "uninstall" | "status" | "check"` (SEA with no args = `install`; `--run` = run; non-SEA with no args = `run`).

- [ ] **Step 1: Write failing tests:** logger rotates at `maxBytes` and swallows write errors; second `acquireLock` on a live PID returns `{ok:false}`, on a stale file succeeds; `parseMode([], true)==="install"`, `parseMode(["--run"],true)==="run"`, `parseMode([],false)==="run"`, `parseMode(["--uninstall"],true)==="uninstall"`.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement**, then rewire `index.ts`: mode `run` = acquire lock (exit 0 quietly if held), logger to `logPath()`, approver from config (`dialog` default when `isSea`), all `process.stdout/stderr` writes removed from the run path. A missing token logs once and exits with code 2 (no restart loop; Task 7 shows the dialog).
- [ ] **Step 4: Run** `npm test` -> PASS.

### Task 5: Relay multi-device routing

**Files:** Modify `relay/src/protocol.ts`, `relay/src/device-hub.ts`, `relay/src/mcp.ts`; extend `relay/test/harness/harness.ts` (`/call` accepts `device`); new test `relay/test/devices.test.ts` (run with `wrangler dev` like the existing harness).

**Interfaces:**
- Produces: `DeviceHub.call(tool: string, args: unknown, device?: string): Promise<DeviceReply>`; `DeviceHub.devices(): Promise<{deviceId:string; online:boolean; profile:string; version:string; tools:string[]}[]>`; per-socket attachment `{deviceId}` set on `hello` via `ws.serializeAttachment`; `hello:<deviceId>` storage keys.

- [ ] **Step 1: Write failing tests** (two fake device sockets `A` and `B` via `ws`): both `online`; `call("fs_list",{},"A")` reaches only A; no `device` with two online returns error containing both names; no `device` with one online routes to it; unknown name errors with the online list; reconnecting `A` closes only A's old socket and B stays connected; a forwarded call's `args` has no `device` key.
- [ ] **Step 2: Run** relay harness tests -> FAIL.
- [ ] **Step 3: Implement.** `/connect` no longer closes existing sockets; on `hello` close other sockets whose attachment has the same `deviceId`. `mcp.ts`: add `device: z.string().optional()` to every forwarded tool schema, strip it from `args`, pass it to `hub.call`; `device_status` returns `devices()` (keep `online`/`device` for the single-device legacy shape not required). Update `exec` description to "PowerShell (Windows) or sh (macOS)".
- [ ] **Step 4: Run** relay harness tests and `npx tsc --noEmit` in `relay/` -> PASS.

### Task 6: Icon pipeline and real favicon

**Files:** Create `scripts/make-icons.mjs`, outputs `assets/icon.ico`, `assets/icon-256.png`, `assets/icon.icns.iconset/` (PNG set for `iconutil`); modify `relay/src/icon.ts` (add `iconIco(): ArrayBuffer`) and `relay/src/auth.ts` (`/favicon.ico` -> `image/x-icon`, `/icon.png` unchanged); test `scripts/test/icons.test.mjs`.

**Interfaces:**
- Produces: `assets/icon.ico` (PNG-in-ICO, sizes 16/24/32/48/64/128/256); `iconIco()` returning the same bytes base64-embedded in `icon.ts`.

- [ ] **Step 1: Write failing test:** parse `assets/icon.ico` header (reserved 0, type 1, count 7) and assert each entry's width/height match the sizes above and every image chunk starts with the PNG signature; assert `relay` `/favicon.ico` handler returns `Content-Type: image/x-icon` and the ICO header bytes.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement** `make-icons.mjs`: rasterize `ICON_SVG` with `sharp` to each size, write the ICO container by hand, write the iconset PNG names `icon_16x16.png ... icon_512x512@2x.png`, and regenerate the base64 constant in `icon.ts`.
- [ ] **Step 4: Run** -> PASS.

### Task 7: Installer orchestration and OS adapters

**Files:** Create `device/src/installer/{install.ts,windows.ts,macos.ts}`; test `device/test/installer.test.ts`.

**Interfaces:**
- Consumes: `dcHome()`, `loadConfig`, `embeddedConfig`, `Approver`/dialog helpers (Tasks 1, 3).
- Produces: `interface PlatformOps { stopAgent(): Promise<void>; copySelf(dest: string): Promise<void>; registerAutostart(exe: string): Promise<void>; unregisterAutostart(): Promise<void>; registerUninstallEntry(exe: string, icon: string): Promise<void>; removeUninstallEntry(): Promise<void>; startHidden(exe: string): Promise<void>; notify(title: string, text: string): Promise<void> }`; `install(ops: PlatformOps, opts?: {exe?: string}): Promise<{ configWritten: boolean; tokenKept: boolean }>`; `uninstall(ops: PlatformOps, opts?: {purge?: boolean}): Promise<void>`; `status(): Promise<{ installed: boolean; running: boolean }>`. Env `DC_NO_UI=1` makes `notify` a no-op (tests/automation).

- [ ] **Step 1: Write failing tests** with a fake `PlatformOps` and `DC_HOME=tmp`: first install writes `config.json` from embedded config and reports `configWritten:true`; second install keeps the same `deviceToken` (`tokenKept:true`, file bytes unchanged); `stopAgent` is called before `copySelf` and `startHidden` after; install with no token anywhere calls `notify` once with an error and does not register autostart; `uninstall` calls unregister + remove-entry and keeps `audit.jsonl` unless `purge`; paths containing spaces and non-ASCII characters pass through `registerAutostart` unmodified.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement.** `windows.ts`: `reg.exe add HKCU\...\Run /v dc-custom /d "\"<exe>\" --run"`, Uninstall key with `DisplayName`, `DisplayIcon`=`<exe>,0`, `UninstallString`=`"<exe>" --uninstall`; `startHidden` = `spawn(exe,["--run"],{detached:true,windowsHide:true,stdio:"ignore"}).unref()`; `stopAgent` = stop processes whose command line matches the installed exe path (never other `node.exe`); `notify` = hidden PowerShell MessageBox with the icon. `macos.ts`: writes `agent.plist.tpl` to `~/Library/LaunchAgents/com.dc-custom.agent.plist`, `launchctl bootstrap/bootout gui/<uid>`, `osascript` notification. Config written with ACL (`icacls`) / mode 600 only when absent.
- [ ] **Step 4: Run** `npm test` -> PASS.

### Task 8: Windows EXE build

**Files:** Create `scripts/build-windows.mjs`; add devDependencies `esbuild`, `postject`, `resedit`; output `dist/dc-custom-setup.exe`; test `scripts/test/build-windows.test.mjs`.

**Interfaces:**
- Consumes: Task 6 `assets/icon.ico`; Task 4 `parseMode`; build config from `DC_DEVICE_TOKEN` env or the existing `%LOCALAPPDATA%\dc-custom\config.json`, relay URL from the same source.

- [ ] **Step 1: Write failing test** (reads the built exe): PE optional-header Subsystem equals 2; the icon resource group contains the 7 sizes; version info `ProductName` = `dc-custom`; the build log and the exe's strings do not appear in any file under the repo outside `dist/`.
- [ ] **Step 2: Run** -> FAIL (no exe).
- [ ] **Step 3: Implement** the pipeline: esbuild bundle (`platform:node`, `format:cjs`, `target:node22`) -> `sea-config.json` with `assets: {"build-config.json": ...}` -> `node --experimental-sea-config` -> copy `process.execPath` -> `postject ... NODE_SEA_BLOB` with the sentinel fuse -> patch Subsystem byte to 2 -> `resedit` writes icon + version -> `dist/dc-custom-setup.exe`. `.gitignore`/ignore `dist/` and the generated build config.
- [ ] **Step 4: Run** the test -> PASS.
- [ ] **Step 5: Smoke test** in isolation: `DC_HOME=<tmp> DC_NO_UI=1 dist\dc-custom-setup.exe`; expect `config.json`, copied exe, Run key `dc-custom`, a running `dc-custom.exe --run` with `MainWindowHandle = 0` and no `conhost.exe`/`cmd.exe` child; second run keeps the token; `--uninstall` leaves no process and no Run key. (Use a separate `DC_HOME`; the real install at `%LOCALAPPDATA%\dc-custom` must not be touched.)

### Task 9: macOS packaging, connect guide, final checks

**Files:** Create `scripts/build-mac.sh`, `installer/macos/Info.plist` (`LSUIElement`=true, `CFBundleIconFile`=`icon`), `installer/macos/agent.plist.tpl`, `CONNECT.md`; modify `README.md` (one paragraph pointing to the new flow).

- [ ] **Step 1: Write `build-mac.sh`** (esbuild -> SEA with the Mac's `node` -> `codesign --sign -` -> `dc-custom.app/Contents/{MacOS,Resources}` with `iconutil -c icns` from the Task 6 iconset -> zip) and `CONNECT.md` with the MCP URL `https://dc-custom-relay.sufianaser.workers.dev/mcp` and Claude Code / ChatGPT / Antigravity steps, each marked "verify in your client".
- [ ] **Step 2: Verify what is verifiable here:** `bash -n scripts/build-mac.sh`; plist files parse as XML; list the Mac checklist (build, right-click Open, `launchctl list | grep dc-custom`, `device_status` shows the Mac online).
- [ ] **Step 3: Full run:** `device` `npm test`, relay `npx tsc --noEmit` and harness tests, `node scripts/test/*.test.mjs` -> all PASS.
- [ ] **Step 4: Ask the owner before deploying** (`cd relay; npx wrangler deploy`). After the go-ahead, deploy, then verify `/icon.png` (200 `image/png`), `/icon.svg` (200 `image/svg+xml`), `/favicon.ico` (200 `image/x-icon`), and `device_status` after installing the new EXE.
