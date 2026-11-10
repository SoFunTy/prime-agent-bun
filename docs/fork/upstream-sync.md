# Following upstream after the kernel swap

The fork keeps tracking Prime Agent. The data says that is a real cost, not a
formality: over the last 300 upstream commits, **98 touched the kernel surface**
(`prime-agent-runtime/`, `crates/pa-core/src/kernel/`, `tools/ipython*`,
`prompts/layers/`, `skills/`) — roughly one in three, and rising as upstream
invests in the RLM/factory APIs that live inside the runtime.

So "follow upstream" is two coupled tracks, not one `git rebase`.

## Track 1 — mechanical: keep git mergeable

1. Keep the fork a **thin patch series over upstream `main`**, not a divergent
   history:
   ```bash
   git remote add upstream git@github.com:PrimeIntellect-ai/prime-agent.git
   git fetch upstream
   ```
2. Confine the fork's changes to the declared file set
   (`docs/fork/kernel-ownership.md`). Conflicts then always land in known files.
3. Never delete the upstream Python runtime: dormant files merge cleanly.

Per-sync loop:

```bash
git fetch upstream
python3 scripts/fork/classify_upstream.py --range <last-synced>..upstream/main
# clean commits  -> cherry-pick / rebase mechanically
# kernel commits -> one ledger row each (below)
python3 scripts/fork/protocol_drift.py --ref upstream/main
```

## Track 2 — semantic: the port ledger

Kernel-surface commits do not merge; they are re-derived against the Bun
runtime. Every one gets a row here with a disposition:

- **Port** — implement the same behavior in `prime-agent-bun-runtime`
- **Not applicable** — Python/IPython/dill/uv/venv-internal (the drift script
  reports Python-only paths separately)
- **Defer** — crosses too much of the fork's surface; schedule separately

### Ledger

| upstream | disposition | fork | note |
| --- | --- | --- | --- |
| kernel protocol v3 (`repl.md`) | Ported | `prime-agent-bun-runtime/src/repl.ts` | Full request/event set, caps, ordering |
| dill snapshots | Ported (format divergence) | `src/snapshot.ts` | Bun-native payload; host treats it as opaque |
| `rlm.spawn` / `create_session` / `find_models` / `list_subagents` / `collect` / `rename` / `delete_subagent` / `progress_note` / `end_turn` / `session.messages` | Ported | `src/rlm.ts` | Same wire request types |
| `rlm.harness` CRUD | Ported | `src/harness.ts` | Same on-disk state shape |
| `bash()` + persistent shells + `bash_activity` | Ported | `src/bash.ts` | Handle surface, the `[bash-done]` `bash.completed` lane, and `bash.consumed` |
| factory executor + machine library | Deferred | — | `rlm.factory.*` refuses with a pointer; `factory_activity` answers an error |
| executable Python skills (`edit`/`agent-message`/`agent-observe`/`compact`/`goal`/`refine`/`rlm-heartbeat`/`websearch`/`attach-image`) | Ported | `skills/<name>/index.ts` | Same host request types; `linear`/`notion` use `mcp.call_tool` |
| generic MCP runtime | Ported | `prime-agent-bun-runtime/src/mcp.ts` | Dependency-free JSON-RPC (stdio + HTTP); host keeps config/credential ownership |
| model-facing kernel prose | Ported (gated) | `crates/pa-core/src/prompts/layers/kernel-bun.md` | Appended only when the Bun runtime is selected; the tool there is `bun_repl` |
| Python executable skills (`edit`/`attach_image`/`websearch`/`linear`/`notion`) | Deferred | — | Runtime does not load them |
| continual-harness skill `reference` contracts (`/refine` planner) | Deferred | — | Still Python-typed; the Bun digest says those entries do not execute in this kernel |
| Python venv provisioning (`bootstrap/venv/**`, `provisioner.rs` bootstrap) | Not applicable | `bun_runtime.rs` | Bun resolution replaces uv/venv; the Python path is retained |

Update this table (and `KERNEL-API.md`) in the same change that ports something.

## Real-provider verification

The protocol suite and the scripted-provider gates prove the *machinery*. They
cannot prove the model behaves under the real prompt, so a live session was run
against a user-configured provider (`third-cn` / `deepseek-v4.1-flash`, isolated
session dir):

| Scenario | Result |
| --- | --- |
| "List the files here; use one kernel cell" | 1 tool call, `bun_repl`, `await bash('ls -la')` in JavaScript, correct answer |
| "Create plan.md, then use the edit skill to change three→four" (before the sweep) | 12 tool calls; the model was misled by `edit/SKILL.md`'s Python example and by `require`/`import` failing; it recovered by reading `skills/edit/index.ts` |
| Same scenario (after the sweep) | 4 tool calls, 0 Python idioms, `require('fs')` works, `await edit({ path, old_str, new_str })`, correct file on disk |
| Long conversation: 9 turns, growth past an 8%-of-window compaction threshold | **8 automatic compactions** in one session, each injecting the Bun-worded kernel-state notice; a binding created at turn 3 (`counts`) and a string created at turn 2 were read back at turn 9 **without recomputation**, through a multi-line `try/catch` + `if/else` cell |
| RLM subagent: "spawn a child named probe and report its reply" | Child session created and run to completion; the parent reported `child-ok` |
| Automatic refinement (`autoRefine` + `turnInterval: 2`) | The host ran a refinement on its own schedule, injected `Refinement complete: …` and the `[self-refinement]` row, and wrote one global memory; a following cell still read the long-lived binding |

The live runs stayed inside a probe agent dir (`models.json` and `auth.json`
symlinked, everything else written there), so no session, harness entry, or
credential of the operator's real `~/.prime/agent` was touched.

The long-conversation run found a fourth defect: a `try { … } catch { … }` cell
died with `Unexpected keyword 'return'. Try statements must have at least a catch
or finally block.` The statement scanner ended a statement at the block's closing
`}`, so the following `else` / `catch` / `finally` / `while` clause was read as a
trailing expression and rewritten to `return (else { … })`. Clauses now stay part
of their statement; `test/case-22` pins every control-flow shape.

The live run found three defects the scripted gates could not: cells did not
accept TypeScript, module loading (`require` / static `import`) did not work, and
the skill markdown taught Python calls. All three are fixed and gated.

## Drift detection

Three surfaces can silently invalidate the Bun runtime. `protocol_drift.py`
diffs all three against a reference revision:

1. **protocol spec** — `prime-agent-runtime/src/rlm/repl.md` +
   `crates/pa-core/src/kernel/protocol.rs` (request/event vocabulary,
   `REPL_PROTOCOL_VERSION`, the `*_CAP` constants);
2. **`rlm` API** — the `` `rlm.*` `` references in
   `crates/pa-core/src/prompts/layers/core.md`;
3. **kernel probe** — the assertion list in
   `crates/pa-core/src/kernel/bootstrap/venv/probe.rs`, which enumerates the
   entire `rlm` surface in one place and is the closest thing upstream ships to
   a machine-readable API contract.

A non-empty report *is* the port backlog. Wire it into CI as a warning first,
then a gate once the backlog is empty.

## Phases

| Phase | State | Content |
| --- | --- | --- |
| 0 | Done | Ownership map, classification + drift scripts |
| 1 | Done | Bun runtime speaks protocol v3 (requests, events, caps, ordering) |
| 2 | Done | Rust seam: `KernelLauncher` + runtime selection + Bun resolution (`bun_runtime.rs`) |
| 3 | Done except factory | `rlm` API, executable skills, and the MCP client are ported; only the factory executor remains |
| 4 | Done | `test/case-1..22` protocol/scenario suite, five Rust integration gates, and `test/verify-all.sh` as the single entry point (16 lanes, `--with-package` builds the real payload), plus the live-provider scenarios above |
| 5 | Partly | Runtime-conditional prompt layer and the `javascriptCellTimeoutMs` alias are in; the tool rename (`python_repl` → `javascript`) remains a product decision |
| 2b | Open | Packaging: add `prime-agent-bun-runtime` to the release sidecar lists (`scripts/package_release.py`, `scripts/release/assemble_artifacts.py`, `native_compat.py`, `assemble_source.py`, `Makefile`). Until then the dev path uses `PRIME_AGENT_BUN_RUNTIME_DIR`. |
| 6 | Open | Retire the Python runtime (only after 5 and a full end-to-end session run) |

## Governance note

`AGENTS.md` in this tree is upstream's. Its parity-diff gate is defined against
the TypeScript build (`v0.9.8`, tag `PA_TS_REFERENCE`) and its adoption-telemetry
rule assumes upstream's shipped surfaces. Neither holds for the Bun kernel, so
the fork must maintain its own gate definition rather than silently editing
upstream's file. This document is that definition: parity means **protocol
conformance** (`test/case-*`) plus the declared divergences in `KERNEL-API.md`,
verified against the real server, never against a re-implementation of it.
