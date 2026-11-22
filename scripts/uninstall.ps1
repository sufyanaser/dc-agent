[CmdletBinding()]
param([switch]$KeepAudit)
$ErrorActionPreference = "Continue"
$Root = Join-Path $env:LOCALAPPDATA "dc-custom"
Unregister-ScheduledTask -TaskName "dc-custom-device" -Confirm:$false -ErrorAction SilentlyContinue
# Match the exact installed entry point so unrelated node processes are never touched.
$entry = Join-Path $Root "device\dist\src\index.js"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force (Join-Path $Root "device") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $Root "config.json") -ErrorAction SilentlyContinue
if (-not $KeepAudit) { Remove-Item -Force (Join-Path $Root "audit.jsonl") -ErrorAction SilentlyContinue }
Write-Host "Removed dc-custom device agent. Revoke the token on the relay too: npx wrangler secret delete DEVICE_TOKEN" -ForegroundColor Green
