# Starts the device agent in this visible window (required for console approvals).
$ErrorActionPreference = "Stop"
$Target = Join-Path $env:LOCALAPPDATA "dc-custom\device"
if (-not (Test-Path (Join-Path $Target "dist\src\index.js"))) { throw "Agent not installed. Run scripts\install.ps1 first." }
$env:DC_CONFIG = Join-Path $env:LOCALAPPDATA "dc-custom\config.json"
Set-Location $Target
# Absolute entry path, so uninstall.ps1 can find and stop this process by its command line.
node (Join-Path $Target "dist\src\index.js")
