/**
 * Wire types and frame caps of the REPL runtime protocol, version 3.
 *
 * The authoritative specification is `prime-agent-runtime/src/rlm/repl.md`
 * (`python -m rlm.repl`). This module is the Bun implementation's mirror of
 * that contract: the Rust host (`crates/pa-core/src/kernel/protocol.rs`)
 * re-exports the same version and caps, and the two must agree byte for byte.
 */

/** Handshake version. The host refuses a `ready` that does not announce exactly this. */
export const PROTOCOL_VERSION = 3;

/** A Python-level write ships at most this many characters per `stdout`/`stderr` frame. */
export const STREAM_FRAME_TEXT_CAP = 64 * 1024;

/** `result` / `error.evalue` / each traceback entry are capped at this many characters. */
export const RESULT_TEXT_CAP = 1_048_576;

/** Appended after truncated result/error text so the reader can tell it was cut. */
export const RESULT_TRUNCATION_MARKER = `\n[... result truncated at ${RESULT_TEXT_CAP} characters ...]`;

/** `display` and `host_request` payloads larger than this are refused in the calling cell. */
export const PAYLOAD_CAP = 16 * 1024 * 1024;

/** Names the snapshot never serializes: runtime surface plus Python-parity reserved names. */
export const ALWAYS_SKIP: ReadonlySet<string> = new Set([
  "rlm",
  "mcp",
  "bash",
  "asyncio",
  "In",
  "Out",
  "get_ipython",
  "exit",
  "quit",
  "open",
]);

/** Names a payload may contain but the restore never revives. */
export const RESTORE_SKIP: ReadonlySet<string> = new Set(["In", "Out", "get_ipython"]);

/** Default aggregate payload ceiling (bytes) when the request omits `max_bytes`. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/** Default per-variable ceiling (bytes) when the request omits `max_variable_bytes`. */
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;

/** Display MIME for the bash-command summary the host folds into the cell card. */
export const BASH_COMMAND_MIME = "application/vnd.prime-agent.bash-command+json";

/** Display MIME for one transcript read record (`rlm.session.messages`). */
export const TRANSCRIPT_READ_MIME = "application/vnd.prime-agent.transcript-read+json";

/** Host request type that ends the turn (`rlm.end_turn()`). */
export const END_TURN_REQUEST_TYPE = "rlm.end_turn";

/** Host request type that reports a background bash completion (`[bash-done]` lane). */
export const BASH_COMPLETED_REQUEST_TYPE = "bash.completed";

/** Host request type that reports a read of an already-announced completion. */
export const BASH_CONSUMED_REQUEST_TYPE = "bash.consumed";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One request frame from the host on fd 0. */
export type Request =
  | { type: "execute"; id: string; code: string }
  | { type: "interrupt"; id?: string }
  | { type: "host_reply"; id: string; data: { status: string; [key: string]: Json } }
  | {
      type: "snapshot";
      id: string;
      path: string;
      manifest_path: string;
      max_bytes?: number;
      max_variable_bytes?: number;
      prune_oversized?: boolean;
    }
  | { type: "restore"; id: string; path: string; max_bytes?: number; max_variable_bytes?: number }
  | { type: "list_names"; id: string }
  | { type: "mcp_status"; id: string; servers: string[]; timeout_ms?: number }
  | {
      type: "bash_activity";
      id: string;
      action: "list" | "tail" | "kill";
      activityId?: string;
      lines?: number;
    }
  | { type: "shutdown"; id?: string };

/** Requests that run strictly in order on the single execution lane. */
export function isOrderedRequest(request: Request): boolean {
  switch (request.type) {
    case "execute":
    case "snapshot":
    case "restore":
    case "list_names":
    case "mcp_status":
    case "shutdown":
      return true;
    case "interrupt":
    case "host_reply":
    case "bash_activity":
      return false;
    default:
      return true;
  }
}

/** Truncate cell text to the shared result cap, appending the truncation marker. */
export function capResultText(text: string): string {
  if (text.length <= RESULT_TEXT_CAP) {
    return text;
  }
  return text.slice(0, RESULT_TEXT_CAP) + RESULT_TRUNCATION_MARKER;
}

/** Chunk one user write into protocol stream frames (cap 64 Ki characters each). */
export function chunkStreamText(text: string): string[] {
  if (text.length <= STREAM_FRAME_TEXT_CAP) {
    return text.length === 0 ? [] : [text];
  }
  const frames: string[] = [];
  for (let start = 0; start < text.length; start += STREAM_FRAME_TEXT_CAP) {
    frames.push(text.slice(start, start + STREAM_FRAME_TEXT_CAP));
  }
  return frames;
}

/**
 * Refuse an oversized `display` / `host_request` payload before it reaches the wire.
 *
 * Mirrors `repl.py`'s `_check_payload`: the measure is the JSON encoding length
 * in characters, and the refusal is a `ValueError` raised in the calling cell.
 */
export function assertPayloadWithinCap(event: string, data: Json): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    throw new Error(`${event} payload is not JSON-serializable`);
  }
  if (encoded === undefined) {
    throw new Error(`${event} payload is not JSON-serializable`);
  }
  if (encoded.length > PAYLOAD_CAP) {
    throw new Error(`${event} payload exceeds the ${PAYLOAD_CAP}-character frame cap`);
  }
}

/** Protocol-level error the runtime raises when the host's frames are malformed. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
