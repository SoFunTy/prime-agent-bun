#!/usr/bin/env bash
# Verification suite for the Bun kernel core: drives the real protocol server
# over fd 0 / fd 1 and asserts the protocol-v3 contract per case.
set -uo pipefail
cd "$(dirname "$0")"
failures=0
cases=("$@")
if [ ${#cases[@]} -eq 0 ]; then
  cases=()
  for dir in case-*; do cases+=("$dir"); done
fi
for dir in "${cases[@]}"; do
  if ! bun run "$dir/run.ts"; then
    failures=$((failures + 1))
  fi
done
if [ "$failures" -ne 0 ]; then
  echo "FAILED: $failures case(s)"
  exit 1
fi
echo "OK: all cases passed"
