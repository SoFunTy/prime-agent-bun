/**
 * Executable skill loading.
 *
 * The Python runtime pre-imports each Python skill package into the cell
 * namespace. The Bun runtime does the same for JavaScript skill packages: a
 * skill directory declaring
 *
 * ```json
 * { "primeAgent": { "javascript": { "global": "edit", "entry": "index.ts" } } }
 * ```
 *
 * exports a factory that receives the kernel context and returns the value bound
 * to the global name. A skill directory with no JavaScript entry is silently
 * skipped (it is a Python-only or markdown-only skill), so both runtimes can
 * share one `skills/` tree.
 *
 * A failing import is reported through the same stdout marker the Python
 * runtime uses, so the host's existing "unavailable skills" notice — and the
 * model's prompt — need no new channel.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Json } from "./protocol.ts";
import type { BashHandle } from "./bash.ts";
import type { BashRegistry } from "./bash.ts";
import type { HarnessState } from "./harness.ts";

/** Line the bootstrap prints when one or more skills failed to import. */
export const SKILL_IMPORT_ERROR_MARKER = "__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__";

/** What a skill factory receives. */
export interface SkillContext {
  /** Typed host-bridge request (`rlm.host_request`). */
  hostRequest: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Ship one display event. */
  emit: (data: { [mime: string]: Json }) => void;
  /** Start a shell command. */
  bash: (command: string, persistent?: boolean) => BashHandle;
  /** The session's harness store. */
  harness: HarnessState;
  /** The `rlm` object. */
  rlm: Record<string, unknown>;
  /** The kernel's working directory. */
  cwd: string;
}

/** One skill the host asked the runtime to prepare. */
export interface SkillSpec {
  name: string;
  dir: string;
}

interface PackageMetadata {
  primeAgent?: {
    javascript?: {
      global?: string;
      entry?: string;
    };
  };
}

/** The JavaScript entry for a skill directory, or `null` when it has none. */
export function resolveSkillEntry(dir: string): string | null {
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageMetadata;
      const entry = manifest.primeAgent?.javascript?.entry;
      if (typeof entry === "string" && entry !== "") {
        const candidate = join(dir, entry);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // A malformed manifest falls through to the conventional entry names.
    }
  }
  for (const candidate of ["index.ts", "index.js", "index.mjs"]) {
    const path = join(dir, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/** The global name a skill binds, from its manifest or its directory name. */
export function resolveSkillGlobal(dir: string, fallback: string): string {
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageMetadata;
      const name = manifest.primeAgent?.javascript?.global;
      if (typeof name === "string" && name !== "") {
        return name;
      }
    } catch {
      // fall through
    }
  }
  return fallback;
}

/**
 * Import every skill that has a JavaScript entry.
 *
 * Returns the names that failed, keyed by skill name. Prints the shared
 * import-error marker once when at least one failed, so the host reports them
 * the same way it reports failed Python skill imports.
 */
export async function loadSkills(specs: SkillSpec[], context: SkillContext): Promise<Record<string, string>> {
  const failures: Record<string, string> = {};
  for (const spec of specs) {
    const dir = resolve(spec.dir);
    const entry = resolveSkillEntry(dir);
    if (entry === null) {
      continue;
    }
    const globalName = resolveSkillGlobal(dir, spec.name);
    try {
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
        create?: unknown;
      };
      const factory = module.default ?? module.create ?? module;
      const value =
        typeof factory === "function"
          ? await (factory as (ctx: SkillContext) => unknown)(context)
          : factory;
      if (value === undefined || value === null) {
        throw new Error("the skill module exported nothing");
      }
      (globalThis as Record<string, unknown>)[globalName] = value;
    } catch (error) {
      const text = error instanceof Error ? (error.message || error.name) : String(error);
      failures[spec.name] = text;
      (globalThis as Record<string, unknown>)[globalName] = unavailableSkill(globalName, text);
    }
  }
  if (Object.keys(failures).length > 0) {
    console.log(SKILL_IMPORT_ERROR_MARKER + JSON.stringify(failures));
  }
  return failures;
}

/** The stand-in bound for a skill whose module failed to import. */
function unavailableSkill(name: string, error: string): Record<string, unknown> {
  const raise = (): never => {
    throw new Error(`Skill ${name} is unavailable in this kernel. Import error: ${error}`);
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, property) => (property === "toString" ? () => `<unavailable skill ${name}>` : raise),
    apply: raise,
  };
  return new Proxy(Object.assign(raise, { __unavailable: name, __import_error: error }), handler);
}

/** Build a skill context from the running kernel's surfaces. */
export function createSkillContext(input: {
  registry: BashRegistry;
  hostRequest: SkillContext["hostRequest"];
  emit: SkillContext["emit"];
  bash: SkillContext["bash"];
  harness: HarnessState;
  rlm: Record<string, unknown>;
  cwd: string;
}): SkillContext {
  return {
    hostRequest: input.hostRequest,
    emit: input.emit,
    bash: input.bash,
    harness: input.harness,
    rlm: input.rlm,
    cwd: input.cwd,
  };
}
