#!/bin/sh
# Install the fork's Bun-kernel prime-agent from a GitHub Release (or a local
# release archive). It never touches an installed `prime-agent` (the official
# product): the payload lands under ~/.local/share/prime-agent-bun and the
# launcher is ~/.local/bin/prime-agent-bun.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/prime-agent-bun/main/scripts/fork/install-bun.sh | sh -s -- 0.10.2
#
# Environment overrides:
#   PRIME_AGENT_BUN_REPO       GitHub repo (default SoFunTy/prime-agent-bun)
#   PRIME_AGENT_BUN_BASE_URL   release download base (default GitHub Releases)
#   PRIME_AGENT_BUN_PREFIX     payload dir (default ~/.local/share/prime-agent-bun)
#   PRIME_AGENT_BUN_BIN_DIR    launcher dir (default ~/.local/bin)
set -eu

REPO="${PRIME_AGENT_BUN_REPO:-SoFunTy/prime-agent-bun}"
BASE_URL="${PRIME_AGENT_BUN_BASE_URL:-https://github.com/${REPO}/releases/download}"
PREFIX="${PRIME_AGENT_BUN_PREFIX:-$HOME/.local/share/prime-agent-bun}"
BIN_DIR="${PRIME_AGENT_BUN_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: install-bun.sh <version>            install release tag fork-v<version>
       install-bun.sh --archive <file>     install a local prime-agent-<version>-<platform>.tar.gz
       install-bun.sh --version <version>  same as the positional form
EOF
}

ARCHIVE=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --archive)
      [ $# -ge 2 ] || die "--archive needs a path"
      ARCHIVE="$2"; shift 2 ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) VERSION="$1"; shift ;;
  esac
done

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)             PLATFORM="darwin-arm64" ;;
  Darwin:x86_64)            PLATFORM="darwin-x64" ;;
  Linux:x86_64)             PLATFORM="linux-x64" ;;
  Linux:aarch64|Linux:arm64) PLATFORM="linux-arm64" ;;
  *) die "unsupported platform: $(uname -s) $(uname -m)" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
  file="$ARCHIVE"
else
  [ -n "$VERSION" ] || { usage >&2; exit 2; }
  VERSION="${VERSION#fork-v}"
  VERSION="${VERSION#v}"
  TAG="fork-v$VERSION"
  FILE_NAME="prime-agent-$VERSION-$PLATFORM.tar.gz"
  say "downloading ${BASE_URL}/${TAG}/${FILE_NAME}"
  curl -fsSL "${BASE_URL}/${TAG}/${FILE_NAME}" -o "$work/$FILE_NAME" ||
    die "download failed: ${BASE_URL}/${TAG}/${FILE_NAME}"
  file="$work/$FILE_NAME"
  if curl -fsSL "${BASE_URL}/${TAG}/SHA256SUMS" -o "$work/SHA256SUMS" 2>/dev/null; then
    want="$(awk -v f="$FILE_NAME" '$2 == f { print $1 }' "$work/SHA256SUMS" | head -n 1)"
    [ -n "$want" ] || die "SHA256SUMS has no row for $FILE_NAME"
    got="$(shasum -a 256 "$file" | awk '{ print $1 }')"
    [ "$want" = "$got" ] || die "checksum mismatch for $FILE_NAME"
    say "checksum ok"
  else
    say "warning: no SHA256SUMS published for $TAG; skipping the checksum"
  fi
fi

name="$(basename "$file")"
case "$name" in
  prime-agent-*-"$PLATFORM".tar.gz) ;;
  *) die "$name is not a $PLATFORM release archive" ;;
esac
if [ -z "$VERSION" ]; then
  rest="${name#prime-agent-}"
  VERSION="${rest%-"$PLATFORM".tar.gz}"
fi

target="$PREFIX/releases/$VERSION"
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$file" -C "$target" || die "extract failed"
[ -x "$target/prime-agent" ] || die "the archive has no prime-agent binary"
[ -d "$target/prime-agent-bun-runtime" ] ||
  die "the archive has no prime-agent-bun-runtime/ (the kernel payload)"

mkdir -p "$BIN_DIR"
ln -sfn "$target/prime-agent" "$BIN_DIR/prime-agent-bun"

say "installed prime-agent-bun $VERSION to $target"
say "launcher: $BIN_DIR/prime-agent-bun"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: add $BIN_DIR to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
if command -v bun >/dev/null 2>&1; then
  say "bun: $(bun --version)"
else
  say "warning: Bun is not installed, so the kernel cannot start."
  say "  install it once: curl -fsSL https://bun.sh/install | bash"
fi
