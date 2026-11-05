#!/bin/sh
# Install Threebot:  curl -fsSL https://raw.githubusercontent.com/RokaSwK/threebot/main/install.sh | sh
#
# Downloads a release from GitHub, checks it against the release's SHA256SUMS, and installs it in
# $THREEBOT_HOME/runtime/versions/<version>, with `current` pointing at it, like T3 Code's installer.
# Then run `threebot up` to set it up and start it in the background.
#
# Settings (environment variables):
#   THREEBOT_VERSION           exact version to install (default: newest release)
#   THREEBOT_HOME              data and installs (default: ~/.threebot)
#   THREEBOT_INSTALL_BIN_DIR   where the `threebot` command goes (default: ~/.local/bin)
#   THREEBOT_RELEASE_BASE_URL  download mirror; files are read from <base>/v<version>/
set -eu

REPO="RokaSwK/threebot"
HOME_DIR="${THREEBOT_HOME:-$HOME/.threebot}"
BIN_DIR="${THREEBOT_INSTALL_BIN_DIR:-$HOME/.local/bin}"
BASE_URL="${THREEBOT_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"

say() { printf '%s\n' "$*"; }
die() { printf 'threebot install: %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "needs curl or wget"; fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "needs sha256sum or shasum"; fi
}

# Threebot runs on Node next to T3 Code.
command -v node >/dev/null 2>&1 || die "Node.js 22.13 or newer is required: https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required (it comes with Node.js)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js 22.13 or newer is required; this is $(node --version)"
command -v tar >/dev/null 2>&1 || die "needs tar"

VERSION="${THREEBOT_VERSION:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -z "$VERSION" ]; then
  fetch "https://api.github.com/repos/$REPO/releases/latest" "$TMP/latest.json" || die "couldn't find the latest release"
  VERSION="$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$TMP/latest.json" | head -n 1)"
  [ -n "$VERSION" ] || die "couldn't read the latest release"
fi
VERSION="${VERSION#v}"
ARCHIVE="threebot-$VERSION.tar.gz"

say "Downloading Threebot $VERSION"
fetch "$BASE_URL/v$VERSION/$ARCHIVE" "$TMP/$ARCHIVE" || die "download failed: $BASE_URL/v$VERSION/$ARCHIVE"
fetch "$BASE_URL/v$VERSION/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: SHA256SUMS"
EXPECTED="$(awk -v f="$ARCHIVE" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS")"
[ -n "$EXPECTED" ] || die "SHA256SUMS has no entry for $ARCHIVE"
ACTUAL="$(sha256 "$TMP/$ARCHIVE")"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ARCHIVE (expected $EXPECTED, got $ACTUAL)"

VERSIONS="$HOME_DIR/runtime/versions"
TARGET="$VERSIONS/$VERSION"
mkdir -p "$VERSIONS"
if [ ! -f "$TARGET/.install-complete" ]; then
  STAGING="$(mktemp -d "$VERSIONS/.staging-XXXXXX")"
  tar -xzf "$TMP/$ARCHIVE" -C "$STAGING" --strip-components=1
  say "Installing server dependencies"
  (cd "$STAGING/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || { rm -rf "$STAGING"; die "npm ci failed"; }
  date > "$STAGING/.install-complete"
  rm -rf "$TARGET"
  mv "$STAGING" "$TARGET"
fi

# `current` is the version the service runs; the one it replaces stays as `previous`.
RUNTIME="$HOME_DIR/runtime"
if [ -L "$RUNTIME/current" ] && [ "$(readlink "$RUNTIME/current")" != "$TARGET" ]; then
  ln -sfn "$(readlink "$RUNTIME/current")" "$RUNTIME/previous"
fi
ln -sfn "$TARGET" "$RUNTIME/current"

mkdir -p "$BIN_DIR"
NODE="$(command -v node)"
cat > "$BIN_DIR/threebot" <<EOF
#!/bin/sh
# Written by the Threebot installer: runs the installed version.
THREEBOT_HOME="\${THREEBOT_HOME:-$HOME_DIR}" exec "$NODE" "$RUNTIME/current/server/cli.mjs" "\$@"
EOF
chmod 755 "$BIN_DIR/threebot"

say ""
say "Threebot $VERSION is installed."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH, or run $BIN_DIR/threebot directly." ;; esac
say "Next: run \`threebot up\` to connect it to T3 Code and start it in the background."
