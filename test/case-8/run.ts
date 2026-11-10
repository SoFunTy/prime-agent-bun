/**
 * case-8: interrupt.
 *
 * Pins: an `interrupt` frame targeting a cell ends it with a `KeyboardInterrupt`
 * error frame and `done status:"error"`; a parked interrupt is delivered when
 * its request becomes active; an interrupt for an unknown id is harmless; and
 * the kernel keeps serving afterwards.
 */
import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-8 interrupt", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  // The interrupt arrives before the queued cell starts: it must be parked and
  // delivered the moment that request becomes active, not dropped.
  kernel.send({ type: "execute", id: "i1", code: "await new Promise(() => {});" });
  kernel.send({ type: "interrupt", id: "i1" });

  const done = await kernel.next((frame) => frame.event === "done" && frame.id === "i1");
  const error = kernel.received().find((frame) => frame.event === "error" && frame.id === "i1");
  assertEqual(done.status, "error", "the interrupted cell reports error");
  assertEqual(error?.ename, "KeyboardInterrupt", "the interrupt surfaces as KeyboardInterrupt");

  kernel.send({ type: "interrupt", id: "never-running" });
  const survived = await kernel.execute("i2", "'alive'");
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "i2");
  await kernel.stop();
  assertEqual(survived.status, "ok", "the kernel keeps serving after an interrupt");
  assertEqual(result?.text, "\"alive\"", "the next cell runs normally");
});
