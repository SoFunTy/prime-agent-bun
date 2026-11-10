/**
 * case-2: namespace persistence across cells.
 *
 * Pins: `const`/`let`/`var`, function, and class declarations, destructuring,
 * and undeclared assignment all survive into a later cell through `globalThis`.
 */
import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-2 namespace persistence", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  await kernel.execute(
    "d1",
    [
      "const a = 1;",
      "let b = 2;",
      "var c = 3;",
      "function f() { return 4; }",
      "class K { value() { return 5; } }",
      "const { x, y: renamed } = { x: 6, y: 7 };",
      "const [p, q] = [8, 9];",
      "undeclared = 10;",
    ].join("\n"),
  );
  const done = await kernel.execute("d2", "[a, b, c, f(), new K().value(), x, renamed, p, q, undeclared].join(',')");
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "d2");
  await kernel.stop();

  assertEqual(done.status, "ok", "the reading cell succeeds");
  assertEqual(result?.text, "\"1,2,3,4,5,6,7,8,9,10\"", "every declaration kind persists");
});
