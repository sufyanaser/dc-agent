#!/usr/bin/env bash
# Builds dist/dc-custom.app and dist/dc-custom-mac-<arch>.zip ON A MAC (or a macOS CI runner): one
# double-clickable background app that is both the installer and the agent (Node SEA).
#
#   DC_RELAY_URL="wss://dc-custom-relay.<you>.workers.dev/device" bash scripts/build-mac.sh
#
#   DC_PUBLIC_BUILD=1  no token inside (safe for a release); the app asks for it on first install.
#                      Without it, the script asks for the token (hidden) and embeds it: a private build.
#   NODE_ARCH          arm64 (Apple Silicon) or x64 (Intel). Default: this Mac's architecture.
#   DC_PROFILE         readonly|scoped|full (default readonly); DC_ALLOWED_ROOTS ":" separated, for scoped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DC_RELAY_URL:?set DC_RELAY_URL}"
if [ "${DC_PUBLIC_BUILD:-}" = "1" ]; then
  DC_DEVICE_TOKEN=""
elif [ -z "${DC_DEVICE_TOKEN:-}" ]; then
  read -rsp "Device token: " DC_DEVICE_TOKEN
  echo
fi
export DC_RELAY_URL DC_DEVICE_TOKEN
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
VERSION="$(node -p "require('$ROOT/device/package.json').version")"
case "${NODE_ARCH:-$(uname -m)}" in arm64|aarch64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
APP="$ROOT/dist/dc-custom.app"
ZIP="$ROOT/dist/dc-custom-mac-$NODE_ARCH.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$ROOT/dist"

echo "==> Build tools"
(cd "$ROOT/device" && npm ci --no-audit --no-fund >/dev/null)

echo "==> Icon"
iconutil -c icns "$ROOT/assets/icon.iconset" -o "$TMP/icon.icns"

echo "==> Bundling the agent v$VERSION"
"$ROOT/device/node_modules/.bin/esbuild" "$ROOT/device/src/index.ts" --bundle --platform=node --format=cjs --target=node22 \
  --external:bufferutil --external:utf-8-validate --log-level=warning --outfile="$TMP/agent.cjs"

node -e '
  const roots = (process.env.DC_ALLOWED_ROOTS || "").split(":").filter(Boolean);
  const cfg = { relayUrl: process.env.DC_RELAY_URL, policy: { profile: process.env.DC_PROFILE || "readonly", allowedRoots: roots, approvalMode: "dialog" } };
  if (process.env.DC_DEVICE_TOKEN) cfg.deviceToken = process.env.DC_DEVICE_TOKEN;
  process.stdout.write(JSON.stringify(cfg));' > "$TMP/build-config.json"

cat > "$TMP/sea-config.json" <<EOF
{
  "main": "$TMP/agent.cjs",
  "output": "$TMP/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": false,
  "assets": { "build-config.json": "$TMP/build-config.json", "icon.icns": "$TMP/icon.icns" }
}
EOF
node --experimental-sea-config "$TMP/sea-config.json"

echo "==> Official Node runtime ($NODE_ARCH)"
# Homebrew's node links to /opt/homebrew libraries and breaks on the next `brew upgrade`, so the app embeds
# the self-contained build from nodejs.org, same version as the node that made the SEA blob above.
NODE_VER="$(node -v)"
curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$NODE_ARCH.tar.gz" | tar -xz -C "$TMP"
NODE_BIN="$TMP/node-$NODE_VER-darwin-$NODE_ARCH/bin/node"
if otool -L "$NODE_BIN" | tail -n +2 | grep -v -E '^\s*/(usr/lib|System)/' | grep -q .; then
  echo "Refusing: $NODE_BIN links to non-system libraries" >&2
  exit 1
fi

echo "==> Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$NODE_BIN" "$APP/Contents/MacOS/dc-custom"
codesign --remove-signature "$APP/Contents/MacOS/dc-custom"
"$ROOT/device/node_modules/.bin/postject" "$APP/Contents/MacOS/dc-custom" NODE_SEA_BLOB "$TMP/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE" --macho-segment-name NODE_SEA
cp "$ROOT/installer/macos/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
cp "$TMP/icon.icns" "$APP/Contents/Resources/icon.icns"
codesign --force --deep --sign - "$APP"   # ad-hoc signature: required to run on Apple Silicon

(cd "$ROOT/dist" && rm -f "$ZIP" && ditto -c -k --keepParent dc-custom.app "$ZIP")
echo "Built $APP and $ZIP (v$VERSION, $NODE_ARCH, token $([ -n "$DC_DEVICE_TOKEN" ] && echo EMBEDDED || echo 'not embedded'))"
