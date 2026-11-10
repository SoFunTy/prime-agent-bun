/**
 * case-15: executable skill loading.
 *
 * Pins: the bootstrap call the host emits imports a skill's JavaScript entry and
 * binds it to its global name, a skill without a JavaScript entry is skipped
 * silently, and a skill whose module fails to import (a) still binds a stand-in
 * that raises a clear error, and (b) reports through the shared stdout marker the
 * host already parses for unavailable Python skills.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

const MARKER = "__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__";

await runCase("case-15 skill loading", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-bun-case15-"));
  try {
    // A healthy skill with an explicit manifest.
    const good = join(root, "greet");
    mkdirSync(good, { recursive: true });
    writeFileSync(
      join(good, "package.json"),
      JSON.stringify({ name: "greet", primeAgent: { javascript: { global: "greet", entry: "index.ts" } } }),
    );
    writeFileSync(
      join(good, "index.ts"),
      "export default function createSkill(ctx: any) { return (name: string) => `hello ${name}`; }\n",
    );

    // A skill whose module throws at import time.
    const broken = join(root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "index.ts"), "throw new Error('skill module exploded');\n");

    // A Python-only skill: no JavaScript entry at all.
    const pythonOnly = join(root, "py-only");
    mkdirSync(join(pythonOnly, "src", "py_only"), { recursive: true });
    writeFileSync(join(pythonOnly, "pyproject.toml"), "[project]\nname='py-only'\n");
    writeFileSync(join(pythonOnly, "src", "py_only", "__init__.py"), "");

    const kernel = KernelClient.start();
    await kernel.next((frame) => frame.event === "ready");

    const specs = JSON.stringify([
      { name: "greet", dir: good },
      { name: "broken", dir: broken },
      { name: "py-only", dir: pythonOnly },
    ]);
    const bootstrap = await kernel.execute("boot", `await __prime_agent_load_skills__(${specs});`);
    assertEqual(bootstrap.status, "ok", "the bootstrap cell settles ok even with a broken skill");

    const stdout = kernel
      .received()
      .filter((frame) => frame.event === "stdout" && frame.id === "boot")
      .map((frame) => frame.text)
      .join("");
    assert(stdout.includes(MARKER), "the failure report uses the shared import-error marker");
    const reported = JSON.parse(stdout.slice(stdout.indexOf(MARKER) + MARKER.length).trim()) as Record<string, string>;
    assertEqual(Object.keys(reported), ["broken"], "only the broken skill is reported");
    assert(
      reported.broken?.includes("exploded"),
      `the report carries the import error (got ${JSON.stringify(reported)})`,
    );

    // The healthy skill is callable; the python-only one was skipped (no global).
    const call = await kernel.execute("use", "greet('kernel')");
    const result = kernel.received().find((frame) => frame.event === "result" && frame.id === "use");
    assertEqual(result?.text, '"hello kernel"', "the imported skill is bound and callable");

    const skipped = await kernel.execute("skip", "typeof py_only");
    const skippedResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "skip");
    assertEqual(skippedResult?.text, '"undefined"', "a skill with no JavaScript entry leaves no global");

    // The failed skill's stand-in raises instead of silently doing nothing.
    const failure = await kernel.execute("broken-call", "broken({})");
    const failureDone = kernel.received().find((frame) => frame.event === "done" && frame.id === "broken-call");
    const failureError = kernel.received().find((frame) => frame.event === "error" && frame.id === "broken-call");
    assertEqual(failureDone.status, "error", "calling a broken skill raises");
    assert(
      String(failureError?.evalue).includes("unavailable"),
      `the error explains the skill is unavailable (got ${JSON.stringify(failureError?.evalue)})`,
    );

    await kernel.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
