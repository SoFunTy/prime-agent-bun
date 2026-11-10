# JavaScript-backed skills

A JavaScript-backed skill is a markdown skill whose directory also holds a
JavaScript module the kernel loads at startup, so the agent can *call* the
capability instead of following instructions.

## Contract

```
skills/<name>/
  SKILL.md          # the instructions (see the standard)
  package.json      # declares the module
  index.ts          # the module (or index.js)
```

`package.json`:

```json
{
  "name": "<name>",
  "private": true,
  "primeAgent": { "javascript": { "global": "<globalName>", "entry": "index.ts" } }
}
```

`index.ts` exports a factory. The kernel calls it once at startup with the
kernel context and binds the returned value to `<globalName>`:

```ts
export default function createSkill(ctx: {
  hostRequest(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  emit(data: Record<string, unknown>): void;
  bash(command: string, persistent?: boolean): unknown;
  harness: unknown;
  rlm: Record<string, unknown>;
  cwd: string;
}) {
  const run = async (options: { path: string }) => {
    const receipt = await ctx.hostRequest("my.request", { path: options.path });
    return receipt;
  };
  const callable = (options: { path: string }) => run(options);
  callable.run = run;   // both `my_skill({...})` and `my_skill.run({...})` work
  return callable;
}
```

## Rules

- Take **one options object**; the model calls `await my_skill({ ... })`. Add a
  `.run` alias when the capability has a single verb, and named methods for a
  multi-verb surface (`compact.status()`, `compact.run({ instructions })`).
- Route anything the host owns — sessions, goals, compaction, budgets, MCP,
  credentials — through `ctx.hostRequest(type, payload)`. Never reach for
  `process.env` secrets or spawn long-lived processes.
- Shell work goes through `ctx.bash(...)`. Never `node:child_process`.
- Return plain data (objects, arrays, strings). The kernel renders the value
  with `Bun.inspect`, so return the summary, not a transcript.
- Throw a clear `Error` for bad input; the model sees the message and can fix
  its call. Do not return a failure as a successful string.
- A skill that fails to load is reported to the agent as unavailable and calling
  it raises with the import error — a broken module never breaks the kernel.
- Keep it dependency-free when possible: the standard library, `fetch`, and
  Bun's built-ins cover most cases. If a package is required, install it with
  `bun add` in the skill directory and commit the lockfile.
- Do not add a Python package to the same skill: the kernel runs JavaScript, and
  Python files there are dead weight.
