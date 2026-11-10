/**
 * A minimal MCP stdio server used by case-16: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, one `echo` tool. It is deliberately dependency-free and tiny so
 * the test exercises the runtime's own client code, not a third-party SDK.
 */

function send(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      handle(line);
    }
    index = buffer.indexOf("\n");
  }
}

function handle(line: string): void {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: { name?: string; arguments?: { text?: string } };
  };
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "echo", description: "Echo the given text", inputSchema: { type: "object" } },
          ],
        },
      });
      return;
    case "tools/call":
      if (message.params?.name !== "echo") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool" } });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }] },
      });
      return;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}
