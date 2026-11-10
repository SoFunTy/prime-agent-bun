# Kernel API contract and parity ledger

The authoritative protocol specification is
`prime-agent-runtime/src/rlm/repl.md` (protocol version 3). This file tracks
what the Bun runtime implements, what it deliberately diverges on, and what is
still owed. It is the fork's port backlog: upstream changes to the protocol,
the frame caps, or the `rlm` API land here first.

## Protocol requests

| Request | Status | Notes |
| --- | --- | --- |
| `execute` | Done | Async-function cell; persistence transform; result/error/done |
| `interrupt` | Done | Parked-before-start and mid-cell delivery; sync loops are not preemptible (JS is single-threaded) |
| `host_reply` | Done | Routed by id on the reader path, never queued behind a cell |
| `snapshot` | Done | Atomic payload + manifest; per-variable and aggregate caps; `prune_oversized` |
| `restore` | Done | Missing file → `ok` + `reason`; per-name failures reported; `In`/`Out`/`get_ipython` never revived |
| `list_names` | Done | Sorted, same filter as the snapshot |
| `mcp_status` | Done | Lists each configured server's real tools; a failing/timing-out server reports its own error row |
| `bash_activity` | Done | `list` / `tail` / `kill`; latest 64 finished rows; tail clamped to 1..200 |
| `shutdown` | Done | Replies `done`, closes persistent shells, exits 0 |
| `factory_activity` | Not ported | Answers `done error` with a pointer to this file (factory executor is deferred) |

## Protocol events

| Event | Status | Notes |
| --- | --- | --- |
| `ready` | Done | `{"event":"ready","protocol":3,"runtime":"bun","bun":"<version>"}`; extra keys are ignored by the Rust parser |
| `stdout` / `stderr` | Done | Tagged with the originating cell via `AsyncLocalStorage`; 64 Ki characters per frame |
| `result` | Done | 1,048,576-character cap + truncation marker |
| `display` | Done | 16 Mi-character payload cap, refused in the calling cell |
| `host_request` | Done | Runtime-minted id; same payload cap |
| `error` | Done | `ename` / `evalue` / `traceback`, caps applied |
| `done` | Done | Exactly one per id'd request, after all of its other frames |

## Cell compilation

| Step | Behavior | Why it exists |
| --- | --- | --- |
| TypeScript erasure | `Bun.Transpiler({loader:"ts"})` strips type annotations and `interface`; a source it cannot parse falls through unchanged | The prompt promises cells accept TypeScript; without this `const x: Foo \| null = null` is a syntax error |
| Trailing expression sink | The last top-level expression becomes `__prime_agent_result__(expr)` | Bun's transpiler drops effect-free trailing expressions (`answer` → nothing), which silently removed every cell result |
| Static import rewriting | `import {a} from "m"` → `const {a} = await import("m")` (default, namespace, side-effect and type-only forms handled) | A cell body is an async function body, where a static `import` is a syntax error |
| `require` | A `createRequire` binding is passed into the cell | The CommonJS spelling is what JavaScript users reach for first |
| Persistence | Top-level `const`/`let`/`var`/`function`/`class` and assignments are copied to `globalThis` | Cells share one namespace |
| Statement scanning | `else` / `catch` / `finally` / `while` stay part of the statement before them | A block's closing `}` must not split `try {…} catch {…}`, or the clause reads as a trailing expression and the cell becomes `return (else …)` |

## Frame caps

| Cap | Value | Status |
| --- | --- | --- |
| stream frame text | 65,536 chars | Done |
| result / error text | 1,048,576 chars | Done |
| display / host_request payload | 16,777,216 chars | Done |
| protocol line | 32 MiB (host side) | n/a |
| snapshot per-variable | 16 MiB default | Done |
| snapshot aggregate | 256 MiB default | Done |
| bash activity reply | 16 KiB | Done (response trimmed) |

## `rlm` API

| Surface | Status | Notes |
| --- | --- | --- |
| `spawn` / `create_session` | Done | Wraps `rlm.run` / `rlm.create_session` (the wire type stays `rlm.run` for cross-version compatibility) |
| `collect(targets, { timeout_ms })`, `session.count('user')` | Done | One options object (a bare number / bare role string is accepted too) |
| `find_models` / `list_subagents` / `collect` | Done | Payload validation mirrors `__init__.py` |
| `progress_note` / `delete_subagent` / `rename` | Done | 512-character note limit enforced |
| `end_turn` | Done | `rlm.end_turn` request type |
| `session.messages` / `session.count` | Done | Emits the transcript-read display record |
| `harness` / `get_harness_state` | Done | JSON store matching the Python `schema`/`entries`/`refinements` shape; `create_*`/`update_*` accept the JS options object and the Python positional form |
| `persistent_shells` | Done | Sentinel-fenced long-lived shell |
| `bash()` handle surface | Done | `await handle`, `.output()`, `.tail(n)`, `.poll()`, `.running`, `.kill()` |
| Persistent shell | Done | One long-lived `sh`; commands are serialized and its stdout lines are queued, so a command can never hang on a line that arrived before its reader |
| `bash.completed` / `bash.consumed` host requests | Done | A detached command that outlives its cell fires `[bash-done]`; reading an announced result tells the host to drop it |
| `mcp.list_tools` / `mcp.call_tool` / `mcp.status` | Done | Dependency-free JSON-RPC client (stdio + streamable HTTP); config/credentials stay host-owned via `mcp.config` |
| `mcp.list_connections` / `list_plugins` / `search_plugins` / `search_tools` / `describe_tool` | Done | Host inventory passthrough (`mcp.*`) |
| `factory.*` | Not ported | `run`/`status`/`stop`/`resume`/`graph`/`watch` refuse with one message; `help()` points here |
| `edit`, `agent_message`, `agent_observe`, `compact`, `goal`, `refine`, `rlm_heartbeat`, `websearch`, `attach_image` skills | Done | JavaScript packages beside their Python originals (`skills/<name>/index.ts` + `package.json` `primeAgent.javascript`), loaded by the bootstrap cell |
| `linear` / `notion` integration skills | Not ported | They subclass the Python `McpIntegration`; use `mcp.call_tool` directly |
| continual-harness skill entries (`/refine` `reference` contracts) | Not ported | The refine planner prompt and the entry schema still describe Python `reference` objects; the Bun harness digest states those entries do not execute here, and installed JavaScript modules are the callable path |

## Declared divergences

These are intentional and must be revisited when the model-facing surface is
rewritten (fork phase 5 in `docs/fork/upstream-sync.md`):

1. **Result rendering.** Python returns `repr()`; the Bun runtime returns
   `Bun.inspect(v, {colors: false, depth: 4})`. Strings render double-quoted and
   objects render JS-style.
2. **Raw fd 1 writes.** Python redirects fd 1/2 into pipes so `os.write` /
   subprocess output is captured as untagged stream events. Bun has no `dup2`,
   so fd 1 belongs to the protocol and a raw `fs.writeSync(1, ...)` /
   `Bun.write(Bun.stdout, ...)` from user code would corrupt framing. `console`,
   `process.stdout/stderr`, and `bash()` are all captured correctly.
3. **Interrupting synchronous code.** A cell blocked in a synchronous loop
   cannot be interrupted (single-threaded JS). `await`-suspended cells
   interrupt normally; this matches the Python runtime's Windows best-effort
   path.
4. **Method spellings.** Every `rlm` method and every skill `run` accepts
   snake_case keys (the documented Python API) *and* camelCase aliases, so the
   existing prompt keeps working while the fork migrates. JavaScript skills take
   one options object (`await edit({ path, old_str, new_str })`); the Python
   skills' keyword form is not valid JavaScript.
5. **Snapshot payload format.** Bun-native (structured clone via `bun:jsc` plus
   source recipes for plain functions). The Rust host treats the payload as
   opaque and only stats the manifest, so a Python snapshot is not readable by
   the Bun runtime and vice versa.

## Selection layering

`apply_product_default()` at the composition root forces Bun for the shipped
binary: the product has no Python fallback, so an install without Bun fails the
kernel start with an actionable error. `pa-core`'s library default stays Python
so upstream's test surface is untouched; `PRIME_AGENT_KERNEL_RUNTIME=bun` is the
library opt-in. `KernelManagerOptions::python` (an explicitly named interpreter)
always wins over both.

## Model-facing prompt

The harness prompt stays upstream's, driven by the process-global runtime
selection: selecting the Bun kernel appends the static
`prompts/layers/kernel-bun.md` layer, which states that cells are
JavaScript/TypeScript, how `bash()` / skills / `mcp` / `rlm` are called in JS,
and what the snapshot carries. The tool is `bun_repl` in a Bun session (see
below); the `python_repl` spelling stays accepted as a dispatch alias so a
session recorded before the swap keeps routing its calls.

## The kernel tool's name

The tool is **`bun_repl`** when the Bun runtime is selected and `python_repl` on
the Python runtime (`pa_types::ai::kernel_tool_name()`; `BUN_TOOL_NAME` /
`PYTHON_TOOL_NAME` are the two spellings). Because `prime-agent` selects the Bun
runtime, the shipped product exposes `bun_repl`. Dispatch accepts the other
runtime's spelling and the short aliases (`python`, `ipython`, `bun`,
`javascript`, `js`), so a session resumed across a kernel switch still routes its
recorded tool calls. Under the Python default every upstream spelling is byte
identical, which keeps the TS-parity fixtures valid.

## Runtime-aware prose

Model- and user-visible wording that names the kernel comes from
`crates/pa-core/src/kernel/vocabulary.rs` (selected by the shared rule in
`crates/pa-types/src/kernel_runtime.rs`): the busy-kernel prompt, the reset
banner, the cell-timeout hint, the working notes, the post-compaction and
post-restore notices, the unavailable-skills notice, the compaction summary
note, the tool description and its snippet, the skills-inventory sentence, the
TUI cell-card language label, the TUI's injected-prompt headers
(`Restored <Bun|Python> kernel state`, `<JavaScript|Python> skills unavailable`),
the ACP tool-call title (`Bun cell` / `Python cell`), the harness digest's call
contract, the goal continuation prompt's REPL name, the generic-MCP guidance,
and the CLI `--help` about-line. The Python branch holds the upstream sentences
byte for byte.

## Skill documentation

`SKILL.md` and its `references/*.md` are model-facing: the model reads them on
demand. They were swept for the Bun kernel and are gated by
`crates/pa-core/tests/bun_skill_docs_conformance.rs`, which fails when any skill
doc carries a Python kernel call form (`\`\`\`python`, `Python REPL`,
`global_=True`, `print(await …)`, …). Three files document Python on purpose and
say so in the gate: the Python runtime's own skill contract, and the Prime
Intellect platform SDK references, each of which now carries the JavaScript path
beside the SDK example.

## Preserved identifiers (deliberately not renamed)

These stay byte-identical to upstream even in a Bun session, because something
outside this runtime parses or pins them. Only the prose around them follows the
runtime (see `crates/pa-core/src/kernel/vocabulary.rs`).

| Identifier | Consumed by |
| --- | --- |
| `python_repl` spelling (`pa_types::ai::PYTHON_TOOL_NAME`) | the Python runtime's own session JSONL and TS-parity fixtures; in a Bun session it is a dispatch alias only, and `bun_repl` is the name the model sees |
| `<python_import>` in the skills inventory | `pa-core/src/refinement/planner.rs` parses it |
| `<ipython_kernel_reset>` | restart-notice classification and `kernel_cell_timeout` assertions |
| `[python-state]`, `[python-state-restored]`, `[python-skills-unavailable]` | the TUI's injected-prompt classification (`custom_message`), daemon traces |
| `pythonCellTimeoutMs` (settings key) | upstream settings documents; `javascriptCellTimeoutMs` is accepted as an alias |

## Scenarios covered

`test/case-1..23` (protocol + scenario), plus four Rust integration gates
(`bun_kernel_e2e`, `bun_provisioner_e2e`, `bun_session_tool_surface`,
`bun_session_scenarios`) and `test/verify-all.sh`, which runs every gate
including the real release packager with `--with-package`.

## The conformance gate

```bash
cargo test -p pa-core --test bun_prompt_conformance        # prompt + vocabulary
cargo test -p pa-core --test bun_session_tool_surface      # a real session end to end
cargo test -p pa-core --lib -- tools::ipython::tests       # tool definition wiring
```

`bun_session_tool_surface` is the product-level gate: a real session engine with
a scripted provider asserts that the tool list the model is handed is
`bun_repl` (and not `python_repl`), then runs a `bun_repl` turn and asserts the
Bun cell's stdout reached the model's context. Selecting the Python runtime makes
it fail with the tool list it actually saw.

`bun_prompt_conformance` asserts, with the Bun runtime selected, that the tool is
`bun_repl`, that the prompt carries the `kernel-bun` layer and every required
JavaScript fact, and that the prompt's **dynamic tail** contains no Python claim
at all; then it flips to the Python default and asserts every upstream spelling
survives. The unit test pins the tool definition (name, label, description,
snippet, `code` schema) to the runtime vocabulary. Both are live gates: breaking
`BUN_TOOL_NAME` fails them.

## Keeping this ledger current

```bash
python3 scripts/fork/protocol_drift.py --ref upstream/main
```

A non-empty drift report is the exact port backlog for this runtime; record the
disposition in `docs/fork/upstream-sync.md`.
