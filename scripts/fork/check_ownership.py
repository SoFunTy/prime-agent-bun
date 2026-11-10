#!/usr/bin/env python3
"""Fail when the fork's own diff leaves the declared kernel ownership surface.

The fork's mergeability rests on its diff being confined to a known file set
(`docs/fork/kernel-ownership.md`). This check makes that a gate: any changed
path outside the surface is either a mistake or a surface change that must be
declared in the same pull request.

Usage:
    python3 scripts/fork/check_ownership.py                        # upstream/main...HEAD
    python3 scripts/fork/check_ownership.py --range HEAD~5..HEAD
    python3 scripts/fork/check_ownership.py --allow-undeclared     # report, do not fail
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

from classify_upstream import KERNEL_SURFACE_PATTERNS  # noqa: E402

# Files whose *existence* is fork tooling rather than a changed upstream file;
# still listed so the intent is explicit.
FORK_TOOLING = (
    r"^docs/fork/",
    r"^scripts/fork/",
    r"^test/",
    r"^\.changes/",
)


def is_owned(path: str) -> bool:
    patterns = [pattern for _, pattern in KERNEL_SURFACE_PATTERNS]
    patterns.extend(FORK_TOOLING)
    return any(re.match(pattern, path) for pattern in patterns)


def changed_paths(revision_range: str) -> list[str]:
    output = subprocess.run(
        ["git", "diff", "--name-only", revision_range],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [line for line in output.splitlines() if line]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--range", default="upstream/main...HEAD")
    parser.add_argument("--allow-undeclared", action="store_true")
    args = parser.parse_args()

    try:
        paths = changed_paths(args.range)
    except subprocess.CalledProcessError as error:
        print(f"git diff failed for {args.range!r}: {error}", file=sys.stderr)
        if "upstream" in args.range:
            print("Add the remote first: git remote add upstream <url> && git fetch upstream", file=sys.stderr)
        return 2

    undeclared = [path for path in paths if not is_owned(path)]
    print(f"{len(paths)} changed path(s) in {args.range}; {len(undeclared)} outside the owned surface")
    for path in undeclared:
        print(f"  UNDECLARED {path}")
    if undeclared and not args.allow_undeclared:
        print(
            "\nAdd the path to docs/fork/kernel-ownership.md and "
            "scripts/fork/classify_upstream.py, or move the change back inside the surface.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
