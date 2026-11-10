/**
 * case-3: top-level await and async background state.
 *
 * Pins: `await` works at cell top level, the awaited value is the cell result,
 * and a background task created in one cell keeps running between cells.
 */
import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-3 top-level await", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const first = await kernel.execute(
    "a1",
    [
      "const later = (async () => { await new Promise((r) => setTimeout(r, 20)); globalThis.bg = 'done'; })();",
      "await new Promise((r) => setTimeout(r, 5));",
      "'awaited'",
    ].join("\n"),
  );
  const firstResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "a1");
  assertEqual(first.status, "ok", "a top-level await cell succeeds");
  assertEqual(firstResult?.text, "\"awaited\"", "the awaited expression is the result");

  // The background task from a1 is unaffected by the a1 cell boundary.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await kernel.execute("a2", "globalThis.bg");
  const second = kernel.received().find((frame) => frame.event === "result" && frame.id === "a2");
  await kernel.stop();
  assertEqual(second?.text, "\"done\"", "the background task kept running between cells");
});
