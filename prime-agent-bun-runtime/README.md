# prime-agent-bun-runtime

The Bun-side RLM kernel runtime for the Prime Agent Rust build: a drop-in
replacement for `prime-agent-runtime` (Python / IPython) that speaks the same
**REPL runtime protocol v3** over fd 0 / fd 1.

Nothing in the Rust kernel layer changes when this runtime is selected. The
protocol server, wire types, frame caps, snapshot lifecycle, host-request
handlers, and every consumer of `ExecuteResult` are shared; only the launched
process and the language the model writes in differ.

## Run it

```bash
bun run src/repl.ts          # serves the protocol on stdin/stdout
bash ../test/run-all.sh      # the protocol + scenario cases (../test/case-*)
```

## Selection

`prime-agent` **always runs this kernel**: the composition root forces Bun, so the
shipped product has no Python fallback. An install without Bun fails the kernel
start with an actionable error instead of silently switching runtimes.

| Environment | Product (`prime-agent`) | Library / tests |
| --- | --- | --- |
| (unset) | **Bun kernel** | Python kernel (upstream default) |
| no Bun installed | kernel start fails with install guidance | Python kernel |
| `PRIME_AGENT_KERNEL_RUNTIME=bun` | **Bun kernel** | Bun kernel |
| `PRIME_AGENT_KERNEL_RUNTIME=python` | ignored (the product forces Bun) | Python kernel |
| `PRIME_AGENT_KERNEL_PYTHON=/path/to/python` | ignored (the product forces Bun) | Python kernel (a pinned interpreter) |

`pa-core`'s *library* default stays upstream's Python runtime, so upstream's
tests and library callers are unaffected; only the binary forces the product
runtime. The Rust side resolves the runtime beside the binary (`PI_PACKAGE_DIR`),
at the checkout root, or from `PRIME_AGENT_BUN_RUNTIME_DIR`; it validates
Bun >= 1.3.14 and otherwise fails the kernel start with an actionable error.
Selection logic and tests live in `crates/pa-core/src/kernel/bun_runtime.rs`.

## Layout

| File | Responsibility |
| --- | --- |
| `src/protocol.ts` | Wire types, frame caps, request/event vocabulary |
| `src/streams.ts` | fd 1 frame writer, user-output capture, `display`/`host_request` emitters |
| `src/transform.ts` | Persistent-namespace source transform (literals-aware scanner) |
| `src/namespace.ts` | Cell execution, binding registry, result/error formatting |
| `src/snapshot.ts` | Snapshot/restore payload + manifest |
| `src/bash.ts` | `bash()` handles, persistent shells, the activity registry |
| `src/harness.ts` | Durable prompt/memory/skill/subagent/factory store |
| `src/rlm.ts` | `rlm` API + the host bridge |
| `src/skills.ts` | Executable-skill loading (JavaScript packages) |
| `src/mcp.ts` | Dependency-free MCP client (stdio + HTTP) |
| `src/repl.ts` | The protocol server (request routing, interrupt, shutdown) |

## What the model sees

The kernel installs these globals in every session:

- `rlm` — `spawn`, `create_session`, `find_models`, `list_subagents`, `collect`,
  `progress_note`, `delete_subagent`, `rename`, `end_turn`, `session.messages`,
  `session.count`, `harness`, `get_harness_state`, `host_request`
- `bash(command, persistent?)`, `persistent_shells()`
- `emit(data)`, `host_request(type, payload)`, `harness`
- `mcp.list_tools` / `mcp.call_tool` / `mcp.status` / `mcp.list_connections`
- one global per executable skill (`edit`, `agent_message`, `compact`,
  `goal`, `refine`, `rlm_heartbeat`, `websearch`, `attach_image`, …)

Every `rlm` method is a typed wrapper over one `host_request` frame, exactly like
the Python runtime: the host owns admission, budgets, rosters, and session state.

See [`KERNEL-API.md`](KERNEL-API.md) for the per-surface parity ledger and the
declared divergences.
