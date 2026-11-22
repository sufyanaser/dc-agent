#!/usr/bin/env bash
# dc-custom: one-command install for macOS. The repo is private, so this runs through GitHub CLI:
#
#   gh api repos/sufyanaser/dc-agent/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#
# Downloads the latest release for this Mac (Apple Silicon or Intel) and opens it; the app copies itself to
# ~/Applications, asks for the device token on first install, and starts in the background at every login.
set -euo pipefail
REPO="sufyanaser/dc-agent"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is needed: brew install gh   then: gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in to GitHub first: gh auth login"; exit 1; }

case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading dc-custom $TAG ($ARCH) ..."
gh release download "$TAG" --repo "$REPO" --pattern "dc-custom-mac-$ARCH.zip" --dir "$TMP"
ditto -x -k "$TMP/dc-custom-mac-$ARCH.zip" "$TMP"
xattr -cr "$TMP/dc-custom.app"

echo "Installing (first install asks for your device token) ..."
open -W "$TMP/dc-custom.app"

if launchctl list | grep -q com.dc-custom.agent; then
  echo "dc-custom $TAG is installed and running in the background."
else
  echo "Installed, but the agent is not running. Details: ~/Library/Logs/dc-custom/agent.log"
  exit 1
fi
