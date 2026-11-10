/**
 * Namespace persistence: snapshot, restore, and the JSON manifest.
 *
 * The payload format is Bun-native (structured clone via `bun:jsc.serialize`,
 * with a source recipe for plain function/class bindings). The Rust host treats
 * the payload as opaque and only stat()s the manifest, so the format is owned
 * here; `path` / `manifest_path` come from the request.
 */

import { renameSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";

import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
  RESTORE_SKIP,
} from "./protocol.ts";
import type { Namespace } from "./namespace.ts";

/** Payload magic; a snapshot without it is not this runtime's. */
export const SNAPSHOT_MAGIC = "PRIME-AGENT-BUN-KERNEL-SNAPSHOT-V1\n";

interface JscModule {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}

let jsc: JscModule | null = null;
try {
  jsc = (await import("bun:jsc")) as unknown as JscModule;
} catch {
  jsc = null;
}

export interface SnapshotOutcome {
  saved: string[];
  skipped: Array<{ name: string; reason: string }>;
  pruned: string[];
  bytes: number;
}

export interface RestoreOutcome {
  restored: string[];
  failed: Array<{ name: string; reason: string }>;
  reason?: string;
}

type Entry = { kind: "bin" | "src"; data: string };

function encodeValue(value: unknown): Entry {
  if (typeof value === "function") {
    return { kind: "src", data: value.toString() };
  }
  if (typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`unsupported value type: ${typeof value}`);
  }
  if (jsc !== null) {
    try {
      const bytes = jsc.serialize(value);
      return { kind: "bin", data: Buffer.from(bytes).toString("base64") };
    } catch (error) {
      // Fall through to JSON for values structured clone cannot carry.
      try {
        return { kind: "bin", data: Buffer.from(JSON.stringify(value)).toString("base64") };
      } catch {
        throw new Error(`unserializable value: ${(error as Error).message}`);
      }
    }
  }
  return { kind: "bin", data: Buffer.from(JSON.stringify(value)).toString("base64") };
}

function decodeValue(entry: Entry): unknown {
  if (entry.kind === "src") {
    // Best-effort revival of a plain function/class definition from its source.
    // eslint-disable-next-line no-eval
    return (0, eval)(`(${entry.data})`);
  }
  const bytes = Buffer.from(entry.data, "base64");
  if (jsc !== null) {
    try {
      return jsc.deserialize(new Uint8Array(bytes));
    } catch {
      return JSON.parse(bytes.toString("utf8"));
    }
  }
  return JSON.parse(bytes.toString("utf8"));
}

function entryBytes(entry: Entry): number {
  return entry.kind === "src" ? Buffer.byteLength(entry.data, "utf8") : Buffer.from(entry.data, "base64").length;
}

function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

/** Serialize the namespace to `path`, honoring the request's byte caps. */
export function saveSnapshot(
  namespace: Namespace,
  path: string,
  manifestPath: string,
  maxBytes: number = DEFAULT_SNAPSHOT_MAX_BYTES,
  maxVariableBytes: number = DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
  pruneOversized = false,
): SnapshotOutcome {
  const saved: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const pruned: string[] = [];
  const entries: Record<string, Entry> = {};
  let total = 0;

  for (const [name, value] of namespace.entries()) {
    let entry: Entry;
    try {
      entry = encodeValue(value);
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message });
      continue;
    }
    const size = entryBytes(entry);
    if (size > maxVariableBytes) {
      skipped.push({ name, reason: `exceeds the per-variable cap of ${maxVariableBytes} bytes` });
      if (pruneOversized) {
        namespace.deleteName(name);
        pruned.push(name);
      }
      continue;
    }
    if (total + size > maxBytes) {
      skipped.push({ name, reason: `would exceed the aggregate cap of ${maxBytes} bytes` });
      continue;
    }
    entries[name] = entry;
    saved.push(name);
    total += size;
  }

  const payload = SNAPSHOT_MAGIC + JSON.stringify({ version: 1, runtime: "bun", entries });
  atomicWrite(path, payload);
  const bytes = Buffer.byteLength(payload, "utf8");
  const manifest = {
    version: 1,
    runtime: "bun",
    savedNames: saved,
    skipped,
    pruned,
    bytes,
    timestamp: new Date().toISOString(),
  };
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  return { saved, skipped, pruned, bytes };
}

/** Revive a snapshot into the namespace; per-name failures never abort the restore. */
export function restoreSnapshot(namespace: Namespace, path: string): RestoreOutcome {
  if (!existsSync(path) || statSync(path).size === 0) {
    return { restored: [], failed: [], reason: "snapshot not found" };
  }
  const raw = readFileSync(path, "utf8");
  if (!raw.startsWith(SNAPSHOT_MAGIC)) {
    return { restored: [], failed: [], reason: "unrecognized snapshot format" };
  }
  let parsed: { entries?: Record<string, Entry> };
  try {
    parsed = JSON.parse(raw.slice(SNAPSHOT_MAGIC.length));
  } catch (error) {
    return { restored: [], failed: [], reason: `corrupt snapshot: ${(error as Error).message}` };
  }
  const restored: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const [name, entry] of Object.entries(parsed.entries ?? {})) {
    if (name.startsWith("_") || RESTORE_SKIP.has(name)) {
      continue;
    }
    try {
      const value = decodeValue(entry);
      (globalThis as Record<string, unknown>)[name] = value;
      namespace.registry.add(name);
      restored.push(name);
    } catch (error) {
      failed.push({ name, reason: (error as Error).message });
    }
  }
  return { restored: restored.sort(), failed };
}
