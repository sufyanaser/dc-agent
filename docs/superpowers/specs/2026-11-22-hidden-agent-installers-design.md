# dc-custom: hidden agent, one-file installers, two devices, icon everywhere

Date: 2026-11-22. Status: awaiting approval. Scope: personal use, two devices (Windows PC `SUFYAN`, one Mac).

## Intent and why

The owner wants dc-custom (ChatGPT / Claude Code / any MCP client to the owner's own computers) to feel like a finished product, not a dev setup:

1. The agent runs **with no visible window**, ever.
2. Installation is **one double-click file** per OS (`.exe` on Windows, a double-clickable app on macOS) that does everything: copies the agent, writes the config, starts it hidden, and starts it at every login.
3. After that, the only manual step is connecting an AI tool to the relay URL and signing in with GitHub. The relay already supports this (OAuth + dynamic client registration), so no tool-specific work is needed.
4. **The tool has its icon everywhere**: the installer file, the agent process, Windows "Apps & features", the Mac app, the approval pop-ups, and the MCP connector as shown in AI tools.

## Goals

- No console window at any time on Windows; no Dock icon on macOS (background app).
- One file per OS; re-running it upgrades in place and **keeps the existing device token and config**.
- Both devices online at once, addressable by name.
- Write/delete/exec approvals still work while hidden (native pop-up, deny on timeout).
- One icon design, derived from the existing relay icon, used on every surface.

## Non-goals

- Multi-user or distribution to other people (decided: own devices only).
- Code signing / notarization (see Constraints).
- Auto-update, tray menu, GUI settings screen.
- Changing the OAuth/GitHub login model.

## Anti-goals (a failure even if it technically works)

- Any flashing console window on install or login.
- Re-running the installer silently replacing the token and breaking the relay link.
- A token ending up in a shared/zipped artifact or in git-like history by accident.
- Second device silently kicking the first offline (today's behaviour).

## Constraints found in the code and environment

- `device/src/approval.ts:21`: approvals need `stdin.isTTY`; a hidden process has none, so every approval is denied today.
- `relay/src/device-hub.ts:26`: a new device connection closes all older ones. `mcp.ts` always uses `idFromName("owner")` and `sockets[0]`.
- `device/src/exec.ts` is cross-platform in structure (`/bin/sh` off Windows) but the `exec` tool text, shell enum and the policy allowlists (`dir`, `Get-ChildItem`, ...) are Windows-only.
- `config.ts` already resolves a non-Windows config path (`~/dc-custom/config.json`).
- Relay already serves `/icon.png`, `/icon.svg` and `/favicon.ico` (200, verified live) and declares them in MCP `serverInfo.icons`. `/favicon.ico` currently returns a PNG with `image/png`, not a real `.ico`.
- Toolchain here: Node 24 (`--experimental-sea-config`), npm, Rust, .NET, OpenSSH. No Inno Setup, no NSIS. `wrangler` is logged in to the owner's Cloudflare account.
- A Windows `.exe` cannot be built for macOS from this machine; the Mac artifact must be built on the Mac (script supplied, **not testable from here**).
- An unsigned `.exe` triggers SmartScreen ("unknown publisher") if it arrives with a download mark (browser, chat attachment). Copying by USB/LAN share usually avoids it. Signing is out of scope.

## Approaches considered

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | One executable built with Node SEA from an esbuild bundle. The same file is installer + agent: first run installs itself, later runs (`--run`) are the agent. Config is embedded at build time. | One file, nothing else to install, no extra tool. Console-subsystem patch and icon resource are done by a small build script. |
| B | Separate native installer (Rust/.NET) plus bundled Node. | Nicer installer UI, but two artifacts and a second codebase for little gain. |
| C | Inno Setup / NSIS wrapper. | Polished setup wizard, but needs installing a new tool and still needs A's agent binary inside. |

Chosen by the owner: A, with both devices connected at the same time.

## Design

### 1. Agent (`device/`)

- **Hidden mode:** the Windows build is patched to the GUI subsystem, so no console is ever allocated. Logging moves from stderr to `%LOCALAPPDATA%\dc-custom\agent.log` (macOS: `~/Library/Logs/dc-custom/agent.log`), size-capped with one rotation. All `process.stdout/stderr` writes are guarded.
- **Single instance:** lock file with PID liveness check; a second start exits quietly.
- **Approvals:** new `approvalMode: "dialog"` (default for installed builds). Windows: a topmost WinForms dialog (app icon, tool + summary, Allow / Deny) launched hidden via PowerShell. macOS: `osascript display dialog` with the app icon. Timeout = `approvalTimeoutSec`, then deny. Requests stay serialized (existing queue). `console` and `deny` modes remain for dev/tests.
- **Cross-platform:** `exec` tool uses `shell: "powershell"|"cmd"|"sh"`; default is PowerShell on Windows and `sh` on macOS. Per-OS allowlist defaults (macOS: `ls`, `cat`, `grep`, `git`, `node`, `npm`, `python3`, `whoami`, `pwd`, ...). Existing behaviour on Windows is unchanged.
- **Config:** precedence = env vars > `config.json` on disk > embedded build config. `DC_HOME` env var overrides the install root (used for isolated testing). `deviceId` defaults to the hostname.
- **Profile:** installed builds keep the owner's current profile (`readonly`) unless the build config says otherwise; changing it later = edit `config.json` and restart. Allowed roots are set the same way. (Builder's call; flagged below.)

### 2. Relay (`relay/`)

- `DeviceHub` keeps **all** device sockets, tagged with their `deviceId` (`acceptWebSocket(server, [deviceId])`). A reconnect with the same `deviceId` replaces only that device's old socket; other devices stay up. Per-device `hello` is stored under `hello:<deviceId>`.
- Every device tool gets an optional `device` string. Routing: named device if given; else the only online device; else an error listing online device names ("specify `device`").
- `device_status` lists all known devices with `online`, `profile`, `tools`, `version`.
- Same single `DEVICE_TOKEN` is accepted from both devices (personal use).
- `/favicon.ico` serves a real multi-size `.ico` (`image/x-icon`); `/icon.png` and `/icon.svg` unchanged. `serverInfo.icons` unchanged (already declared).
- Needs `wrangler deploy` to take effect. **I will ask right before deploying**, because it changes the live service your tools already use.

### 3. Windows EXE (`installer/windows/`, build script)

- Build: `esbuild` bundle -> Node SEA blob -> copy of `node.exe` + inject (postject) -> patch subsystem to GUI -> embed version info and the multi-size `.ico` with `resedit` (pure JS) -> `dist\dc-custom-setup.exe`.
- Embedded asset: build config (relay URL, token, profile). Token source at build time: the existing `%LOCALAPPDATA%\dc-custom\config.json` or `DC_DEVICE_TOKEN`; never written into the repo or logs.
- Behaviour:
  - Double-click (no args) = install: copy self to `%LOCALAPPDATA%\dc-custom\dc-custom.exe`, write `config.json` only if absent (keep token on re-run; ACL restricted to the current user), register autostart in `HKCU\...\Run`, register `HKCU\...\Uninstall\dc-custom` with `DisplayIcon` so it shows with its icon in Settings > Apps, start the agent hidden, then show one small confirmation dialog ("dc-custom installed. Running in the background.") with the icon.
  - `--run`: agent mode. `--uninstall`: stop process, remove autostart/uninstall keys and files (keeps `audit.jsonl` unless `--purge`). `--status`: prints state to a dialog or, if a console is attached, stdout.
  - Idempotent and safe to run twice.

### 4. macOS (`installer/macos/`, built on the Mac)

- `build-mac.sh` (run once on the Mac with Node installed): same esbuild + SEA flow with the Mac's own `node`, ad-hoc `codesign`, wraps the binary as `dc-custom.app` (`LSUIElement=true`, so no Dock icon) with an `.icns` icon, optionally zipped.
- Double-click `dc-custom.app` (first time: right-click > Open, because it is not notarized) = install: copy to `~/Applications`, write config if absent (mode 600), install `~/Library/LaunchAgents/com.dc-custom.agent.plist` (RunAtLoad, KeepAlive), start it.
- Same flags as Windows. Config embedded at build time from the same build config.
- **Not tested by me**; I deliver it plus a checklist, and you tell me the result.

### 5. Icons (one design, every surface)

Source of truth: the existing SVG (indigo rounded square with white `>_`). Generated by one script:

| Surface | Asset |
|---|---|
| Windows installer/agent EXE, Explorer, taskbar | multi-size `.ico` (16/24/32/48/64/128/256) embedded as the PE icon |
| Settings > Apps entry | same `.ico` via `DisplayIcon` |
| Approval / confirmation dialogs | same `.ico` on the dialog window |
| macOS app, Finder, approval dialogs | `.icns` (via `iconutil` on the Mac) |
| MCP connector in AI tools | existing `/icon.png` + `/icon.svg` in `serverInfo.icons`; `/favicon.ico` becomes a real ICO |

Honest limit: whether each AI tool *shows* the declared MCP icon depends on that tool. The relay side (declared + reachable) I can verify; the rendering in ChatGPT / Claude / Antigravity I can only check where you tell me what you see.

### 6. Connecting the tools (docs only)

A short `CONNECT.md` with the MCP URL `https://dc-custom-relay.sufianaser.workers.dev/mcp` and per-tool steps (Claude Code via `claude mcp add --transport http`, ChatGPT developer-mode connector, Antigravity/other MCP clients via their remote-server config), each noted as "verify in your client". GitHub sign-in stays locked to `sufyanaser`.

### 7. Security notes

- The built installer contains the device token. Treat it like a password: don't upload or share it. Build output goes to a git-ignored `dist/` folder. Anyone holding the token can register a device to your relay (they still can't use your GitHub OAuth).
- Hidden does not mean unaudited: `audit.jsonl` keeps working; the dialog approvals are logged like console approvals.
- `full` profile semantics unchanged.

## Verification plan (what "done" means)

Windows, on this machine, using `DC_HOME` to avoid touching the live install:

1. Unit tests: multi-device routing, approver (dialog backend stubbed), config precedence. Existing 20 tests still pass.
2. Relay test with two fake devices on `wrangler dev` (extend the existing harness): both online, routing by name, default routing, reconnect of one doesn't drop the other.
3. Build `dc-custom-setup.exe`; confirm: PE subsystem = GUI, icon resource present (extracted and compared), version info present.
4. Run it install -> verify files, autostart key, running process with **no window and no conhost child**, connection to relay (`device_status` shows it online), re-run keeps token, `--uninstall` leaves nothing running.
5. Deploy relay (after your go-ahead) and check `/icon.png`, `/icon.svg`, `/favicon.ico` headers and `device_status`.

Not verifiable by me: macOS build/install, how each AI client renders the icon, SmartScreen behaviour on your second machine.

## Calls I made (change any)

- Default profile stays `readonly` (your current setting); installer does not widen access.
- One shared token for both devices; devices are told apart by name.
- macOS delivered as a `.app` built on the Mac, not a `.pkg`.
- Autostart via `HKCU\Run` (no admin rights needed) rather than a Scheduled Task; crash recovery comes from the agent's own reconnect loop.
- Build config (relay URL, token, profile) is embedded at build time, not typed at install time.
