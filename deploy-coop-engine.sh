#!/bin/zsh
# Build + deploy @deepseek-ai/dsh-coop into the dsh-tui profile as a suffixed engine tarball.
#
# Why this script exists: the runtime loads lib/index.js (a tsdown bundle of
# lib/types/index.js), NOT the tsc-emitted lib/types/*.js. Deploying after
# `tsc -b` alone ships a stale bundle — every feature silently missing (the
# engine04-10 incident). This script always runs BOTH build steps and
# fingerprint-verifies the bundle BEFORE packing and AFTER installing.
#
# Usage: ./deploy-coop-engine.sh [engine-suffix]   (default: auto-increment engine<N>)

set -euo pipefail

REPO_ROOT="${0:A:h}"
PKG_DIR="$REPO_ROOT/packages/coop/coop"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/dsh-tui}"
TSDOWN="$REPO_ROOT/node_modules/.bin/tsdown"
TSC="$REPO_ROOT/node_modules/typescript/bin/tsc"

# Feature fingerprints that must exist in the BUNDLE (lib/index.js) — extend as features land.
FINGERPRINTS=(liveMasters coop_handoff deadPane contextHard skillMatch contextHandoffAt)

check-fingerprints() {
  local file="$1" label="$2" missing=0
  for key in "${FINGERPRINTS[@]}"; do
    if ! grep -q "$key" "$file"; then
      echo "✗ $label: fingerprint '$key' missing from $file" >&2
      missing=1
    fi
  done
  if (( missing )); then
    echo "✗ $label failed — refusing to continue (stale bundle?)" >&2
    exit 1
  fi
  echo "✓ $label: all ${#FINGERPRINTS} fingerprints present"
}

# Resolve the engine suffix: explicit arg, else highest existing engine<N> + 1.
VERSION="$(node -e "console.log(require('$PKG_DIR/package.json').version)")"
if [[ -n "${1:-}" ]]; then
  SUFFIX="$1"
else
  LAST=$(ls "$PKG_DIR" | grep -oE "deepseek-ai-dsh-coop-${VERSION//./\\.}-engine([0-9]+)" | grep -oE '[0-9]+$' | sort -n | tail -1)
  SUFFIX="engine$(( ${LAST:-0} + 1 ))"
fi
TGZ_NAME="deepseek-ai-dsh-coop-${VERSION}-${SUFFIX}.tgz"
TGZ="$PKG_DIR/$TGZ_NAME"

echo "── build (tsc → lib/types, tsdown → lib/index.js bundle) ──"
node --max-old-space-size=4096 "$TSC" -b "$PKG_DIR/tsconfig.json"
(cd "$REPO_ROOT" && "$TSDOWN" --env.DSH_BUILD_FACE host >/dev/null)
check-fingerprints "$PKG_DIR/lib/index.js" "repo bundle"

echo "── pack $TGZ_NAME ──"
rm -f "$PKG_DIR/deepseek-ai-dsh-coop-${VERSION}.tgz"
(cd "$PKG_DIR" && pnpm pack --pack-destination . >/dev/null)
mv "$PKG_DIR/deepseek-ai-dsh-coop-${VERSION}.tgz" "$TGZ"

echo "── install into $PROFILE_DIR ──"
sed -i '' -E "s|deepseek-ai-dsh-coop-${VERSION//./\\.}-engine[0-9]+\\.tgz|$TGZ_NAME|g" "$PROFILE_DIR/package.json"
(cd "$PROFILE_DIR" && pnpm add "file:$TGZ" >/dev/null)
check-fingerprints "$PROFILE_DIR/node_modules/@deepseek-ai/dsh-coop/lib/index.js" "installed bundle"

echo "✓ deployed $TGZ_NAME"
echo "⚠ Running dsh-tui panes still hold the old code in memory — restart each pane:"
echo "    herdr pane send-keys <pane> C-c; sleep 1; herdr pane send-keys <pane> C-c; sleep 3; herdr pane run <pane> dsh-tui"
