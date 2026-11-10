/**
 * case-21: module loading inside a cell.
 *
 * A cell body is an async function body, so a static `import` declaration is a
 * syntax error there and `require` is not in scope. Both spellings are what
 * JavaScript users reach for first — a real session was observed flailing on
 * exactly this — so the runtime rewrites static imports and exposes `require`.
 *
 * Pins every form: side-effect, default, namespace, named, aliased, TS-only, a
 * relative file import, the dynamic import, and Node-style `require`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelClient, assertEqual, runCase } from "../lib/kernel-client.ts";

await runCase("case-21 module loading in cells", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-bun-case21-"));
  try {
    writeFileSync(
      join(root, "mod.ts"),
      "export const hello = 'from-module';\nexport default { tag: 'default-module' };\n",
    );

    const kernel = KernelClient.start();
    await kernel.next((frame) => frame.event === "ready");

    // Node-style require.
    const required = await kernel.execute(
      "m1",
      "const fs = require('node:fs');\nconst path = require('node:path');\n[typeof fs.readFileSync, path.join('a', 'b')].join('|')",
    );
    const requiredResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m1");
    assertEqual(required.status, "ok", "require works inside a cell");
    assertEqual(requiredResult?.text, '"function|a/b"', "require returns the real module");

    // Static import forms.
    const imported = await kernel.execute(
      "m2",
      [
        "import { writeFileSync } from 'node:fs';",
        "import os from 'node:os';",
        "import * as nodePath from 'node:path';",
        "import 'node:assert';",
        "import type { Stats } from 'node:fs';",
        "const stats: Stats | null = null;",
        "[typeof writeFileSync, typeof os.tmpdir, nodePath.join('x', 'y'), String(stats)].join('|')",
      ].join("\n"),
    );
    const importedResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m2");
    assertEqual(imported.status, "ok", "every static import form is rewritten and runs");
    assertEqual(
      importedResult?.text,
      '"function|function|x/y|null"',
      "the imported bindings are usable",
    );

    // Aliased named import.
    const aliased = await kernel.execute(
      "m3",
      "import { writeFileSync as write } from 'node:fs';\ntypeof write",
    );
    const aliasedResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m3");
    assertEqual(aliased.status, "ok", "an aliased import is rewritten");
    assertEqual(aliasedResult?.text, '"function"', "the alias is bound");

    // Relative file import + dynamic import.
    const relative = await kernel.execute(
      "m4",
      [
        `import { hello } from ${JSON.stringify(join(root, "mod.ts"))};`,
        `const mod = await import(${JSON.stringify(join(root, "mod.ts"))});`,
        "[hello, mod.default.tag].join('|')",
      ].join("\n"),
    );
    const relativeResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m4");
    assertEqual(relative.status, "ok", "a relative file import works");
    assertEqual(relativeResult?.text, '"from-module|default-module"', "both named and dynamic forms resolve");

    // The lazy-transpiler fast path must not miss a TypeScript signal: a cell
    // whose only TypeScript is a type-only import, and one whose only TypeScript
    // is a type assertion.
    const typeOnlyImport = await kernel.execute(
      "m5",
      "import type { Stats } from 'node:fs';\n'type-only-import-ok'",
    );
    const typeOnlyResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m5");
    assertEqual(typeOnlyImport.status, "ok", "a type-only import alone still runs");
    assertEqual(typeOnlyResult?.text, '"type-only-import-ok"', "the statement after it runs");

    const assertion = await kernel.execute(
      "m6",
      "const source: unknown = { n: 7 };\nconst typed = source as { n: number };\ntyped.n",
    );
    const assertionResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m6");
    assertEqual(assertion.status, "ok", "a type assertion alone still runs");
    assertEqual(assertionResult?.text, "7", "the asserted value reads back");

    const plainJs = await kernel.execute("m7", "const plain = [1, 2, 3].length;\nplain");
    const plainResult = kernel.received().find((frame) => frame.event === "result" && frame.id === "m7");
    assertEqual(plainJs.status, "ok", "plain JavaScript still runs");
    assertEqual(plainResult?.text, "3", "plain JavaScript keeps its result");

    await kernel.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
