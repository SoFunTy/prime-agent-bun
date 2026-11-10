/**
 * case-10: the host bridge (`rlm.spawn` → `host_request` → `host_reply`).
 *
 * Pins: `rlm.spawn` emits an `rlm.run` host_request with the admission kwargs,
 * the host's `host_reply` resolves the awaiting cell, and `rlm.end_turn` uses
 * the sanctioned request type. This is the seam the Rust host owns.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-10 host bridge", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  kernel.send({
    type: "execute",
    id: "h1",
    code: "const handle = await rlm.spawn('review the parser', { name: 'reviewer' }); handle.rlm_child_id",
  });

  const request = await kernel.next(
    (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "rlm.run",
  );
  const payload = request.data as { prompt: string; kwargs: { name: string } };
  assertEqual(payload.prompt, "review the parser", "the prompt rides the request");
  assertEqual(payload.kwargs.name, "reviewer", "the name rides the request kwargs");
  kernel.send({
    type: "host_reply",
    id: request.id,
    data: {
      status: "ok",
      result: { rlm_child_id: "child-1", name: "reviewer", session_dir: "/tmp/child", model: "fake/model" },
    },
  });

  const done = await kernel.next((frame) => frame.event === "done" && frame.id === "h1");
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "h1");
  assertEqual(done.status, "ok", "the cell resumes after the reply");
  assertEqual(result?.text, "\"child-1\"", "the spawn handle is returned to the cell");

  kernel.send({ type: "execute", id: "h2", code: "await rlm.end_turn()" });
  const endTurn = await kernel.next(
    (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "rlm.end_turn",
  );
  kernel.send({ type: "host_reply", id: endTurn.id, data: { status: "ok", result: {} } });
  const endDone = await kernel.next((frame) => frame.event === "done" && frame.id === "h2");
  await kernel.stop();
  assertEqual(endDone.status, "ok", "end_turn round-trips");
});
