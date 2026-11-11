# Kernel performance: Bun vs Python

Measured on the same machine (darwin-arm64, Apple silicon), same host, same
REPL protocol v3. Two sources:

1. **Controlled benchmark** (`test/bench/kernel-bench.ts`) — identical
   workload, each cell written in its runtime's idiomatic form, results
   asserted so a failing cell cannot look fast. This is the authoritative
   comparison.
2. **Real session records** (`~/.prime/agent/sessions`) — what the two kernels
   actually did in this user's sessions. Useful for context, not for an
   apples-to-apples speed claim: the workloads differ.

## TL;DR

| Question | Answer |
| --- | --- |
| Is the Bun kernel faster per cell? | Yes: **~2× per empty/scalar cell**, **~3× on 1000-write cells**, **~8.5× on snapshots**, **~3.4× on startup** |
| Does it make the agent feel much faster end to end? | No. Model/network latency is **>99%** of a turn; the kernel contributes milliseconds |
| Where the fork genuinely wins | no Python venv (235 MB, uv bootstrap), 184 KB runtime vs 1.7 MB + venv, faster startup/snapshot, ~24% lower idle memory |
| What actually produced the big perceived speedup this week | proxy bypass for the provider (`bypassProxy`): 9.6 s → 1.9 s first byte on the measured channel — not the kernel swap |

## 1. Controlled benchmark

`bun run test/bench/kernel-bench.ts --rounds 3`

| metric | bun | python | bun vs python |
| --- | ---: | ---: | ---: |
| cold start (ms) | 11.51 | 39.27 | **-71%** (3.4×) |
| empty cell (ms) | 0.06 | 0.12 | -50% |
| scalar cell (ms) | 0.07 | 0.12 | -42% |
| 1 KiB output (ms) | 0.08 | 0.14 | -43% |
| 64 KiB output (ms) | 0.13 | 0.21 | -38% |
| 1000 writes (ms) | 1.48 | 4.41 | **-66%** (3.0×) |
| bash echo (ms) | 4.22 | 6.35 | -34% |
| 200 cells, per cell (ms) | 0.04 | 0.11 | **-64%** |
| snapshot, 200 vars (ms) | 0.55 | 4.69 | **-88%** (8.5×) |
| RSS at ready (MiB) | 22.38 | 29.52 | -24% |
| RSS after work (MiB) | 36.02 | 31.06 | **+16%** (Bun uses more) |
| RSS after GC (MiB) | 36.33 | 31.06 | +17% |

Reading: per-cell interpreter overhead drops by roughly half to two thirds,
startup by 71%, snapshots by 88%. Under sustained work the Bun process holds a
larger heap (36 MiB vs 31 MiB) — the one metric where Python wins.

## 2. Real session records

Corpus at the time of writing:

| | Python kernel | Bun kernel |
| --- | ---: | ---: |
| sessions | 48 | 6 |
| kernel cells | ≈8,700 | ≈360 |

| slice | python (median / p95) | bun (median / p95) |
| --- | ---: | ---: |
| all cells | 56 ms / 10.9 s | 57 ms / 28.1 s |
| bash-driven cells | 187 ms / 14.3 s | 51.5 ms / 32.3 s |
| pure cells, 1–5 lines, ok | 5 ms / 5.6 s | 59 ms / 1.2 s |
| first cell of a session | 4 ms / 63 ms | — |

**Do not read a speedup from this table.** The two corpora are different jobs:

- the Python corpus spans months of mixed work, with many tiny introspection
  cells (the 5 ms median);
- the Bun corpus is essentially **one** heavy session (Nuxt/CloudBase work:
  file I/O, `bun install`, builds, network calls, deliberate `setTimeout`
  waits). Its "pure" cells still read files or call the network, so the cell
  duration measures that work, not the interpreter.

The controlled benchmark above is the number to quote. The session data is
useful for three things: corpus size, the error-rate shift (below), and the
"kernel is a rounding error in a turn" argument.

## 3. What dominates a turn

From `PI_REQUEST_TIMING=1` on a real third-cn request:

| phase | time |
| --- | ---: |
| dispatch → prompt built | 0.1 ms |
| prompt built → request sent | 0.4 ms |
| request sent → first byte | **3.9–10.3 s** |
| first byte → first token | 0.3 ms |
| first token → stream done | 0.1–2.6 s |

A typical kernel cell is 0.05–0.2 ms (empty/scalar) and a bash cell adds the
command's own runtime. Even a 200-cell session saves ~10 ms of interpreter
overhead with Bun — invisible next to a 4–10 s model wait.

The same day's actual end-to-end win came from outside the kernel:

| change | measured effect on first byte |
| --- | --- |
| `bypassProxy` for the provider | 9.6 s → **1.9 s** (≈5×) |
| stale 18-day-old daemon replaced by the fork daemon | 44.7 s turns (2 `Connection error.` retries) → **2.2–2.8 s** |

## 4. Where the Bun swap does pay off

- **No Python venv.** `~/.prime/agent/kernel-venv` is **235 MB**; the Bun
  sidecar is **184 KB** (Bun itself is a one-time, machine-level install).
  No uv bootstrap, no venv drift, no per-install skill installation.
- **Startup 3.4× faster** (11.5 ms vs 39.3 ms) and **snapshots 8.5× faster**
  (0.55 ms vs 4.69 ms for 200 variables), which is what a resumed session
  pays.
- **Lower idle footprint** (22.4 vs 29.5 MiB).
- **No per-cell import costs**: no `import` statements, no module reloading.

## 5. Costs and regressions observed

- **Memory under load**: +16% (36.0 vs 31.1 MiB) after sustained work.
- **Language migration errors**: when existing sessions switched kernels, the
  model kept writing Python into the Bun kernel — `SyntaxError` /
  `ReferenceError` cells (4.1% vs 2.3% error rate in the corpus). The prompt
  layer and the card/dispatch fixes address this; a resumed Python-era session
  still anchors on its own history, so start a fresh session after the switch.
- **No `repr()` parity**: results render with `Bun.inspect`, so text is
  double-quoted and objects are JS-shaped.

## 6. Reproduce

```bash
# controlled benchmark (both runtimes, 3 rounds)
bun run test/bench/kernel-bench.ts --rounds 3

# real-session corpus statistics
python3 scripts/fork/kernel_session_stats.py
```

## 7. Conclusion

The kernel swap is an **infrastructure** improvement, not an end-to-end
speedup: ~2–3× less per-cell overhead, 3.4× faster startup, 8.5× faster
snapshots, no 235 MB Python toolchain — against a turn whose model latency is
measured in seconds. Report the controlled numbers when the subject is the
kernel; attribute the dramatic "waiting" improvements to the proxy/daemon
work, not to Bun.
