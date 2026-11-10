/**
 * case-13: the source transform, unit-level.
 *
 * Pins the scanner's literal-awareness and the declaration extraction: a
 * `const` inside a string/template/comment must not be mistaken for a
 * top-level declaration, destructuring defaults and property keys must not
 * leak names, and the trailing expression becomes the return.
 */
import { transformCell } from "../../prime-agent-bun-runtime/src/transform.ts";
import { assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-13 transform", async () => {
  // Literals never create declarations.
  const literal = transformCell(
    ["const a = 'const b = 99';", "const c = `const d = ${1}`;", "// const e = 1", "a + c"].join("\n"),
  );
  assert(literal.code.includes("__prime_agent_persist__({ a })"), "a real declaration persists");
  assert(!literal.code.includes("__prime_agent_persist__({ b })"), "a string body is not a declaration");
  assert(!literal.code.includes("__prime_agent_persist__({ d })"), "a template body is not a declaration");
  assert(!literal.code.includes("__prime_agent_persist__({ e })"), "a comment is not a declaration");
  assert(literal.code.includes("return ("), "the trailing expression becomes the return");

  // Destructuring: keys and defaults do not leak, bindings do.
  const destructured = transformCell("const { a: renamed, b = 1, c: { d }, [e]: computed, ...rest } = obj;");
  const names = /__prime_agent_persist__\(\{ ([^}]*) \}\)/.exec(destructured.code)?.[1] ?? "";
  for (const expected of ["renamed", "b", "d", "rest"]) {
    assert(names.includes(expected), `${expected} is extracted from the pattern (got ${names})`);
  }
  for (const forbidden of ["a", "c", "e"]) {
    assert(!new RegExp(`(^|, )${forbidden}(,|$)`).test(names), `${forbidden} is not a binding (got ${names})`);
  }

  // No trailing expression: no synthetic return.
  const statementsOnly = transformCell("if (true) { foo(); }");
  assert(!statementsOnly.code.includes("return ("), "a block statement is not returned");
  assertEqual(statementsOnly.declarations.length, 0, "a block statement declares nothing");
});
