# dc-custom: one-command install for Windows. The repo is private, so this runs through GitHub CLI:
#
#   gh api repos/sufyanaser/dc-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | Out-String | iex
#
# It downloads the latest release installer, runs it (first install asks for the device token once),
# and checks that the agent is running. Wrapped in a script block so nothing leaks into your session,
# and it never calls `exit`, which would close your PowerShell window.
& {
  $ErrorActionPreference = "Stop"
  $repo = "sufyanaser/dc-agent"

  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "GitHub CLI is needed: winget install GitHub.cli   then: gh auth login" -ForegroundColor Yellow
    return
  }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Write-Host "Sign in to GitHub first: gh auth login" -ForegroundColor Yellow; return }

  $tag = gh release view --repo $repo --json tagName --jq .tagName
  if ($LASTEXITCODE -ne 0 -or -not $tag) { Write-Host "Could not read the latest release of $repo." -ForegroundColor Red; return }

  $dir = Join-Path $env:TEMP ("dc-custom-install-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force $dir | Out-Null
  try {
    Write-Host "Downloading dc-custom $tag ..."
    gh release download $tag --repo $repo --pattern "dc-custom-setup.exe" --dir $dir --clobber
    if ($LASTEXITCODE -ne 0) { Write-Host "Download failed." -ForegroundColor Red; return }

    Write-Host "Installing (first install asks for your device token) ..."
    $p = Start-Process (Join-Path $dir "dc-custom-setup.exe") -PassThru
    $p.WaitForExit() # waits for the installer only, not the agent it starts
    $log = Join-Path $env:LOCALAPPDATA "dc-custom\agent.log"
    if ($p.ExitCode -ne 0) { Write-Host "The installer reported a problem (exit $($p.ExitCode)). Details: $log" -ForegroundColor Red; return }

    $exe = Join-Path $env:LOCALAPPDATA "dc-custom\dc-custom.exe"
    $running = Get-CimInstance Win32_Process -Filter "Name='dc-custom.exe'" | Where-Object { $_.ExecutablePath -eq $exe }
    if ($running) { Write-Host "dc-custom $tag is installed and running in the background." -ForegroundColor Green }
    else { Write-Host "Installed, but the agent is not running. Details: $log" -ForegroundColor Red }
  }
  finally {
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
