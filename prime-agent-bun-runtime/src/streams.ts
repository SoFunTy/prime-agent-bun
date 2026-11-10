/**
 * Event shipping and the user-output capture boundary.
 *
 * The protocol channel is fd 1: every frame is one synchronous `writeSync(1)`
 * call, so frames can never interleave. User code must never write protocol
 * frames by accident, so `console.*` and `process.stdout/stderr.write` are
 * intercepted and re-shipped as tagged `stdout` / `stderr` events. The cell a
 * write belongs to travels with the async context (`AsyncLocalStorage`), which
 * is the Bun analogue of the Python runtime's asyncio task context.
 *
 * Known divergence from `repl.md`: Python additionally redirects fds 1 and 2
 * into pipes so raw-fd writes (`os.write`, C extensions, subprocesses) are
 * captured as untagged `stdout`/`stderr` without corrupting framing. Bun has
 * no `dup2`, so a raw `fs.writeSync(1, ...)` / `Bun.write(Bun.stdout, ...)`
 * from user code still reaches the protocol channel. The runtime reserves fd 1
 * for frames and documents the restriction; everything reached through
 * `console`, `process.stdout`, `process.stderr`, and the `bash()` helper is
 * captured correctly.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";

import { chunkStreamText, type Json, assertPayloadWithinCap } from "./protocol.ts";

/** The cell a user write belongs to; `null` outside a cell (timers, shutdown). */
export const cellContext = new AsyncLocalStorage<string | null>();

/**
 * Write one protocol frame to fd 1, completing the write.
 *
 * A pipe write can be short (the 1 MiB result frame exceeds the pipe buffer),
 * and a short write would truncate a frame into the next one. Channel writers
 * and readers stay line-aligned only if every frame lands whole.
 */
export function writeFrame(frame: Record<string, Json | undefined>): void {
  const bytes = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") {
        continue;
      }
      throw error;
    }
  }
}

/** Ships one protocol event verbatim. */
export function emitEvent(event: Record<string, Json | undefined>): void {
  writeFrame(event);
}

/** Ships `text` as `stdout`/`stderr` frames tagged with `id` (may be null). */
export function emitStream(kind: "stdout" | "stderr", id: string | null, text: string): void {
  for (const piece of chunkStreamText(text)) {
    writeFrame({ event: kind, id, text: piece });
  }
}

/** Ships one `display` event; refuses a payload past the frame cap. */
export function emitDisplay(data: { [mime: string]: Json }): void {
  assertPayloadWithinCap("display", data);
  writeFrame({ event: "display", id: cellContext.getStore() ?? null, data });
}

/** Ships one `host_request` event with a runtime-minted id. */
export function emitHostRequest(id: string, data: Json): void {
  assertPayloadWithinCap("host_request", data);
  writeFrame({ event: "host_request", id, data });
}

let captureInstalled = false;

interface WriteTarget {
  write: (...args: unknown[]) => boolean;
}

function capture(target: WriteTarget, kind: "stdout" | "stderr"): void {
  const original = target.write.bind(target);
  target.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? new TextDecoder().decode(chunk)
          : String(chunk);
    emitStream(kind, cellContext.getStore() ?? null, text);
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") {
      (cb as () => void)();
    }
    // Report success without touching the real pipe: fd 1 carries protocol frames.
    return true;
  }) as WriteTarget["write"];
  void original;
}

/**
 * Install the capture boundary. Idempotent.
 *
 * `console` is overridden explicitly because Bun's console does not
 * necessarily route through `process.stdout.write`.
 */
export function installOutputCapture(): void {
  if (captureInstalled) {
    return;
  }
  captureInstalled = true;
  capture(process.stdout as unknown as WriteTarget, "stdout");
  capture(process.stderr as unknown as WriteTarget, "stderr");

  const format = (args: unknown[]): string =>
    args
      .map((value) => (typeof value === "string" ? value : Bun.inspect(value, { colors: false })))
      .join(" ") + "\n";

  console.log = (...args: unknown[]) => emitStream("stdout", cellContext.getStore() ?? null, format(args));
  console.info = console.log;
  console.debug = (...args: unknown[]) => emitStream("stdout", cellContext.getStore() ?? null, format(args));
  console.warn = (...args: unknown[]) => emitStream("stderr", cellContext.getStore() ?? null, format(args));
  console.error = (...args: unknown[]) => emitStream("stderr", cellContext.getStore() ?? null, format(args));
}
