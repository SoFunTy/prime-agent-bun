/**
 * Kernel benchmark: the Bun runtime against the Python runtime, same machine,
 * same protocol, same workload.
 *
 * Both runtimes speak REPL protocol v3, so one client drives them identically
 * and only the *language of the cell bodies* differs; every cell is written to
 * do the same work with each runtime's idiomatic form.
 *
 * Usage:
 *   bun run test/bench/kernel-bench.ts                 # both runtimes
 *   bun run test/bench/kernel-bench.ts bun             # one runtime
 *   bun run test/bench/kernel-bench.ts --rounds 5
 *
 * The Python runtime binary comes from `PRIME_BENCH_PYTHON` (default: the
 * kernel venv the Rust provisioner builds beside the agent dir).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME_ENTRY = new URL(
  "../../prime-agent-bun-runtime/src/repl.ts",
  import.meta.url,
).pathname;

interface RuntimeSpec {
  name: string;
  cmd: string[];
  /** The cell the host runs before the first user cell, when the runtime needs one. */
  bootstrap: string | null;
  /** What each measured cell must produce, so a failing cell can never look fast. */
  expect: (cell: string) => { result?: string; stdoutLines?: number; stdoutChars?: number };
  cells: {
    scalar: string;
    empty: string;
    kib1: string;
    kib64: string;
    manyWrites: string;
    bash: string;
    seed: string;
    afterSeed: string;
    collect: string;
  };
}

function pythonBinary(): string {
  if (process.env.PRIME_BENCH_PYTHON) {
    return process.env.PRIME_BENCH_PYTHON;
  }
  const venv = join(process.env.HOME ?? "", ".prime", "agent", "kernel-venv", "bin", "python");
  return venv;
}

function runtimes(): RuntimeSpec[] {
  const python = pythonBinary();
  return [
    {
      name: "bun",
      cmd: ["bun", "run", RUNTIME_ENTRY],
      bootstrap: null, // the runtime installs its own globals at startup
      expect: (cell) => {
        switch (cell) {
          case "scalar":
          case "sequential":
            return { result: "2" };
          case "bash":
            return { result: "hi" };
          case "afterSeed":
            return { result: "39601" };
          case "kib1":
            return { stdoutChars: 1025 };
          case "kib64":
            return { stdoutChars: 65537 };
          case "manyWrites":
            return { stdoutLines: 1000 };
          default:
            return {};
        }
      },
      cells: {
        scalar: "1 + 1",
        empty: "void 0",
        kib1: "console.log('x'.repeat(1024)); ''",
        kib64: "console.log('x'.repeat(65536)); ''",
        manyWrites: "for (let i = 0; i < 1000; i += 1) console.log('l' + i); ''",
        bash: "const r = await bash('echo hi'); r.output.trim()",
        seed: "for (let i = 0; i < 200; i += 1) globalThis['v' + i] = i * i; 'seeded'",
        afterSeed: "v199",
        collect: "Bun.gc(true); 'collected'",
      },
    },
    {
      name: "python",
      cmd: [python, "-m", "rlm.repl"],
      // The host runs this before the first cell; without it `rlm`/`bash` are
      // undefined and every measured cell fails in microseconds.
      bootstrap: [
        "import asyncio",
        "import os as _prime_agent_os",
        "_prime_agent_os.environ['NO_COLOR'] = '1'",
        "import rlm as _prime_agent_rlm_module",
        "rlm = _prime_agent_rlm_module.rlm",
        "bash = _prime_agent_rlm_module.bash",
        "import rlm.mcp as mcp",
        "'bootstrapped'",
      ].join("\n"),
      expect: (cell) => {
        switch (cell) {
          case "scalar":
          case "sequential":
            return { result: "2" };
          case "bash":
            return { result: "hi" };
          case "afterSeed":
            return { result: "39601" };
          case "kib1":
            return { stdoutChars: 1025 };
          case "kib64":
            return { stdoutChars: 65537 };
          case "manyWrites":
            return { stdoutLines: 1000 };
          default:
            return {};
        }
      },
      cells: {
        scalar: "1 + 1",
        empty: "pass",
        kib1: "print('x' * 1024)",
        kib64: "print('x' * 65536)",
        manyWrites: "for i in range(1000): print('l%d' % i)",
        bash: "(await bash('echo hi')).output.strip()",
        seed: "for _i in range(200): globals()['v%d' % _i] = _i * _i\n'seeded'",
        afterSeed: "v199",
        collect: "import gc; gc.collect(); 'collected'",
      },
    },
  ];
}

interface Frame {
  event: string;
  id?: string | null;
  status?: string;
  text?: string;
  [key: string]: unknown;
}

class Client {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private frames: Frame[] = [];
  private waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private buffer = "";

  constructor(cmd: string[], env: Record<string, string> = {}) {
    this.proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line !== "") {
          this.accept(JSON.parse(line) as Frame);
        }
        index = this.buffer.indexOf("\n");
      }
    }
  }

  private accept(frame: Frame): void {
    this.frames.push(frame);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(frame);
    }
  }

  send(request: Record<string, unknown>): void {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(request) + "\n");
    void stdin.flush();
  }

  next(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error("bench timeout"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async ready(): Promise<number> {
    const started = performance.now();
    await this.next((frame) => frame.event === "ready");
    return performance.now() - started;
  }

  async cell(id: string, code: string): Promise<number> {
    const started = performance.now();
    this.send({ type: "execute", id, code });
    await this.next((frame) => frame.event === "done" && frame.id === id);
    return performance.now() - started;
  }

  /** The `result` text of one settled cell (both runtimes render a string value). */
  resultOf(id: string): string | null {
    const frame = this.frames.find((entry) => entry.event === "result" && entry.id === id);
    return typeof frame?.text === "string" ? frame.text : null;
  }

  /** Everything the cell wrote to stdout. */
  stdoutOf(id: string): string {
    return this.frames
      .filter((frame) => frame.event === "stdout" && frame.id === id)
      .map((frame) => frame.text ?? "")
      .join("");
  }

  /** Bootstrap the runtime, then assert it is usable. */
  async bootstrap(code: string | null): Promise<void> {
    if (code === null) {
      return;
    }
    await this.cell("__bootstrap", code);
    const error = this.frames.find((frame) => frame.event === "error" && frame.id === "__bootstrap");
    if (error) {
      throw new Error(`bootstrap failed: ${String(error.ename)}: ${String(error.evalue)}`);
    }
  }

  /** Run one measured cell and assert it did the work it was asked to do. */
  async checkedCell(
    id: string,
    cell: string,
    code: string,
    expect: (cell: string) => { result?: string; stdoutLines?: number; stdoutChars?: number },
  ): Promise<number> {
    const ms = await this.cell(id, code);
    const error = this.frames.find((frame) => frame.event === "error" && frame.id === id);
    if (error) {
      throw new Error(`cell ${cell} failed: ${String(error.ename)}: ${String(error.evalue)}`);
    }
    const want = expect(cell);
    if (want.result !== undefined) {
      const got = (this.resultOf(id) ?? "").replace(/^["']|["']$/g, "");
      if (got !== want.result) {
        throw new Error(`cell ${cell} result ${JSON.stringify(got)} != ${JSON.stringify(want.result)}`);
      }
    }
    const stdout = this.stdoutOf(id);
    if (want.stdoutChars !== undefined && stdout.length !== want.stdoutChars) {
      throw new Error(`cell ${cell} wrote ${stdout.length} chars, expected ${want.stdoutChars}`);
    }
    if (want.stdoutLines !== undefined) {
      const lines = stdout.split("\n").filter((line) => line !== "").length;
      if (lines !== want.stdoutLines) {
        throw new Error(`cell ${cell} wrote ${lines} lines, expected ${want.stdoutLines}`);
      }
    }
    return ms;
  }

  async snapshot(path: string, manifest: string, id: string): Promise<number> {
    const started = performance.now();
    this.send({ type: "snapshot", id, path, manifest_path: manifest });
    await this.next((frame) => frame.event === "done" && frame.id === id);
    return performance.now() - started;
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  rssKb(): number | null {
    const pid = this.proc.pid;
    if (!pid) {
      return null;
    }
    try {
      const output = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
      const value = Number.parseInt(output.stdout.toString().trim(), 10);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Result {
  name: string;
  ready: number;
  empty: number;
  scalar: number;
  kib1: number;
  kib64: number;
  manyWrites: number;
  bash: number;
  sequential: number;
  snapshot: number;
  rssReadyKb: number | null;
  rssAfterWorkKb: number | null;
  rssSettledKb: number | null;
}

async function measure(spec: RuntimeSpec, rounds: number, sessionRoot: string): Promise<Result> {
  const starts: number[] = [];
  const empties: number[] = [];
  const scalars: number[] = [];
  const kib1s: number[] = [];
  const kib64s: number[] = [];
  const manyWritesSamples: number[] = [];
  const bashSamples: number[] = [];
  const snapshots: number[] = [];
  const rssReady: number[] = [];
  const rssAfterWork: number[] = [];
  const rssSettled: number[] = [];

  for (let round = 0; round < rounds; round += 1) {
    const client = new Client(spec.cmd);
    starts.push(await client.ready());
    const readyRss = client.rssKb();
    if (readyRss !== null) {
      rssReady.push(readyRss);
    }
    await client.bootstrap(spec.bootstrap);

    // Warm-up: the first cell pays compilation/JIT costs its language shares
    // across all later cells, which every real session also pays once.
    await client.checkedCell("warm", "scalar", spec.cells.scalar, spec.expect);

    for (let i = 0; i < 12; i += 1) {
      empties.push(await client.checkedCell(`e${round}-${i}`, "empty", spec.cells.empty, spec.expect));
      scalars.push(await client.checkedCell(`s${round}-${i}`, "scalar", spec.cells.scalar, spec.expect));
    }
    kib1s.push(await client.checkedCell(`k1-${round}`, "kib1", spec.cells.kib1, spec.expect));
    kib64s.push(await client.checkedCell(`k64-${round}`, "kib64", spec.cells.kib64, spec.expect));
    manyWritesSamples.push(
      await client.checkedCell(`mw-${round}`, "manyWrites", spec.cells.manyWrites, spec.expect),
    );
    bashSamples.push(await client.checkedCell(`b-${round}`, "bash", spec.cells.bash, spec.expect));
    // Repeat the payload cells a few times inside the round: one sample per
    // round is too noisy to compare sub-millisecond work.
    for (let i = 0; i < 6; i += 1) {
      kib1s.push(await client.checkedCell(`k1-${round}-${i}`, "kib1", spec.cells.kib1, spec.expect));
      kib64s.push(await client.checkedCell(`k64-${round}-${i}`, "kib64", spec.cells.kib64, spec.expect));
    }

    await client.checkedCell(`seed-${round}`, "seed", spec.cells.seed, spec.expect);
    const dir = join(sessionRoot, `${spec.name}-${round}`);
    snapshots.push(
      await client.snapshot(join(dir, "state.bin"), join(dir, "state.json"), `snap-${round}`),
    );
    await client.checkedCell(`after-${round}`, "afterSeed", spec.cells.afterSeed, spec.expect);

    const afterWork = client.rssKb();
    if (afterWork !== null) {
      rssAfterWork.push(afterWork);
    }
    await client.cell(`collect-${round}`, spec.cells.collect);
    const settled = client.rssKb();
    if (settled !== null) {
      rssSettled.push(settled);
    }
    client.kill();
  }

  // Sequential throughput in one process: 200 scalar cells.
  const sequentialClient = new Client(spec.cmd);
  await sequentialClient.ready();
  await sequentialClient.bootstrap(spec.bootstrap);
  await sequentialClient.checkedCell("warm2", "sequential", spec.cells.scalar, spec.expect);
  const sequentialStart = performance.now();
  for (let i = 0; i < 200; i += 1) {
    await sequentialClient.checkedCell(`seq-${i}`, "sequential", spec.cells.scalar, spec.expect);
  }
  const sequential = (performance.now() - sequentialStart) / 200;
  sequentialClient.kill();

  return {
    name: spec.name,
    ready: round(median(starts)),
    empty: round(median(empties)),
    scalar: round(median(scalars)),
    kib1: round(median(kib1s)),
    kib64: round(median(kib64s)),
    manyWrites: round(median(manyWritesSamples)),
    bash: round(median(bashSamples)),
    sequential: round(sequential),
    snapshot: round(median(snapshots)),
    rssReadyKb: rssReady.length > 0 ? Math.round(median(rssReady)) : null,
    rssAfterWorkKb: rssAfterWork.length > 0 ? Math.round(median(rssAfterWork)) : null,
    rssSettledKb: rssSettled.length > 0 ? Math.round(median(rssSettled)) : null,
  };
}

function table(results: Result[]): void {
  const metrics: Array<[string, (result: Result) => number | null, (value: number | null) => string]> = [
    ["cold start (ms)", (r) => r.ready, (v) => `${v}`],
    ["empty cell (ms)", (r) => r.empty, (v) => `${v}`],
    ["scalar cell (ms)", (r) => r.scalar, (v) => `${v}`],
    ["1 KiB output (ms)", (r) => r.kib1, (v) => `${v}`],
    ["64 KiB output (ms)", (r) => r.kib64, (v) => `${v}`],
    ["1000 writes (ms)", (r) => r.manyWrites, (v) => `${v}`],
    ["bash echo (ms)", (r) => r.bash, (v) => `${v}`],
    ["200 cells / cell (ms)", (r) => r.sequential, (v) => `${v}`],
    ["snapshot 200 vars (ms)", (r) => r.snapshot, (v) => `${v}`],
    ["RSS at ready (MiB)", (r) => (r.rssReadyKb === null ? null : r.rssReadyKb / 1024), (v) => (v === null ? "n/a" : `${Math.round(v * 100) / 100}`)],
    ["RSS after work (MiB)", (r) => (r.rssAfterWorkKb === null ? null : r.rssAfterWorkKb / 1024), (v) => (v === null ? "n/a" : `${Math.round(v * 100) / 100}`)],
    ["RSS after GC (MiB)", (r) => (r.rssSettledKb === null ? null : r.rssSettledKb / 1024), (v) => (v === null ? "n/a" : `${Math.round(v * 100) / 100}`)],
  ];

  const header = ["metric", ...results.map((r) => r.name)];
  const pair = results.length === 2;
  if (pair) {
    header.push("bun vs python");
  }
  const body: string[][] = [];
  for (const [label, read, render] of metrics) {
    const values = results.map(read);
    const cells = [label, ...values.map(render)];
    if (pair) {
      const [bunValue, pythonValue] = values;
      const ratio =
        bunValue === null || pythonValue === null || pythonValue === 0 ? null : bunValue / pythonValue;
      cells.push(ratio === null ? "n/a" : `${ratio <= 1 ? "" : "+"}${Math.round((ratio - 1) * 100)}%`);
    }
    body.push(cells);
  }

  const widths = header.map((_, column) =>
    Math.max(header[column]!.length, ...body.map((row) => row[column]!.length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) {
    console.log(line(row));
  }
  console.log();
  console.log("negative = Bun faster; positive = Bun slower");
}

const args = process.argv.slice(2);
const roundsFlag = args.indexOf("--rounds");
const rounds = roundsFlag >= 0 ? Number.parseInt(args[roundsFlag + 1] ?? "3", 10) : 3;
const only = args.find((arg) => !arg.startsWith("--") && arg !== String(rounds));

const sessionRoot = mkdtempSync(join(tmpdir(), "pa-bench-"));
const specs = runtimes().filter((spec) => {
  if (only !== undefined) {
    return spec.name === only;
  }
  if (spec.name === "python" && !existsSync(spec.cmd[0]!)) {
    console.error(`skipping python: ${spec.cmd[0]} does not exist (set PRIME_BENCH_PYTHON)`);
    return false;
  }
  return true;
});

const results: Result[] = [];
for (const spec of specs) {
  console.error(`measuring ${spec.name} (${rounds} rounds)...`);
  results.push(await measure(spec, rounds, sessionRoot));
}
console.log();
table(results);
rmSync(sessionRoot, { recursive: true, force: true });
