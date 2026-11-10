#!/usr/bin/env bash
# The fork's full verification set: every gate in one command, with a summary.
#
# Usage:
#   ./test/verify-all.sh                 # everything except the release packager
#   ./test/verify-all.sh --with-package  # also build + stage the real release payload
#
# Exit status is non-zero when any gate fails.
set -uo pipefail
cd "$(dirname "$0")/.."

with_package=0
[ "${1:-}" = "--with-package" ] && with_package=1

log_dir="$(mktemp -d)"
passed=0
failed=0
results=()

gate() {
  local name="$1"; shift
  local log="$log_dir/$(echo "$name" | tr ' /:' '___').log"
  if "$@" >"$log" 2>&1; then
    passed=$((passed + 1))
    results+=("PASS  $name")
  else
    failed=$((failed + 1))
    results+=("FAIL  $name   (see $log)")
  fi
}

# Lanes that must be fully green. The fork's `pa-core` gate names the surfaces the
# fork owns instead of the whole crate: the upstream suites contain tests that are
# order- or environment-sensitive on macOS (a cross-process venv disk-memo test,
# path canonicalization) and they are reported as the informational baseline below
# rather than gating a fork change.
gate "fmt"                        cargo fmt --all --check
gate "check all targets"          cargo check -p pa-core -p pa-types -p pa-tui -p pa-daemon --all-targets --message-format=short
gate "pa-types lib"               cargo test -p pa-types --lib
gate "pa-core fork surfaces"      cargo test -p pa-core --lib -- kernel::bun_runtime kernel::vocabulary prompts:: skills:: settings:: tools::ipython session_engine::skills_unavailable_notice session_engine::state_restore_notice session_engine::ipython_state session_engine::agent_messaging session_engine::engine::
gate "pa-tui cell surfaces"       cargo test -p pa-tui --lib -- code_preview:: tool_card::
gate "bun protocol cases"         ./test/run-all.sh
gate "selection unit tests"       cargo test -p pa-core --lib -- kernel::bun_runtime
gate "prompt conformance"         cargo test -p pa-core --test bun_prompt_conformance
gate "skill docs conformance"     cargo test -p pa-core --test bun_skill_docs_conformance
gate "session tool surface"       env PRIME_AGENT_BUN_E2E=required cargo test -p pa-core --test bun_session_tool_surface
gate "kernel e2e"                 env PRIME_AGENT_BUN_E2E=required cargo test -p pa-core --test bun_kernel_e2e
gate "provisioner e2e"            env PRIME_AGENT_BUN_E2E=required cargo test -p pa-core --test bun_provisioner_e2e
gate "session scenarios"          env PRIME_AGENT_BUN_E2E=required cargo test -p pa-core --test bun_session_scenarios
gate "release native compat"      python3 scripts/release/test_native_compat.py
gate "protocol drift (self)"      python3 scripts/fork/protocol_drift.py --ref HEAD
gate "ownership gate"             python3 scripts/fork/check_ownership.py --range HEAD

if [ "$with_package" = 1 ]; then
  gate "release build"            cargo build --release -p pa-cli --bin prime-agent
  gate "release package"          python3 scripts/package_release.py --skip-build --catalog-assets target/catalog-assets --out-dir target/release-package
fi

echo "=== verify-all ==="
for line in "${results[@]}"; do echo "$line"; done
echo
echo "lanes: $passed passed, $failed failed"

# Informational: the machine's baseline for the two broad suites.
echo
echo "informational (known environment failures, not gates):"
echo -n "  pa-core --lib: "
cargo test -p pa-core --lib 2>&1 | grep -E "^test result" | tail -1 | sed 's/^/  /' || true
echo -n "  pa-daemon --lib: "
cargo test -p pa-daemon --lib 2>&1 | grep -E "^test result" | tail -1 | sed 's/^/  /' || true

echo
echo "logs: $log_dir"
[ "$failed" -eq 0 ]
