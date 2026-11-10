/**
 * case-22: control-flow cells and the trailing expression.
 *
 * A cell's last top-level expression becomes its result. A statement scanner
 * that ends a statement at a block's closing `}` mis-reads the *clause* that
 * follows it (`else`, `catch`, `finally`, `while` of a `do`), turns it into
 * `return (else { … })`, and the cell dies with a parse error. A real
 * long-conversation session hit exactly that on a `try { … } catch { … }` cell.
 *
 * Pins every control-flow shape, braced and braceless, alone and followed by a
 * trailing expression.
 */
import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-22 control flow", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const cells: Array<[string, string, string]> = [
    [
      "c1",
      "const a = 1;\nif (a === 1) {\n  console.log('then-branch');\n} else {\n  console.log('else-branch');\n}",
      "ok",
    ],
    [
      "c2",
      "try {\n  throw new Error('boom');\n} catch (error) {\n  console.log('caught', error.message);\n} finally {\n  console.log('finally-ran');\n}",
      "ok",
    ],
    [
      "c3",
      "let n = 0;\ndo {\n  n += 1;\n} while (n < 3);\nconsole.log('do-while', n);\n'n=' + n",
      "ok",
    ],
    [
      "c4",
      "for (const item of ['x', 'y']) {\n  console.log(item);\n}",
      "ok",
    ],
    [
      "c5",
      "const value = 2;\nswitch (value) {\n  case 1:\n    throw new Error('wrong branch');\n  case 2:\n    console.log('case-2');\n    break;\n  default:\n    throw new Error('wrong default');\n}",
      "ok",
    ],
    [
      "c6",
      "const flag = false;\nif (!flag) console.log('braceless-then');\nelse console.log('braceless-else');",
      "ok",
    ],
    [
      "c7",
      "let total = 0;\nfor (let i = 0; i < 3; i += 1) total += i;\ntry {\n  total += 1;\n} finally {\n  total += 1;\n}\ntotal",
      "ok",
    ],
    [
      "c8",
      "while (false) {\n  console.log('never');\n}\n'after-loop'",
      "ok",
    ],
    [
      // The clause must not swallow the trailing expression: `if` with no else.
      "c9",
      "if (true) {\n  console.log('only-then');\n}\n6 * 7",
      "ok",
    ],
  ];

  for (const [id, code, expected] of cells) {
    const done = await kernel.execute(id, code);
    assertEqual(done.status, expected, `cell ${id} must settle ${expected}`);
  }
  await kernel.stop();

  const frames = kernel.received();
  const stdoutFor = (id: string): string =>
    frames
      .filter((frame) => frame.event === "stdout" && frame.id === id)
      .map((frame) => frame.text)
      .join("");
  const resultFor = (id: string): string | undefined =>
    frames.find((frame) => frame.event === "result" && frame.id === id)?.text;

  assertEqual(stdoutFor("c1"), "then-branch\n", "if/else runs the taken branch");
  assertEqual(stdoutFor("c2"), "caught boom\nfinally-ran\n", "try/catch/finally all run");
  assertEqual(stdoutFor("c3"), "do-while 3\n", "do/while continues past its block");
  assertEqual(stdoutFor("c4"), "x\ny\n", "for/of runs");
  assertEqual(stdoutFor("c5"), "case-2\n", "switch selects its case");
  assertEqual(stdoutFor("c6"), "braceless-then\n", "a braceless if/else resolves");
  assertEqual(stdoutFor("c8"), "", "a while block that never runs logs nothing");
  assertEqual(resultFor("c8"), "\"after-loop\"", "a trailing expression still becomes the result after a while");
  assertEqual(stdoutFor("c9"), "only-then\n", "code after an if block runs");
  assertEqual(resultFor("c3"), "\"n=3\"", "a trailing expression still becomes the result after a do/while");
  assertEqual(resultFor("c7"), "5", "a trailing expression still becomes the result after try/finally");
  assertEqual(resultFor("c9"), "42", "a trailing expression still becomes the result after an if");
});
