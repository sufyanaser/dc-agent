# SDD ledger — plan: docs/superpowers/plans/2026-11-22-hidden-agent-installers.md
Ruling: not a git repo, so no worktree/commits/task scripts; ledger kept by hand, work in place — nothing to isolate or commit to — cost if wrong: no rollback (mitigated by dc-custom*.zip backups already in the parent folder)
Pre-flight: T1 produces dcHome/configPath/logPath/embeddedConfig/loadConfig -> consumed by T4 (log path), T7 (install paths); T2 approvalMode 'dialog' -> consumed by T3/T4; T3 Approver(mode,timeout,runner) -> T4 index.ts; T4 parseMode -> T7/T8; T5 hub.call(tool,args,device) -> mcp.ts; T6 assets/icon.ico -> T8 resedit, T9 iconset. No conflicts found.
Task 1: complete (tests: npm test in device -> 26/26)
Task 2: complete (tests: npm test in device -> 31/31). Ruling: tools.ts proc_list/proc_kill already had non-Windows branches, only exec shell enum/default changed — spec only requires per-OS defaults — none
Ruling: defaultShell/resolveShell live in exec.ts (not policy.ts as plan said) — they are about shells, not policy — none
Task 3: complete (tests: npm test in device -> 36/36; Windows dialog script parses with 0 errors; real dialog not clicked yet — macOS osascript path untested)
Task 4: complete (tests: npm test in device -> 45/45). Ruling: lock file records pid + boot time and treats a pre-reboot lock as stale — a reused pid after reboot would otherwise block the agent forever at login (Review Focus 2) — none
Ruling: uncaughtException/unhandledRejection are logged and the agent keeps running — Windows HKCU Run has no restarter, so exiting would leave the device offline until next login — a corrupt state could persist until restart
Ruling: index.ts install/uninstall/status branch is a stub until Task 7 wires it — none
Task 5: complete (tests: node --test test/devices.test.mjs in relay -> 7/7; npx tsc --noEmit clean). Ruling: relay test is a wrangler-dev integration test (.mjs) instead of extending only the harness — the hub needs a real Durable Object runtime — needs ~10s startup
Ruling: /status now returns {online, devices[]} (was {online, device}) — multi-device; only README mentions it
Ruling: MCP serverInfo.version bumped to 0.2.0 — tool schema changed (device arg) — none
Task 6: complete (tests: node --test scripts/test/icons.test.mjs -> 3/3; relay tsc clean). Ruling: ICO base64 is generated into a marked block inside relay/src/icon.ts (not a separate file) and iconResponse() lives there so it is unit-testable in plain Node — none
Task 7: complete (tests: npm test in device -> 54/54; notice PowerShell script parses clean). Ruling: windows.ts/macos.ts side-effect calls (reg, taskkill, icacls, launchctl) are verified by the Task 8 smoke test (Windows) / user checklist (macOS), not unit tests; only launchAgentPlist is unit-tested — they are thin wrappers over OS tools — a Windows quirk would show up in the smoke test
Ruling: InstallResult gained ok/error fields beyond the plan's {configWritten, tokenKept} — callers need to know failure — none
Ruling: plist is generated in code (launchAgentPlist) instead of an installer/macos/agent.plist.tpl file — a SEA binary cannot read repo files at runtime — none
Ruling: Windows stopAgent uses taskkill by image name with PID-ne-self filter instead of command-line matching — simpler, still excludes the installer itself — would also kill a different program named dc-custom.exe
Task 8 (build part): build-windows.mjs builds dist\dc-custom-setup.exe (89.8 MB); scripts/test/build-windows.test.mjs 5/5 expected after this run. Ruling: resedit-first then postject order works; the exe runs as SEA (embedded config read) although postject prints 'Relocation corrupted: BlockSize out of bound' — LIEF warning, exe verified to run via --check — verify again in smoke test
Ruling: build test allowlists project\New Text Document.txt (owner scratch file that contains the device token, created at 20:04 during this session) — it is not produced by the build — token sits in plain text in the project folder; reported to owner
Task 9: files done (build-mac.sh bash -n OK, Info.plist + generated LaunchAgent parse as XML, CONNECT.md in Arabic, README section). Final suite: device 54/54, relay devices 7/7 + tsc clean, icons 3/3, build-windows 5/5. Ruling: macOS copySelf also runs xattr -c and codesign --sign - on the copied binary — a binary copied out of its signed .app would otherwise be refused on Apple Silicon / blocked by quarantine — untested on a Mac
Ruling: CONNECT.md written in Arabic (owner's language), README section in English (README's language) — none
Final review: dispatched to a fresh reviewer (opus)
Final review: fresh reviewer (opus) — 0 Critical, 9 Important, 13 Minor.
Final: fixed #1 stale pid lock (Fast Startup / pid reuse) — replaced lock.ts with instance.ts (named pipe / unix socket released by the OS) — instance.test.ts 'a killed holder releases the instance' RED->GREEN, suite 61/61
Final: fixed #2 macOS restart loop — KeepAlive SuccessfulExit=false, config errors exit 0 — review-fixes 'LaunchAgent restarts only after a crash' RED->GREEN
Final: fixed #3 mac log folder not created before launchd — mkdir in registerAutostart — no unit test (macOS side effect), untested on a Mac
Final: fixed #4 non-ASCII account breaks icacls / leaves unprotected config — grant by SID (parseWhoamiSid) + remove config written in a failed run — review-fixes parseWhoamiSid + installer 'locking down config.json fails' RED->GREEN
Final: fixed #5 approval outliving relay timeout — deadline from arrival, capped at 80s, expired queued requests denied — review-fixes 2 tests RED->GREEN
Final: fixed #6 'installed' claimed without checking — config validated before touching the install, agentStarted() verified after start — installer 2 tests RED->GREEN
Final: fixed #7 same-deviceId ping-pong — 4001 backs off to 30s; Windows installer stops the legacy node agent — relay-client.test RED->GREEN
Final: fixed #8 mac binary copied out of .app — whole .app copied to ~/Applications with ditto; CONNECT.md documents Files and Folders access — review-fixes installedExePath('darwin') RED->GREEN
Final: fixed #9 Homebrew node in Mac build — build-mac.sh downloads the official nodejs.org binary and refuses non-system links — bash -n only, untested on a Mac
Final: Ruling: token in shell history (reviewer Minor) re-graded Important (spec anti-goal) — build-mac.sh prompts with read -rs — none
Final: Ruling: outdated Gatekeeper step in CONNECT.md (reviewer Minor) re-graded Important (owner would be stuck) — doc fixed — none
Final: minor (deferred): Mac binary/app readable by other local accounts (token embedded)
Final: minor (deferred): corrupt config.json silently replaced by embedded config (no .bak)
Final: minor (deferred): spawn() in startHidden/removeFile has no 'error' listener
Final: minor (deferred): taskkill without /T can orphan an open approval dialog on reinstall
Final: minor (deferred): deviceId matching is exact/case-sensitive; ids >100 chars silently ignored
Final: minor (deferred): agent reports version 0.1.0 while build/Apps entry say 0.2.0
Final: minor (deferred): old.close(4001) in device-hub not wrapped in try
Final: minor (deferred): LaunchAgent ProcessType Background may throttle; Adaptive fits better
Final: minor (deferred): Arabic text via AppleScript 'system attribute', PNG-in-ICO in System.Drawing.Icon, dialog DPI/RTL not verified
Task 8: complete (smoke test of the real dist\dc-custom-setup.exe in an isolated DC_HOME with spaces + Arabic, against a local wrangler harness: 20/20 PASS — no window, no console child, Run key, Apps entry, tool call, re-install keeps token, uninstall clean). Final: fixed smoke-found bug: delayed self-delete used a detached PowerShell that never starts from a windowless parent — switched to cmd — smoke 'config and exe removed' FAIL->PASS, suite 61/61
Deploy: relay deployed with owner's go-ahead (version f72aa341-bfb8-4ab7-9e0b-19b5c1367d00). Live checks: /icon.png 200 image/png, /icon.svg 200 image/svg+xml, /favicon.ico 200 image/x-icon (bytes = assets/icon.ico), /mcp and /status 401 without token, /status with token returns new {online, devices[]} shape (0 devices until the new agent connects).
Install: owner approved; dist\dc-custom-setup.exe installed on this PC (LOCALAPPDATA\dc-custom). Agent hidden (no window), Run key + Apps entry present, existing config/token kept, live relay /status shows SUFYAN online, profile readonly, 5 tools.
