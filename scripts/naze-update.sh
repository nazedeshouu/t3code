#!/bin/sh
# Takes a new upstream nightly: rebases the personal branches, rebuilds, stages an ad-hoc app.
# Then run ~/Desktop/Install T3 Code Fork.command. --no-rebase rebuilds the current commit.
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
OUT="$HOME/Temp/t3code-naze-build"
APP_NAME="T3 Code (Nightly).app"
INSTALLED="/Applications/$APP_NAME"
MONITOR_DIR=native/resource-monitor/target/aarch64-apple-darwin/release
PATH="$ROOT/node_modules/.bin:$PATH"
# pingdotgg/t3code: upstream in this fork checkout, origin in a plain clone.
REMOTE=${NAZE_UPSTREAM_REMOTE:-$(git remote | grep -qx upstream && echo upstream || echo origin)}
export PATH

die() {
  echo "naze-update: $*" >&2
  exit 1
}

[ -z "$(git status --porcelain)" ] || die "the worktree has uncommitted changes."

if [ "${1:-}" != "--no-rebase" ]; then
  git fetch --tags "$REMOTE"
  old_base=$(git rev-parse feat/claude-rewind)
  git rebase "$REMOTE/main" feat/claude-rewind ||
    die "fix the conflict, git rebase --continue, then: git rebase --onto feat/claude-rewind $old_base naze/main, then rerun with --no-rebase."
  git rebase --onto feat/claude-rewind "$old_base" naze/main ||
    die "fix the conflict, git rebase --continue, then rerun with --no-rebase."
  vp i
fi
[ "$(git rev-parse --abbrev-ref HEAD)" = naze/main ] || die "build from naze/main."

nightly=$(git describe --tags --match 'v*-nightly.*' --abbrev=0 HEAD)
nightly=${nightly#v}
last=$(cat "$OUT/last-version" 2>/dev/null || true)
case "$last" in
  "$nightly.naze."*) version="$nightly.naze.$((${last##*.} + 1))" ;;
  *) version="$nightly.naze.1" ;;
esac

# The same public identifiers official builds bake in. Without them T3 Connect disappears.
[ -f .env ] || cp .env.example .env

# Without cargo, reuse the installed app's monitor, which is fine while its source is unchanged.
reused_monitor=
if ! command -v cargo >/dev/null 2>&1; then
  installed_version=$(plutil -extract CFBundleShortVersionString raw "$INSTALLED/Contents/Info.plist")
  git diff --quiet "v${installed_version%.naze.*}" HEAD -- native/resource-monitor ||
    echo "naze-update: native/resource-monitor changed since $installed_version; the reused binary is older." >&2
  mkdir -p "$MONITOR_DIR"
  cp "$INSTALLED/Contents/Resources/resource-monitor/t3-resource-monitor" "$MONITOR_DIR/"
  reused_monitor=1
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR
fi

staging="$OUT/.staging-$version"
mkdir -p "$OUT"
node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 \
  --build-version "$version" --output-dir "$staging"
[ -z "$reused_monitor" ] || rm -rf native/resource-monitor/target

built="$staging/mac-arm64/$APP_NAME"
[ -d "$built" ] || die "the build did not produce $built."
codesign --force --deep --sign - "$built"
codesign --verify --deep --strict "$built"

rm -rf "${OUT:?}/$APP_NAME"
mv "$built" "$OUT/$APP_NAME"
rm -rf "$staging"
echo "$version" >"$OUT/last-version"
echo "Staged $version at $OUT/$APP_NAME."
echo "Install it with ~/Desktop/Install T3 Code Fork.command."
