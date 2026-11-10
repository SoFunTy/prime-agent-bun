/**
 * case-4: output capture and stream tagging.
 *
 * Pins: `console.log` becomes a `stdout` frame tagged with the cell id,
 * `console.error` / `process.stderr.write` become `stderr` frames, and no user
 * text ever appears on the raw stderr pipe used for diagnostics.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-4 output capture", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const done = await kernel.execute(
    "s1",
    [
      "console.log('to-out');",
      "console.error('to-err');",
      "process.stdout.write('raw-out\\n');",
    ].join("\n"),
  );
  await kernel.stop();

  const frames = kernel.received();
  const stdout = frames
    .filter((frame) => frame.event === "stdout" && frame.id === "s1")
    .map((frame) => frame.text)
    .join("");
  const stderr = frames
    .filter((frame) => frame.event === "stderr" && frame.id === "s1")
    .map((frame) => frame.text)
    .join("");

  assertEqual(done.status, "ok", "the writing cell succeeds");
  assert(stdout.includes("to-out"), `stdout carries console.log (got ${JSON.stringify(stdout)})`);
  assert(stdout.includes("raw-out"), "stdout carries process.stdout.write");
  assert(stderr.includes("to-err"), `stderr carries console.error (got ${JSON.stringify(stderr)})`);
  assert(
    !kernel.stderr().includes("to-err") && !kernel.stderr().includes("to-out"),
    `user text never reaches the raw stderr pipe (got ${JSON.stringify(kernel.stderr())})`,
  );
});
