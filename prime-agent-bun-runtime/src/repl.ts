#!/usr/bin/env bun
/**
 * The Bun REPL runtime: the protocol-v3 server on fd 0 / fd 1.
 *
 * Requests arrive as newline-delimited JSON on stdin, events leave as
 * newline-delimited JSON on stdout. The specification lives in
 * `prime-agent-runtime/src/rlm/repl.md`; this file is the Bun implementation of
 * that contract (`KERNEL-API.md` tracks the per-request parity status).
 *
 * Ordered requests (execute / snapshot / restore / list_names / mcp_status /
 * shutdown) run one at a time on a single lane; `interrupt`, `host_reply`, and
 * `bash_activity` are out-of-band so a running cell cannot block cancellation
 * or inspection.
 */

import { BashRegistry, closePersistentShells } from "./bash.ts";
import { Namespace } from "./namespace.ts";
import {
  BASH_COMPLETED_REQUEST_TYPE,
  BASH_CONSUMED_REQUEST_TYPE,
  END_TURN_REQUEST_TYPE,
  PROTOCOL_VERSION,
  ProtocolError,
  capResultText,
  type Json,
  type Request,
} from "./protocol.ts";
import { createRlm, HostBridge } from "./rlm.ts";
import { restoreSnapshot, saveSnapshot } from "./snapshot.ts";
import { createSkillContext, loadSkills, type SkillSpec } from "./skills.ts";
import { emitEvent, emitStream, installOutputCapture, cellContext } from "./streams.ts";

/** Error raised when an interrupt targets the running cell. */
class InterruptError extends Error {
  constructor() {
    super("KeyboardInterrupt");
    this.name = "KeyboardInterrupt";
  }
}

interface ActiveCell {
  id: string;
  interrupt: (error: Error) => void;
}

function errorEvent(id: string | null, error: unknown) {
  if (error instanceof Error) {
    const lines = (error.stack ?? "").split("\n").slice(1).map(capResultText);
    return {
      event: "error",
      id,
      ename: error.name || "Error",
      evalue: capResultText(error.message),
      traceback: lines,
    };
  }
  return { event: "error", id, ename: "Error", evalue: capResultText(String(error)), traceback: [] };
}

class Kernel {
  private readonly namespace = new Namespace();
  private readonly registry = new BashRegistry();
  private readonly bridge = new HostBridge();
  private readonly globals: Record<string, unknown>;
  private readonly mcpRegistry: {
    status(servers: string[], timeoutMs: number): Promise<unknown[]>;
    close(): void;
  };
  private active: ActiveCell | null = null;
  private parkedInterrupt: { id?: string } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private lastSnapshot: { path: string; manifestPath: string } | null = null;

  constructor() {
    const surface = createRlm({
      bridge: this.bridge,
      registry: this.registry,
      isCellActive: (id) => id !== null && this.active?.id === id,
    });
    // The `[bash-done]` lane: a detached command that outlived its cell wakes the
    // agent; reading an announced result afterwards tells the host to drop it.
    this.registry.setNotifiers(
      (completion) => {
        if (completion.pid === null || completion.pid <= 0) {
          return;
        }
        void this.bridge
          .request({
            type: BASH_COMPLETED_REQUEST_TYPE,
            pid: completion.pid,
            command: completion.command,
            exitCode: completion.exitCode,
          })
          .catch(() => {});
      },
      (completion) => {
        if (completion.pid === null || completion.pid <= 0) {
          return;
        }
        void this.bridge
          .request({
            type: BASH_CONSUMED_REQUEST_TYPE,
            pid: completion.pid,
            command: completion.command,
          })
          .catch(() => {});
      },
    );
    this.globals = surface;
    this.mcpRegistry = surface.mcpRegistry as unknown as Kernel["mcpRegistry"];
    for (const [name, value] of Object.entries(surface)) {
      (globalThis as Record<string, unknown>)[name] = value;
    }
    // The runtime-owned names the model reaches directly.
    (globalThis as Record<string, unknown>).mcp = surface.mcp;
    (globalThis as Record<string, unknown>).harness = surface.harness;
    // Executable skills are prepared by the bootstrap cell the host runs right
    // after startup; the loader itself lives here so the bootstrap stays a thin
    // call with a JSON skill list.
    const skillContext = createSkillContext({
      registry: this.registry,
      hostRequest: surface.host_request as ReturnType<typeof createSkillContext>["hostRequest"],
      emit: surface.emit as ReturnType<typeof createSkillContext>["emit"],
      bash: surface.bash as ReturnType<typeof createSkillContext>["bash"],
      harness: surface.harness as ReturnType<typeof createSkillContext>["harness"],
      rlm: surface.rlm as Record<string, unknown>,
      cwd: process.cwd(),
    });
    (globalThis as Record<string, unknown>).__prime_agent_skill_context = skillContext;
    (globalThis as Record<string, unknown>).__prime_agent_load_skills__ = (specs: SkillSpec[]) =>
      loadSkills(specs, skillContext);
  }

  /** Bounded end-turn request passthrough (host-owned). */
  get hostBridge(): HostBridge {
    return this.bridge;
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work, work);
  }

  private async runExecute(request: Extract<Request, { type: "execute" }>): Promise<void> {
    const { id, code } = request;
    let reject: (error: Error) => void = () => {};
    const interruptPromise = new Promise<never>((_, rej) => {
      reject = rej;
    });
    this.active = { id, interrupt: reject };
    const parked = this.parkedInterrupt;
    if (parked !== null && (parked.id === undefined || parked.id === id)) {
      this.parkedInterrupt = null;
      reject(new InterruptError());
    }
    try {
      const outcome = await Promise.race([this.namespace.run(id, code), interruptPromise]);
      if (outcome.result !== null) {
        emitEvent({ event: "result", id, text: capResultText(outcome.result) });
      }
      if (outcome.error !== null) {
        emitEvent({
          event: "error",
          id,
          ename: outcome.error.ename,
          evalue: capResultText(outcome.error.evalue),
          traceback: outcome.error.traceback.map(capResultText),
        });
        emitEvent({ event: "done", id, status: "error" });
      } else {
        emitEvent({ event: "done", id, status: "ok" });
      }
    } catch (error) {
      if (error instanceof InterruptError) {
        emitEvent(errorEvent(id, error));
        emitEvent({ event: "done", id, status: "error" });
      } else {
        emitEvent(errorEvent(id, error));
        emitEvent({ event: "done", id, status: "error" });
      }
    } finally {
      this.active = null;
    }
  }

  private async runSnapshot(request: Extract<Request, { type: "snapshot" }>): Promise<void> {
    const { id, path, manifest_path: manifestPath } = request;
    if (typeof path !== "string" || typeof manifestPath !== "string") {
      emitEvent({ event: "done", id, status: "error", reason: "path and manifest_path must be strings" });
      return;
    }
    if (path === manifestPath) {
      emitEvent({ event: "done", id, status: "error", reason: "path and manifest_path must differ" });
      return;
    }
    try {
      const outcome = saveSnapshot(
        this.namespace,
        path,
        manifestPath,
        request.max_bytes,
        request.max_variable_bytes,
        request.prune_oversized === true,
      );
      this.lastSnapshot = { path, manifestPath };
      emitEvent({
        event: "done",
        id,
        status: "ok",
        saved: outcome.saved,
        skipped: outcome.skipped as unknown as Json,
        pruned: outcome.pruned,
        bytes: outcome.bytes,
      });
    } catch (error) {
      emitEvent({ event: "done", id, status: "error", reason: (error as Error).message });
    }
  }

  private async runRestore(request: Extract<Request, { type: "restore" }>): Promise<void> {
    const { id, path } = request;
    if (typeof path !== "string") {
      emitEvent({ event: "done", id, status: "error", reason: "path must be a string" });
      return;
    }
    const outcome = restoreSnapshot(this.namespace, path);
    if (outcome.reason !== undefined && outcome.restored.length === 0 && outcome.failed.length === 0) {
      emitEvent({
        event: "done",
        id,
        status: "ok",
        restored: [],
        failed: [],
        reason: outcome.reason,
      });
      return;
    }
    emitEvent({
      event: "done",
      id,
      status: outcome.reason === undefined ? "ok" : "error",
      restored: outcome.restored,
      failed: outcome.failed as unknown as Json,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    });
  }

  private runListNames(request: Extract<Request, { type: "list_names" }>): void {
    emitEvent({ event: "done", id: request.id, status: "ok", names: this.namespace.listedNames() });
  }

  /**
   * MCP status: list each configured server's tools, bounded per server. A
   * server that fails or times out reports its own error row, so one broken
   * server never fails the view.
   */
  private async runMcpStatus(request: Extract<Request, { type: "mcp_status" }>): Promise<void> {
    const servers = Array.isArray(request.servers) ? request.servers : [];
    const timeoutMs = typeof request.timeout_ms === "number" ? request.timeout_ms : 10_000;
    let connections: unknown[];
    try {
      connections = await this.mcpRegistry.status(servers, timeoutMs);
    } catch (error) {
      // A registry-level failure (no host handler, malformed config) still
      // answers: the view renders one row per requested server.
      const reason = error instanceof Error ? error.message : String(error);
      connections = servers.map((server) => ({ server, tools: null, error: reason }));
    }
    emitEvent({ event: "done", id: request.id, status: "ok", connections: connections as Json });
  }

  private runBashActivity(request: Extract<Request, { type: "bash_activity" }>): void {
    const { id, action } = request;
    try {
      if (action === "list") {
        emitEvent({ event: "done", id, status: "ok", activities: this.registry.list() as unknown as Json });
        return;
      }
      if (action === "tail") {
        const lines = Math.min(Math.max(request.lines ?? 50, 1), 200);
        const tail = request.activityId === undefined ? null : this.registry.tail(request.activityId);
        if (tail === null) {
          emitEvent({ event: "done", id, status: "error", reason: "unknown activity id" });
          return;
        }
        emitEvent({ event: "done", id, status: "ok", tail: tail.slice(-lines).join("\n") });
        return;
      }
      if (action === "kill") {
        const killed = request.activityId === undefined ? false : this.registry.kill(request.activityId);
        emitEvent({ event: "done", id, status: "ok", killed });
        return;
      }
      emitEvent({ event: "done", id, status: "error", reason: `unknown action: ${String(action)}` });
    } catch (error) {
      emitEvent({ event: "done", id, status: "error", reason: (error as Error).message });
    }
  }

  private async shutdown(requestedId: string | undefined): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.bridge.clear();
    try {
      this.mcpRegistry.close();
    } catch {
      // MCP children are best-effort on the shutdown path
    }
    await closePersistentShells();
    if (typeof requestedId === "string") {
      emitEvent({ event: "done", id: requestedId, status: "ok" });
    }
    process.exit(0);
  }

  /** Route one parsed request. */
  handle(request: Request): void {
    switch (request.type) {
      case "interrupt": {
        const active = this.active;
        if (active !== null && (request.id === undefined || request.id === active.id)) {
          active.interrupt(new InterruptError());
        } else {
          this.parkedInterrupt = request.id === undefined ? {} : { id: request.id };
        }
        return;
      }
      case "host_reply":
        this.bridge.resolve(request.id, request.data);
        return;
      case "bash_activity":
        this.runBashActivity(request);
        return;
      case "factory_activity":
        emitEvent({
          event: "done",
          id: (request as unknown as { id: string }).id,
          status: "error",
          reason: "factory activity is not ported in the Bun kernel core",
        });
        return;
      case "shutdown":
        this.enqueue(async () => this.shutdown(request.id));
        return;
      case "execute":
        this.enqueue(async () => this.runExecute(request));
        return;
      case "snapshot":
        this.enqueue(async () => this.runSnapshot(request));
        return;
      case "restore":
        this.enqueue(async () => this.runRestore(request));
        return;
      case "list_names":
        this.enqueue(async () => this.runListNames(request));
        return;
      case "mcp_status":
        this.enqueue(async () => this.runMcpStatus(request));
        return;
      default:
        throw new ProtocolError(`unknown request type: ${JSON.stringify(request)}`);
    }
  }

  /** Wait for every queued ordered request to settle. */
  async drain(): Promise<void> {
    await this.queue;
  }

  /** Whether the kernel has begun tearing down. */
  get stopped(): boolean {
    return this.shuttingDown;
  }
}

/** Parse one request line, reporting protocol errors without killing the loop. */
function parseRequest(line: string): Request | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    emitEvent({ ...errorEvent(null, new ProtocolError("unparseable request line")), id: null });
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitEvent({ ...errorEvent(null, new ProtocolError("request is not a JSON object")), id: null });
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") {
    emitEvent({ ...errorEvent(null, new ProtocolError("request without a type")), id: null });
    return null;
  }
  return parsed as Request;
}

async function main(): Promise<void> {
  installOutputCapture();
  const kernel = new Kernel();
  emitEvent({
    event: "ready",
    protocol: PROTOCOL_VERSION,
    runtime: "bun",
    bun: Bun.version,
  });

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        const request = parseRequest(line);
        if (request !== null) {
          kernel.handle(request);
        }
      }
      index = buffer.indexOf("\n");
    }
  }
  // EOF is equivalent to shutdown (the host process is gone), but only after
  // every request already read from the pipe has settled.
  await kernel.drain();
  await kernel.shutdown(undefined);
}

if (import.meta.main) {
  void main();
}

export { Kernel, main, END_TURN_REQUEST_TYPE, cellContext, emitStream };
