// Bun kernel skill. The factory receives the kernel context and returns the
// value bound to the skill's global name. See
// prime-agent-bun-runtime/KERNEL-API.md for the contract.
const DIFF_MIME = "application/vnd.prime-agent.diff+json";

interface EditOptions {
  path: string;
  old_str?: string;
  oldStr?: string;
  new_str?: string;
  newStr?: string;
}

export default function createSkill(ctx: {
  emit(data: Record<string, unknown>): void;
  cwd: string;
}) {
  const run = async (options: EditOptions): Promise<string> => {
    const path = options?.path;
    const oldStr = options.old_str ?? options.oldStr;
    const newStr = options.new_str ?? options.newStr;
    if (typeof path !== "string" || path === "") {
      throw new TypeError("path must be a non-empty string");
    }
    if (typeof oldStr !== "string") {
      throw new TypeError("old_str must be a string");
    }
    if (typeof newStr !== "string") {
      throw new TypeError("new_str must be a string");
    }
    const resolved = path.startsWith("~")
      ? path.replace(/^~(?=[/]|$)/, process.env.HOME ?? "")
      : path;
    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${resolved}`);
    }
    const original = await file.text();
    const first = original.indexOf(oldStr);
    if (first < 0) {
      throw new Error(`old_str not found in ${resolved}`);
    }
    if (original.indexOf(oldStr, first + 1) >= 0) {
      throw new Error(`old_str appears more than once in ${resolved}; widen the snippet to make it unique`);
    }
    await Bun.write(resolved, original.slice(0, first) + newStr + original.slice(first + oldStr.length));
    const startLine = original.slice(0, first).split("\n").length;
    try {
      ctx.emit({ [DIFF_MIME]: { path, old_str: oldStr, new_str: newStr, start_line: startLine }, "text/plain": `Edited ${path}` });
    } catch {
      // display is best-effort
    }
    return `Edited ${resolved}`;
  };
  const callable = (options: EditOptions) => run(options);
  callable.run = run;
  return callable;
}
