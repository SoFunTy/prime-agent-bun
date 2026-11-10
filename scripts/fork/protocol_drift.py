#!/usr/bin/env python3
"""Report protocol/API drift between this fork and upstream Prime Agent.

The fork replaces the kernel runtime, so exactly three upstream surfaces can
silently invalidate it:

1. the REPL protocol specification (`prime-agent-runtime/src/rlm/repl.md`);
2. the Rust wire types that mirror it (`crates/pa-core/src/kernel/protocol.rs`);
3. the model-facing `rlm` API, documented in
   `crates/pa-core/src/prompts/layers/core.md` and enumerated (as assertions)
   in `crates/pa-core/src/kernel/bootstrap/venv/probe.rs`.

This script extracts a normalized view of each and diffs it against a reference
revision (default `upstream/main`). Any non-empty diff is the exact port
backlog for the Bun runtime.

Usage:
    git fetch upstream
    python3 scripts/fork/protocol_drift.py
    python3 scripts/fork/protocol_drift.py --ref origin/main
    python3 scripts/fork/protocol_drift.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

PROTOCOL_DOC = "prime-agent-runtime/src/rlm/repl.md"
PROTOCOL_RS = "crates/pa-core/src/kernel/protocol.rs"
CORE_PROMPT = "crates/pa-core/src/prompts/layers/core.md"
PROBE_RS = "crates/pa-core/src/kernel/bootstrap/venv/probe.rs"

REQUEST_ROW = re.compile(r"^\|\s*`([a-z_]+)`\s*\|")
RS_REQUEST = re.compile(r'Request::(\w+)\s*(?:\{[^}]*\})?\s*=>\s*"([a-z_]+)"')
RS_VERSION = re.compile(r"REPL_PROTOCOL_VERSION:\s*u64\s*=\s*(\d+)")
PY_VERSION = re.compile(r"PROTOCOL_VERSION\s*=\s*(\d+)")
ASSERTION = re.compile(r"(?:assert|hasattr|callable)\s*\(?\s*([A-Za-z_][A-Za-z0-9_.]*)")
PROMPT_API = re.compile(r"`(rlm(?:\.[A-Za-z_][A-Za-z0-9_]*)+)")
CAP_RS = re.compile(r"(?:const\s+)?([A-Z][A-Z0-9_]*CAP|MAX_[A-Z0-9_]+)\s*(?::\s*usize)?\s*=\s*([0-9_*\s]+);")


def read(ref: str | None, path: str) -> str | None:
    revision = f"{ref}:{path}" if ref else f":{path}"
    if ref is None:
        try:
            return open(path, encoding="utf-8").read()
        except OSError:
            return None
    try:
        return subprocess.run(
            ["git", "show", revision], check=True, capture_output=True, text=True
        ).stdout
    except subprocess.CalledProcessError:
        return None


def view(ref: str | None) -> dict[str, object]:
    doc = read(ref, PROTOCOL_DOC)
    rs = read(ref, PROTOCOL_RS)
    prompt = read(ref, CORE_PROMPT)
    probe = read(ref, PROBE_RS)

    requests = sorted({match.group(1) for match in REQUEST_ROW.finditer(doc or "")})
    rs_requests = sorted({match.group(2) for match in RS_REQUEST.finditer(rs or "")})
    version = None
    if rs:
        found = RS_VERSION.search(rs)
        version = int(found.group(1)) if found else None
    elif doc:
        found = PY_VERSION.search(doc)
        version = int(found.group(1)) if found else None
    api = sorted({match.group(1) for match in PROMPT_API.finditer(prompt or "")})
    probe_api = sorted({match.group(1) for match in ASSERTION.finditer(probe or "")})
    caps = {match.group(1): re.sub(r"[\s_]", "", match.group(2)) for match in CAP_RS.finditer(rs or "")}
    return {
        "protocol_version": version,
        "requests": requests,
        "rust_requests": rs_requests,
        "rlm_api": api,
        "probe_assertions": probe_api,
        "caps": caps,
    }


def diff_sets(label: str, fork_items: list[str], upstream_items: list[str]) -> list[str]:
    added = [item for item in upstream_items if item not in fork_items]
    removed = [item for item in fork_items if item not in upstream_items]
    lines: list[str] = []
    for item in added:
        lines.append(f"+ upstream adds {label}: {item}")
    for item in removed:
        lines.append(f"- upstream removes {label}: {item}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="upstream/main", help="reference revision (default: upstream/main)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    upstream = view(args.ref)
    if all(value in (None, [], {}) for value in upstream.values()):
        print(f"reference {args.ref!r} is not available; run: git fetch upstream", file=sys.stderr)
        return 2
    fork = view(None)

    report: dict[str, object] = {"reference": args.ref, "drift": []}
    drift: list[str] = []

    if fork["protocol_version"] != upstream["protocol_version"]:
        drift.append(
            f"! protocol version: fork={fork['protocol_version']} upstream={upstream['protocol_version']}"
        )
    drift += diff_sets("request type (docs)", fork["requests"], upstream["requests"])
    drift += diff_sets("request type (protocol.rs)", fork["rust_requests"], upstream["rust_requests"])
    drift += diff_sets("rlm API (core.md)", fork["rlm_api"], upstream["rlm_api"])
    drift += diff_sets("kernel probe assertion", fork["probe_assertions"], upstream["probe_assertions"])
    fork_caps = fork["caps"]
    upstream_caps = upstream["caps"]
    assert isinstance(fork_caps, dict) and isinstance(upstream_caps, dict)
    for name, value in sorted(upstream_caps.items()):
        if name in fork_caps and fork_caps[name] != value:
            drift.append(f"! cap {name}: fork={fork_caps[name]} upstream={value}")
        elif name not in fork_caps:
            drift.append(f"+ upstream adds cap: {name}={value}")

    report["drift"] = drift
    if args.json:
        print(json.dumps(report, indent=2))
        return 1 if drift else 0

    if not drift:
        print(f"no protocol/API drift against {args.ref}")
        return 0
    print(f"# Kernel drift against `{args.ref}`\n")
    for line in drift:
        print(f"- {line}")
    print()
    print("Port each `+`/`!` line into prime-agent-bun-runtime and record it in")
    print("docs/fork/upstream-sync.md; a `-` line means the fork is ahead.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
