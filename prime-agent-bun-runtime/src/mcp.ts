/**
 * Generic MCP client.
 *
 * The Python runtime drives MCP servers through the official `mcp` SDK. The Bun
 * runtime speaks the same protocol directly (JSON-RPC 2.0) with no third-party
 * dependency, so the packaged tree stays installable offline:
 *
 * - **stdio** transport: spawn the configured command and exchange
 *   newline-delimited JSON-RPC on its stdin/stdout;
 * - **http** transport: POST JSON-RPC to the configured URL, accepting either a
 *   JSON body or an SSE (`text/event-stream`) reply.
 *
 * Server configuration comes from the host (`mcp.config`), exactly like the
 * Python runtime, so credential binding, endpoint pinning, and settings
 * validation stay host-owned.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Json } from "./protocol.ts";

/** Environment a stdio server inherits (mirrors the Python runtime's safe set). */
const SAFE_ENV = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"] as const;

const CLIENT_INFO = { name: "prime-agent", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";
const MAX_TOOL_PAGES = 25;
const DEFAULT_TIMEOUT_MS = 60_000;
const TOOLS_LIST_TIMEOUT_MS = 30_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpConnectionStatus {
  server: string;
  tools: Array<{ name: string; description: string }> | null;
  error: string | null;
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

function agentDir(): string {
  return (
    process.env.PRIME_AGENT_CODING_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".prime", "agent")
  );
}

function resolveConfigValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("!")) {
    return "";
  }
  return (process.env[trimmed] ?? trimmed).trim();
}

function readAuth(provider: string): Record<string, unknown> | null {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth[provider];
    return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The transport one configured server speaks. */
type Transport =
  | {
      kind: "stdio";
      proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
      nextId: number;
      pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
      buffer: string;
      closed: boolean;
    }
  | { kind: "http"; url: string; headers: Record<string, string>; nextId: number };

/** One live server connection. */
class ServerConnection {
  private transport: Transport | null = null;
  private readonly tools = new Map<string, McpTool>();
  private listing: Promise<void> | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(
    readonly server: string,
    private readonly config: Record<string, unknown>,
  ) {}

  private stdioEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of SAFE_ENV) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const raw = this.config.env;
    if (raw === undefined) {
      return env;
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error("MCP stdio env must be an object");
    }
    for (const [key, reference] of Object.entries(raw as Record<string, unknown>)) {
      const source =
        reference !== null && typeof reference === "object"
          ? (reference as { env?: unknown }).env
          : undefined;
      if (typeof source !== "string" || !(source in process.env)) {
        throw new Error(`MCP stdio environment reference for '${key}' is unavailable`);
      }
      env[key] = process.env[source] ?? "";
    }
    return env;
  }

  private httpHeaders(): Record<string, string> {
    const raw = this.config.headers;
    const headers: Record<string, string> = {};
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "object") {
        throw new Error("MCP HTTP headers must contain strings");
      }
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error("MCP HTTP headers must contain strings");
        }
        headers[key] = value;
      }
    }
    const source = this.config.credentialSource;
    if (source === "acp" || source === "static-token") {
      // ACP and static-token credentials are already materialized by the host.
      return headers;
    }
    const envName = this.config.bearerTokenEnvVar;
    let token = typeof envName === "string" ? (process.env[envName] ?? "").trim() : "";
    if (this.config.oauth === true && token === "") {
      const credential = readAuth(`mcp:${this.server}`);
      token = resolveConfigValue(String(credential?.access ?? credential?.key ?? ""));
    }
    if (token !== "") {
      headers.Authorization = `Bearer ${token}`;
    } else if (this.config.oauth === true || typeof envName === "string") {
      throw new Error(
        `MCP credentials for '${this.server}' are unavailable; run /mcp login ${this.server}`,
      );
    }
    return headers;
  }

  /** Create the transport (once) without sending anything. */
  private createTransport(): Transport {
    if (this.config.type === "http") {
      const url = this.config.url;
      if (typeof url !== "string" || url === "") {
        throw new Error(`MCP server '${this.server}' has no url`);
      }
      const transport: Transport = { kind: "http", url, headers: this.httpHeaders(), nextId: 1 };
      this.transport = transport;
      return transport;
    }
    const command = this.config.command;
    if (typeof command !== "string" || command === "") {
      throw new Error(`MCP server '${this.server}' has no command`);
    }
    const args = Array.isArray(this.config.args) ? (this.config.args as string[]) : [];
    const proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.stdioEnv(),
    });
    const transport: Transport = {
      kind: "stdio",
      proc,
      nextId: 1,
      pending: new Map(),
      buffer: "",
      closed: false,
    };
    this.transport = transport;
    void this.pumpStdout(transport);
    void this.pumpStderr(transport);
    return transport;
  }

  /** Run the `initialize` handshake exactly once per connection. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initializing ??= (async () => {
      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      await this.notify("notifications/initialized", {});
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async pumpStdout(transport: Extract<Transport, { kind: "stdio" }>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of transport.proc.stdout as ReadableStream<Uint8Array>) {
      transport.buffer += decoder.decode(chunk, { stream: true });
      let index = transport.buffer.indexOf("\n");
      while (index >= 0) {
        const line = transport.buffer.slice(0, index).trim();
        transport.buffer = transport.buffer.slice(index + 1);
        if (line !== "") {
          this.acceptFrame(transport, line);
        }
        index = transport.buffer.indexOf("\n");
      }
    }
    transport.closed = true;
    for (const [, waiter] of transport.pending) {
      waiter.reject(new Error(`MCP server '${this.server}' closed its output`));
    }
    transport.pending.clear();
  }

  private async pumpStderr(transport: Extract<Transport, { kind: "stdio" }>): Promise<void> {
    for await (const chunk of transport.proc.stderr as ReadableStream<Uint8Array>) {
      void chunk; // server diagnostics are intentionally dropped, like the Python tail
    }
  }

  private acceptFrame(transport: Extract<Transport, { kind: "stdio" }>, line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // a non-JSON line is server noise
    }
    if (typeof parsed.id !== "number") {
      return; // a notification needs no reply
    }
    const waiter = transport.pending.get(parsed.id);
    if (waiter === undefined) {
      return;
    }
    transport.pending.delete(parsed.id);
    if (parsed.error !== undefined && parsed.error !== null) {
      waiter.reject(new Error(parsed.error.message ?? `MCP error ${parsed.error.code ?? ""}`.trim()));
      return;
    }
    waiter.resolve(parsed.result);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const transport = this.transport ?? this.createTransport();
    if (transport.kind === "stdio") {
      const id = transport.nextId;
      transport.nextId += 1;
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      const stdin = transport.proc.stdin as import("bun").FileSink;
      stdin.write(frame);
      await stdin.flush();
      return new Promise<unknown>((resolve, reject) => {
        transport.pending.set(id, { resolve, reject });
      });
    }
    const id = transport.nextId;
    transport.nextId += 1;
    return httpRequest(transport, { jsonrpc: "2.0", id, method, params }, TOOLS_LIST_TIMEOUT_MS);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const transport = this.transport ?? this.createTransport();
    if (transport.kind !== "stdio") {
      return;
    }
    const stdin = transport.proc.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    await stdin.flush();
  }

  /** Every tool the server advertises, following pagination. */
  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    if (this.listing !== null) {
      await this.listing;
      return [...this.tools.values()];
    }
    this.listing = (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = (await this.request("tools/list", cursor === undefined ? {} : { cursor })) as {
          tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
          nextCursor?: unknown;
        };
        for (const tool of result?.tools ?? []) {
          if (typeof tool.name === "string" && tool.name !== "") {
            this.tools.set(tool.name, {
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: tool.inputSchema,
            });
          }
        }
        if (typeof result?.nextCursor !== "string" || result.nextCursor === "") {
          break;
        }
        cursor = result.nextCursor;
      }
    })();
    try {
      await this.listing;
    } finally {
      this.listing = null;
    }
    return [...this.tools.values()];
  }

  /** Call one tool and normalize its result. */
  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = (await this.request("tools/call", { name: tool, arguments: args })) as {
      content?: Array<{ type?: string; text?: unknown }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const texts = (result?.content ?? [])
      .filter((block) => typeof block.text === "string")
      .map((block) => block.text as string);
    if (result?.isError === true) {
      throw new Error(texts.join("\n") || "MCP tool returned an error");
    }
    if (result?.structuredContent !== undefined && result?.structuredContent !== null) {
      return result.structuredContent;
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
    if ((result?.content ?? []).length > 0) {
      return result?.content;
    }
    return result;
  }

  close(): void {
    const transport = this.transport;
    this.transport = null;
    this.tools.clear();
    this.initialized = false;
    this.initializing = null;
    if (transport !== null && transport.kind === "stdio") {
      try {
        transport.proc.kill();
      } catch {
        // already gone
      }
    }
  }
}

async function httpRequest(
  transport: Extract<Transport, { kind: "http" }>,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(transport.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...transport.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP error ${response.status}`);
    }
    let envelope: JsonRpcResponse | null = null;
    if (contentType.includes("text/event-stream")) {
      // Take the last complete `data:` frame carrying our id.
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        try {
          const candidate = JSON.parse(trimmed.slice(5).trim()) as JsonRpcResponse;
          if (candidate.id === payload.id) {
            envelope = candidate;
          }
        } catch {
          // partial frame
        }
      }
    } else {
      envelope = JSON.parse(body) as JsonRpcResponse;
    }
    if (envelope === null) {
      throw new Error("MCP HTTP response carried no JSON-RPC frame");
    }
    if (envelope.error !== undefined && envelope.error !== null) {
      throw new Error(envelope.error.message ?? "MCP HTTP error");
    }
    return envelope.result;
  } finally {
    clearTimeout(timer);
  }
}

/** The runtime's MCP surface: one connection per server, opened on demand. */
export class McpRegistry {
  private readonly connections = new Map<string, ServerConnection>();

  constructor(
    private readonly hostRequest: (
      type: string,
      payload?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) {}

  private async config(server: string): Promise<Record<string, unknown>> {
    const config = await this.hostRequest("mcp.config", { server });
    if (config === null || typeof config !== "object" || Object.keys(config).length === 0) {
      throw new Error(`MCP server '${server}' is not declared in user settings`);
    }
    if (config.enabled === false) {
      throw new Error(`MCP server '${server}' is disabled`);
    }
    return config;
  }

  private async connection(server: string): Promise<ServerConnection> {
    const existing = this.connections.get(server);
    if (existing !== undefined) {
      return existing;
    }
    const connection = new ServerConnection(server, await this.config(server));
    this.connections.set(server, connection);
    return connection;
  }

  /** Tool list for one server. */
  async listTools(server: string): Promise<McpTool[]> {
    return (await this.connection(server)).listTools();
  }

  /** Call one tool on one server. */
  async callTool(server: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof tool !== "string" || tool === "") {
      throw new TypeError("tool must be a non-empty string");
    }
    return (await this.connection(server)).callTool(tool, args);
  }

  /** Per-server tool listing for the host's connections view. */
  async status(servers: string[], timeoutMs: number): Promise<McpConnectionStatus[]> {
    const bound = Math.max(timeoutMs, 1000);
    return Promise.all(
      servers.map(async (server): Promise<McpConnectionStatus> => {
        try {
          const tools = await withTimeout(this.listTools(server), bound);
          return {
            server,
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
            error: null,
          };
        } catch (error) {
          return {
            server,
            tools: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          };
        }
      }),
    );
  }

  /** The user's MCP connections (host-owned records, no secrets). */
  async listConnections(): Promise<unknown[]> {
    const result = await this.hostRequest("mcp.list_connections", {});
    const connections = result.connections;
    if (!Array.isArray(connections)) {
      throw new Error("MCP connection inventory from the host is malformed");
    }
    return connections;
  }

  /** One bounded page of the supported-service catalog. */
  async listPlugins(options: {
    connectionStatus?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { limit: options.limit ?? 50 };
    if (options.connectionStatus !== undefined) {
      payload.connectionStatus = options.connectionStatus;
    }
    if (options.cursor !== undefined) {
      payload.cursor = options.cursor;
    }
    return this.hostRequest("mcp.list_plugins", payload);
  }

  /** Bounded search of the supported-service catalog. */
  async searchPlugins(query: string, limit = 10): Promise<Record<string, unknown>> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new TypeError("query must be a non-empty string");
    }
    return this.hostRequest("mcp.search_plugins", { query: query.trim(), limit });
  }

  /** Search the connected servers' tools. */
  async searchTools(query: string, limit = 10, cursor?: string): Promise<Record<string, unknown>> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new TypeError("query must be a non-empty string");
    }
    const payload: Record<string, unknown> = { query: query.trim(), limit };
    if (cursor !== undefined) {
      payload.cursor = cursor;
    }
    return this.hostRequest("mcp.search_tools", payload);
  }

  /** Describe one tool on one connection. */
  async describeTool(connectionId: string, tool: string): Promise<Record<string, unknown>> {
    return this.hostRequest("mcp.describe_tool", { connectionId, tool });
  }

  /** Close every server this kernel opened. */
  close(): void {
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
