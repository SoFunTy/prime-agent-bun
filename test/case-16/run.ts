/**
 * case-16: the generic MCP client.
 *
 * Pins: `mcp.list_tools` / `mcp.call_tool` drive a real stdio MCP server
 * (initialize handshake, `tools/list`, `tools/call`), the server configuration
 * comes from the host (`mcp.config` host_request), and the protocol
 * `mcp_status` request reports the server's real tools instead of a placeholder.
 */
import { KernelClient, assert, assertEqual, runCase } from "../lib/kernel-client.ts";

const SERVER = new URL("../lib/fake-mcp-server.ts", import.meta.url).pathname;

await runCase("case-16 mcp client", async () => {
  const kernel = KernelClient.start();
  await kernel.next((frame) => frame.event === "ready");

  // list_tools: the runtime asks the host for the server config, then speaks
  // JSON-RPC to the spawned server.
  kernel.send({ type: "execute", id: "m1", code: 'const tools = await mcp.list_tools("demo"); tools.map((t) => t.name).join(",")' });
  const configRequest = await kernel.next(
    (frame) => frame.event === "host_request" && (frame.data as { type?: string })?.type === "mcp.config",
  );
  assertEqual(
    (configRequest.data as { server?: string }).server,
    "demo",
    "the runtime asks the host for this server's configuration",
  );
  kernel.send({
    type: "host_reply",
    id: configRequest.id,
    data: { status: "ok", result: { type: "stdio", command: "bun", args: ["run", SERVER] } },
  });
  const listed = await kernel.next((frame) => frame.event === "done" && frame.id === "m1");
  const listedResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m1");
  assertEqual(listed.status, "ok", "tools/list succeeds against the real server");
  assertEqual(listedResult?.text, '"echo"', "the server's tool name reaches the cell");

  // call_tool: the connection is reused, so no second config request is needed.
  const called = await kernel.execute("m2", 'await mcp.call_tool("demo", "echo", { text: "hi" })');
  const calledResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m2");
  assertEqual(called.status, "ok", "tools/call succeeds");
  assertEqual(calledResult?.text, '"echo:hi"', "the tool result is normalized to its text");

  // The protocol request the TUI's MCP panel uses now reports real tools.
  kernel.send({ type: "mcp_status", id: "m3", servers: ["demo"], timeout_ms: 5000 });
  const status = await kernel.next((frame) => frame.event === "done" && frame.id === "m3");
  const connections = status.connections as Array<{
    server: string;
    tools: Array<{ name: string; description: string }> | null;
    error: string | null;
  }>;
  assertEqual(status.status, "ok", "mcp_status answers");
  assertEqual(connections.length, 1, "one row for the requested server");
  assert(connections[0]?.error === null, `no error for a healthy server (got ${connections[0]?.error})`);
  assertEqual(connections[0]?.tools?.map((tool) => tool.name), ["echo"], "the row lists the real tools");

  await kernel.stop();
});
