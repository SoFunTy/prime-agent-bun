/**
 * case-9: `bash()` and `bash_activity`.
 *
 * Pins: `bash()` emits the bash-command display, is awaitable, returns the
 * command's exit code and output, and the started command shows up in the
 * out-of-band `bash_activity` list while a cell is still running.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

const BASH_COMMAND_MIME = "application/vnd.prime-agent.bash-command+json";

await runCase("case-9 bash + bash_activity", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const done = await kernel.execute("b1", "const out = await bash('echo kernel-bash-ok'); out.output.trim()");
  const display = kernel.received().find(
    (frame) =>
      frame.event === "display" &&
      frame.id === "b1" &&
      typeof frame.data === "object" &&
      frame.data !== null &&
      BASH_COMMAND_MIME in (frame.data as Record<string, unknown>),
  );
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "b1");
  assert(display !== undefined, "bash() emits the bash-command display");
  assertEqual(done.status, "ok", "the bash cell succeeds");
  assertEqual(result?.text, "\"kernel-bash-ok\"", "the command output reaches the cell");

  // bash_activity is out-of-band: ask while a cell holds the lane.
  kernel.send({ type: "execute", id: "b2", code: "await new Promise((r) => setTimeout(r, 250)); 'done'" });
  kernel.send({ type: "bash_activity", id: "act1", action: "list" });
  const activity = await kernel.next((frame) => frame.event === "done" && frame.id === "act1");
  assertEqual(activity.status, "ok", "bash_activity answers out of band");
  assert(Array.isArray(activity.activities), "the list carries activity rows");
  await kernel.next((frame) => frame.event === "done" && frame.id === "b2");
  await kernel.stop();
});
