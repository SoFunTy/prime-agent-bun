#!/usr/bin/env python3
"""Kernel-cell statistics from the local session store.

Compares the tool-cell durations the Bun kernel and the Python kernel recorded
in `~/.prime/agent/sessions/*.jsonl`. The corpora are *different workloads*, so
treat the output as context, not as a controlled benchmark: use
`test/bench/kernel-bench.ts` for the apples-to-apples numbers.

Counts every `toolResult` whose tool name is a kernel alias, and reports the
duration distribution for: all cells, bash-driven cells, pure comparable cells
(1-5 lines, ok, no bash/wait, not the session's first cell), and the first
cell of a session (bootstrap + warm-up).

Usage:
    python3 scripts/fork/kernel_session_stats.py [sessions-dir]
"""

from __future__ import annotations

import glob
import json
import statistics
import sys
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
WAIT_TOKENS = ("sleep", "setTimeout", "setInterval", "while (true)", "while True")


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))]


def collect(sessions_dir: Path):
    cells: list[dict] = []
    kernels_by_session: dict[str, set[str]] = {}
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
        seen: set[str] = set()
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
            code = (calls.get(message.get("toolCallId")) or {}).get("code") or ""
            first = kernel not in seen
            seen.add(kernel)
            cells.append(
                {
                    "sid": sid,
                    "kernel": kernel,
                    "ms": float(duration),
                    "status": str(details.get("status") or ""),
                    "error": bool(message.get("isError")) or details.get("status") == "error",
                    "bash": bool(details.get("bashCommands")) or bool(details.get("background")),
                    "waits": any(token in code for token in WAIT_TOKENS),
                    "lines": len([line for line in code.splitlines() if line.strip()]),
                    "first": first,
                }
            )
            kernels_by_session.setdefault(sid, set()).add(kernel)
    return cells, kernels_by_session


def row(label: str, rows: list[dict], kernel: str) -> str:
    values = [cell["ms"] for cell in rows if cell["kernel"] == kernel]
    if not values:
        return f"{label:<26} {kernel:<7} n=0"
    errors = sum(1 for cell in rows if cell["kernel"] == kernel and cell["error"])
    return (
        f"{label:<26} {kernel:<7} n={len(values):<5} "
        f"median={statistics.median(values):8.2f}ms mean={statistics.mean(values):9.2f}ms "
        f"p90={percentile(values, 0.90):9.2f} p95={percentile(values, 0.95):9.2f} "
        f"<10ms={sum(1 for value in values if value < 10) / len(values):6.1%} "
        f"err={errors / len(values):5.1%}"
    )


def main() -> int:
    sessions_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".prime/agent/sessions"
    cells, kernels_by_session = collect(sessions_dir)
    comparable = [
        cell
        for cell in cells
        if not cell["bash"]
        and not cell["waits"]
        and not cell["error"]
        and cell["status"] in ("", "ok")
        and not cell["first"]
        and 1 <= cell["lines"] <= 5
    ]
    print(f"sessions={len(kernels_by_session)} kernel-cells={len(cells)}")
    print(f"comparable pure cells={len(comparable)}")
    slices = (
        ("all cells", cells),
        ("bash-driven cells", [cell for cell in cells if cell["bash"]]),
        ("pure comparable", comparable),
        ("first cell of session", [cell for cell in cells if cell["first"] and not cell["bash"]]),
    )
    for label, rows in slices:
        for kernel in ("python", "bun"):
            print(row(label, rows, kernel))
        print()
    for kernel in ("python", "bun"):
        medians = []
        for sid, kernels in kernels_by_session.items():
            if kernels != {kernel}:
                continue
            values = [cell["ms"] for cell in comparable if cell["sid"] == sid]
            if len(values) >= 5:
                medians.append(statistics.median(values))
        if medians:
            print(
                f"per-session median ({kernel}): sessions={len(medians)} "
                f"median-of-medians={statistics.median(medians):.2f}ms "
                f"min={min(medians):.2f} max={max(medians):.2f}"
            )
    print("\nnote: the two corpora run different workloads; quote test/bench/kernel-bench.ts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
