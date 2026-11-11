#!/usr/bin/env python3
"""Kernel-cell analysis from the local session store (Bun vs Python).

Reads `~/.prime/agent/sessions/*.jsonl` and compares what the two kernels
actually did: corpus composition, per-class cell durations, the cells that ran
an identical bash command under both kernels, error rates, and the total time
spent inside kernel cells.

This is a *real-workload* analysis, not a controlled benchmark: the Bun corpus
and the Python corpus run different jobs, so per-class medians are context,
and the identical-command cohort is the only like-for-like slice.

Usage:
    python3 scripts/fork/kernel_session_stats.py [sessions-dir]
"""

from __future__ import annotations

import glob
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

ALIASES = {
    "python_repl": "python",
    "python": "python",
    "ipython": "python",
    "repl_python": "python",
    "bun_repl": "bun",
    "bun": "bun",
    "javascript": "bun",
    "js": "bun",
}
SHELL_TRIVIAL = re.compile(r"^(echo|true|pwd|whoami|date|uname)\b")
IO_TOKENS = (
    "Bun.file", "fetch(", "readFile", "writeFile", "open(", "requests.", "urllib",
    "subprocess", "os.system", "node:fs", "read_text(",
)
SLEEP_TOKENS = ("sleep", "setTimeout", "setInterval")


def normalize_command(command: str) -> str:
    command = command.strip()
    command = re.sub(r"^cd\s+\S+\s*(&&|;)\s*", "", command)
    return re.sub(r"\s+", " ", command)


def classify(cell: dict) -> str:
    if cell["bash"]:
        return "bash_trivial" if cell["bash_trivial"] else "bash_other"
    if any(token in cell["code"] for token in SLEEP_TOKENS):
        return "wait"
    if any(token in cell["code"] for token in IO_TOKENS):
        return "file_or_net"
    if re.search(r"\b(import|require)\b", cell["code"]):
        return "import"
    if "await" in cell["code"]:
        return "await"
    if cell["lines"] <= 2:
        return "pure_short"
    return "pure_multi"


def collect(sessions_dir: Path):
    cells: list[dict] = []
    sessions: dict[str, set[str]] = {}
    for path in glob.glob(str(sessions_dir / "*.jsonl")):
        try:
            rows = [json.loads(line) for line in open(path) if line.strip()]
        except (OSError, json.JSONDecodeError):
            continue
        session = next((row for row in rows if row.get("type") == "session"), {})
        sid = session.get("id") or Path(path).stem
        calls: dict[str, dict] = {}
        for row in rows:
            message = row.get("message") or {}
            if message.get("role") != "assistant":
                continue
            for part in message.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    calls[part.get("id")] = part.get("arguments") or {}
        for row in rows:
            message = row.get("message") or {}
            if message.get("role") != "toolResult":
                continue
            kernel = ALIASES.get(message.get("toolName") or "")
            if kernel is None:
                continue
            details = message.get("details") or {}
            duration = details.get("durationMs")
            if not isinstance(duration, (int, float)):
                continue
            code = ((calls.get(message.get("toolCallId")) or {}).get("code") or "").strip()
            bash = details.get("bashCommands") or {}
            count = int(bash.get("count") or 0) if isinstance(bash, dict) else 0
            command = normalize_command(str(bash.get("first") or "")) if isinstance(bash, dict) else ""
            cells.append(
                {
                    "sid": sid,
                    "kernel": kernel,
                    "ms": float(duration),
                    "code": code,
                    "lines": len([line for line in code.splitlines() if line.strip()]),
                    "bash": count > 0,
                    "bash_count": count,
                    "command": command,
                    "bash_trivial": count == 1 and bool(SHELL_TRIVIAL.match(command)),
                    "error": bool(message.get("isError")) or details.get("status") == "error",
                }
            )
            sessions.setdefault(sid, set()).add(kernel)
    for cell in cells:
        cell["class"] = classify(cell)
    return cells, sessions


def row(label: str, cells: list[dict], kernel: str) -> str:
    values = [cell["ms"] for cell in cells if cell["kernel"] == kernel]
    if not values:
        return f"{label:<20} {kernel:<7} n=0"
    errors = sum(1 for cell in cells if cell["kernel"] == kernel and cell["error"])
    ordered = sorted(values)
    p90 = ordered[min(len(ordered) - 1, round(0.9 * (len(ordered) - 1)))]
    return (
        f"{label:<20} {kernel:<7} n={len(values):<5} median={statistics.median(values):8.2f}ms "
        f"mean={statistics.mean(values):9.2f}ms p90={p90:9.2f} "
        f"err={errors / len(values):5.1%}"
    )


def main() -> int:
    sessions_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".prime/agent/sessions"
    cells, sessions = collect(sessions_dir)
    kernels = Counter(kernel for kernel_list in sessions.values() for kernel in kernel_list)
    print(f"cells={len(cells)} sessions(python)={kernels['python']} sessions(bun)={kernels['bun']}")
    for kernel in ("python", "bun"):
        mine = [cell for cell in cells if cell["kernel"] == kernel]
        if mine:
            total_minutes = sum(cell["ms"] for cell in mine) / 1000 / 60
            print(
                f"  {kernel}: cells/session={len(mine) / kernels[kernel]:.1f} "
                f"total cell time={total_minutes:.1f}min"
            )
    print()
    print("composition and durations by class:")
    for cls in (
        "pure_short", "pure_multi", "import", "await", "file_or_net",
        "bash_trivial", "bash_other", "wait",
    ):
        sub = [cell for cell in cells if cell["class"] == cls]
        for kernel in ("python", "bun"):
            print(row(cls, sub, kernel))
        print()

    print("identical single-command bash cells (like-for-like):")
    singles = [
        cell
        for cell in cells
        if cell["bash_count"] == 1 and cell["command"]
    ]
    commands = {kernel: Counter(c["command"] for c in singles if c["kernel"] == kernel) for kernel in ("python", "bun")}
    common = sorted(set(commands["python"]) & set(commands["bun"]))
    matched_py, matched_bun = [], []
    for command in common:
        py = [c["ms"] for c in singles if c["kernel"] == "python" and c["command"] == command]
        bn = [c["ms"] for c in singles if c["kernel"] == "bun" and c["command"] == command]
        print(
            f"  {command[:64]:<64} py n={len(py):<3} {statistics.median(py):7.1f}ms | "
            f"bun n={len(bn):<3} {statistics.median(bn):7.1f}ms"
        )
        matched_py.extend(py)
        matched_bun.extend(bn)
    if matched_py and matched_bun:
        print(
            f"  matched total: python n={len(matched_py)} median={statistics.median(matched_py):.1f}ms | "
            f"bun n={len(matched_bun)} median={statistics.median(matched_bun):.1f}ms"
        )
    print()

    print("error rate (all kernel cells):")
    for kernel in ("python", "bun"):
        mine = [cell for cell in cells if cell["kernel"] == kernel]
        if mine:
            errors = sum(1 for cell in mine if cell["error"])
            print(f"  {kernel}: {errors}/{len(mine)} = {errors / len(mine):.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
