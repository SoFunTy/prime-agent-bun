# test/ — Bun kernel verification cases

Each `case-N/` directory holds one runnable verification of the Bun kernel
runtime (`../prime-agent-bun-runtime`). Cases drive the **real** protocol server
over fd 0 / fd 1 through `lib/kernel-client.ts`; they do not import runtime
internals except in the pure-function case (case-13).

```bash
../test/verify-all.sh            # the FULL set: cases + every Rust gate + release + drift + ownership
./test/run-all.sh                # every case
./test/run-all.sh case-6         # one case
cd test && bun run case-1/run.ts
```

Requires Bun >= 1.3.14 on `PATH`.

| Case | Pins |
| --- | --- |
| case-1 | `ready` handshake (protocol 3); `execute` → `stdout`/`result`/`done ok`, exactly one `done`, result before done |
| case-2 | namespace persistence across cells: `const`/`let`/`var`, function, class, destructuring, undeclared assignment |
| case-3 | top-level `await`; background task survives the cell boundary |
| case-4 | `console.*` / `process.*.write` become tagged `stdout`/`stderr` events; raw stderr stays clean |
| case-5 | thrown error → one `error` frame (name/message/traceback) + `done error`; kernel keeps serving |
| case-6 | snapshot/restore round trip; `_`-prefixed names skipped; payload + manifest written |
| case-7 | `list_names` sorted, same filter as the snapshot |
| case-8 | `interrupt` ends the running cell with `KeyboardInterrupt`; parked interrupt delivery; kernel keeps serving |
| case-9 | `bash()` display + awaitable result; out-of-band `bash_activity list` during a running cell |
| case-10 | host bridge: `rlm.spawn` → `rlm.run` request → `host_reply`; `rlm.end_turn` request type |
| case-11 | `shutdown` replies + exits 0; stdin EOF drains read requests then exits 0 |
| case-12 | 64 Ki stream frames; 1 MiB result cap + truncation marker; snapshot per-variable cap + `prune_oversized` |
| case-13 | transform unit: literal-awareness, destructuring/computed-key name extraction, trailing-expression return |
| case-14 | `mcp_status` with no host (bounded per-server error rows), missing-snapshot restore, `bash_activity` tail/kill unknown id |
| case-15 | Executable skill loading: manifest entry imported and bound, Python-only skill skipped, broken import reported via the shared marker and callable as a raising stand-in |
| case-16 | Generic MCP client against a real stdio server: `mcp.config` host round trip, `tools/list`, `tools/call`, and a real `mcp_status` row |
| case-17 | The `rlm` host-bridge matrix: wire type + payload shape for spawn / create_session / find_models / list_subagents / collect / progress_note / delete_subagent / rename / session.messages / session.count / end_turn, plus the transcript-read display |
| case-18 | Local surfaces: harness CRUD persisted with the Python-compatible schema, the factory refusal (never a hang), and an MCP server that cannot start failing the cell |
| case-19 | The bash lanes: `persistent=true` shell state, concurrent persistent commands both settling in order (the shell's line queue), the `[bash-done]` `bash.completed` notice for a detached command, `bash.consumed` after a read, and the handle's `tail`/`poll`/`running`/`kill` |
| case-22 | Control flow in cells: if/else, try/catch/finally, do/while, for/of, switch, braceless if/else, and a trailing expression after each shape |
| case-21 | Module loading inside a cell: `require`, every static `import` form (default, namespace, named, aliased, side-effect, type-only), a relative file import, and dynamic `import()`, plus TypeScript erasure |
| case-20 | Skill behavior: `edit` refuses an ambiguous match and applies a unique one (with the diff display), `attach_image` emits an attachment for a real PNG and rejects a missing file, `websearch` teaches the setup path when no key is configured |

The Rust seam has two more gates:

```bash
cargo test -p pa-core --lib kernel::bun_runtime           # selection + resolution + version gate
cargo test -p pa-core --test bun_prompt_conformance       # the prompt/tool surface never claims Python
cargo test -p pa-core --test bun_session_tool_surface     # a real session presents bun_repl and Bun runs the cell
cargo test -p pa-core --test bun_skill_docs_conformance    # no skill doc teaches the Python kernel
cargo test -p pa-core --test bun_kernel_e2e              # real ReplKernelManager -> Bun process
cargo test -p pa-core --test bun_provisioner_e2e         # real session provisioner -> Bun kernel
```

`bun_provisioner_e2e` is the product-chain gate: it drives
`IpythonKernelProvisioner` (the daemon's seam) with no interpreter named, so the
runtime selection decides, then asserts the Bun identity, the bootstrap's
JavaScript skill, and a real file edit.

`bun_kernel_e2e` skips when Bun is absent; a lane that has Bun sets
`PRIME_AGENT_BUN_E2E=required` to make the skip a failure.
