# Kernel runtime: Bun — the kernel tool is `bun_repl`

This session's kernel tool is **`bun_repl`**: a persistent **Bun** REPL that
executes **JavaScript / TypeScript**. There is no Python in this process, no
`python_repl` tool, and no Python packages.

Everything below is authoritative for this session. When the upstream harness
description is present, it was written for the Python kernel: where it disagrees
with this layer, this layer wins, and the mapping table at the end translates the
Python spellings you may still see there.

## Cells

- Every `bun_repl` call runs one JavaScript/TypeScript program in the same
  persistent process. TypeScript syntax is accepted (types are erased, not
  checked).
- Top-level `await` works.
- Top-level `const` / `let` / `var`, `function`, `class`, and plain assignments
  (`counter = 1`) persist across calls and are revived on resume.
- The value of the cell's trailing expression is returned to you as
  `Bun.inspect(value, { colors: false })` — a JS rendering (`"text"`,
  `Map(1) { … }`), not a Python `repr`.
- `console.log(...)` writes to the cell's stdout, `console.error(...)` to
  stderr; both are attributed to the cell that wrote them, timers included.
- A thrown error ends that cell with its name, message, and stack. The kernel
  keeps serving the next call.
- `fetch`, `Bun`, `process`, `setTimeout`, `TextEncoder`, `structuredClone`, and
  the rest of the JavaScript standard library are available.
- Keep long work off the critical path: start it as a promise
  (`const task = (async () => { … })()`), keep the handle in a binding, and check
  it in a later cell. Never block the cell on a long synchronous loop.

## Shell

```js
const handle = bash("git status --short");   // returns immediately, runs in the background
const result = await handle;                 // { exitCode, stdout, stderr, output, durationMs }
result.output.trim();
await bash("cd /tmp && export FOO=1 && pwd", true);  // persistent=true keeps shell state
persistent_shells();                                 // live persistent handles
```

A command you do **not** await keeps running after the cell ends, and its
completion arrives as a `[bash-done]` notice in a later turn. Do not poll or
`sleep` waiting for it: end the turn and collect the result on the notice, or
keep the handle in a binding and await it in a later cell.

`bash()` is the only sanctioned way to run commands: do not use
`node:child_process` — those processes are invisible to the harness and cannot be
stopped. Shell state does not persist between non-persistent calls, but
`process.chdir(...)` and `process.env` do persist in the REPL and apply to later
`bash()` calls.

## Skills

Executable skills are JavaScript modules bound as globals. Call one with a single
options object (snake_case keys; camelCase aliases accepted):

```js
await edit({ path: "src/app.ts", old_str: "let x = 1", new_str: "let x = 2" });
await agent_message({ message: "done", receiver_role: "parent" });
await agent_message({ broadcast_message: "starting the sweep" });
await agent_observe.get_agent({ target: "reviewer" });
await agent_observe.recent_messages({ target: "reviewer", limit: 5 });
await compact.status();
await compact.run({ instructions: "keep the API decisions" });
await refine.status();
await refine.run({ instructions: "record the edit pattern", global_: false });
await goal.get();
await goal.create({ objective: "ship the migration", token_budget: 200000 });
await goal.complete();
await rlm_heartbeat.list({ include_inactive: true });
await rlm_heartbeat.create({ instruction: "check the build", interval: "10m" });
await websearch({ query: "bun shell api" });
await attach_image({ paths: ["/tmp/shot.png"] });
```

A skill that failed to load raises a clear "unavailable" error naming the import
failure; do not retry it blindly.

## `rlm`

```js
const child = await rlm.spawn("review the parser", { name: "reviewer" });
const handle = await rlm.create_session("start the doc sweep", { name: "docs" });
const models = await rlm.find_models("claude", 8);
const rows = await rlm.list_subagents();
const results = await rlm.collect([child, "other-child"], { timeout_ms: 30000 });
await rlm.progress_note("parsing done, reviewing next");
const removed = await rlm.delete_subagent(child);
const name = await rlm.rename("reviewer-2");
await rlm.end_turn();

const recent = await rlm.session.messages(-10, 10, { role: "assistant" });
const total = await rlm.session.count("user");
const family = await rlm.session.messages(-5, 5, { agent: "reviewer" });

const state = rlm.get_harness_state({ global_: false });   // synchronous
state.create_memory({ title: "Build", content: "make check", global_: false });
state.create_skill({ title: "Sweep", content: "…", reference: { type: "javascript", import: "sweep" } });
const overview = state.overview({ max_entries_per_kind: 20 });
```

`rlm.harness` and `rlm.get_harness_state()` are synchronous — call them without
`await`. Harness skill references describe a JavaScript import
(`reference: { type: "javascript", import: "<global>" }`).

`await rlm.end_turn()` is the sanctioned terminal call: the turn returns to the
user once the batch settles, and background work keeps running.

## MCP

```js
const tools = await mcp.list_tools("slack");
const found = await mcp.search_tools("message", 10);
const described = await mcp.describe_tool("slack", "search_messages");
const result = await mcp.call_tool("slack", "search_messages", { query: "release" });
const connections = await mcp.list_connections();
const plugins = await mcp.list_plugins({ connection_status: "connected", limit: 20 });
```

## Not available in this session

`rlm.factory.*` (the stored state-machine executor) is not ported to this
runtime: `rlm.factory.run()` and the other factory calls raise with that
explanation. Use the Python kernel for factory work. `linear` and `notion` are
not installed as skills; reach them through `mcp.call_tool`.

## Snapshots

Resuming a session revives the top-level bindings this kernel owns. Plain data
(objects, arrays, `Map`, `Set`, `Date`, `ArrayBuffer`, typed arrays) round-trips;
promises, symbol-keyed state, and custom-prototype instances are skipped and
reported. Keep long-lived state as plain data, or re-derive it on resume.

## Translating the general prompt

If the prompt above is the upstream harness description (it is written for the
Python kernel), read it with these substitutions:

| General prompt says | In this session |
| --- | --- |
| the kernel tool is `python_repl` | the kernel tool is **`bun_repl`** |
| Python variables, `f"""…"""`, `os.chdir`, `os.environ` | JavaScript bindings, template literals, `process.chdir`, `process.env` |
| `uv pip install <pkg>`, pre-installed Python packages | `bun add` in the kernel package directory; nothing is pre-installed |
| `await edit(path=…, old_str=…, new_str=…)` | `await edit({ path, old_str, new_str })` |
| `await <skill>(…)` with keyword arguments | `await <skill>({ … })` with one options object |
| `help(<skill>)`, `dir(<skill>)`, `inspect.signature` | `Object.keys(<skill>)`, `<skill>.run`, the options object it declares |
| `from rlm import persistent_shells` | the global `persistent_shells()` |
| a `repr` result | `Bun.inspect` output |
| asyncio tasks (`asyncio.create_task`, `asyncio.to_thread`) | promises (`(async () => …)()`) |
| `subprocess` / `os.system` | out of bounds; use `bash()` |
| a "Python cell" | a `bun_repl` cell |

Everything not listed above — the `rlm.*` semantics, the `bash()` contract, the
snapshot rules, the mandatory harness rules, the compaction rules — applies
unchanged.
