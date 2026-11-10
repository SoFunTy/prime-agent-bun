/**
 * Protocol client for the case suites: spawns `src/repl.ts` on Bun and drives it
 * over the real fd 0 / fd 1 wire, so every case exercises the shipped framing.
 */

export interface Frame {
  event: string;
  id?: string | null;
  status?: string;
  text?: string;
  names?: string[];
  reason?: string;
  [key: string]: unknown;
}

export type FramePredicate = (frame: Frame) => boolean;

const RUNTIME = new URL("../../prime-agent-bun-runtime/src/repl.ts", import.meta.url).pathname;

export class KernelClient {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<{ predicate: FramePredicate; resolve: (frame: Frame) => void }> = [];
  private readonly stderrChunks: string[] = [];

  private constructor(proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.proc = proc;
    void this.pumpStdout();
    void this.pumpStderr();
  }

  static start(env: Record<string, string> = {}): KernelClient {
    const proc = Bun.spawn(["bun", "run", RUNTIME], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    return new KernelClient(proc);
  }

  private async pumpStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") {
          this.accept(JSON.parse(line) as Frame);
        }
        index = buffer.indexOf("\n");
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr as ReadableStream<Uint8Array>) {
      this.stderrChunks.push(decoder.decode(chunk, { stream: true }));
    }
  }

  private accept(frame: Frame): void {
    this.frames.push(frame);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter!.resolve(frame);
    }
  }

  /** Send one request frame. */
  send(request: Record<string, unknown>): void {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(request) + "\n");
    void stdin.flush();
  }

  /** Wait for the first frame matching `predicate`. */
  next(predicate: FramePredicate, timeoutMs = 30_000): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  /** Every frame received so far, in order. */
  received(): Frame[] {
    return [...this.frames];
  }

  /** Everything the runtime wrote to raw stderr. */
  stderr(): string {
    return this.stderrChunks.join("");
  }

  /** Execute one cell and resolve with its `done` frame. */
  async execute(id: string, code: string, timeoutMs = 30_000): Promise<Frame> {
    this.send({ type: "execute", id, code });
    return this.next((frame) => frame.event === "done" && frame.id === id, timeoutMs).catch((error) => {
      throw new Error(`cell ${id} never settled: ${String(error)}`);
    });
  }

  /** Close stdin and wait for the process to exit. */
  async stop(): Promise<number> {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    return this.proc.exited;
  }

  /** Kill the process outright. */
  kill(): void {
    this.proc.kill();
  }
}

/** Minimal assertion helpers shared by every case. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`assertion failed: ${message}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

/** Frames of one kind for one id, in arrival order. */
export function framesFor(frames: Frame[], event: string, id: string): Frame[] {
  return frames.filter((frame) => frame.event === event && frame.id === id);
}

/** Run one case body, printing PASS/FAIL and setting the exit code on failure. */
export async function runCase(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as Error).message}`);
    process.exit(1);
  }
}
