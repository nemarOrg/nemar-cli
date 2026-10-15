/**
 * Keeps the string "undefined" out of `process.env`.
 *
 * CI TIER: unit-pure. Real filesystem, no mocks, no network, and this file deliberately never
 * names the live-tier tokens that `.github/workflows/test.yml` greps for: a file that does moves
 * to the integration tier.
 *
 * In Bun, `process.env.X = undefined` does NOT unset the variable: it stores the nine-character
 * STRING "undefined". `bun test` runs every file in one process, so a test that "restores" an
 * originally-unset variable that way pollutes every later file: `NEMAR_CONFIG_DIR="undefined"`
 * makes the CLI write under a literal `./undefined/` directory in the repository, and
 * `PATH="undefined"` stops every later spawn of `git` or `git-annex` from resolving.
 *
 * The accepted restore for an originally-unset variable is
 * `Reflect.deleteProperty(process.env, "X")` (Biome's `noDelete` flags the `delete` operator);
 * for an originally-set one, assign the saved string back.
 *
 * Not flagged, on purpose: an `env: { X: undefined }` option or a local object copy
 * (`const env = { ...process.env }; env.X = undefined`). Those are plain objects, not
 * `process.env`, and the spawn layer drops an undefined value rather than stringifying it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCANNED_ROOTS = ["test", "backend/test", "src", "backend/src", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

const UNSET = "(?:undefined|void\\s+0)";
const ENV_OBJECT = "(?:process|Bun)\\.env";
/** `process.env.X = undefined`, `process.env["X"] = undefined`, `process.env[name] = undefined`. */
const DIRECT_ASSIGNMENT = new RegExp(
  `${ENV_OBJECT}(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]\\n]+\\])\\s*(?:\\?\\?|\\|\\|)?=(?!=)\\s*${UNSET}(?![\\w$])`,
  "g",
);
/** `Object.assign(process.env, { X: undefined })`, on one line or spread over several. */
const OBJECT_ASSIGN = new RegExp(
  `Object\\.assign\\(\\s*${ENV_OBJECT}\\s*,[^)]*?:\\s*${UNSET}(?![\\w$])`,
  "g",
);

type EnvUndefinedHit = { line: number; text: string };

/** Every place `source` writes undefined into `process.env`, as 1-based lines. */
function findEnvUndefinedWrites(source: string): EnvUndefinedHit[] {
  const lines = source.split("\n");
  const hits = new Map<number, string>();
  for (const pattern of [DIRECT_ASSIGNMENT, OBJECT_ASSIGN]) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      const text = lines[line - 1] ?? "";
      // A comment that explains the hazard names the pattern without executing it.
      if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) continue;
      hits.set(line, text.trim());
    }
  }
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text }));
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...sourceFiles(join(directory, entry.name)));
      }
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

describe("the scanner", () => {
  // Built from parts so this file does not itself contain the pattern it hunts for.
  const UNDEF = "undefined";
  const VOID_ZERO = ["void", "0"].join(" ");

  test("flags every shape of an env write that stores the string", () => {
    const bad = [
      "afterAll(() => {",
      `  process.env.SOME_DIR = ${UNDEF};`,
      `  process.env["OTHER"] = ${UNDEF};`,
      `  process.env[name] = ${UNDEF}`,
      `  Bun.env.THIRD = ${VOID_ZERO};`,
      `  process.env.FOURTH=${UNDEF};`,
      `  Object.assign(process.env, { FIFTH: ${UNDEF} });`,
      "  process.env.SIXTH =",
      `    ${UNDEF};`,
      "});",
    ].join("\n");
    expect(findEnvUndefinedWrites(bad).map((h) => h.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  test("passes the accepted restores and the look-alikes that are not process.env", () => {
    const good = [
      "const saved = process.env.SOME_DIR;",
      `if (saved === ${UNDEF}) Reflect.deleteProperty(process.env, "SOME_DIR");`,
      "else process.env.SOME_DIR = saved;",
      `if (process.env.OTHER === ${UNDEF}) run();`,
      `const same = process.env.OTHER == ${UNDEF};`,
      'const env = { ...process.env, KEPT: "1" };',
      `env.DROPPED = ${UNDEF};`,
      `spawn(cmd, { env: { DROPPED: ${UNDEF} } });`,
      'process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;',
      `// process.env.COMMENTED = ${UNDEF} stores the string`,
      ` * \`process.env.DOCUMENTED = ${UNDEF}\` does not unset anything`,
    ].join("\n");
    expect(findEnvUndefinedWrites(good)).toEqual([]);
  });

  test("reports the offending line number and text", () => {
    const [hit] = findEnvUndefinedWrites(`x();\n  process.env.REPORTED = ${UNDEF};\n`);
    expect(hit).toEqual({ line: 2, text: `process.env.REPORTED = ${UNDEF};` });
  });
});

describe("the repository", () => {
  test("no test, script or source file writes undefined into process.env", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        scanned++;
        for (const hit of findEnvUndefinedWrites(readFileSync(file, "utf8"))) {
          offenders.push(`${relative(REPO_ROOT, file)}:${hit.line}: ${hit.text}`);
        }
      }
    }
    // A scan that read nothing would pass vacuously.
    expect(scanned).toBeGreaterThan(100);
    // Joined so a failure prints file:line for every hit. Restore an originally-unset variable
    // with Reflect.deleteProperty(process.env, "NAME"), or assign the saved string back.
    expect(offenders.join("\n")).toBe("");
  });
});
