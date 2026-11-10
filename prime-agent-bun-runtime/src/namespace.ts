/**
 * The persistent user namespace.
 *
 * One process-wide namespace backs every cell: declarations persist across
 * cells through `globalThis`, and a registry records which names the runtime
 * owns for snapshot / restore / `list_names`. The registry is reconciled from
 * `globalThis`'s own properties after every cell, so undeclared assignments
 * (`counter = 1`) participate too.
 */

import { createRequire } from "node:module";

import { ALWAYS_SKIP, capResultText } from "./protocol.ts";
import { cellContext } from "./streams.ts";
import { PERSIST_HELPER, RESULT_SINK, splitTrailingExpression, transformCell } from "./transform.ts";

/** A structured cell failure, already clipped to the protocol caps by the caller. */
export interface CellError {
  ename: string;
  evalue: string;
  traceback: string[];
}

/** The outcome of one `execute` request. */
export interface CellOutcome {
  /** Formatted trailing expression, or `null` when the cell produced none. */
  result: string | null;
  error: CellError | null;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

const RESERVED: ReadonlySet<string> = new Set([...ALWAYS_SKIP, PERSIST_HELPER]);

/**
 * `require` for cell code.
 *
 * A cell body is an async function body, so neither a static `import` nor
 * Node-style `require` is in scope by default. The transform rewrites static
 * imports, and this binding covers the CommonJS spelling JavaScript users reach
 * for first (and any dependency that only ships CJS).
 */
const cellRequire = createRequire(`${process.cwd()}/`);

/**
 * TypeScript erasure for cells.
 *
 * The prompt tells the model cells accept JavaScript **and** TypeScript, so a
 * cell must survive `const x: Foo | null = null` and `interface`. Bun's own
 * transpiler strips the types and leaves `import` declarations alone (the
 * transform below rewrites those), which is exactly the pass this runtime needs.
 * When a source is not valid TypeScript, the raw text goes through and the cell
 * reports its own parse error.
 */
let cellTranspiler: Bun.Transpiler | null | undefined;

/** Create the transpiler on first need; it costs ~1 MiB of resident memory. */
function transpiler(): Bun.Transpiler | null {
  if (cellTranspiler === undefined) {
    try {
      cellTranspiler = new Bun.Transpiler({ loader: "ts" });
    } catch {
      cellTranspiler = null;
    }
  }
  return cellTranspiler;
}

/**
 * Tokens that only appear in TypeScript. Their absence means the source is plain
 * JavaScript, which costs nothing to skip: the transpiler is then never created
 * in a JavaScript-only session, and every such cell skips a parse pass.
 *
 * A false negative would leave a TypeScript cell unparsed (a hard failure), so
 * the list is deliberately over-inclusive — `:`, `as`, `<T>`, `!` and the
 * declaration keywords all force the transpiler.
 */
const TYPESCRIPT_SIGNALS =
  /(?:^|\n)\s*(?:interface|type|enum|declare|abstract|namespace|implements|readonly)\b|:\s|\sas\s|\breadonly\b|\bimplements\b|\bdeclare\b|<\s*[A-Za-z_$][\w$]*\s*(?:,|>)|!\s*[.;,)\]]/;

function toRunnableSource(source: string): string {
  const engine = TYPESCRIPT_SIGNALS.test(source) ? transpiler() : null;
  if (engine === null) {
    return source;
  }
  try {
    return engine.transformSync(source);
  } catch {
    return source;
  }
}

/** Own property names of `globalThis` as an array (no intermediate Set). */
function globalKeys(): string[] {
  return Object.getOwnPropertyNames(globalThis);
}

/**
 * Format the trailing expression, notebook style.
 *
 * This is `Bun.inspect`, not Python `repr`: the Bun kernel renders JS values
 * with JS spelling (`"text"`, `Map(1) {...}`). That is an intentional,
 * documented divergence; see `KERNEL-API.md` (result rendering).
 */
function formatValue(value: unknown): string {
  return Bun.inspect(value, { colors: false, depth: 4 });
}

/**
 * A `ReferenceError` is the one cell failure the model can usually fix in one
 * step, but only if it knows what *is* defined — after a compaction or a kernel
 * restart the answer is not in its context. Append the surviving names.
 */
export function undefinedNameHint(error: CellError, names: string[], limit = 24): string {
  if (error.ename !== "ReferenceError") {
    return "";
  }
  const match = /^([A-Za-z_$][\w$]*) is not defined/.exec(error.evalue);
  if (match === null) {
    return "";
  }
  const missing = match[1]!;
  if (names.length === 0) {
    return `\n\nHint: \`${missing}\` is not defined, and this kernel's namespace is empty. Kernel state does not survive a restart; define what you need in this cell.`;
  }
  const shown = names.slice(0, limit);
  const more = names.length > shown.length ? `, … (+${names.length - shown.length} more)` : "";
  return `\n\nHint: \`${missing}\` is not defined in this kernel. Currently defined: ${shown.join(", ")}${more}. Kernel state does not survive a restart; if the binding you need is missing, re-create it.`;
}

function describeError(error: unknown): CellError {
  if (error instanceof Error) {
    const lines = (error.stack ?? "").split("\n").slice(1);
    return {
      ename: error.name || "Error",
      evalue: error.message,
      traceback: lines.length > 0 ? lines : [String(error)],
    };
  }
  return { ename: "Error", evalue: String(error), traceback: [] };
}

/// The `globalThis` names present before the kernel's first cell. Grown as cells
/// add bindings, so the per-cell diff is a membership check per global.
let baselineGlobals: Set<string> | null = null;

export class Namespace {
  /** User-defined top-level names, in first-seen order. */
  readonly registry = new Set<string>();

  /** Whether the name is a runtime-owned, non-reserved user binding. */
  private isPersistable(name: string): boolean {
    return !name.startsWith("_") && !RESERVED.has(name);
  }

  /** The `__prime_agent_persist__` implementation the transform calls. */
  readonly persist = (entries: Record<string, unknown>): void => {
    for (const [name, value] of Object.entries(entries)) {
      (globalThis as Record<string, unknown>)[name] = value;
      if (this.isPersistable(name)) {
        this.registry.add(name);
      }
    }
  };

  /** Names eligible for snapshot / `list_names`, sorted. */
  listedNames(): string[] {
    return [...this.registry].filter((name) => this.isPersistable(name)).sort();
  }

  /** Snapshot-visible values keyed by name. */
  entries(): Array<[string, unknown]> {
    return this.listedNames().map((name) => [name, (globalThis as Record<string, unknown>)[name]]);
  }

  /** Delete one name from the namespace and the registry; returns whether it existed. */
  deleteName(name: string): boolean {
    const existed = this.registry.has(name) || Object.hasOwn(globalThis, name);
    delete (globalThis as Record<string, unknown>)[name];
    this.registry.delete(name);
    return existed;
  }

  /** Run one cell body in an async context tagged with `id`. */
  async run(id: string, source: string): Promise<CellOutcome> {
    // Reconcile new bindings without allocating a Set of every global per cell:
    // the first cell records the baseline, later cells only look for additions.
    const before = baselineGlobals ?? new Set(globalKeys());
    if (baselineGlobals === null) {
      baselineGlobals = before;
    }
    // The trailing expression becomes a call so Bun's TypeScript pass keeps it,
    // then the source is transpiled and finally rewritten for persistence and
    // module loading.
    const { head, expression } = splitTrailingExpression(source);
    const withSink = expression === null ? head : `${head}\n${RESULT_SINK}(${expression});\n`;
    const { code } = transformCell(toRunnableSource(withSink));
    const started = performance.now();
    let outcome: CellOutcome;
    let captured: unknown;
    let capturedSet = false;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
      ) => (persist: unknown, require: unknown, sink: (value: unknown) => void) => Promise<unknown>;
      const fn = new AsyncFunction(PERSIST_HELPER, "require", RESULT_SINK, code);
      const sink = (value: unknown): void => {
        if (value !== undefined) {
          captured = value;
          capturedSet = true;
        }
      };
      await cellContext.run(id, () => fn(this.persist, cellRequire, sink));
      if (capturedSet) {
        (globalThis as Record<string, unknown>)._ = captured;
      }
      outcome = {
        result: capturedSet ? capResultText(formatValue(captured)) : null,
        error: null,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const described = describeError(error);
      described.evalue += undefinedNameHint(described, this.listedNames());
      outcome = {
        result: null,
        error: described,
        durationMs: Math.round(performance.now() - started),
      };
    }
    for (const name of globalKeys()) {
      if (!before.has(name)) {
        before.add(name);
        if (this.isPersistable(name)) {
          this.registry.add(name);
        }
      }
    }
    return outcome;
  }
}
