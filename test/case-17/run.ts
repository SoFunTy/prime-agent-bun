/**
 * case-17: the `rlm` host-bridge matrix.
 *
 * Pins the wire type and payload shape of every `rlm` API the model can call
 * from a Bun cell: spawn, create_session, find_models, list_subagents, collect,
 * progress_note, delete_subagent, rename, session.messages/count, and end_turn.
 * A drift in any of these breaks the host contract silently, so each one is
 * asserted against a scripted host.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

type Request = { type: string; [key: string]: unknown };

const SPAWN_HANDLE = { rlm_child_id: "child-1", name: "reviewer", session_dir: "/tmp/child", model: "fake/model" };

await runCase("case-17 rlm host-bridge matrix", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  const seen: Request[] = [];
  const consumed = new Set<string>();

  /** Answer the next un-consumed host_request of `type` and record what arrived. */
  const answer = async (type: string, result: Record<string, unknown>): Promise<Request> => {
    const request = await kernel.next(
      (frame) =>
        frame.event === "host_request" &&
        (frame.data as Request)?.type === type &&
        !consumed.has(String(frame.id)),
    );
    consumed.add(String(request.id));
    seen.push(request.data as Request);
    kernel.send({ type: "host_reply", id: request.id, data: { status: "ok", result } });
    return request.data as Request;
  };

  // One cell drives the whole surface; the host answers each request in order.
  kernel.send({
    type: "execute",
    id: "m",
    code: [
      "const child = await rlm.spawn('review the parser', { name: 'reviewer' });",
      "const session = await rlm.create_session('sweep the docs', { name: 'docs', model: 'fake/model' });",
      "const models = await rlm.find_models('claude', 3);",
      "const rows = await rlm.list_subagents();",
      "const collected = await rlm.collect([child], { timeout_ms: 5000 });",
      "const note = await rlm.progress_note('parsing done');",
      "const removed = await rlm.delete_subagent(child);",
      "const renamed = await rlm.rename('reviewer-2');",
      "const transcript = await rlm.session.messages(-5, 5, { role: 'assistant' });",
      "const total = await rlm.session.count('user');",
      "await rlm.end_turn();",
      "[child.rlm_child_id, session.active_session_id, models.length, rows.length,",
      " collected.length, note.accepted, removed.rlm_child_id, renamed, transcript.length, total].join('|')",
    ].join("\n"),
  });

  await answer("rlm.run", SPAWN_HANDLE);
  await answer("rlm.create_session", {
    active_session_id: "active-1",
    session_id: "session-1",
    name: "docs",
    session_file: "/tmp/session.jsonl",
    model: "fake/model",
  });
  await answer("rlm.find_models", {
    models: [{ provider: "fake", id: "model-1", name: "Model One", selector: "fake/model-1" }],
  });
  await answer("rlm.list_subagents", {
    subagents: [
      {
        rlm_child_id: "child-1",
        active_session_id: "active-1",
        session_id: "session-1",
        session_name: "reviewer",
        session_dir: "/tmp/child",
        status: "running",
      },
    ],
  });
  await answer("rlm.collect", {
    results: [
      {
        rlm_child_id: "child-1",
        session_name: "reviewer",
        session_dir: "/tmp/child",
        status: "running",
        settled: false,
        answer_preview: null,
      },
    ],
  });
  await answer("rlm.progress.note", { accepted: true });
  await answer("rlm.delete_subagent", { subagent: { ...SPAWN_HANDLE, status: "cancelled" } });
  await answer("rlm.rename", { name: "reviewer-2" });
  await answer("rlm.session.messages", {
    messages: [
      {
        index: 0,
        id: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      },
    ],
    total: 1,
  });
  await answer("rlm.session.messages", { messages: [], total: 7 });
  await answer("rlm.end_turn", {});

  const done = kernel.next((frame) => frame.event === "done" && frame.id === "m");
  const finished = await done;
  const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "m");
  await kernel.stop();

  assertEqual(finished.status, "ok", "the matrix cell succeeds");

  // The request shapes the host dispatches on.
  assertEqual(
    seen.map((request) => request.type),
    [
      "rlm.run",
      "rlm.create_session",
      "rlm.find_models",
      "rlm.list_subagents",
      "rlm.collect",
      "rlm.progress.note",
      "rlm.delete_subagent",
      "rlm.rename",
      "rlm.session.messages",
      "rlm.session.messages",
      "rlm.end_turn",
    ],
    "every API emits its documented host request type, in order",
  );
  const byType = new Map(seen.map((request) => [request.type, request]));
  assertEqual(byType.get("rlm.run")?.prompt, "review the parser", "spawn sends the prompt");
  assertEqual(
    (byType.get("rlm.run")?.kwargs as { name?: string })?.name,
    "reviewer",
    "spawn sends the admission kwargs",
  );
  assertEqual(byType.get("rlm.find_models")?.query, "claude", "find_models sends the query");
  assertEqual(byType.get("rlm.find_models")?.limit, 3, "find_models sends the limit");
  assertEqual(
    (byType.get("rlm.collect")?.targets as string[])?.[0],
    "child-1",
    "collect normalizes a spawn handle to its child id",
  );
  assertEqual(byType.get("rlm.collect")?.timeout_ms, 5000, "collect sends the timeout");
  assertEqual(byType.get("rlm.progress.note")?.message, "parsing done", "progress_note sends the message");
  assertEqual(byType.get("rlm.delete_subagent")?.target, "child-1", "delete_subagent targets the child id");
  assertEqual(byType.get("rlm.rename")?.name, "reviewer-2", "rename sends the new name");
  const transcriptReads = seen.filter((request) => request.type === "rlm.session.messages");
  assertEqual(transcriptReads.length, 2, "messages and count each read the transcript");
  assertEqual(
    (transcriptReads[0]?.roles as string[])?.[0],
    "assistant",
    "the transcript read sends the role filter",
  );
  assertEqual(
    (transcriptReads[1]?.roles as string[])?.[0],
    "user",
    "count sends its positional role",
  );

  // The cell's own view of every reply.
  assertEqual(
    result?.text,
    '"child-1|active-1|1|1|1|true|child-1|reviewer-2|1|7"',
    "every reply is normalized into the cell's result",
  );

  // The transcript read rides the display record the host folds into the card.
  const display = kernel.received().find(
    (frame) =>
      frame.event === "display" &&
      typeof frame.data === "object" &&
      frame.data !== null &&
      "application/vnd.prime-agent.transcript-read+json" in (frame.data as Record<string, unknown>),
  );
  assert(display !== undefined, "a transcript read emits its display record");
});
