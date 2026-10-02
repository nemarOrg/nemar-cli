/**
 * The transform stays pure (epic #1586, phase 1).
 *
 * `shared/neurobagel/` is claimed to run unchanged in the Cloudflare Worker and in
 * Bun scripts: no I/O, no Node or Bun API, no wasm, no clock, no randomness, no
 * dynamic code.
 * Two guards hold that claim, and neither depends on a reviewer remembering it:
 *   1. `backend/tsconfig.json` includes `../shared/neurobagel/**` so `bun run typecheck`
 *      (the lint job and the deploy gate) compiles it against the Worker's types,
 *      where `node:` modules, `process`, `Buffer` and `Bun` do not exist;
 *   2. this test reads every source file with the TypeScript parser and rejects what the
 *      type check cannot see: `eval`, `new Function`, dynamic `import()`, `Date`,
 *      `Math.random`, network and timer calls, and any import outside this directory,
 *      the contract and zod.
 * The scanner is itself tested on sources that break each rule, so a rule that stops
 * matching fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DIR = join(import.meta.dir, "../shared/neurobagel");

/** Identifiers that mean I/O, a clock, randomness, a Node or Bun API, or dynamic code. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "Bun",
  "process",
  "Buffer",
  "require",
  "module",
  "__dirname",
  "__filename",
  "eval",
  "Function",
  "Date",
  "performance",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "WebAssembly",
]);

function allowedSpecifier(specifier: string): boolean {
  if (specifier === "zod") return true;
  if (specifier.startsWith("./")) return true;
  // The data plane's contract, which is itself zod and constants only.
  return specifier === "../contract/dataset.js";
}

/** Everything in `source` that breaks the purity rules, as readable strings. */
function purityViolations(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowedSpecifier(node.moduleSpecifier.text)
    ) {
      found.push(`import of "${node.moduleSpecifier.text}"`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push("dynamic import()");
    }
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      // `Math.random` is caught below; an identifier used as a property NAME (x.process) is not a use.
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && parent.propertyName === node);
      if (!isPropertyName) found.push(`use of ${node.text}`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    ) {
      found.push("use of Math.random");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "crypto" &&
      node.name.text !== "subtle"
    ) {
      found.push(`use of crypto.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("shared/neurobagel is pure", () => {
  const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  test("the directory has the transform's sources (the scan is not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(8);
    expect(sources).toContain("transform.ts");
  });

  for (const name of sources) {
    test(`${name}: no I/O, Node or Bun API, clock, randomness or dynamic code, and imports stay inside the allowed set`, () => {
      expect(purityViolations(readFileSync(join(DIR, name), "utf8"))).toEqual([]);
    });
  }

  test("backend/tsconfig.json compiles the directory against the Worker's types", () => {
    const config = readFileSync(join(import.meta.dir, "../backend/tsconfig.json"), "utf8");
    expect(config).toContain("../shared/neurobagel/**/*.ts");
  });
});

describe("the purity scanner rejects what it is meant to reject", () => {
  const cases: [string, string, string][] = [
    ["a node: import", 'import { readFileSync } from "node:fs";', 'import of "node:fs"'],
    ["a bare Node import", 'import fs from "fs";', 'import of "fs"'],
    ["a re-export from outside", 'export * from "../../scripts/x";', 'import of "../../scripts/x"'],
    ["a third-party import", 'import x from "ajv";', 'import of "ajv"'],
    ["the Bun global", "const f = Bun.file('x');", "use of Bun"],
    ["process", "const e = process.env.HOME;", "use of process"],
    ["Buffer", "const b = Buffer.from('x');", "use of Buffer"],
    ["require", "const x = require('x');", "use of require"],
    ["eval", "eval('1');", "use of eval"],
    ["new Function", "new Function('return 1');", "use of Function"],
    ["a dynamic import", "await import('x');", "dynamic import()"],
    ["Date", "const t = Date.now();", "use of Date"],
    ["Math.random", "const r = Math.random();", "use of Math.random"],
    ["crypto.randomUUID", "const r = crypto.randomUUID();", "use of crypto.randomUUID"],
    [
      "crypto.getRandomValues",
      "crypto.getRandomValues(new Uint8Array(1));",
      "use of crypto.getRandomValues",
    ],
    ["fetch", "await fetch('https://example.org');", "use of fetch"],
    ["a timer", "setTimeout(() => {}, 1);", "use of setTimeout"],
    ["wasm", "WebAssembly.instantiate(x);", "use of WebAssembly"],
  ];
  for (const [label, source, expected] of cases) {
    test(`rejects ${label}`, () => {
      expect(purityViolations(source)).toContain(expected);
    });
  }

  test("accepts the shapes the module does use", () => {
    const fine = `
      import { z } from "zod";
      import { byCodeUnit } from "./canonical-json";
      import { NO_SESSION_KEY } from "../contract/dataset.js";
      import snapshot from "./vocab/snapshot.json";
      const digest = await crypto.subtle.digest("SHA-1", new Uint8Array(1));
      const x = { process: 1, Date: 2 }; x.process;
    `;
    expect(purityViolations(fine)).toEqual([]);
  });
});
