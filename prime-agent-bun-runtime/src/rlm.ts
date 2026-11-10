/**
 * The `rlm` surface and the host bridge.
 *
 * `rlm` is the model-facing API described by the harness system prompt. Every
 * method is a typed wrapper over one `host_request` frame: the host owns
 * admission, budgets, rosters, and session state, and this module only validates
 * shapes and normalizes payloads — exactly like `prime-agent-runtime/src/rlm/__init__.py`.
 *
 * Method names are snake_case (the prompt's documented API) with camelCase
 * aliases beside them, so both spellings resolve. The aliases exist only until
 * the fork's model-facing surface phase; see `KERNEL-API.md`.
 */

import { bash, persistentShells, type BashHandle, type BashRegistry } from "./bash.ts";
import { McpRegistry } from "./mcp.ts";
import { getHarnessState, type HarnessState } from "./harness.ts";
import { TRANSCRIPT_READ_MIME, type Json } from "./protocol.ts";
import { cellContext, emitDisplay, emitHostRequest } from "./streams.ts";

/** One reply from the host for a `host_request` frame. */
export interface HostReply {
  status: string;
  result?: Json;
  error?: string;
}

/** Routes runtime-originated host requests to the host and back. */
export class HostBridge {
  private readonly pending = new Map<string, (reply: HostReply) => void>();
  private sequence = 0;

  /** Send one typed request and await the host's reply. */
  request(data: Json): Promise<HostReply> {
    this.sequence += 1;
    const id = `runtime-host-${this.sequence}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      emitHostRequest(id, data);
    });
  }

  /** Route a `host_reply` frame; unknown ids are dropped, like the Python runtime. */
  resolve(id: string, data: HostReply): void {
    const waiter = this.pending.get(id);
    if (waiter !== undefined) {
      this.pending.delete(id);
      waiter(data);
    }
  }

  /** Drop every outstanding request (shutdown / interrupt). */
  clear(): void {
    this.pending.clear();
  }

  get outstanding(): number {
    return this.pending.size;
  }
}

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** Add camelCase aliases for snake_case keys, non-destructively. */
export function withAliases<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => withAliases(item)) as unknown as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const [key, item] of Object.entries(source)) {
    if (key.includes("_")) {
      const alias = camel(key);
      if (!(alias in out)) {
        out[alias] = withAliases(item);
      }
    }
  }
  return out as T;
}

function parseReply(requestType: string, reply: HostReply): Record<string, unknown> {
  if (reply.status === "ok") {
    const result = reply.result;
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      return withAliases(result) as Record<string, unknown>;
    }
    return { value: result ?? null };
  }
  if (reply.status === "error") {
    throw new Error(String(reply.error ?? `host request ${requestType} failed`));
  }
  throw new Error(`host request ${requestType} returned unexpected status: ${reply.status}`);
}

export interface RlmRuntime {
  bridge: HostBridge;
  registry: BashRegistry;
  /** Whether a cell id is the kernel's currently running cell. */
  isCellActive?: (id: string | null) => boolean;
}

/** Options accepted by `spawn` / `createSession`. */
export interface SpawnOptions {
  name?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
}

function kwargs(options: SpawnOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options.name !== undefined) {
    out.name = options.name;
  }
  if (options.model !== undefined) {
    out.model = options.model;
  }
  if (options.thinking !== undefined) {
    out.thinking = options.thinking;
  }
  if (options.cwd !== undefined) {
    out.cwd = options.cwd;
  }
  return out;
}

function selector(target: unknown, what = "target"): string {
  if (typeof target === "string" && target.trim() !== "") {
    return target.trim();
  }
  if (target !== null && typeof target === "object") {
    const row = target as Record<string, unknown>;
    const id = row.rlm_child_id ?? row.rlmChildId;
    if (typeof id === "string" && id !== "") {
      return id;
    }
  }
  throw new TypeError(`${what} must be a spawn handle, subagent row, or non-empty string`);
}

const PROGRESS_NOTE_MAX_LENGTH = 512;

/** Build the `rlm` object, its host bridge, and the module-level helpers. */
export function createRlm(runtime: RlmRuntime): Record<string, unknown> {
  const { bridge, registry } = runtime;
  const isCellActive = runtime.isCellActive ?? (() => true);
  /** `bash()` from a cell: the cell id tags the command for the `[bash-done]` lane. */
  const runBash = (command: string, persistent = false): BashHandle =>
    bash(registry, command, persistent, cellContext.getStore() ?? null, isCellActive);

  const hostRequest = async (
    requestType: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    if (typeof requestType !== "string" || requestType === "") {
      throw new TypeError("request_type must be a non-empty string");
    }
    const reply = await bridge.request({ ...payload, type: requestType } as Json);
    return parseReply(requestType, reply);
  };

  const spawn = async (prompt: string, options: SpawnOptions = {}) => {
    if (typeof prompt !== "string") {
      throw new TypeError("prompt must be a string");
    }
    if (typeof options.name !== "string" || options.name === "") {
      throw new TypeError("name is required");
    }
    const payload = await hostRequest("rlm.run", { prompt, kwargs: kwargs(options) });
    return withAliases(payload);
  };

  const createSession = async (prompt: string, options: SpawnOptions = {}) => {
    if (typeof prompt !== "string") {
      throw new TypeError("prompt must be a string");
    }
    return withAliases(await hostRequest("rlm.create_session", { prompt, kwargs: kwargs(options) }));
  };

  const findModels = async (query = "", limit = 8) => {
    if (typeof query !== "string" || !Number.isInteger(limit)) {
      throw new TypeError("query must be a string and limit an integer");
    }
    const payload = await hostRequest("rlm.find_models", { query, limit });
    const models = payload.models;
    if (!Array.isArray(models)) {
      throw new Error("rlm.find_models returned an invalid models list");
    }
    return withAliases(models);
  };

  const listSubagents = async () => {
    const payload = await hostRequest("rlm.list_subagents");
    const rows = payload.subagents;
    if (!Array.isArray(rows)) {
      throw new Error("rlm.list_subagents returned an invalid subagents registry");
    }
    return withAliases(rows);
  };

  /** `collect(targets, { timeout_ms })`; a bare number is accepted for tolerance. */
  const collect = async (targets?: unknown, options: { timeout_ms?: number } | number = {}) => {
    const timeoutMs = typeof options === "number" ? options : (options?.timeout_ms ?? 0);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeout_ms must be a non-negative integer");
    }
    let selectors: string[] = [];
    if (targets !== undefined && targets !== null) {
      selectors = Array.isArray(targets) ? targets.map((t) => selector(t, "collect target")) : [selector(targets, "collect target")];
    }
    const payload = await hostRequest("rlm.collect", { targets: selectors, timeout_ms: timeoutMs });
    const results = payload.results;
    if (!Array.isArray(results)) {
      throw new Error("rlm.collect returned an invalid results list");
    }
    return withAliases(results);
  };

  const progressNote = async (message: string) => {
    if (typeof message !== "string") {
      throw new TypeError("message must be a string");
    }
    const stripped = message.trim();
    if (stripped === "") {
      throw new Error("message must not be empty");
    }
    if (stripped.length > PROGRESS_NOTE_MAX_LENGTH) {
      throw new Error(`message must be at most ${PROGRESS_NOTE_MAX_LENGTH} characters`);
    }
    return withAliases(await hostRequest("rlm.progress.note", { message: stripped }));
  };

  const deleteSubagent = async (target: unknown) => {
    const payload = await hostRequest("rlm.delete_subagent", { target: selector(target) });
    return withAliases(payload.subagent ?? {});
  };

  const rename = async (newName: string, options: { session_id?: unknown } = {}) => {
    if (typeof newName !== "string") {
      throw new TypeError("new_name must be a string");
    }
    const payload: Record<string, unknown> = { name: newName };
    if (options.session_id !== undefined && options.session_id !== null) {
      payload.session_id = selector(options.session_id, "session_id");
    }
    const reply = await hostRequest("rlm.rename", payload);
    return String(reply.name ?? newName);
  };

  const endTurn = async () => hostRequest("rlm.end_turn", {});

  const readTranscript = async (
    start: number,
    limit: number,
    roles: string[],
    agent: unknown,
  ): Promise<Record<string, unknown>> => {
    const request: Record<string, unknown> = { start, limit, roles };
    if (agent !== undefined && agent !== null) {
      return hostRequest("agent_observe.session_messages", {
        ...request,
        target: selector(agent, "agent"),
      });
    }
    return hostRequest("rlm.session.messages", request);
  };

  const sessionMessages = async (
    start = -10,
    limit = 10,
    options: { role?: string | string[]; agent?: unknown } = {},
  ) => {
    if (limit < 0) {
      throw new Error("limit must not be negative");
    }
    const roles = options.role === undefined ? ["*"] : Array.isArray(options.role) ? options.role : [options.role];
    const reply = await readTranscript(start, limit, roles, options.agent);
    const rows = reply.messages;
    if (!Array.isArray(rows)) {
      throw new Error("rlm.session.messages returned an invalid transcript");
    }
    const messages = rows.map((row) => {
      const record = row as Record<string, unknown>;
      const message = record.message as Record<string, unknown>;
      return withAliases({
        index: record.index,
        id: record.id,
        role: message.role,
        text: messageText(message),
        timestamp: message.timestamp ?? null,
        raw: message,
      });
    });
    emitDisplay({
      [TRANSCRIPT_READ_MIME]: {
        returned: messages.length,
        first: messages.length > 0 ? (messages[0] as { index: unknown }).index as Json : null,
        total: (reply.total ?? 0) as Json,
        roles,
      },
    });
    return messages;
  };

  /** `count('user')` or `count({ role, agent })`, matching the Python positional role. */
  const sessionCount = async (
    roleOrOptions: string | string[] | { role?: string | string[]; agent?: unknown } = {},
  ) => {
    const options =
      typeof roleOrOptions === "string" || Array.isArray(roleOrOptions)
        ? { role: roleOrOptions }
        : roleOrOptions;
    const roles = options.role === undefined ? ["*"] : Array.isArray(options.role) ? options.role : [options.role];
    const reply = await readTranscript(0, 0, roles, options.agent);
    return Number(reply.total ?? 0);
  };

  const harnessRef = (): HarnessState => getHarnessState();

  let degradedHarness: HarnessState | null = null;
  /** Never-throwing harness resolution, mirroring the Python `_HarnessProxy`. */
  const tolerantHarness = (): HarnessState => {
    try {
      return getHarnessState();
    } catch {
      degradedHarness ??= new HarnessState({ inMemory: true });
      return degradedHarness;
    }
  };
  const harnessProxyObject = new Proxy({} as HarnessState, {
    get: (_target, property) => {
      const state = tolerantHarness();
      const value = (state as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(state) : value;
    },
    has: (_target, property) => property in tolerantHarness(),
  });

  const factoryRefusal = async (): Promise<never> => {
    throw new Error(
      "The factory executor is not ported in the Bun kernel core. " +
        "Use the Python kernel for rlm.factory, or port factory.ts (see KERNEL-API.md).",
    );
  };

  const notPorted = (surface: string) => async (): Promise<never> => {
    throw new Error(`${surface} is not ported in the Bun kernel core (see KERNEL-API.md).`);
  };

  const rlmCallable = (() => {
    throw new TypeError(
      "'rlm' is not callable; spawn a child with: const handle = await rlm.spawn('sub-task', { name: 'worker' })",
    );
  }) as unknown as Record<string, unknown> & ((...args: unknown[]) => never);

  const session = {
    messages: sessionMessages,
    count: sessionCount,
    messagesSync: notPorted("rlm.session.messages (sync)"),
  };

  const factory = {
    run: factoryRefusal,
    status: factoryRefusal,
    stop: factoryRefusal,
    resume: factoryRefusal,
    graph: factoryRefusal,
    watch: factoryRefusal,
    help: () =>
      "The factory executor is planned but not ported in the Bun kernel core. " +
      "See prime-agent-bun-runtime/KERNEL-API.md for the port ledger entry.",
  };

  // Generic MCP: the runtime speaks JSON-RPC to the configured servers itself
  // (no third-party dependency), while the host owns configuration, credential
  // binding, and endpoint pinning through `mcp.config`.
  const mcpRegistry = new McpRegistry(hostRequest);
  const mcp = {
    list_tools: (server: string) => mcpRegistry.listTools(server),
    call_tool: (server: string, tool: string, args: Record<string, unknown> = {}) =>
      mcpRegistry.callTool(server, tool, args),
    status: (servers: string[], timeoutMs = 10_000) => mcpRegistry.status(servers, timeoutMs),
    list_connections: () => mcpRegistry.listConnections(),
    list_plugins: (options: Parameters<McpRegistry["listPlugins"]>[0] = {}) =>
      mcpRegistry.listPlugins(options),
    search_plugins: (query: string, limit = 10) => mcpRegistry.searchPlugins(query, limit),
    search_tools: (query: string, limit = 10, cursor?: string) =>
      mcpRegistry.searchTools(query, limit, cursor),
    describe_tool: (connectionId: string, tool: string) =>
      mcpRegistry.describeTool(connectionId, tool),
    close: () => mcpRegistry.close(),
  };

  const api: Record<string, unknown> = {
    spawn,
    create_session: createSession,
    find_models: findModels,
    list_subagents: listSubagents,
    collect,
    progress_note: progressNote,
    delete_subagent: deleteSubagent,
    rename,
    end_turn: endTurn,
    host_request: hostRequest,
    get_harness_state: harnessRef,
    harness: harnessProxyObject,
    session,
    factory,
    mcp,
    mcpRegistry,
    bash: runBash,
    persistent_shells: () => persistentShells(registry),
  };

  Object.assign(rlmCallable, api);
  // camelCase aliases beside the snake_case API.
  for (const [key, value] of Object.entries(api)) {
    if (key.includes("_")) {
      const alias = camel(key);
      if (!(alias in rlmCallable)) {
        (rlmCallable as Record<string, unknown>)[alias] = value;
      }
    }
  }

  return {
    rlm: rlmCallable,
    bash: runBash,
    persistent_shells: () => persistentShells(registry),
    persistentShells: () => persistentShells(registry),
    emit: (data: Record<string, Json>) => emitDisplay(data),
    host_request: hostRequest,
    hostRequest,
    end_turn: endTurn,
    spawn,
    create_session: createSession,
    find_models: findModels,
    list_subagents: listSubagents,
    collect,
    progress_note: progressNote,
    delete_subagent: deleteSubagent,
    rename,
    get_harness_state: harnessRef,
    harness: harnessProxyObject,
    session,
    factory,
    mcp,
    mcpRegistry,
  } satisfies Record<string, unknown>;
}

/** Extract display text from one transcript row. */
function messageText(message: Record<string, unknown>): string {
  const role = message.role;
  if (role === "compactionSummary" || role === "branchSummary") {
    return String(message.summary ?? "");
  }
  if (role === "bashExecution") {
    return [message.command, message.output].filter((part) => typeof part === "string").join("\n");
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => (block as { type?: string }).type === "text")
      .map((block) => String((block as { text?: unknown }).text ?? ""))
      .join("\n");
  }
  return "";
}

export type { BashHandle, BashRegistry };
