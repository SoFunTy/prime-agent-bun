/**
 * case-12: frame caps.
 *
 * Pins: stdout is chunked at 64 Ki characters; the result text is capped at
 * 1,048,576 characters with the truncation marker; oversized snapshot
 * variables are skipped and (with `prune_oversized`) removed from the
 * namespace.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

const STREAM_CAP = 64 * 1024;
const RESULT_CAP = 1_048_576;

await runCase("case-12 frame caps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-bun-case12-"));
  try {
    const kernel = KernelClient.start();
    await kernel.next((frame) => frame.event === "ready");

    await kernel.execute("c1", "console.log('x'.repeat(70000));");
    const stdoutFrames = kernel
      .received()
      .filter((frame) => frame.event === "stdout" && frame.id === "c1");
    assert(stdoutFrames.length >= 2, "a 70 000-character write splits into multiple frames");
    for (const frame of stdoutFrames) {
      assert((frame.text as string).length <= STREAM_CAP, "no stdout frame exceeds the 64 Ki cap");
    }
    assertEqual(
      stdoutFrames.map((frame) => frame.text).join("").length,
      70_001,
      "the chunks rejoin to the full write",
    );

    await kernel.execute("c2", "'y'.repeat(1100000)");
    const bigResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "c2");
    assert((bigResult?.text as string).length > RESULT_CAP, "the truncated result carries the marker");
    assert(
      (bigResult?.text as string).startsWith('"yyy') && (bigResult?.text as string).includes("result truncated"),
      `the result is cut at the cap with the marker appended (len=${(bigResult?.text as string).length})`,
    );

    await kernel.execute("c3", "const huge = 'z'.repeat(4000); const small = 1;");
    kernel.send({
      type: "snapshot",
      id: "snap",
      path: join(dir, "state.dill"),
      manifest_path: join(dir, "state.json"),
      max_variable_bytes: 1000,
      prune_oversized: true,
    });
    const snapDone = await kernel.next((frame) => frame.event === "done" && frame.id === "snap");
    assertEqual(snapDone.status, "ok", "the capped snapshot succeeds");
    const skipped = (snapDone.skipped as Array<{ name: string }>).map((row) => row.name);
    assert(skipped.includes("huge"), "the oversized variable is reported as skipped");
    assert((snapDone.pruned as string[]).includes("huge"), "prune_oversized removes it");

    await kernel.execute("c4", "typeof huge");
    const afterPrune = kernel.received().find((frame) => frame.event === "result" && frame.id === "c4");
    await kernel.stop();
    assertEqual(afterPrune?.text, "\"undefined\"", "the pruned name is gone from the namespace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
