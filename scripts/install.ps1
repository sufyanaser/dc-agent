<#
.SYNOPSIS
  Installs dc-custom device agent on this Windows PC.
.DESCRIPTION
  - Checks Node.js >= 22
  - Copies the device agent to %LOCALAPPDATA%\dc-custom\device
  - Installs production dependencies
  - Generates a device token and writes config.json
  - Optionally registers an at-logon Scheduled Task (headless; approvals then auto-deny)
.PARAMETER RelayUrl
  wss://<your-worker>.workers.dev/device
.PARAMETER Profile
  full | scoped | readonly  (default: scoped)
.PARAMETER AllowedRoots
  Folders the scoped profile may touch, e.g. "C:\Work","D:\Projects"
.PARAMETER ApprovalMode
  console | deny  (default: console)
.PARAMETER Autostart
  Register a Scheduled Task that starts the agent at logon. Requires -ApprovalMode deny,
  because a headless task has no window for console approvals.
.PARAMETER RotateToken
  Generate a new device token even if an install already exists. Without this switch a
  re-run keeps the existing token, so the relay secret stays valid.
.PARAMETER NoPrintToken
  Copy a newly generated token to the clipboard instead of printing it to the console.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RelayUrl,
  [ValidateSet("full", "scoped", "readonly")][string]$Profile = "scoped",
  [string[]]$AllowedRoots = @(),
  [ValidateSet("console", "deny")][string]$ApprovalMode = "console",
  [switch]$Autostart,
  [switch]$RotateToken,
  [switch]$NoPrintToken
)

$ErrorActionPreference = "Stop"
$Root = Join-Path $env:LOCALAPPDATA "dc-custom"
$Target = Join-Path $Root "device"
$Source = Join-Path $PSScriptRoot "..\device"
$ConfigPath = Join-Path $Root "config.json"
$TaskName = "dc-custom-device"

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

Write-Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Install Node.js 22 LTS from nodejs.org and reopen PowerShell." }
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node.js $major found, 22 or newer required." }

if ($RelayUrl -notmatch '^wss://') { throw "RelayUrl must start with wss://" }
if ($Profile -eq "scoped" -and $AllowedRoots.Count -eq 0) {
  throw "Profile 'scoped' needs -AllowedRoots (e.g. -AllowedRoots 'C:\Work')."
}
if ($Autostart -and $ApprovalMode -eq "console") {
  throw "-Autostart runs headless, so console approvals would all time out and be denied. Add -ApprovalMode deny, or drop -Autostart and use scripts\run.ps1."
}
if (-not (Test-Path (Join-Path $Source "dist\src\index.js"))) {
  throw "No built agent at $Source\dist. Run 'npm ci; npm run build' in the device folder first (or use the prebuilt dc-custom-windows package)."
}

Write-Step "Copying agent to $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $Source "dist") -Destination $Target -Recurse -Force
Copy-Item -Path (Join-Path $Source "package.json") -Destination $Target -Force
Copy-Item -Path (Join-Path $Source "package-lock.json") -Destination $Target -Force -ErrorAction SilentlyContinue

Write-Step "Installing production dependencies"
Push-Location $Target
try {
  if (Test-Path "package-lock.json") { npm ci --omit=dev --no-audit --no-fund } else { npm install --omit=dev --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally { Pop-Location }

Write-Step "Generating device token and config"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$token = $null
$tokenIsNew = $true
if ((Test-Path $ConfigPath) -and -not $RotateToken) {
  try { $token = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).deviceToken } catch { $token = $null }
  if ($token) { $tokenIsNew = $false; Write-Host "Existing install found: keeping the current device token (use -RotateToken to replace it)." -ForegroundColor Yellow }
}
if (-not $token) {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$policy = [ordered]@{
  profile          = $Profile
  allowedRoots     = @($AllowedRoots | ForEach-Object { [IO.Path]::GetFullPath($_) })
  approvalMode     = $ApprovalMode
  approvalTimeoutSec = 120
  auditLog         = (Join-Path $Root "audit.jsonl")
  auditContent     = ($Profile -eq "full")
  maxOutputBytes   = 1000000
}
$config = [ordered]@{
  relayUrl    = $RelayUrl
  deviceToken = $token
  deviceId    = $env:COMPUTERNAME
  policy      = $policy
}
$config | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -Path $ConfigPath
# Use the full DOMAIN\user identity: the bare $env:USERNAME can resolve to the wrong principal.
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $ConfigPath /inheritance:r /grant:r "${me}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict permissions on $ConfigPath (icacls exit $LASTEXITCODE). The config holds the device token; fix this before continuing." }

if ($Autostart) {
  Write-Step "Registering Scheduled Task '$TaskName' (at logon)"
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$Target\dist\src\index.js`"" -WorkingDirectory $Target
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Autostart enabled (headless, approvals auto-deny). Use run.ps1 for interactive approvals." -ForegroundColor Yellow
}

Write-Host ""
if (-not $tokenIsNew) {
  Write-Host "Installed. Device token unchanged, so the relay secret is still valid." -ForegroundColor Green
} elseif ($NoPrintToken) {
  Set-Clipboard -Value $token
  Write-Host "Installed. The new device token is on your clipboard (not printed). Paste it into 'wrangler secret put DEVICE_TOKEN', then clear the clipboard." -ForegroundColor Green
} else {
  Write-Host "Installed. Save this device token now:" -ForegroundColor Green
  Write-Host $token -ForegroundColor Yellow
  Write-Host "(It is also stored in $ConfigPath.)"
}
Write-Host ""
Write-Host "Set it on the relay with:  npx wrangler secret put DEVICE_TOKEN   (paste the token above)"
Write-Host "Start the agent with:      powershell -ExecutionPolicy Bypass -File scripts\run.ps1"
