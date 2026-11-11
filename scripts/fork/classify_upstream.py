#!/usr/bin/env python3
"""Classify upstream Prime Agent commits for a fork that replaces the kernel.

The fork's whole upstream-tracking strategy rests on one fact: a commit either
touches the file set the fork owns (and therefore needs a human disposition) or
it does not (and can be cherry-picked or rebased mechanically). This script
answers that question per commit and emits a ledger table.

Usage:
    git fetch upstream
    python3 scripts/fork/classify_upstream.py                       # upstream/main..HEAD
    python3 scripts/fork/classify_upstream.py --range HEAD~300..HEAD
    python3 scripts/fork/classify_upstream.py --json                # machine-readable

Exit code is 0 when the classification itself succeeded; it does not fail on
kernel-surface commits (they are expected, not errors).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

# Paths whose upstream changes collide with the fork's kernel replacement.
# Keep this list in sync with docs/fork/kernel-ownership.md.
KERNEL_SURFACE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("runtime-py", r"^prime-agent-runtime/"),
    ("runtime-bun", r"^prime-agent-bun-runtime/"),
    ("kernel-core", r"^crates/pa-core/src/kernel/"),
    ("kernel-tool", r"^crates/pa-core/src/tools/ipython(?:\.rs|/)"),
    ("kernel-tests", r"^crates/pa-core/tests/bun_"),
    ("kernel-vocabulary", r"^crates/pa-core/src/session_engine/(?:ipython_state|state_restore_notice|skills_unavailable_notice|compaction|agent_messaging)\.rs$"),
    ("shared-vocabulary", r"^crates/pa-types/src/(?:kernel_runtime\.rs|lib\.rs|ai/mod\.rs)$"),
    ("http-transport", r"^crates/pa-ai/src/(?:utils_inner/http\.rs|lib\.rs)$"),
    ("provider-config", r"^crates/pa-core/src/models/(?:custom|registry)\.rs$"),
    ("kernel-tool-dispatch", r"^crates/pa-core/src/session_engine/(?:tool_bridge\.rs|engine\.rs|engine/tests\.rs)$"),
    ("kernel-tool-schema", r"^crates/pa-cli/src/prompt_command\.rs$"),
    ("acp-kernel-title", r"^crates/pa-daemon/src/acp/wire_events\.rs$"),
    ("ui-kernel-label", r"^crates/pa-tui/src/tool_card/ipython\.rs$"),
    ("ui-injected-prompt", r"^crates/pa-tui/src/custom_message/injected_prompt\.rs$"),
    ("harness-digest", r"^crates/pa-core/src/refinement/ranking\.rs$"),
    ("goal-prompt", r"^crates/pa-core/src/goals\.rs$"),
    ("product-docs", r"^(?:README\.md|docs/google-workspace-mcp\.md)$"),
    ("ui-cell-preview", r"^crates/pa-tui/src/code_preview/(?:python\.rs|mod\.rs)$"),
    ("cli-about", r"^crates/pa-cli/src/command_registry\.rs$"),
    ("settings", r"^crates/pa-core/src/settings/(?:types|load)\.rs$"),
    ("composition-root", r"^crates/pa-cli/src/main\.rs$"),
    ("prompt-core", r"^crates/pa-core/src/prompts/layers(?:/|\.rs$)"),
    ("prompt-assembly", r"^crates/pa-core/src/prompts/system_prompt\.rs$"),
    ("prompt-model", r"^crates/pa-core/src/prompts/layers/model_prompts\.toml$"),
    ("skills-rust", r"^crates/pa-core/src/skills/"),
    ("skills-payload", r"^skills/"),
    ("ci", r"^\.github/workflows/(?:ci|continuous|nightly)\.yml$"),
    ("make", r"^Makefile$"),
    ("packaging", r"^(?:packaging/|install-rust\.sh$|install\.ps1$|scripts/package_release\.py$)"),
    ("packaging-scripts", r"^scripts/release/"),
    ("kernel-scripts", r"^scripts/check_(?:kernel_env|ipython_diff_frames|restore_notice)\.py$"),
    ("fork-suite", r"^test/"),
    ("fork-docs", r"^docs/fork/"),
    ("repo-config", r"^\.gitignore$"),
)

# Upstream paths that are re-implemented by the fork's runtime; their changes are
# almost always `Not applicable` rather than `Port` (Python/IPython/dill/uv).
PYTHON_ONLY_PATTERNS: tuple[str, ...] = (
    r"^prime-agent-runtime/src/rlm/(?:repl|bash|harness|factory|mcp|mcp_base|skill|_winjob)\.py$",
    r"^prime-agent-runtime/test/",
    r"^crates/pa-core/src/kernel/bootstrap/venv/",
    r"^crates/pa-core/src/kernel/provisioner\.rs$",
)


def classify(path: str) -> list[str]:
    areas = [name for name, pattern in KERNEL_SURFACE_PATTERNS if re.match(pattern, path)]
    return areas or ["upstream-owned"]


def sh(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def commit_rows(revision_range: str) -> list[dict[str, object]]:
    raw = sh("git", "log", "--reverse", "--no-merges", "--format=%H%x1f%h%x1f%s", revision_range)
    rows: list[dict[str, object]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        sha, short, subject = line.split("\x1f", 2)
        files = [f for f in sh("git", "show", "--name-only", "--format=", sha).splitlines() if f]
        areas = sorted({area for path in files for area in classify(path)})
        touches_kernel = areas != ["upstream-owned"]
        python_only = touches_kernel and bool(files) and all(
            any(re.match(pattern, path) for pattern in PYTHON_ONLY_PATTERNS) for path in files
        )
        rows.append(
            {
                "sha": sha,
                "short": short,
                "subject": subject,
                "files": files,
                "areas": areas,
                "touches_kernel": touches_kernel,
                "python_only": python_only,
                "suggested_disposition": (
                    "Not applicable (Python-only runtime internals)"
                    if python_only
                    else ("Port / review" if touches_kernel else "Clean merge")
                ),
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--range",
        default="upstream/main..HEAD",
        help="git revision range to classify (default: upstream/main..HEAD)",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    args = parser.parse_args()

    try:
        rows = commit_rows(args.range)
    except subprocess.CalledProcessError as error:
        print(f"git log failed for range {args.range!r}: {error}", file=sys.stderr)
        if "upstream" in args.range:
            print("Add the remote first: git remote add upstream <url> && git fetch upstream", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    kernel_rows = [row for row in rows if row["touches_kernel"]]
    print(f"# Upstream classification: `{args.range}`\n")
    print(f"- commits total: {len(rows)}")
    print(f"- touching the kernel surface: {len(kernel_rows)}")
    print(f"- clean (mechanical merge/cherry-pick): {len(rows) - len(kernel_rows)}")
    print()
    if kernel_rows:
        print("| upstream commit | disposition | areas | subject |")
        print("| --- | --- | --- | --- |")
        for row in kernel_rows:
            print(
                f"| `{row['short']}` | {row['suggested_disposition']} | "
                f"{', '.join(row['areas'])} | {row['subject']} |"
            )
        print()
    print("Record the dispositions in `docs/fork/upstream-sync.md`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
