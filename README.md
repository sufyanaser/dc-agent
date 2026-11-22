# dc-custom

ChatGPT ↔ your Windows PC bridge, with a permission model you control.

```
ChatGPT (custom MCP connector, OAuth)
   │  HTTPS  /mcp
   ▼
Cloudflare Worker  (OAuth via GitHub, login locked to one account)
   │  Durable Object DeviceHub (hibernatable WebSocket)
   ▲  outbound WSS  /device   (Bearer DEVICE_TOKEN)
   │
dc-device  (Node 22, runs on your PC, no inbound port)
   └─ policy → audit → tools (fs_*, exec, proc_*)
```

The PC dials out, so nothing listens on your network. The Worker is the trust boundary: anyone holding a valid ChatGPT token for your login can drive the device, within the device's profile.

## Layout

| Path | What |
| --- | --- |
| `device/` | Device agent (TypeScript). Policy, audit, approvals, 11 tools, WebSocket client. |
| `relay/` | Cloudflare Worker: MCP endpoint, OAuth authorize/callback, `DeviceHub` Durable Object. |
| `scripts/` | Windows PowerShell: `install.ps1`, `run.ps1`, `uninstall.ps1`, `configure-relay.ps1`. |

## Profiles

| Profile | Files | Process/terminal | Approvals | Notes |
| --- | --- | --- | --- | --- |
| `full` | anywhere | any command | none | Audit logs full arguments. Filesystem roots and home folder are still refused for delete. |
| `scoped` | `allowedRoots` only | allowlist, no chaining | write, delete, move, exec, kill | Default. Blocks `.env`, keys, `.ssh`, `.aws`. |
| `readonly` | read only | read-only allowlist | n/a | No write, move, delete, exec or kill tools reach the device. |

Every policy field is in `device/config.example.json`. Change the profile without rebuilding anything: edit `config.json`, restart the agent.

## Install with one command

Needs GitHub CLI signed in to an account that can read this private repo (`gh auth login`).

Windows (PowerShell):

```powershell
gh api repos/sufyanaser/dc-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | Out-String | iex
```

macOS (Terminal):

```bash
gh api repos/sufyanaser/dc-agent/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

Both download the latest release and run it. The first install on a computer asks for the device token once; later runs upgrade in place without asking.

## Releases

Pushing a tag `v*` runs `.github/workflows/release.yml`: it tests the agent, builds `dc-custom-setup.exe` on Windows and `dc-custom.app` (arm64 + x64) on macOS, and publishes them as a GitHub release. These are **public builds**: no device token inside; the first install on each computer asks for it. Local private builds (token embedded) are still possible with the commands below.

The agent also runs local MCP servers as **bridges** and exposes each at its own connector URL, `/mcp/<bridge>`. Figwright is enabled by default (`/mcp/figwright`); configure or disable bridges with `"bridges"` in `config.json`.

## One-file installers (recommended)

After the relay is deployed and one device token exists, build a single installer per OS. Each file is both the installer and the agent, runs with no window, starts at login, and has the dc-custom icon:

```powershell
node scripts/make-icons.mjs          # icons from relay/src/icon.ts (once, or after changing the icon)
node scripts/build-windows.mjs       # -> dist/dc-custom-setup.exe (token read from %LOCALAPPDATA%\dc-custom\config.json or DC_DEVICE_TOKEN)
```

On the Mac: `DC_RELAY_URL=... bash scripts/build-mac.sh` (it asks for the token, hidden) -> `dist/dc-custom.app`. Both devices can be online at once; tools take an optional `device` argument. How to connect Claude Code, Claude, ChatGPT and other MCP clients: see [CONNECT.md](CONNECT.md). The built installer embeds the device token: do not share it.

## Setup (Windows, manual scripts)

Prerequisites: Node.js 22+, a Cloudflare account (free plan works), a GitHub account, a ChatGPT plan that supports custom MCP connectors in developer mode.

1. Install the agent (PowerShell):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 `
     -RelayUrl "wss://dc-custom-relay.YOUR-SUBDOMAIN.workers.dev/device" `
     -Profile scoped -AllowedRoots "C:\Users\YOU\Projects"
   ```
   Save the printed token.
2. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps). Callback URL: `https://dc-custom-relay.YOUR-SUBDOMAIN.workers.dev/callback`.
3. Configure and deploy the relay:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\configure-relay.ps1 `
     -WorkerUrl "https://dc-custom-relay.YOUR-SUBDOMAIN.workers.dev" -GithubLogin YOUR_GITHUB_LOGIN
   cd relay
   npm install
   npx wrangler login
   npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put DEVICE_TOKEN          # the token from step 1
   npx wrangler deploy
   ```
4. Start the agent in a visible window (approvals need the console):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\run.ps1
   ```
5. In ChatGPT: Settings → Apps → Advanced → Developer mode → create a connector with URL `https://dc-custom-relay.YOUR-SUBDOMAIN.workers.dev/mcp`, then authorize it with GitHub.

Check the device is online: `https://<worker>/status` with `Authorization: Bearer <DEVICE_TOKEN>`.

## Tools

`fs_list`, `fs_stat`, `fs_read`, `fs_write`, `fs_edit`, `fs_move`, `fs_delete`, `fs_search`, `exec`, `proc_list`, `proc_kill`, plus relay-side `device_status`.

`fs_write` and `fs_edit` are atomic (temp file, then rename). `fs_edit` requires exactly one match. `exec` runs in PowerShell by default and kills the whole process tree on timeout.

## Audit

Every decision is one JSON line in `audit.jsonl`: tool, category, arguments, decision (`allowed`, `denied`, `approved`, `rejected`), outcome, duration. In `scoped` and `readonly` the arguments of long strings are reduced to their length, so file contents are not logged.

## Security notes

- Revoke access fast: `npx wrangler secret delete DEVICE_TOKEN` cuts the device; revoke the GitHub OAuth App to cut ChatGPT.
- Rotate the device token: generate a new 48-byte random value, put it in `%LOCALAPPDATA%\dc-custom\config.json` (`deviceToken`), then run `npx wrangler secret put DEVICE_TOKEN` in `relay\`. Restart the agent.
- `full` means full: a leaked token equals control of the PC. Keep the Worker URL private and prefer `scoped`.
- The Worker stores no file contents. Command output and file bytes pass through it in transit only.
- Limits of the Cloudflare free plan (100k requests/day, 10 ms CPU per request) apply to the relay.

## Tests

```powershell
cd device; npm install; npm test        # 20 tests: policy, dispatch, audit, WebSocket protocol
cd relay; npx tsc --noEmit              # typecheck
```

End-to-end run performed on Linux against `wrangler dev`: real device agent, Durable Object, and the MCP endpoint (`initialize`, `tools/list`, `tools/call`). Not yet verified: Windows execution of PowerShell scripts and `exec`/`proc_*` on Windows, the GitHub OAuth round trip, and ChatGPT's connector handshake against a deployed Worker.
