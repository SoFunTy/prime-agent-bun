/**
 * case-19: the bash lanes.
 *
 * Pins the shell contract the prompt promises: `persistent=true` keeps shell
 * state between calls; a detached command that outlives its cell fires the
 * `[bash-done]` lane (`bash.completed` with pid/command/exitCode); reading that
 * result afterwards announces `bash.consumed`; and the handle exposes
 * `tail()` / `poll()` / `running` / `kill()`.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-19 bash lanes", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  // Persistent shell: state survives between calls.
  await kernel.execute("p1", 'await bash("export PA_MARK=42", true)');
  const p2 = await kernel.execute("p2", '(await bash("echo mark=$PA_MARK", true)).output.trim()');
  const p2Result = kernel.received().find((frame) => frame.event === "result" && frame.id === "p2");
  assertEqual(p2.status, "ok", "persistent-shell calls succeed");
  assertEqual(p2Result?.text, '"mark=42"', "persistent=true keeps shell state between calls");

  // Two concurrent persistent commands must both resolve, in submission order:
  // the shell's single stdout stream is line-queued, never hand-off-dropped.
  const concurrent = await kernel.execute(
    "p3",
    [
      "const [first, second] = await Promise.all([",
      "  bash('echo first', true),",
      "  bash('echo second', true),",
      "]);",
      "[first.output.trim(), second.output.trim()].join('|')",
    ].join("\n"),
  );
  const concurrentResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "p3");
  assertEqual(concurrent.status, "ok", "concurrent persistent commands both settle");
  assertEqual(concurrentResult?.text, '"first|second"', "each command reads its own output, in order");

  // Detached command: the cell ends while it still runs.
  const detached = await kernel.execute("d1", "const later = bash('sleep 0.3; echo done-later'); 'started'");
  assertEqual(detached.status, "ok", "the starting cell ends immediately");

  const notice = await kernel
    .next(
      (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "bash.completed",
      30_000,
    )
    .catch((error) => {
      throw new Error(`step=notice: ${String(error)}`);
    });
  const payload = notice.data as { pid?: number; command?: string; exitCode?: number };
  assert(typeof payload.pid === "number" && payload.pid > 0, "the notice carries a positive pid");
  assert(
    typeof payload.command === "string" && payload.command.includes("done-later"),
    `the notice carries the command (got ${JSON.stringify(payload.command)})`,
  );
  assertEqual(payload.exitCode, 0, "the notice carries the exit code");
  kernel.send({ type: "host_reply", id: notice.id, data: { status: "ok", result: {} } });

  // Reading the announced result tells the host to drop the notice.
  const read = await kernel.execute("d2", "const out = await later; out.exitCode + ':' + out.output.trim()");
  const readResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "d2");
  assertEqual(readResult?.text, '"0:done-later"', "the handle resolves to the finished result");

  const consumed = await kernel
    .next(
      (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "bash.consumed",
      30_000,
    )
    .catch((error) => {
      throw new Error(`step=consumed: ${String(error)}`);
    });
  const consumedPayload = consumed.data as { pid?: number; command?: string };
  assertEqual(consumedPayload.pid, payload.pid, "the consumed notice names the same pid");
  kernel.send({ type: "host_reply", id: consumed.id, data: { status: "ok", result: {} } });

  // The handle's inspection surface.
  const inspect = await kernel.execute(
    "d3",
    [
      "const h = bash('sleep 0.25; echo inspect-me');",
      "const k = bash('sleep 5');",
      "const killed = k.kill();",
      "[String(h.running), String(h.poll()), String(killed), String(typeof h.tail(5))].join('|')",
    ].join("\n"),
  );
  const inspectResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "d3");
  assertEqual(inspect.status, "ok", "the inspection cell succeeds");
  assertEqual(
    inspectResult?.text,
    '"true|null|true|string"',
    "running/poll/kill/tail report the handle's live state",
  );

  // A killed handle settles, and its exit code says it did not finish cleanly.
  const settled = await kernel.execute("d4", "await new Promise((r) => setTimeout(r, 400)); const done = await k; [String(k.running), done.exitCode !== 0].join('|')");
  const settledResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "d4");
  assertEqual(settled.status, "ok", "a killed handle settles");
  assertEqual(settledResult?.text, '"false|true"', "the killed handle reports a failure exit");

  await kernel.stop();
});
