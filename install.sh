#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$repo_root"

os="$(uname -s)"
arch="$(uname -m)"
case "$os:$arch" in
  Darwin:x86_64|Darwin:amd64)
    build_script='build:macos:x64'
    artifact='dist/mcpx-lite-macos-x64'
    ;;
  Darwin:arm64|Darwin:aarch64)
    build_script='build:macos:arm64'
    artifact='dist/mcpx-lite-macos-arm64'
    ;;
  Linux:x86_64|Linux:amd64)
    build_script='build:linux:x64'
    artifact='dist/mcpx-lite-linux-x64'
    ;;
  Linux:aarch64|Linux:arm64)
    build_script='build:linux:arm64'
    artifact='dist/mcpx-lite-linux-arm64'
    ;;
  *)
    printf 'Unsupported platform: %s/%s (supported: macOS/Linux x64/arm64)\n' "$os" "$arch" >&2
    exit 1
    ;;
esac

: "${HOME:?HOME must be set}"
command -v pnpm >/dev/null 2>&1 || { printf 'pnpm is required\n' >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { printf 'Bun is required\n' >&2; exit 1; }

pnpm run "$build_script"

source_binary="$repo_root/$artifact"
if [[ ! -f "$source_binary" ]]; then
  printf 'Build did not produce expected binary: %s\n' "$source_binary" >&2
  exit 1
fi

bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"
destination="$bin_dir/mcpx-lite"
temporary_file=''
cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f "$temporary_file"
  fi
}
trap cleanup EXIT

temporary_file="$(mktemp "$bin_dir/.mcpx-lite.XXXXXX")"
install -m 755 "$source_binary" "$temporary_file"
mv -f "$temporary_file" "$destination"
temporary_file=''
trap - EXIT

printf 'Installed mcpx-lite to %s\n' "$destination"
