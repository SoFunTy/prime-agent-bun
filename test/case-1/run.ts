/**
 * case-1: protocol handshake and the basic execute lane.
 *
 * Pins: the `ready` frame announces protocol 3; an `execute` produces, in
 * order, `stdout`, `result`, and exactly one `done` with `status: "ok"`.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-1 handshake+execute", async () => {
  const kernel = KernelClient.start();
  const ready = await kernel.next((frame) => frame.event === "ready");
  assertEqual(ready.protocol, 3, "ready announces protocol 3");

  const done = await kernel.execute("c1", 'const answer = 40 + 2; answer');
  await kernel.stop();

  const frames = kernel.received();
  const stdout = frames.find((frame) => frame.event === "stdout" && frame.id === "c1");
  const result = frames.find((frame) => frame.event === "result" && frame.id === "c1");
  assertEqual(stdout, undefined, "a bare expression writes no stdout");
  assertEqual(result?.text, "42", "the trailing expression is returned as the result");
  assertEqual(done.status, "ok", "the done frame reports ok");
  assertEqual(
    frames.filter((frame) => frame.event === "done" && frame.id === "c1").length,
    1,
    "exactly one done frame per execute",
  );
  const resultIndex = frames.indexOf(result!);
  const doneIndex = frames.indexOf(done);
  assert(resultIndex < doneIndex, "the result frame precedes done");
});
