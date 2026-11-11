#!/usr/bin/env python3
"""Full Bun-vs-Python kernel comparison from the local session store.

Sections: corpus overview, distributions (cluster-bootstrap CI), per-class,
like-for-like cohorts (identical commands, output-size and code-size buckets),
model-controlled comparison, error taxonomy with Wilson intervals, kernel
readiness, output volume, long-tail concentration, per-session aggregates and a
back-calculation. Everything is derived from
`~/.prime/agent/sessions/*.jsonl`; no synthetic benchmark is involved.

Usage:
    python3 scripts/fork/kernel_session_stats.py [sessions-dir]
"""

from __future__ import annotations

import glob
import json
import math
import random
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
PY_SYNTAX = re.compile(
    r"(\bimport\s+\w|\bfrom\s+\w+\s+import|^\s*print\(|^def \w+\(|^class \w+:|f'|f\"|\.append\()", re.M
)
KERNELS = ("python", "bun")


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


def quant(values: list[float]) -> dict:
    if not values:
        return {}
    ordered = sorted(values)

    def q(p):
        return ordered[min(len(ordered) - 1, max(0, round(p * (len(ordered) - 1))))]

    mean = statistics.mean(ordered)
    sd = statistics.pstdev(ordered) if len(ordered) > 1 else 0.0
    return {
        "n": len(ordered), "min": ordered[0], "p25": q(.25), "median": statistics.median(ordered),
        "p75": q(.75), "p90": q(.90), "p95": q(.95), "p99": q(.99), "max": ordered[-1],
        "mean": mean, "sd": sd, "cv": sd / mean if mean else 0.0,
    }


def cluster_bootstrap_median(cells: list[dict], rounds: int = 2000) -> tuple[float, float] | None:
    """Resample sessions (clusters), not cells; 95% CI for the median."""
    by_session: dict[str, list[float]] = defaultdict(list)
    for cell in cells:
        by_session[cell["sid"]].append(cell["ms"])
    sessions = list(by_session)
    if len(sessions) < 3:
        return None
    rng = random.Random(7)
    medians = []
    for _ in range(rounds):
        pool = [value for sid in (rng.choice(sessions) for _ in sessions) for value in by_session[sid]]
        if pool:
            medians.append(statistics.median(pool))
    medians.sort()
    return medians[int(0.025 * (len(medians) - 1))], medians[int(0.975 * (len(medians) - 1))]


def cliffs_delta(a: list[float], b: list[float]) -> float | None:
    if not a or not b:
        return None
    wins = sum((x > y) - (x < y) for x in a for y in b)
    return wins / (len(a) * len(b))


def bootstrap_median_diff(a: list[dict], b: list[dict], rounds: int = 2000) -> tuple[float, float] | None:
    """Session-cluster bootstrap CI for median(b) - median(a)."""
    groups = {}
    for name, cells in (("a", a), ("b", b)):
        by_session: dict[str, list[float]] = defaultdict(list)
        for cell in cells:
            by_session[cell["sid"]].append(cell["ms"])
        groups[name] = by_session
    if len(groups["a"]) < 3 or len(groups["b"]) < 3:
        return None
    rng = random.Random(11)
    diffs = []
    for _ in range(rounds):
        medians = {}
        for name, by_session in groups.items():
            sessions = list(by_session)
            pool = [value for sid in (rng.choice(sessions) for _ in sessions) for value in by_session[sid]]
            medians[name] = statistics.median(pool)
        diffs.append(medians["b"] - medians["a"])
    diffs.sort()
    return diffs[int(0.025 * (len(diffs) - 1))], diffs[int(0.975 * (len(diffs) - 1))]


def compare(label: str, py: list[float], bun: list[float], note: str = "") -> str:
    """One comparison row: medians, delta, ratio, percent change."""
    if not py or not bun:
        return f"| {label} | {len(py)} | {len(bun)} | — | — | — | — | {note} |"
    med_py = statistics.median(py)
    med_bun = statistics.median(bun)
    delta = med_bun - med_py
    ratio = med_bun / med_py if med_py else float("inf")
    pct = delta / med_py * 100 if med_py else 0.0
    return (
        f"| {label} | {med_py:.1f} | {med_bun:.1f} | {delta:+.1f} | {ratio:.2f}× | {pct:+.1f}% | "
        f"{len(py)}/{len(bun)} | {note} |"
    )


def wilson(errors: int, total: int) -> tuple[float, float]:
    if not total:
        return (0.0, 0.0)
    z = 1.96
    p = errors / total
    denom = 1 + z * z / total
    centre = p + z * z / (2 * total)
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))
    return (centre - margin) / denom, (centre + margin) / denom


def collect(sessions_dir: Path):
    cells: list[dict] = []
    sessions: dict[str, dict] = {}
    for path in glob.glob(str(sessions_dir / "*.jsonl")):
        try:
            rows = [json.loads(line) for line in open(path) if line.strip()]
        except (OSError, json.JSONDecodeError):
            continue
        session = next((row for row in rows if row.get("type") == "session"), {})
        sid = session.get("id") or Path(path).stem
        model = None
        for row in rows:
            if row.get("type") == "model_change":
                model = f"{row.get('provider')}/{row.get('modelId')}"
            message = row.get("message") or {}
            if message.get("role") == "assistant" and message.get("model"):
                model = f"{message.get('provider')}/{message.get('model')}"
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
            code = ((calls.get(message.get("toolCallId")) or {}).get("code") or "").strip()
            bash = details.get("bashCommands") if isinstance(details.get("bashCommands"), dict) else {}
            count = int(bash.get("count") or 0)
            command = normalize_command(str(bash.get("first") or "")) if bash else ""
            cell = {
                "sid": sid,
                "kernel": kernel,
                "model": model or "?",
                "ms": float(duration),
                "code": code,
                "lines": len([line for line in code.splitlines() if line.strip()]),
                "bash": count > 0,
                "bash_count": count,
                "command": command,
                "bash_trivial": count == 1 and bool(SHELL_TRIVIAL.match(command)),
                "stdout": len(str(details.get("stdout") or "")),
                "result": len(str(details.get("result") or "")),
                "error": bool(message.get("isError")) or details.get("status") == "error",
                "ename": str(details.get("errorEname") or (details.get("error") or {}).get("ename") or ""),
                "status": str(details.get("status") or ""),
                "restarted": bool(details.get("kernelRestarted")),
                "first": kernel not in seen,
                "pythonlike": bool(PY_SYNTAX.search(code)),
            }
            seen.add(kernel)
            cell["class"] = classify(cell)
            cells.append(cell)
            sessions.setdefault(sid, {"model": model, "start": session.get("timestamp"), "cells": 0})
            sessions[sid]["cells"] += 1
    return cells, sessions


def dist_row(label: str, cells: list[dict]) -> str:
    q = quant([cell["ms"] for cell in cells])
    if not q:
        return f"| {label} | 0 | — | — | — | — | — | — |"
    ci = cluster_bootstrap_median(cells)
    ci_text = f"[{ci[0]:.1f}, {ci[1]:.1f}]" if ci else "—"
    return (
        f"| {label} | {q['n']} | {q['median']:.1f} ms | {ci_text} | {q['p75']:.1f} | "
        f"{q['p90']:.1f} | {q['p95']:.1f} | {q['p99']:.1f} | {q['mean']:.1f} | {q['max']:.1f} |"
    )


def main() -> int:
    sessions_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".prime/agent/sessions"
    cells, sessions = collect(sessions_dir)
    by_kernel = {kernel: [cell for cell in cells if cell["kernel"] == kernel] for kernel in KERNELS}
    kernel_sessions = {
        kernel: {cell["sid"] for cell in by_kernel[kernel]} for kernel in KERNELS
    }

    print("## Corpus")
    print(f"- kernel cells: {len(cells)}; sessions: {len(sessions)}")
    for kernel in KERNELS:
        mine = by_kernel[kernel]
        starts = sorted(sessions[sid]["start"] for sid in kernel_sessions[kernel] if sessions[sid]["start"])
        models = Counter(cell["model"] for cell in mine)
        print(
            f"- {kernel}: sessions={len(kernel_sessions[kernel])} cells={len(mine)} "
            f"cells/session={len(mine)/max(1,len(kernel_sessions[kernel])):.1f} "
            f"span={starts[0] if starts else '?'}..{starts[-1] if starts else '?'}"
        )
        for model, count in models.most_common(3):
            print(f"    {model}: {count}")

    print("\n## Headline comparison values (Bun vs Python)")
    print("| metric | python | bun | delta | ratio | change | n py/bun | note |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
    print(compare("all kernel cells", [c["ms"] for c in by_kernel["python"]],
                  [c["ms"] for c in by_kernel["bun"]], "workloads differ"))
    model = "commandcode/deepseek/deepseek-v4.1-flash"
    print(compare(f"same model ({model.split('/')[-1]})",
                  [c["ms"] for c in by_kernel["python"] if c["model"] == model],
                  [c["ms"] for c in by_kernel["bun"] if c["model"] == model],
                  "model-controlled, workload still differs"))
    singles = [cell for cell in cells if cell["bash_count"] == 1 and cell["command"]]
    commands = {kernel: Counter(cell["command"] for cell in singles if cell["kernel"] == kernel)
                for kernel in KERNELS}
    common = set(commands["python"]) & set(commands["bun"])
    matched_py = [cell["ms"] for cell in singles if cell["kernel"] == "python" and cell["command"] in common]
    matched_bun = [cell["ms"] for cell in singles if cell["kernel"] == "bun" and cell["command"] in common]
    print(compare("identical bash commands", matched_py, matched_bun,
                  f"Cliff's delta={cliffs_delta(matched_bun, matched_py):+.2f}; the only like-for-like slice"))
    for cls in ("import", "await"):
        print(compare(cls, [c["ms"] for c in by_kernel["python"] if c["class"] == cls],
                      [c["ms"] for c in by_kernel["bun"] if c["class"] == cls], "class cohorts, not matched work"))
    py_first = [c["ms"] for c in by_kernel["python"] if c["first"]]
    bun_first = [c["ms"] for c in by_kernel["bun"] if c["first"]]
    print(compare("kernel readiness (first cell)", py_first, bun_first, "includes kernel start"))
    if py_first and bun_first:
        print(f"| readiness p90 | {quant(py_first)['p90']:.1f} | {quant(bun_first)['p90']:.1f} | "
              f"{quant(bun_first)['p90']-quant(py_first)['p90']:+.1f} | "
              f"{quant(bun_first)['p90']/quant(py_first)['p90']:.2f}× | "
              f"{(quant(bun_first)['p90']-quant(py_first)['p90'])/quant(py_first)['p90']*100:+.1f}% | "
              f"{len(py_first)}/{len(bun_first)} | includes kernel start |")
        print(f"| readiness max | {quant(py_first)['max']:.1f} | {quant(bun_first)['max']:.1f} | "
              f"{quant(bun_first)['max']-quant(py_first)['max']:+.1f} | "
              f"{quant(bun_first)['max']/quant(py_first)['max']:.2f}× | "
              f"{(quant(bun_first)['max']-quant(py_first)['max'])/quant(py_first)['max']*100:+.1f}% | "
              f"{len(py_first)}/{len(bun_first)} | cold-start outlier |")
    py_err = sum(1 for c in by_kernel["python"] if c["error"]) / len(by_kernel["python"])
    bun_err = sum(1 for c in by_kernel["bun"] if c["error"]) / len(by_kernel["bun"])
    print(f"| error rate | {py_err:.1%} | {bun_err:.1%} | {bun_err-py_err:+.1%} pp | "
          f"{bun_err/py_err:.2f}× | {(bun_err-py_err)/py_err*100:+.1f}% | "
          f"{len(by_kernel['python'])}/{len(by_kernel['bun'])} | language migration |")
    diff_ci = bootstrap_median_diff(by_kernel["python"], by_kernel["bun"])
    if diff_ci:
        print(f"\nall-cells median difference 95% CI: [{diff_ci[0]:+.1f}, {diff_ci[1]:+.1f}] ms "
              f"(spans zero = not distinguishable)")

    print("\n## Duration distribution (all cells)")
    print("| kernel | n | median | 95% CI (session bootstrap) | p75 | p90 | p95 | p99 | mean | max |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for kernel in KERNELS:
        print(dist_row(kernel, by_kernel[kernel]))

    print("\n## Duration distribution by class")
    print("| class | n (py) | median (py) | p90 (py) | n (bun) | median (bun) | p90 (bun) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for cls in ("pure_short", "pure_multi", "import", "await", "file_or_net",
                "bash_trivial", "bash_other", "wait"):
        row = []
        for kernel in KERNELS:
            subset = [cell for cell in by_kernel[kernel] if cell["class"] == cls]
            q = quant([cell["ms"] for cell in subset])
            row.extend([q["n"], f"{q['median']:.1f}", f"{q['p90']:.1f}"] if q else [0, "—", "—"])
        print(f"| {cls} | " + " | ".join(str(value) for value in row) + " |")

    print("\n## Like-for-like: identical single-command bash cells")
    singles = [cell for cell in cells if cell["bash_count"] == 1 and cell["command"]]
    commands = {
        kernel: Counter(cell["command"] for cell in singles if cell["kernel"] == kernel)
        for kernel in KERNELS
    }
    common = sorted(set(commands["python"]) & set(commands["bun"]))
    print("| command | py n | py median | bun n | bun median |")
    print("| --- | ---: | ---: | ---: | ---: |")
    matched_py, matched_bun = [], []
    for command in common:
        py = [cell["ms"] for cell in singles if cell["kernel"] == "python" and cell["command"] == command]
        bun = [cell["ms"] for cell in singles if cell["kernel"] == "bun" and cell["command"] == command]
        print(f"| `{command[:56]}` | {len(py)} | {statistics.median(py):.1f} | {len(bun)} | {statistics.median(bun):.1f} |")
        matched_py.extend(py)
        matched_bun.extend(bun)
    if matched_py and matched_bun:
        delta = cliffs_delta(matched_bun, matched_py)
        print(
            f"\nmatched total: python n={len(matched_py)} median={statistics.median(matched_py):.1f}ms; "
            f"bun n={len(matched_bun)} median={statistics.median(matched_bun):.1f}ms; "
            f"Cliff's delta={delta:+.2f} (positive = Bun slower)"
        )
        rng = random.Random(23)
        diffs = []
        for _ in range(4000):
            py_sample = [rng.choice(matched_py) for _ in matched_py]
            bun_sample = [rng.choice(matched_bun) for _ in matched_bun]
            diffs.append(statistics.median(bun_sample) - statistics.median(py_sample))
        diffs.sort()
        print(
            f"matched median-difference 95% CI (cell bootstrap): "
            f"[{diffs[int(0.025*(len(diffs)-1))]:+.1f}, {diffs[int(0.975*(len(diffs)-1))]:+.1f}] ms"
        )

    print("\n## Bash cells by output size (stdout chars)")
    print("| bucket | py n | py median | bun n | bun median |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for label, low, high in (("0", 0, 0), ("1-100", 1, 100), ("101-1k", 101, 1000),
                             ("1k-10k", 1001, 10000), (">10k", 10001, 10**12)):
        row = []
        for kernel in KERNELS:
            subset = [cell["ms"] for cell in by_kernel[kernel] if cell["bash"] and low <= cell["stdout"] <= high]
            q = quant(subset)
            row.extend([q["n"], f"{q['median']:.1f}"] if q else [0, "—"])
        print(f"| {label} | " + " | ".join(str(value) for value in row) + " |")

    print("\n## Non-bash cells by output size (stdout chars)")
    print("| bucket | py n | py median | bun n | bun median |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for label, low, high in (("0", 0, 0), ("1-100", 1, 100), ("101-1k", 101, 1000), (">1k", 1001, 10**12)):
        row = []
        for kernel in KERNELS:
            subset = [cell["ms"] for cell in by_kernel[kernel] if not cell["bash"] and low <= cell["stdout"] <= high]
            q = quant(subset)
            row.extend([q["n"], f"{q['median']:.1f}"] if q else [0, "—"])
        print(f"| {label} | " + " | ".join(str(value) for value in row) + " |")

    print("\n## Model-controlled comparison (same provider/model)")
    models = {kernel: Counter(cell["model"] for cell in by_kernel[kernel]) for kernel in KERNELS}
    overlap = set(models["python"]) & set(models["bun"])
    print("| model | py n | py median | bun n | bun median |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for model in sorted(overlap):
        py = [cell["ms"] for cell in by_kernel["python"] if cell["model"] == model]
        bun = [cell["ms"] for cell in by_kernel["bun"] if cell["model"] == model]
        print(f"| {model} | {len(py)} | {statistics.median(py):.1f} | {len(bun)} | {statistics.median(bun):.1f} |")

    print("\n## Error rates")
    print("| kernel | errors / cells | rate | 95% Wilson CI | top error names |")
    print("| --- | ---: | ---: | ---: | --- |")
    for kernel in KERNELS:
        mine = by_kernel[kernel]
        errors = sum(1 for cell in mine if cell["error"])
        low, high = wilson(errors, len(mine))
        names = Counter(cell["ename"] for cell in mine if cell["error"]).most_common(4)
        names_text = ", ".join(f"{name or '?'}×{count}" for name, count in names)
        print(f"| {kernel} | {errors}/{len(mine)} | {errors/len(mine):.1%} | [{low:.1%}, {high:.1%}] | {names_text} |")

    print("\n## Kernel readiness (first cell of a session)")
    print("| kernel | n | median | p90 | max |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for kernel in KERNELS:
        q = quant([cell["ms"] for cell in by_kernel[kernel] if cell["first"]])
        if q:
            print(f"| {kernel} | {q['n']} | {q['median']:.1f} ms | {q['p90']:.1f} ms | {q['max']:.1f} ms |")

    print("\n## Output volume per cell")
    print("| kernel | stdout median chars | stdout p90 chars | result median chars |")
    print("| --- | ---: | ---: | ---: |")
    for kernel in KERNELS:
        stdout = [cell["stdout"] for cell in by_kernel[kernel]]
        result = [cell["result"] for cell in by_kernel[kernel]]
        q_stdout = quant(stdout)
        q_result = quant(result)
        if q_stdout:
            print(f"| {kernel} | {q_stdout['median']:.0f} | {q_stdout['p90']:.0f} | {q_result['median']:.0f} |")

    print("\n## Long-tail concentration (share of total cell time)")
    print("| kernel | total cell time | top 1% cells | top 5% cells |")
    print("| --- | ---: | ---: | ---: |")
    for kernel in KERNELS:
        mine = sorted(by_kernel[kernel], key=lambda cell: -cell["ms"])
        total = sum(cell["ms"] for cell in mine)
        if not total:
            continue
        top1 = sum(cell["ms"] for cell in mine[: max(1, len(mine) // 100)]) / total
        top5 = sum(cell["ms"] for cell in mine[: max(1, len(mine) // 20)]) / total
        print(f"| {kernel} | {total/1000/60:.1f} min | {top1:.1%} | {top5:.1%} |")

    print("\n## Per-session aggregates (median across sessions)")
    print("| kernel | sessions | cells/session | total cell time/session | median cell | error rate |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for kernel in KERNELS:
        rows = []
        for sid in kernel_sessions[kernel]:
            mine = [cell for cell in by_kernel[kernel] if cell["sid"] == sid]
            rows.append((len(mine), sum(cell["ms"] for cell in mine) / 1000,
                         statistics.median([cell["ms"] for cell in mine]),
                         sum(1 for cell in mine if cell["error"]) / len(mine)))
        columns = list(zip(*rows))
        print(
            f"| {kernel} | {len(rows)} | {statistics.median(columns[0]):.0f} | "
            f"{statistics.median(columns[1]):.0f} s | {statistics.median(columns[2]):.1f} ms | "
            f"{statistics.median(columns[3]):.1%} |"
        )

    print("\n## Back-calculation from the session records")
    python_cells = len(by_kernel["python"])
    if matched_py and matched_bun:
        delta_ms = statistics.median(matched_bun) - statistics.median(matched_py)
        print(
            f"- identical-command cohort: {delta_ms:+.1f} ms/cell (Bun − Python, positive = Bun slower); "
            f"applied to all {python_cells} Python cells: {delta_ms*python_cells/1000:+.1f} s"
        )
    import_cells = [c for c in by_kernel["python"] if c["class"] == "import"]
    await_cells = [c for c in by_kernel["python"] if c["class"] == "await"]
    import_gap = statistics.median([c["ms"] for c in import_cells]) - statistics.median(
        [c["ms"] for c in by_kernel["bun"] if c["class"] == "import"])
    await_gap = statistics.median([c["ms"] for c in await_cells]) - statistics.median(
        [c["ms"] for c in by_kernel["bun"] if c["class"] == "await"])
    print(f"- import: {import_gap:+.1f} ms/cell (Python − Bun, positive = Bun saving) × "
          f"{len(import_cells)} cells = {import_gap*len(import_cells)/1000:+.1f} s")
    print(f"- await:  {await_gap:+.1f} ms/cell × {len(await_cells)} cells = "
          f"{await_gap*len(await_cells)/1000:+.1f} s")
    print(
        f"- net upper bound if every Python cell ran on Bun: "
        f"{(import_gap*len(import_cells) + await_gap*len(await_cells))/1000:+.1f} s "
        f"(identical-command cohort alone says {delta_ms*python_cells/1000:+.1f} s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
