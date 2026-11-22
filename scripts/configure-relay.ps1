<#
.SYNOPSIS
  Writes your Worker URL and GitHub login into the relay config, then prints deploy steps.
  Safe to re-run: it rewrites the current values, not a one-time placeholder.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$WorkerUrl,   # https://dc-custom-relay.<your-subdomain>.workers.dev
  [Parameter(Mandatory = $true)][string]$GithubLogin
)
$ErrorActionPreference = "Stop"
if ($WorkerUrl -cnotmatch '^https://[a-z0-9.-]+$') { throw "WorkerUrl must be lowercase https://host with no path." }
# GitHub logins: 1-39 chars, alphanumeric or single hyphens, no leading/trailing hyphen.
if ($GithubLogin -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$') { throw "GithubLogin '$GithubLogin' is not a valid GitHub username." }

$relay = Join-Path $PSScriptRoot "..\relay"
if (-not (Test-Path $relay)) { throw "Relay folder not found at $relay. Run this from the full project, not the Windows device package." }
$origin = $WorkerUrl.TrimEnd("/")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Literal replacement via evaluator, so '$' in a value is never treated as a backreference.
function Set-Literal([string]$Text, [string]$Pattern, [string]$Replacement, [string]$What) {
  $re = [regex]$Pattern
  if (-not $re.IsMatch($Text)) { throw "Could not find $What to update. The file layout may have changed." }
  return $re.Replace($Text, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $Replacement }, 1)
}

$originFile = (Resolve-Path (Join-Path $relay "src\origin.ts")).Path
$text = [IO.File]::ReadAllText($originFile)
$text = Set-Literal $text 'export const PUBLIC_ORIGIN = "[^"]*";' ('export const PUBLIC_ORIGIN = "' + $origin + '";') "PUBLIC_ORIGIN in origin.ts"
[IO.File]::WriteAllText($originFile, $text, $utf8NoBom)

$wr = (Resolve-Path (Join-Path $relay "wrangler.jsonc")).Path
$text = [IO.File]::ReadAllText($wr)
$text = Set-Literal $text '"PUBLIC_ORIGIN": "[^"]*"' ('"PUBLIC_ORIGIN": "' + $origin + '"') "PUBLIC_ORIGIN in wrangler.jsonc"
$text = Set-Literal $text '"ALLOWED_GITHUB_LOGIN": "[^"]*"' ('"ALLOWED_GITHUB_LOGIN": "' + $GithubLogin + '"') "ALLOWED_GITHUB_LOGIN in wrangler.jsonc"
[IO.File]::WriteAllText($wr, $text, $utf8NoBom)

Write-Host "Configured $origin for $GithubLogin." -ForegroundColor Green
Write-Host @"

Next steps (run inside relay\):
  1. npx wrangler login
  2. npx wrangler kv namespace create OAUTH_KV        -> put the returned id into wrangler.jsonc
  3. npx wrangler secret put GITHUB_CLIENT_ID
  4. npx wrangler secret put GITHUB_CLIENT_SECRET
  5. npx wrangler secret put DEVICE_TOKEN             -> paste the token from install.ps1 (or copy it from %LOCALAPPDATA%\dc-custom\config.json)
  6. npx wrangler deploy
GitHub OAuth App callback URL must be: $origin/callback
"@
