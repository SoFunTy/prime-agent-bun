#!/bin/sh
# Install or update the fork's Bun-kernel prime-agent from GitHub Releases.
# It never touches an installed `prime-agent` (the official product): the
# payload lands under ~/.local/share/prime-agent-bun and the command is
# ~/.local/bin/prime-agent-bun.
#
#   curl -fsSL .../install-bun.sh | sh -s -- 0.10.2     # install a version
#   curl -fsSL .../install-bun.sh | sh -s -- --check    # is there a newer one?
#   curl -fsSL .../install-bun.sh | sh -s -- --update   # install it if so
#
# Environment overrides:
#   PRIME_AGENT_BUN_REPO       GitHub repo (default SoFunTy/prime-agent-bun)
#   PRIME_AGENT_BUN_BASE_URL   release download base (default GitHub Releases)
#   PRIME_AGENT_BUN_API_URL    GitHub API base (default https://api.github.com)
#   PRIME_AGENT_BUN_PREFIX     payload dir (default ~/.local/share/prime-agent-bun)
#   PRIME_AGENT_BUN_BIN_DIR    launcher dir (default ~/.local/bin)
set -eu

REPO="${PRIME_AGENT_BUN_REPO:-SoFunTy/prime-agent-bun}"
BASE_URL="${PRIME_AGENT_BUN_BASE_URL:-https://github.com/${REPO}/releases/download}"
API_URL="${PRIME_AGENT_BUN_API_URL:-https://api.github.com}"
PREFIX="${PRIME_AGENT_BUN_PREFIX:-$HOME/.local/share/prime-agent-bun}"
BIN_DIR="${PRIME_AGENT_BUN_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/prime-agent-bun"

say() { printf '%s\n' "$*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: install-bun.sh <version>            install release tag fork-v<version>
       install-bun.sh --archive <file>     install a local prime-agent-<version>-<platform>.tar.gz
       install-bun.sh --version <version>  same as the positional form
       install-bun.sh --check              print the running vs latest released version
       install-bun.sh --update             install the latest release when it is newer
EOF
}

ACTION="install"
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
    --check) ACTION="check"; shift ;;
    --update) ACTION="update"; shift ;;
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

# The version the launcher points at (`<prefix>/releases/<version>/prime-agent`).
installed_version() {
  [ -L "$LAUNCHER" ] || return 1
  target="$(readlink "$LAUNCHER")" || return 1
  case "$target" in
    */releases/*/prime-agent) ;;
    *) return 1 ;;
  esac
  release_dir="${target%/prime-agent}"
  printf '%s\n' "${release_dir##*/}"
}

# The latest release tag (`fork-v<version>`) from the GitHub API.
latest_tag() {
  body="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
    "${API_URL}/repos/${REPO}/releases/latest")" ||
    die "could not read the latest release of ${REPO} (has one been published?)"
  tag="$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || die "the latest release of ${REPO} has no tag name"
  printf '%s\n' "$tag"
}

# version_gt A B: true (exit 0) when A is a newer major.minor.patch than B.
version_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, A, "."); nb = split(b, B, ".")
    for (i = 1; i <= 3; i++) {
      x = (i <= na ? A[i] : 0) + 0
      y = (i <= nb ? B[i] : 0) + 0
      if (x > y) exit 0
      if (x < y) exit 1
    }
    exit 1
  }'
}

if [ "$ACTION" = "check" ] || [ "$ACTION" = "update" ]; then
  current="$(installed_version || true)"
  tag="$(latest_tag)"
  latest="${tag#fork-v}"
  latest="${latest#v}"
  if [ -z "$current" ]; then
    say "prime-agent-bun is not installed here (latest: $latest)"
  elif version_gt "$latest" "$current"; then
    say "update available: $current -> $latest"
  else
    say "up to date: $current (latest: $latest)"
  fi
  if [ "$ACTION" = "check" ]; then
    exit 0
  fi
  if [ -n "$current" ] && ! version_gt "$latest" "$current"; then
    exit 0
  fi
  VERSION="$latest"
  say "installing $VERSION"
fi

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
    got="$(sha256_of "$file")"
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
ln -sfn "$target/prime-agent" "$LAUNCHER"

say "installed prime-agent-bun $VERSION to $target"
say "command: $LAUNCHER"
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
