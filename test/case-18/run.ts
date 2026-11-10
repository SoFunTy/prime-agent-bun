/**
 * case-18: the local surfaces — harness store, factory refusal, MCP failure path.
 *
 * Pins: `rlm.harness` CRUD persists to the session's harness file with the
 * Python-compatible schema; the factory executor refuses with one clear message
 * instead of hanging; and an MCP server that cannot start fails the cell with a
 * message rather than wedging it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-18 harness/factory/mcp", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-bun-case18-"));
  const sessionDir = join(root, "session");
  try {
    const kernel = KernelClient.start({ RLM_SESSION_DIR: sessionDir });
    await kernel.next((frame) => frame.event === "ready");

    // Harness CRUD, on the session's own store.
    const created = await kernel.execute(
      "h1",
      [
        "const state = rlm.harness;",
        "state.create_memory({ title: 'Build', content: 'make check' });",
        "state.create_skill({ title: 'Sweep', content: 'sweep the tree' });",
        "[state.list('memory').length, state.list('skill').length, state.list('memory')[0].title].join('|')",
      ].join("\n"),
    );
    const createdResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "h1");
    assertEqual(created.status, "ok", "harness CRUD succeeds");
    assertEqual(createdResult?.text, '"1|1|Build"', "entries land in their kind and read back");

    const harnessFile = join(sessionDir, "harness", "harness_state.json");
    assert(existsSync(harnessFile), `the harness store persists at ${harnessFile}`);
    const document = JSON.parse(readFileSync(harnessFile, "utf8")) as {
      schema: number;
      entries: Record<string, Record<string, { title: string }>>;
    };
    assertEqual(document.schema, 1, "the on-disk schema matches the Python runtime's");
    assertEqual(
      Object.values(document.entries.memory ?? {}).map((entry) => entry.title),
      ["Build"],
      "the memory is in the memory kind map",
    );

    // The factory executor is not ported: one clear refusal, never a hang.
    const factory = await kernel.execute("h2", "await rlm.factory.run('review-sweep')");
    const factoryError = kernel.received().find((frame) => frame.event === "error" && frame.id === "h2");
    assertEqual(factory.status, "error", "the factory call fails");
    assert(
      String(factoryError?.evalue).includes("not ported"),
      `the refusal explains why (got ${JSON.stringify(factoryError?.evalue)})`,
    );
    const factoryHelp = await kernel.execute("h3", "rlm.factory.help()");
    const helpResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "h3");
    assertEqual(factoryHelp.status, "ok", "help() still answers");
    assert(
      String(helpResult?.text).includes("not ported"),
      "help() points at the ledger instead of pretending",
    );

    // An MCP server that cannot start fails the call with a message.
    kernel.send({ type: "execute", id: "h4", code: 'await mcp.list_tools("broken")' });
    const config = await kernel.next(
      (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "mcp.config",
    );
    kernel.send({
      type: "host_reply",
      id: config.id,
      data: { status: "ok", result: { type: "stdio", command: "/nonexistent/mcp-server", args: [] } },
    });
    const mcpDone = await kernel.next((frame) => frame.event === "done" && frame.id === "h4", 15_000);
    const mcpError = kernel.received().find((frame) => frame.event === "error" && frame.id === "h4");
    assertEqual(mcpDone.status, "error", "an unstartable MCP server fails the cell");
    assert(
      typeof mcpError?.evalue === "string" && mcpError.evalue.length > 0,
      "the failure carries a message",
    );

    await kernel.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
