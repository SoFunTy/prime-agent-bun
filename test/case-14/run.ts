/**
 * case-14: the remaining request paths.
 *
 * Pins the reply shapes for the surfaces the other cases do not touch:
 * `mcp_status` with no host available (one bounded error row per requested
 * server, never a hang — case-16 covers the healthy path), `restore` of a
 * missing file (ok + `reason: "snapshot not found"`), and `bash_activity`
 * tail / kill of an unknown id.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-14 mcp_status/restore/bash_activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-bun-case14-"));
  try {
    const kernel = KernelClient.start();
    await kernel.next((frame) => frame.event === "ready");

    kernel.send({ type: "mcp_status", id: "m1", servers: ["alpha", "beta"], timeout_ms: 100 });
    const mcp = await kernel.next((frame) => frame.event === "done" && frame.id === "m1");
    assertEqual(mcp.status, "ok", "mcp_status answers rather than hanging");
    const connections = mcp.connections as Array<{ server: string; tools: unknown; error: unknown }>;
    assertEqual(connections.map((row) => row.server), ["alpha", "beta"], "one row per requested server");
    for (const row of connections) {
      assert(row.tools === null && typeof row.error === "string", "each row degrades with an error");
    }

    kernel.send({ type: "restore", id: "m2", path: join(dir, "absent.dill") });
    const restore = await kernel.next((frame) => frame.event === "done" && frame.id === "m2");
    assertEqual(restore.status, "ok", "a missing snapshot is an ok empty restore");
    assertEqual(restore.restored, [], "nothing restored");
    assertEqual(restore.reason, "snapshot not found", "the reason names the missing file");

    kernel.send({ type: "bash_activity", id: "m3", action: "tail", activityId: "unknown", lines: 5 });
    const tail = await kernel.next((frame) => frame.event === "done" && frame.id === "m3");
    assertEqual(tail.status, "error", "an unknown activity id is an error");

    kernel.send({ type: "bash_activity", id: "m4", action: "kill", activityId: "unknown" });
    const kill = await kernel.next((frame) => frame.event === "done" && frame.id === "m4");
    assertEqual(kill.killed, false, "killing an unknown id reports false");

    await kernel.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
