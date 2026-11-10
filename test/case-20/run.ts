/**
 * case-20: the ported skills' real behavior.
 *
 * Pins three executable skills end to end: `edit` refuses an ambiguous match and
 * performs a unique one, `attach_image` emits the attachment display for a real
 * image and rejects a missing file, and `websearch` teaches the setup path when
 * no Serper key is configured (instead of failing).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

const SKILLS = new URL("../../skills", import.meta.url).pathname;

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

await runCase("case-20 skill behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-bun-case20-"));
  const agentDir = join(root, "agent"); // no auth.json -> no Serper key
  const target = join(root, "target.txt");
  const image = join(root, "pixel.png");
  writeFileSync(target, "alpha\ndup\nbeta\ndup\ngamma\n");
  writeFileSync(image, Buffer.from(PNG_1X1, "base64"));

  try {
    const kernel = KernelClient.start({
      PRIME_AGENT_CODING_AGENT_DIR: agentDir,
      SERPER_API_KEY: "",
    });
    await kernel.next((frame) => frame.event === "ready");
    const specs = JSON.stringify(
      ["edit", "attach-image", "websearch"].map((name) => ({ name, dir: `${SKILLS}/${name}` })),
    );
    const bootstrap = await kernel.execute("boot", `await __prime_agent_load_skills__(${specs});`);
    assertEqual(bootstrap.status, "ok", "the src/ skills load");

    // edit: an ambiguous match is refused with the teaching error.
    const ambiguous = await kernel.execute(
      "e1",
      `await edit({ path: ${JSON.stringify(target)}, old_str: 'dup', new_str: 'x' })`,
    );
    const ambiguousError = kernel.received().find((frame) => frame.event === "error" && frame.id === "e1");
    assertEqual(ambiguous.status, "error", "an ambiguous edit is refused");
    assert(
      String(ambiguousError?.evalue).includes("more than once"),
      `the refusal explains the ambiguity (got ${JSON.stringify(ambiguousError?.evalue)})`,
    );
    assertEqual(readFileSync(target, "utf8"), "alpha\ndup\nbeta\ndup\ngamma\n", "the file is untouched");

    // edit: a unique match is applied and the diff rides the display lane.
    const edited = await kernel.execute(
      "e2",
      `await edit({ path: ${JSON.stringify(target)}, old_str: 'beta', new_str: 'BETA' })`,
    );
    const editedResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "e2");
    assertEqual(edited.status, "ok", "a unique edit succeeds");
    assert(
      String(editedResult?.text).includes("Edited"),
      `the result confirms the edit (got ${JSON.stringify(editedResult?.text)})`,
    );
    assert(
      readFileSync(target, "utf8").includes("BETA"),
      "the edit reached the disk",
    );
    const diff = kernel.received().find(
      (frame) =>
        frame.event === "display" &&
        typeof frame.data === "object" &&
        frame.data !== null &&
        "application/vnd.prime-agent.diff+json" in (frame.data as Record<string, unknown>),
    );
    assert(diff !== undefined, "the edit emits the diff display");

    // attach_image: a real image becomes an attachment.
    const attached = await kernel.execute("i1", `await attach_image({ paths: [${JSON.stringify(image)}] })`);
    const attachment = kernel.received().find(
      (frame) =>
        frame.event === "display" &&
        typeof frame.data === "object" &&
        frame.data !== null &&
        "application/vnd.prime-agent.attachment+json" in (frame.data as Record<string, unknown>),
    );
    assertEqual(attached.status, "ok", "attach_image succeeds for a real PNG");
    assert(attachment !== undefined, "the attachment display rides the cell");
    const payload = (attachment?.data as Record<string, Record<string, string>>)[
      "application/vnd.prime-agent.attachment+json"
    ];
    assertEqual(payload?.mime_type, "image/png", "the payload carries the detected mime type");
    assert((payload?.data ?? "").length > 0, "the payload carries the base64 image");

    const missing = await kernel.execute("i2", `await attach_image({ paths: [${JSON.stringify(join(root, "nope.png"))}] })`);
    const missingError = kernel.received().find((frame) => frame.event === "error" && frame.id === "i2");
    assertEqual(missing.status, "error", "a missing image is refused");
    assert(
      String(missingError?.evalue).includes("not found"),
      `the refusal names the file (got ${JSON.stringify(missingError?.evalue)})`,
    );

    // websearch: no key -> the setup teaching text, not an error.
    const search = await kernel.execute("w1", `await websearch({ query: 'bun shell' })`);
    const searchResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "w1");
    assertEqual(search.status, "ok", "websearch answers without a key");
    assert(
      String(searchResult?.text).includes("no Serper API key"),
      `the answer teaches the setup (got ${String(searchResult?.text).slice(0, 120)})`,
    );

    await kernel.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
