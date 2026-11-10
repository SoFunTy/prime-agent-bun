/**
 * case-7: `list_names`.
 *
 * Pins: the reply lists user-defined names sorted, filtered by the same rules
 * the snapshot applies (no `_`-prefixed, no runtime-reserved names).
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-7 list_names", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");
  await kernel.execute(
    "l1",
    ["const zeta = 1;", "const alpha = 2;", "const _hidden = 3;", "const rlm = 'shadow';"].join("\n"),
  );
  kernel.send({ type: "list_names", id: "l2" });
  const done = await kernel.next((frame) => frame.event === "done" && frame.id === "l2");
  await kernel.stop();

  const names = done.names as string[];
  assert(Array.isArray(names), "names is an array");
  assertEqual(done.status, "ok", "list_names succeeds");
  assertEqual(names, ["alpha", "zeta"], "user names sorted, reserved and underscore names filtered");
});
