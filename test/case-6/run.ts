/**
 * case-6: snapshot / restore round trip.
 *
 * Pins: snapshot writes the payload + manifest, skips `_`-prefixed and reserved
 * names, reports `saved`, and restore revives values into a fresh kernel.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-6 snapshot/restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-bun-case6-"));
  const payload = join(dir, "kernel-state.dill");
  const manifest = join(dir, "kernel-state.json");
  try {
    const writer = KernelClient.start();
    await writer.next((frame) => frame.event === "ready");
    await writer.execute(
      "w1",
      ["const kept = { n: 1, list: [1, 2, 3] };", "const _private = 'skip me';", "const mapped = new Map([['k', 1]]);"].join("\n"),
    );
    writer.send({ type: "snapshot", id: "snap1", path: payload, manifest_path: manifest });
    const snapDone = await writer.next((frame) => frame.event === "done" && frame.id === "snap1");
    await writer.stop();

    assertEqual(snapDone.status, "ok", "the snapshot succeeds");
    const saved = snapDone.saved as string[];
    assert(saved.includes("kept"), "a plain object is saved");
    assert(saved.includes("mapped"), "a Map is saved");
    assert(!saved.includes("_private"), "an underscore-name is skipped");
    assert(existsSync(payload) && existsSync(manifest), "payload and manifest exist on disk");
    const manifestBody = JSON.parse(readFileSync(manifest, "utf8")) as { savedNames: string[] };
    assert(manifestBody.savedNames.includes("kept"), "the manifest lists the saved names");

    const reader = KernelClient.start();
    await reader.next((frame) => frame.event === "ready");
    reader.send({ type: "restore", id: "rest1", path: payload });
    const restoreDone = await reader.next((frame) => frame.event === "done" && frame.id === "rest1");
    assertEqual(restoreDone.status, "ok", "the restore succeeds");

    await reader.execute("r1", "[kept.n, kept.list.join('-'), mapped.get('k')].join(',')");
    const result = reader.received().find((frame) => frame.event === "result" && frame.id === "r1");
    await reader.stop();
    assertEqual(result?.text, "\"1,1-2-3,1\"", "restored values are usable in a cell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
