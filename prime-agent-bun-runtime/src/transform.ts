/**
 * Persistent-namespace source transform.
 *
 * A cell runs inside an async function body so top-level `await` works, but
 * declarations inside a function do not outlive the call. This module rewrites
 * the cell source so that:
 *
 *   - every top-level `const` / `let` / `var` declaration is followed by a
 *     generated `__prime_agent_persist__({...bound names...})` call that copies
 *     the same-cell bindings onto `globalThis`;
 *   - `function` / `class` declarations are handled the same way;
 *   - the final top-level expression statement becomes `return (<expr>)` so the
 *     caller can render a notebook-style result.
 *
 * The scanner tracks string, template, comment, and regex-literal state, so the
 * transform never mis-reads syntax inside literals. Declarations without a
 * terminating `;` degrade to statement-level granularity (their bindings still
 * persist at the end of the span) rather than risking a syntax error.
 */

const DECL_KEYWORDS = new Set(["const", "let", "var"]);
/// Clause keywords that belong to the statement before them: `if {…} else {…}`,
/// `try {…} catch {…} finally {…}`, `do {…} while (…)`. Ending the span at the
/// block's `}` would make the clause look like a trailing expression.
const CONTINUATION_KEYWORDS = new Set(["else", "catch", "finally", "while"]);
const BLOCK_KEYWORDS = new Set([
  "function",
  "class",
  "if",
  "for",
  "while",
  "switch",
  "try",
  "do",
]);

/** One top-level statement span found by the scanner. */
export interface StatementSpan {
  start: number;
  end: number;
  kind: "decl" | "block" | "other" | "import";
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isRegexAllowedAfter(prev: string): boolean {
  if (prev === "") {
    return true;
  }
  if (
    /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/.test(prev)
  ) {
    return true;
  }
  return /[([{,;:=!&|?+\-*/%<>^~]$/.test(prev);
}

interface ScanState {
  src: string;
  i: number;
  prevToken: string;
}

function skipWhitespace(state: ScanState): void {
  while (state.i < state.src.length && /\s/.test(state.src[state.i]!)) {
    state.i += 1;
  }
}

/** Skips `//` and `/* *​/` comments; assumes the caller is at a `/` that starts one. */
function skipComment(state: ScanState): void {
  const { src } = state;
  if (src[state.i + 1] === "/") {
    state.i += 2;
    while (state.i < src.length && src[state.i] !== "\n") {
      state.i += 1;
    }
    return;
  }
  state.i += 2;
  while (state.i < src.length && !(src[state.i] === "*" && src[state.i + 1] === "/")) {
    state.i += 1;
  }
  state.i += 2;
}

function skipLineComment(state: ScanState): void {
  while (state.i < state.src.length && state.src[state.i] !== "\n") {
    state.i += 1;
  }
}

function skipString(state: ScanState, quote: string): void {
  state.i += 1;
  while (state.i < state.src.length) {
    const ch = state.src[state.i]!;
    if (ch === "\\") {
      state.i += 2;
      continue;
    }
    state.i += 1;
    if (ch === quote) {
      return;
    }
    if (quote !== "`" && ch === "\n") {
      return; // unterminated single-line string: stop at the newline
    }
  }
}

/** Skips a template literal, tracking nested `${ ... }` substitutions. */
function skipTemplate(state: ScanState): void {
  state.i += 1;
  let braceDepth = 0;
  while (state.i < state.src.length) {
    const ch = state.src[state.i]!;
    if (ch === "\\") {
      state.i += 2;
      continue;
    }
    if (ch === "`" && braceDepth === 0) {
      state.i += 1;
      return;
    }
    if (ch === "$" && state.src[state.i + 1] === "{") {
      braceDepth += 1;
      state.i += 2;
      continue;
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth -= 1;
      state.i += 1;
      continue;
    }
    state.i += 1;
  }
}

function skipRegex(state: ScanState): void {
  state.i += 1;
  let inClass = false;
  while (state.i < state.src.length) {
    const ch = state.src[state.i]!;
    if (ch === "\\") {
      state.i += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    } else if (ch === "/" && !inClass) {
      state.i += 1;
      while (state.i < state.src.length && /[a-z]/i.test(state.src[state.i]!)) {
        state.i += 1;
      }
      return;
    }
    state.i += 1;
  }
}

/**
 * Split `src` into top-level statement spans.
 *
 * A `;` at bracket depth zero always ends a statement. A `}` that returns depth
 * to zero ends a span only when the span began with a block keyword (or an
 * object-literal-ish `{`), because a `}` inside a declaration initializer
 * (`const a = {x: 1}.y`) must not end the declaration early.
 */
export function scanStatements(src: string): StatementSpan[] {
  const state: ScanState = { src, i: 0, prevToken: "" };
  const spans: StatementSpan[] = [];
  let stmtStart = -1;
  let depth = 0;
  let kind: StatementSpan["kind"] = "other";

  const classify = (from: number): StatementSpan["kind"] => {
    let j = from;
    while (j < src.length && /\s/.test(src[j]!)) {
      j += 1;
    }
    if (src[j] === "{") {
      return "block";
    }
    let k = j;
    while (k < src.length && isIdentPart(src[k]!)) {
      k += 1;
    }
    const word = src.slice(j, k);
    if (word === "import" && !src.slice(j, k + 1).endsWith("(") && src[j + 6] !== ".") {
      // A top-level `import` declaration: `import(...)` and `import.meta` are
      // expressions, not declarations.
      const next = src.slice(j + 6, j + 7);
      if (next !== "(" && next !== ".") {
        return "import";
      }
    }
    if (DECL_KEYWORDS.has(word)) {
      return "decl";
    }
    if (BLOCK_KEYWORDS.has(word)) {
      return "block";
    }
    if (word === "async") {
      let m = k;
      while (m < src.length && /\s/.test(src[m]!)) {
        m += 1;
      }
      let e = m;
      while (e < src.length && isIdentPart(src[e]!)) {
        e += 1;
      }
      if (src.slice(m, e) === "function") {
        return "block";
      }
    }
    return "other";
  };

  const beginStatement = (): void => {
    if (stmtStart < 0) {
      stmtStart = state.i;
      kind = classify(state.i);
    }
  };

  /** The next significant word at or after `from`, skipping whitespace/comments. */
  const peekWord = (from: number): string => {
    let i = from;
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) {
        i += 1;
      }
      if (src[i] === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") {
          i += 1;
        }
        continue;
      }
      if (src[i] === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
          i += 1;
        }
        i += 2;
        continue;
      }
      break;
    }
    let end = i;
    while (end < src.length && isIdentPart(src[end]!)) {
      end += 1;
    }
    return src.slice(i, end);
  };

  const endStatement = (endExclusive: number): void => {
    if (stmtStart >= 0) {
      spans.push({ start: stmtStart, end: endExclusive, kind });
      stmtStart = -1;
      kind = "other";
    }
  };

  while (state.i < src.length) {
    const ch = src[state.i]!;
    if (/\s/.test(ch)) {
      state.i += 1;
      continue;
    }
    if (ch === "/") {
      const next = src[state.i + 1];
      if (next === "/") {
        skipComment(state);
        continue;
      }
      if (next === "*") {
        if (stmtStart < 0) {
          state.i += 2;
          while (state.i < src.length && !(src[state.i] === "*" && src[state.i + 1] === "/")) {
            state.i += 1;
          }
          state.i += 2;
          continue;
        }
        skipComment(state);
        continue;
      }
      if (isRegexAllowedAfter(state.prevToken)) {
        beginStatement();
        skipRegex(state);
        state.prevToken = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      beginStatement();
      skipString(state, ch);
      state.prevToken = '"';
      continue;
    }
    if (ch === "`") {
      beginStatement();
      skipTemplate(state);
      state.prevToken = "`";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      beginStatement();
      depth += 1;
      state.i += 1;
      state.prevToken = ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) {
        depth = 0;
      }
      state.i += 1;
      state.prevToken = ch;
      if (depth === 0 && ch === "}" && kind === "block") {
        // `else` / `catch` / `finally` / `while` continue the same statement.
        if (!CONTINUATION_KEYWORDS.has(peekWord(state.i))) {
          endStatement(state.i);
        }
      }
      continue;
    }
    if (ch === ";" && depth === 0) {
      state.i += 1;
      // A braceless `if (a) b(); else c();` also continues past the `;`.
      if (kind !== "block" || !CONTINUATION_KEYWORDS.has(peekWord(state.i))) {
        endStatement(state.i);
      }
      state.prevToken = ";";
      continue;
    }
    if (isIdentStart(ch)) {
      beginStatement();
      let j = state.i + 1;
      while (j < src.length && isIdentPart(src[j]!)) {
        j += 1;
      }
      state.prevToken = src.slice(state.i, j);
      state.i = j;
      continue;
    }
    beginStatement();
    state.prevToken = ch;
    state.i += 1;
  }
  endStatement(src.length);
  return spans;
}

/** Splits `text` on top-level `separator` characters (depth- and literal-aware). */
export function splitTopLevel(text: string, separator: string): string[] {
  const state: ScanState = { src: text, i: 0, prevToken: "" };
  const parts: string[] = [];
  let last = 0;
  let depth = 0;
  while (state.i < text.length) {
    const ch = text[state.i]!;
    if (ch === "/" && text[state.i + 1] === "/") {
      skipLineComment(state);
      continue;
    }
    if (ch === "/" && text[state.i + 1] === "*") {
      skipComment(state);
      continue;
    }
    if (ch === '"' || ch === "'") {
      skipString(state, ch);
      continue;
    }
    if (ch === "`") {
      skipTemplate(state);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === separator && depth === 0) {
      parts.push(text.slice(last, state.i));
      last = state.i + 1;
    }
    state.i += 1;
  }
  if (last <= text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

/** Returns the bound identifiers of one declaration target (identifier or pattern). */
export function extractPatternNames(target: string): string[] {
  const names: string[] = [];
  const state: ScanState = { src: target, i: 0, prevToken: "" };
  const src = target;

  const readIdentifier = (): string => {
    const start = state.i;
    while (state.i < src.length && isIdentPart(src[state.i]!)) {
      state.i += 1;
    }
    return src.slice(start, state.i);
  };

  const skipLiteral = (): boolean => {
    const ch = src[state.i]!;
    if (ch === '"' || ch === "'") {
      skipString(state, ch);
      return true;
    }
    if (ch === "`") {
      skipTemplate(state);
      return true;
    }
    return false;
  };

  const skipUntilTopLevel = (stopChars: string): void => {
    let depth = 0;
    while (state.i < src.length) {
      const ch = src[state.i]!;
      if (skipLiteral()) {
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) {
          return;
        }
        depth -= 1;
      } else if (depth === 0 && stopChars.includes(ch)) {
        return;
      }
      state.i += 1;
    }
  };

  const walk = (inObjectPattern: boolean): void => {
    let expectObjectKey = inObjectPattern;
    while (state.i < src.length) {
      const ch = src[state.i]!;
      if (/\s/.test(ch)) {
        state.i += 1;
        continue;
      }
      if (skipLiteral()) {
        continue;
      }
      if (ch === ",") {
        state.i += 1;
        expectObjectKey = inObjectPattern;
        continue;
      }
      if (ch === "[") {
        if (inObjectPattern && expectObjectKey) {
          // A computed key (`{ [expr]: binding }`): skip the expression, then
          // the `:`, so only the binding is collected.
          state.i += 1;
          let depth = 1;
          while (state.i < src.length && depth > 0) {
            if (skipLiteral()) {
              continue;
            }
            const inner = src[state.i]!;
            if (inner === "[") {
              depth += 1;
            } else if (inner === "]") {
              depth -= 1;
            }
            state.i += 1;
          }
          while (state.i < src.length && /\s/.test(src[state.i]!)) {
            state.i += 1;
          }
          if (src[state.i] === ":") {
            state.i += 1;
          }
          expectObjectKey = false;
          continue;
        }
        state.i += 1;
        walk(false);
        continue;
      }
      if (ch === "{") {
        state.i += 1;
        walk(true);
        continue;
      }
      if (ch === "}" || ch === "]") {
        state.i += 1;
        return;
      }
      if (ch === ".") {
        state.i += 1;
        // rest element `...rest`
        continue;
      }
      if (ch === "=") {
        state.i += 1;
        skipUntilTopLevel(",]}");
        continue;
      }
      if (ch === ":") {
        state.i += 1;
        expectObjectKey = false;
        continue;
      }
      if (ch === "(") {
        state.i += 1;
        skipUntilTopLevel(")");
        if (src[state.i] === ")") {
          state.i += 1;
        }
        continue;
      }
      if (isIdentStart(ch)) {
        const name = readIdentifier();
        let j = state.i;
        while (j < src.length && /\s/.test(src[j]!)) {
          j += 1;
        }
        if (expectObjectKey && src[j] === ":") {
          // property key: the binding follows the colon
          state.i = j + 1;
          expectObjectKey = false;
          continue;
        }
        names.push(name);
        expectObjectKey = false;
        continue;
      }
      state.i += 1;
    }
  };

  walk(false);
  return names;
}

/** One top-level declaration the transform persists. */
export interface PersistedDeclaration {
  names: string[];
  /** Byte offset in the transformed source where the persist call was inserted. */
  at: number;
}

export interface TransformResult {
  code: string;
  declarations: PersistedDeclaration[];
}

function declarationNames(statement: string): string[] {
  const match = /^\s*(?:const|let|var)\b/.exec(statement);
  if (match === null) {
    return [];
  }
  let rest = statement.slice(match[0].length).trim();
  if (rest.endsWith(";")) {
    rest = rest.slice(0, -1);
  }
  const names: string[] = [];
  for (const declarator of splitTopLevel(rest, ",")) {
    const [lhs] = splitTopLevel(declarator, "=");
    if (lhs === undefined) {
      continue;
    }
    for (const name of extractPatternNames(lhs.trim())) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

function functionOrClassName(statement: string): string[] {
  const match = /^\s*(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
    statement,
  );
  return match?.[1] !== undefined ? [match[1]] : [];
}

function isExpressionStatement(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("{")) {
    return false;
  }
  if (
    /^(const|let|var|function|class|async|if|for|while|do|switch|try|throw|return|import|export|else|catch|finally|case|default|;)/.test(
      trimmed,
    )
  ) {
    return false;
  }
  return true;
}

/** The generated helper name; the executor passes the implementation as a parameter. */
export const PERSIST_HELPER = "__prime_agent_persist__";

/** The generated result sink; a call keeps the trailing expression alive. */
export const RESULT_SINK = "__prime_agent_result__";

/**
 * Split a cell into its statements and its trailing expression.
 *
 * Bun's TypeScript transpiler drops an effect-free trailing expression (`answer`
 * becomes nothing), so the trailing expression has to become a *call* before the
 * source is transpiled. The executor does that with [`RESULT_SINK`].
 */
export function splitTrailingExpression(source: string): { head: string; expression: string | null } {
  const spans = scanStatements(source);
  const last = spans.at(-1);
  if (last === undefined || !isExpressionStatement(source.slice(last.start, last.end))) {
    return { head: source, expression: null };
  }
  return {
    head: source.slice(0, last.start),
    expression: source.slice(last.start, last.end).trim().replace(/;$/, ""),
  };
}

/**
 * Rewrite one top-level `import` declaration into a dynamic import.
 *
 * A cell body is an async function body, where a static import declaration is a
 * syntax error, and `require` is not in scope. Rewriting keeps the natural
 * JavaScript spelling usable: `import { a } from "m"` becomes
 * `const { a } = await import("m")`.
 *
 * Returns `null` when the statement is not a form this understands; the caller
 * then leaves it alone.
 */
export function rewriteImportDeclaration(statement: string): string | null {
  const text = statement.trim().replace(/;\s*$/, "");
  const match =
    /^import\s*(?:type\s+)?(?:(?<default>[A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:(?<namespace>\*\s+as\s+[A-Za-z_$][\w$]*)|(?<named>\{[^}]*\}))?\s*(?:from\s+)?(?<source>'[^']*'|"[^"]*")$/.exec(
      text,
    );
  if (match === null) {
    return null;
  }
  const groups = match.groups ?? {};
  const source = groups.source ?? "";
  const typeOnly = groups.type !== undefined || /^import\s+type\b/.test(text);
  if (typeOnly) {
    return "";
  }
  const parts: string[] = [];
  if (groups.default !== undefined) {
    parts.push(`const ${groups.default} = (await import(${source})).default;`);
  }
  if (groups.namespace !== undefined) {
    const name = groups.namespace.replace(/^\*\s+as\s+/, "");
    parts.push(`const ${name} = await import(${source});`);
  }
  if (groups.named !== undefined) {
    const bindings = groups.named
      .slice(1, -1)
      .split(",")
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== "")
      .filter((specifier) => !/^type\s/.test(specifier))
      .map((specifier) => {
        const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
        return alias === null ? specifier : `${alias[1]}: ${alias[2]}`;
      });
    if (bindings.length > 0) {
      parts.push(`const { ${bindings.join(", ")} } = await import(${source});`);
    }
  }
  if (parts.length === 0) {
    parts.push(`await import(${source});`);
  }
  return `\n${parts.join("\n")}\n`;
}

/**
 * Rewrite a cell for execution inside an async function body.
 *
 * Returns the transformed source. Insertions are spliced in ascending offset
 * order so earlier insertions never shift later offsets.
 */
export function transformCell(source: string): TransformResult {
  const spans = scanStatements(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const declarations: PersistedDeclaration[] = [];

  for (const span of spans) {
    if (span.kind === "import") {
      const rewritten = rewriteImportDeclaration(source.slice(span.start, span.end));
      if (rewritten !== null) {
        edits.push({ start: span.start, end: span.end, text: rewritten });
      }
      continue;
    }
    if (span.kind === "block") {
      // A top-level `function` / `class` declaration is a block statement whose
      // name must survive the cell; other blocks (if/for/try) declare nothing.
      const statement = source.slice(span.start, span.end);
      const names = [...new Set(functionOrClassName(statement))];
      if (names.length === 0) {
        continue;
      }
      edits.push({ start: span.end, end: span.end, text: `\n;${PERSIST_HELPER}({ ${names.join(", ")} });\n` });
      declarations.push({ names, at: span.end });
      continue;
    }
    if (span.kind !== "decl") {
      continue;
    }
    const statement = source.slice(span.start, span.end);
    const names = declarationNames(statement).concat(functionOrClassName(statement));
    const unique = [...new Set(names)];
    if (unique.length === 0) {
      continue;
    }
    const call = `\n;${PERSIST_HELPER}({ ${unique.join(", ")} });\n`;
    edits.push({ start: span.end, end: span.end, text: call });
    declarations.push({ names: unique, at: span.end });
  }

  const last = spans.at(-1);
  if (last !== undefined && isExpressionStatement(source.slice(last.start, last.end))) {
    const expr = source.slice(last.start, last.end).trim().replace(/;$/, "");
    edits.push({ start: last.start, end: last.end, text: `\nreturn (\n${expr}\n);\n` });
  }

  // Splice from the highest offset down so earlier edits never shift later ones.
  edits.sort((a, b) => b.start - a.start);
  let code = source;
  for (const edit of edits) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  return { code, declarations };
}
