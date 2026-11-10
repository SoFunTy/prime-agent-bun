/**
 * case-23: self-correcting failures.
 *
 * A `ReferenceError` after a compaction or restart is the failure a model can
 * usually fix in one step — but only if it knows what is *still* defined. The
 * kernel appends the surviving namespace to that error so the recovery does not
 * cost a turn of probing.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-23 undefined-name hint", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  await kernel.execute("s1", "const kept = 41;\nconst alsoKept = 'x';");

  const failed = await kernel.execute("u1", "keptMissing + 1");
  const error = kernel.received().find((frame) => frame.event === "error" && frame.id === "u1");
  await kernel.stop();

  assertEqual(failed.status, "error", "an undefined name fails the cell");
  assertEqual(error?.ename, "ReferenceError", "the error keeps its JavaScript name");
  const message = String(error?.evalue);
  assert(message.includes("keptMissing"), `the hint names the missing binding (got ${JSON.stringify(message)})`);
  assert(message.includes("Currently defined:"), "the hint lists the surviving namespace");
  assert(message.includes("kept") && message.includes("alsoKept"), "the real bindings are listed");
  assert(message.includes("re-create"), "the hint says how to recover");

  // The hint must not turn a real error into a success, and a non-ReferenceError
  // must not get the namespace dump.
  const other = KernelClient.start();
  await other.next((frame) => frame.event === "ready");
  const thrown = await other.execute("t1", "throw new TypeError('boom')");
  const thrownError = other.received().find((frame) => frame.event === "error" && frame.id === "t1");
  await other.stop();
  assertEqual(thrown.status, "error", "a thrown error still fails");
  assertEqual(thrownError?.evalue, "boom", "a non-ReferenceError keeps its message");
});
