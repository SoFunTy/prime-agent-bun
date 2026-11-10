/**
 * case-5: cell errors.
 *
 * Pins: a thrown error produces exactly one `error` frame with the JS error
 * name/message and a non-empty traceback, followed by `done` with
 * `status: "error"`, and the kernel keeps serving the next cell.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-5 error frames", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const failed = await kernel.execute("e1", "throw new TypeError('boom');");
  const error = kernel.received().find((frame) => frame.event === "error" && frame.id === "e1");

  assertEqual(failed.status, "error", "done reports error");
  assertEqual(error?.ename, "TypeError", "the error name is preserved");
  assertEqual(error?.evalue, "boom", "the error message is preserved");
  assert(Array.isArray(error?.traceback) && error.traceback.length > 0, "a traceback is present");

  const survived = await kernel.execute("e2", "1 + 1");
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "e2");
  await kernel.stop();

  assertEqual(survived.status, "ok", "the kernel keeps serving after a cell error");
  assertEqual(result?.text, "2", "the next cell runs normally");
});
