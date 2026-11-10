/**
 * case-11: shutdown and stdin EOF.
 *
 * Pins: a `shutdown` request replies `done` and exits 0; closing stdin without
 * a shutdown request also exits 0 after draining already-read requests.
 */
import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-11 shutdown/eof", async () => {
  const explicit = KernelClient.start();
  await explicit.next((frame) => frame.event === "ready");
  explicit.send({ type: "shutdown", id: "s1" });
  const done = await explicit.next((frame) => frame.event === "done" && frame.id === "s1");
  const code = await explicit.stop();
  assertEqual(done.status, "ok", "shutdown replies done");
  assertEqual(code, 0, "explicit shutdown exits 0");

  const eof = KernelClient.start();
  await eof.next((frame) => frame.event === "ready");
  eof.send({ type: "execute", id: "e1", code: "const drained = 'yes'; drained" });
  const exit = await eof.stop();
  const result = eof.received().find((frame) => frame.event === "result" && frame.id === "e1");
  assertEqual(result?.text, "\"yes\"", "a request read before EOF still runs");
  assertEqual(exit, 0, "stdin EOF exits 0 after draining");
});
