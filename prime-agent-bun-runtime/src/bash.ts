/**
 * `bash()`: project shell commands from inside a cell.
 *
 * Mirrors `prime-agent-runtime/src/rlm/bash.py`'s observable contract: a call
 * returns a handle immediately (the command runs in the background), the handle
 * is awaitable, `persistent=True` keeps one long-lived shell whose state
 * survives between calls, and every start emits the bash-command display the
 * host folds into the cell card.
 */

import { BASH_COMMAND_MIME } from "./protocol.ts";
import { emitDisplay } from "./streams.ts";

/** Result of one finished command. */
export interface BashResult {
  exitCode: number;
  output: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Outcome of one `bash_activity` request. */
export interface ActivityRow {
  id: string;
  command: string;
  pid: number | null;
  durationMs: number;
  status: "running" | "finished";
}

interface Activity {
  id: string;
  command: string;
  pid: number | null;
  startedAt: number;
  finishedAt: number | null;
  tail: string[];
}

const FINISHED_RETENTION = 64;
const TAIL_LINE_CAP = 200;
const ACTIVITY_RESPONSE_CAP = 16 * 1024;

function shellPath(): string {
  const override = process.env.PRIME_AGENT_BASH_SHELL;
  if (override !== undefined && override !== "") {
    if (!override.startsWith("/")) {
      throw new Error("PRIME_AGENT_BASH_SHELL must be an absolute path");
    }
    return override;
  }
  return process.env.SHELL !== undefined && process.env.SHELL !== "" ? process.env.SHELL : "/bin/sh";
}

function commandPrefix(): string {
  return process.env.PRIME_AGENT_BASH_COMMAND_PREFIX ?? "";
}

/** One finished detached command, reported to the host's `[bash-done]` lane. */
export interface BashCompletion {
  activityId: string;
  pid: number | null;
  command: string;
  exitCode: number;
}

/** The activity registry one kernel serves `bash_activity` from. */
export class BashRegistry {
  private readonly activities = new Map<string, Activity>();
  private finishedOrder: string[] = [];
  private nextId = 1;
  /** Fired when a detached command finishes after its originating cell ended. */
  private completionNotifier: ((completion: BashCompletion) => void) | null = null;
  /** Fired when the kernel reads a result it already announced. */
  private consumedNotifier: ((completion: BashCompletion) => void) | null = null;
  /** Activity ids the host has already been told about. */
  private readonly announced = new Set<string>();

  /** Install the `[bash-done]` lane. */
  setNotifiers(
    onCompletion: (completion: BashCompletion) => void,
    onConsumed: (completion: BashCompletion) => void,
  ): void {
    this.completionNotifier = onCompletion;
    this.consumedNotifier = onConsumed;
  }

  /**
   * Announce a finished detached command.
   *
   * The notice fires only when the command outlived the cell that started it —
   * a cell that awaited the handle already consumed the result, so a notice
   * would be noise (the Python runtime's rule).
   */
  announceIfDetached(activityId: string, exitCode: number, originatingCellWasActive: boolean): void {
    if (this.completionNotifier === null || originatingCellWasActive) {
      return;
    }
    const activity = this.activities.get(activityId);
    if (activity === undefined) {
      return;
    }
    this.announced.add(activityId);
    this.completionNotifier({
      activityId,
      pid: activity.pid,
      command: activity.command,
      exitCode,
    });
  }

  /** Tell the host a previously announced result has been read. */
  consumed(activityId: string): void {
    if (!this.announced.delete(activityId) || this.consumedNotifier === null) {
      return;
    }
    const activity = this.activities.get(activityId);
    if (activity !== undefined) {
      this.consumedNotifier({
        activityId,
        pid: activity.pid,
        command: activity.command,
        exitCode: 0,
      });
    }
  }

  start(command: string, pid: number | null): string {
    const id = `bash-${this.nextId}`;
    this.nextId += 1;
    this.activities.set(id, {
      id,
      command,
      pid,
      startedAt: Date.now(),
      finishedAt: null,
      tail: [],
    });
    return id;
  }

  append(id: string, chunk: string): void {
    const activity = this.activities.get(id);
    if (activity === undefined) {
      return;
    }
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        activity.tail.push(line);
      }
    }
    if (activity.tail.length > TAIL_LINE_CAP) {
      activity.tail.splice(0, activity.tail.length - TAIL_LINE_CAP);
    }
  }

  finish(id: string): void {
    const activity = this.activities.get(id);
    if (activity === undefined || activity.finishedAt !== null) {
      return;
    }
    activity.finishedAt = Date.now();
    this.finishedOrder.push(id);
    while (this.finishedOrder.length > FINISHED_RETENTION) {
      const evicted = this.finishedOrder.shift();
      if (evicted !== undefined) {
        this.activities.delete(evicted);
      }
    }
  }

  kill(id: string): boolean {
    const activity = this.activities.get(id);
    if (activity === undefined || activity.pid === null || activity.finishedAt !== null) {
      return false;
    }
    try {
      process.kill(activity.pid, "SIGKILL");
    } catch {
      return false;
    }
    return true;
  }

  list(): ActivityRow[] {
    return [...this.activities.values()].map((activity) => ({
      id: activity.id,
      command: activity.command,
      pid: activity.pid,
      durationMs: (activity.finishedAt ?? Date.now()) - activity.startedAt,
      status: activity.finishedAt === null ? "running" : "finished",
    }));
  }

  tail(id: string): string[] | null {
    return this.activities.get(id)?.tail ?? null;
  }

  /** Clamp a response to the 16 KiB reply budget the protocol documents. */
  static clamp(payload: string): string {
    return payload.length > ACTIVITY_RESPONSE_CAP ? payload.slice(0, ACTIVITY_RESPONSE_CAP) : payload;
  }
}

/** A command started by `bash()`; awaiting it waits for completion. */
/** One started command: awaitable, and inspectable like the Python handle. */
export class BashHandle implements PromiseLike<BashResult> {
  readonly id: string;
  readonly command: string;
  private readonly completion: Promise<BashResult>;
  private readonly registry: BashRegistry;
  private result: BashResult | null = null;

  constructor(id: string, command: string, completion: Promise<BashResult>, registry: BashRegistry) {
    this.id = id;
    this.command = command;
    this.completion = completion;
    this.registry = registry;
    void completion.then(
      (result) => {
        this.result = result;
      },
      () => {},
    );
  }

  private consume(): void {
    this.registry.consumed(this.id);
  }

  /** Await the command and get its result. */
  then<TResult1 = BashResult, TResult2 = never>(
    onfulfilled?: ((value: BashResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.consume();
    return this.completion.then(onfulfilled, onrejected);
  }

  /** The full combined output once the command finishes. */
  async output(): Promise<string> {
    this.consume();
    return (await this.completion).output;
  }

  /** The command's output so far (the retained tail). */
  tail(lines = 50): string {
    return (this.registry.tail(this.id) ?? []).slice(-Math.max(1, lines)).join("\n");
  }

  /** The exit code once the command finished; `null` while it runs. */
  poll(): number | null {
    if (this.result === null) {
      return null;
    }
    this.consume();
    return this.result.exitCode;
  }

  /** Whether the process is still running. */
  get running(): boolean {
    return this.result === null;
  }

  /** Kill the command's process group. */
  kill(): boolean {
    return this.registry.kill(this.id);
  }
}

function collect(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) {
        break;
      }
      if (value !== undefined) {
        const piece = decoder.decode(value, { stream: true });
        text += piece;
        onChunk(piece);
      }
    }
    text += decoder.decode();
    return text;
  })();
}

function startCommand(
  registry: BashRegistry,
  command: string,
  persistent: boolean,
  originatingCell: string | null,
  isCellActive: (id: string | null) => boolean,
): { handle: BashHandle; proc: Bun.Subprocess } {
  const prefix = commandPrefix();
  const proc = Bun.spawn([shellPath(), persistent ? "-s" : "-c", prefix + command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const id = registry.start(command, proc.pid ?? null);
  const started = performance.now();
  const stdoutPromise = collect(proc.stdout as ReadableStream<Uint8Array>, (piece) =>
    registry.append(id, piece),
  );
  const stderrPromise = collect(proc.stderr as ReadableStream<Uint8Array>, (piece) =>
    registry.append(id, piece),
  );
  const completion = (async (): Promise<BashResult> => {
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;
    registry.finish(id);
    // The cell that started this command may be long gone; only then does the
    // host need a `[bash-done]` notice.
    registry.announceIfDetached(id, exitCode, isCellActive(originatingCell));
    return {
      exitCode,
      stdout,
      stderr,
      output: stdout + stderr,
      durationMs: Math.round(performance.now() - started),
    };
  })();
  const handle = new BashHandle(id, command, completion, registry);
  emitDisplay({ [BASH_COMMAND_MIME]: { command, lines: countLines(command) } });
  return { handle, proc };
}

function countLines(command: string): number {
  return command.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Start a command. `persistent=true` keeps shell state (cwd, variables) between
 * calls in one long-lived shell; the default is a fresh process per call.
 */
export function bash(
  registry: BashRegistry,
  command: string,
  persistent = false,
  originatingCell: string | null = null,
  isCellActive: (id: string | null) => boolean = () => true,
): BashHandle {
  if (typeof command !== "string") {
    throw new TypeError("command must be a string");
  }
  if (persistent) {
    return persistentShell(registry).run(command, originatingCell, isCellActive);
  }
  return startCommand(registry, command, false, originatingCell, isCellActive).handle;
}

/** One long-lived shell with sentinel-fenced commands. */
export class PersistentShell {
  private readonly proc: Bun.Subprocess;
  private readonly registry: BashRegistry;
  private buffer = "";
  /** Lines read before a caller asked for them; a dropped line would hang the command. */
  private readonly pendingLines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private sequence = 0;
  /** Commands run one at a time: the shell has a single stdout stream. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly prefix = commandPrefix();

  constructor(registry: BashRegistry) {
    this.registry = registry;
    this.proc = Bun.spawn([shellPath(), "-s"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) {
        return;
      }
      this.buffer += decoder.decode(value, { stream: true });
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.deliverLine(line);
        index = this.buffer.indexOf("\n");
      }
    }
  }

  /** Hand one line to the first waiting command, or queue it for the next. */
  private deliverLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      this.pendingLines.push(line);
    }
  }

  private nextLine(): Promise<string> {
    const queued = this.pendingLines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Queue `command` behind every command already in flight on this shell. */
  run(
    command: string,
    originatingCell: string | null = null,
    isCellActive: (id: string | null) => boolean = () => true,
  ): Promise<BashHandle> {
    const started = this.queue.then(
      () => this.runNow(command, originatingCell, isCellActive),
      () => this.runNow(command, originatingCell, isCellActive),
    );
    this.queue = started.catch(() => {});
    return started;
  }

  private async runNow(
    command: string,
    originatingCell: string | null,
    isCellActive: (id: string | null) => boolean,
  ): Promise<BashHandle> {
    this.sequence += 1;
    const marker = `__PRIME_AGENT_DONE_${this.sequence}__`;
    const id = this.registry.start(command, this.proc.pid ?? null);
    const started = performance.now();
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(`${this.prefix}${command}\nprintf '${marker}%s\\n' "$?"\n`);
    await stdin.flush();
    const completion = (async (): Promise<BashResult> => {
      const collected: string[] = [];
      let exitCode = 0;
      for (;;) {
        const line = await this.nextLine();
        if (line.startsWith(marker)) {
          exitCode = Number.parseInt(line.slice(marker.length), 10) || 0;
          break;
        }
        collected.push(line);
        this.registry.append(id, line + "\n");
      }
      this.registry.finish(id);
      this.registry.announceIfDetached(id, exitCode, isCellActive(originatingCell));
      const output = collected.join("\n") + (collected.length > 0 ? "\n" : "");
      return {
        exitCode,
        stdout: output,
        stderr: "",
        output,
        durationMs: Math.round(performance.now() - started),
      };
    })();
    const handle = new BashHandle(id, command, completion, this.registry);
    emitDisplay({ [BASH_COMMAND_MIME]: { command, lines: countLines(command) } });
    persistentHandles.push(handle);
    return handle;
  }

  async close(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
    await this.proc.exited;
  }
}

let sharedShell: PersistentShell | null = null;
const shells: PersistentShell[] = [];
const persistentHandles: BashHandle[] = [];

/** The kernel's single persistent shell, created on first `persistent=True` call. */
export function persistentShell(registry: BashRegistry): PersistentShell {
  if (sharedShell === null) {
    sharedShell = new PersistentShell(registry);
    shells.push(sharedShell);
  }
  return sharedShell;
}

/** Handles of every command run in a persistent shell (Python `persistent_shells()`). */
export function persistentShells(): BashHandle[] {
  return [...persistentHandles];
}

/** Record one persistent-shell handle so `persistent_shells()` can list it. */
export function trackPersistentHandle(handle: BashHandle): void {
  persistentHandles.push(handle);
}

/** Close every persistent shell this kernel opened (shutdown). */
export async function closePersistentShells(): Promise<void> {
  await Promise.all(shells.map((shell) => shell.close()));
  shells.length = 0;
  persistentHandles.length = 0;
  sharedShell = null;
}
