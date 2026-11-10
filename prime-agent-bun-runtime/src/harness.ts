/**
 * The harness store: durable prompts, memories, skill descriptions, subagent
 * specs, and factory specs, in a local (session) or global (agent-dir) JSON file.
 *
 * State-file layout matches the Python runtime (`schema`, `entries` keyed by
 * kind and id, `refinements`), so a session that switches kernels keeps its
 * harness. Scope resolution honors the same environment contract:
 * `RLM_HARNESS_STATE_DIR`, `RLM_SESSION_DIR` (local), `RLM_GLOBAL_HARNESS_STATE_DIR`
 * (global), `PRIME_AGENT_CODING_AGENT_DIR` (agent dir).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type HarnessKind = "prompt" | "memory" | "skill" | "subagent" | "factory";
export type HarnessScope = "local" | "global";

const KINDS: HarnessKind[] = ["prompt", "memory", "skill", "subagent", "factory"];
const DEFAULT_FILE_NAME = "harness_state.json";
const DEFAULT_HARNESS_DIR_NAME = "harness";

export interface HarnessEntry {
  id: string;
  kind: HarnessKind;
  title: string;
  content: string;
  path: string;
  scope: HarnessScope;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RefinementEvent {
  id: string;
  trigger: string;
  changes: string[];
  evidence: string;
  outcome: string;
  createdAt: string;
}

interface StateDocument {
  schema: number;
  entries: Record<string, Record<string, HarnessEntry>>;
  refinements: RefinementEvent[];
}

function now(): string {
  return new Date().toISOString();
}

function envDir(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  return value === "" ? null : value;
}

function agentDir(): string {
  const raw = envDir("PRIME_AGENT_CODING_AGENT_DIR") ?? envDir("PI_CODING_AGENT_DIR") ?? join(homedir(), ".prime", "agent");
  return resolve(raw);
}

/** Absolute path of one scope's state file, or a thrown instruction when unset. */
export function harnessStateFile(globalScope: boolean, stateDir?: string): string {
  if (stateDir !== undefined && stateDir !== "") {
    return join(resolve(stateDir), DEFAULT_FILE_NAME);
  }
  const explicit = globalScope
    ? envDir("RLM_GLOBAL_HARNESS_STATE_DIR")
    : envDir("RLM_HARNESS_STATE_DIR");
  if (explicit !== null) {
    return join(resolve(explicit), DEFAULT_FILE_NAME);
  }
  if (!globalScope) {
    const sessionDir = envDir("RLM_SESSION_DIR");
    if (sessionDir !== null) {
      return join(resolve(sessionDir), DEFAULT_HARNESS_DIR_NAME, DEFAULT_FILE_NAME);
    }
    throw new Error(
      "Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. " +
        "Use getHarnessState(global_=True) for global state.",
    );
  }
  return join(agentDir(), DEFAULT_HARNESS_DIR_NAME, DEFAULT_FILE_NAME);
}

function refinementsEnabled(): boolean {
  try {
    const document = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return document["harnessRefinements"] !== false;
  } catch {
    return true;
  }
}

function emptyDocument(): StateDocument {
  return { schema: 1, entries: {}, refinements: [] };
}

function readDocument(file: string): StateDocument {
  if (!existsSync(file)) {
    return emptyDocument();
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StateDocument>;
    if (parsed === null || typeof parsed !== "object") {
      return emptyDocument();
    }
    return {
      schema: typeof parsed.schema === "number" ? parsed.schema : 1,
      entries: typeof parsed.entries === "object" && parsed.entries !== null ? parsed.entries : {},
      refinements: Array.isArray(parsed.refinements) ? parsed.refinements : [],
    };
  } catch {
    return emptyDocument();
  }
}

function writeDocument(file: string, document: StateDocument): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(document, null, 2));
  renameSync(temporary, file);
}

function slug(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? fallback : cleaned;
}

function stripScopePrefix(id: string | null, globalScope: boolean): [string | null, boolean] {
  if (typeof id === "string") {
    const match = /^(local|global):(.+)$/.exec(id);
    if (match !== null) {
      return [match[2]!, globalScope || match[1] === "global"];
    }
  }
  return [id, globalScope];
}

/** One scope's harness view. */
export class HarnessState {
  readonly filePath: string | null;
  readonly scope: HarnessScope;
  readonly inMemory: boolean;
  private document: StateDocument;

  constructor(options: { stateDir?: string; global_?: boolean; inMemory?: boolean } = {}) {
    const globalScope = options.global_ === true;
    this.scope = globalScope ? "global" : "local";
    this.inMemory = options.inMemory === true;
    if (this.inMemory) {
      this.filePath = null;
    } else {
      this.filePath = harnessStateFile(globalScope, options.stateDir);
    }
    this.document = this.filePath === null ? emptyDocument() : readDocument(this.filePath);
  }

  private kindMap(kind: HarnessKind): Record<string, HarnessEntry> {
    this.document.entries[kind] ??= {};
    return this.document.entries[kind]!;
  }

  private persist(): void {
    if (this.filePath === null) {
      return;
    }
    if (!refinementsEnabled()) {
      throw new Error("Harness refinements are disabled in /settings");
    }
    writeDocument(this.filePath, this.document);
  }

  private resolveScope(global_: boolean): { state: HarnessState; global: boolean } {
    if (global_ && !this.scopeIsGlobal()) {
      return { state: getHarnessState({ global_: true }), global: true };
    }
    return { state: this, global: this.scopeIsGlobal() };
  }

  private scopeIsGlobal(): boolean {
    return this.scope === "global";
  }

  upsert(
    kind: HarnessKind,
    title: string,
    content: string,
    options: {
      id?: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments_?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
      global_?: boolean;
    } = {},
  ): HarnessEntry {
    const [stripped, global] = stripScopePrefix(options.id ?? null, options.global_ === true);
    const target = this.resolveScope(global).state;
    const id = stripped ?? slug(title, `${kind}-${Date.now()}`);
    const records = target.kindMap(kind);
    const existing = records[id];
    const entry: HarnessEntry = {
      id,
      kind,
      title,
      content,
      path: options.path ?? "general",
      scope: target.scope,
      reference: options.reference ?? {},
      arguments: options.arguments_ ?? {},
      metadata: options.metadata ?? {},
      source: options.source ?? "agent",
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      version: (existing?.version ?? 0) + 1,
    };
    records[id] = entry;
    target.persist();
    return entry;
  }

  create(
    kind: HarnessKind,
    title: string,
    content: string,
    options: {
      id?: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments_?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
      global_?: boolean;
    } = {},
  ): HarnessEntry {
    return this.upsert(kind, title, content, options);
  }

  update(
    kind: HarnessKind,
    id: string,
    patch: { title?: string; content?: string; path?: string; metadata?: Record<string, unknown> },
    options: { global_?: boolean } = {},
  ): HarnessEntry {
    const [stripped, global] = stripScopePrefix(id, options.global_ === true);
    const target = this.resolveScope(global).state;
    const records = target.kindMap(kind);
    const existing = stripped === null ? undefined : records[stripped];
    if (existing === undefined) {
      throw new Error(`${kind} ${id} not found`);
    }
    if (patch.title !== undefined) {
      existing.title = patch.title;
    }
    if (patch.content !== undefined) {
      existing.content = patch.content;
    }
    if (patch.path !== undefined) {
      existing.path = patch.path;
    }
    if (patch.metadata !== undefined) {
      existing.metadata = patch.metadata;
    }
    existing.updatedAt = now();
    existing.version += 1;
    target.persist();
    return existing;
  }

  get(kind: HarnessKind, id: string, options: { global_?: boolean } = {}): HarnessEntry | null {
    const [stripped, global] = stripScopePrefix(id, options.global_ === true);
    const target = this.resolveScope(global).state;
    return stripped === null ? null : (target.kindMap(kind)[stripped] ?? null);
  }

  delete(kind: HarnessKind, id: string, options: { global_?: boolean } = {}): boolean {
    const [stripped, global] = stripScopePrefix(id, options.global_ === true);
    const target = this.resolveScope(global).state;
    if (stripped === null) {
      return false;
    }
    const records = target.kindMap(kind);
    const existed = records[stripped] !== undefined;
    delete records[stripped];
    target.persist();
    return existed;
  }

  list(kind?: HarnessKind, options: { global_?: boolean } = {}): HarnessEntry[] {
    const target = this.resolveScope(options.global_ === true).state;
    const kinds = kind === undefined ? KINDS : [kind];
    const out: HarnessEntry[] = [];
    for (const current of kinds) {
      for (const entry of Object.values(target.kindMap(current))) {
        out.push(entry);
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** `create_memory({ title, content })` or `create_memory(title, content)` (Python shape). */
  private createKind(kind: HarnessKind) {
    return (
      titleOrOptions: string | Record<string, unknown>,
      content?: string,
      options: Parameters<HarnessState["upsert"]>[2] = {},
    ) => {
      const input =
        typeof titleOrOptions === "string"
          ? { ...options, title: titleOrOptions, content: content ?? "" }
          : (titleOrOptions as Record<string, unknown>);
      const title = input.title;
      if (typeof title !== "string" || title === "") {
        throw new TypeError("title must be a non-empty string");
      }
      const body = typeof input.content === "string" ? input.content : "";
      return this.create(kind, title, body, input as Parameters<HarnessState["upsert"]>[2]);
    };
  }

  /** `update_memory({ id, title?, content? })` or `update_memory(id, patch, options)`. */
  private updateKind(kind: HarnessKind) {
    return (
      idOrOptions: string | Record<string, unknown>,
      patch: { title?: string; content?: string; path?: string; metadata?: Record<string, unknown> } = {},
      options: { global_?: boolean } = {},
    ) => {
      const input =
        typeof idOrOptions === "string" ? { ...patch, ...options, id: idOrOptions } : idOrOptions;
      const id = input.id;
      if (typeof id !== "string" || id === "") {
        throw new TypeError("id must be a non-empty string");
      }
      return this.update(kind, id, input, input as { global_?: boolean });
    };
  }

  private deleteKind(kind: HarnessKind) {
    return (id: string, options: { global_?: boolean } = {}) => this.delete(kind, id, options);
  }

  create_memory = this.createKind("memory");
  update_memory = this.updateKind("memory");
  delete_memory = this.deleteKind("memory");
  create_prompt_note = this.createKind("prompt");
  update_prompt_note = this.updateKind("prompt");
  delete_prompt_note = this.deleteKind("prompt");
  create_skill = this.createKind("skill");
  update_skill = this.updateKind("skill");
  delete_skill = this.deleteKind("skill");
  create_subagent = this.createKind("subagent");
  update_subagent = this.updateKind("subagent");
  delete_subagent = this.deleteKind("subagent");
  create_factory = this.createKind("factory");
  update_factory = this.updateKind("factory");
  delete_factory = this.deleteKind("factory");

  recordRefinement(event: {
    trigger: string;
    changes: string[];
    evidence?: string;
    outcome?: string;
  }): RefinementEvent {
    const record: RefinementEvent = {
      id: `refinement-${Date.now()}`,
      trigger: event.trigger,
      changes: event.changes,
      evidence: event.evidence ?? "",
      outcome: event.outcome ?? "",
      createdAt: now(),
    };
    this.document.refinements.push(record);
    this.persist();
    return record;
  }

  overview(options: { maxEntriesPerKind?: number; global_?: boolean } = {}): string {
    const limit = options.maxEntriesPerKind ?? 20;
    const lines: string[] = [];
    for (const kind of KINDS) {
      const entries = this.list(kind).slice(0, limit);
      lines.push(`${kind} (${entries.length}):`);
      for (const entry of entries) {
        lines.push(`  [${entry.scope}:${entry.id}] ${entry.title}`);
      }
    }
    return lines.join("\n");
  }
}

const cache = new Map<string, HarnessState>();

/** Resolve the harness view for one scope; throws when a local store is unconfigured. */
export function getHarnessState(options: { stateDir?: string; global_?: boolean } = {}): HarnessState {
  const key = `${options.stateDir ?? ""}|${options.global_ === true ? "global" : "local"}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const state = new HarnessState(options);
  cache.set(key, state);
  return state;
}

/** Test helper: drop the memoized views so a fresh state dir is picked up. */
export function resetHarnessCache(): void {
  cache.clear();
}

/** Whether the state file exists (manifest-free liveness check). */
export function harnessFileExists(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}
