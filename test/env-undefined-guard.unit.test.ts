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
 * HOW IT SCANS. Each file is first reduced to its code: comments, string contents, template
 * literal text and regular expression bodies are blanked (newlines kept, so line numbers hold),
 * then the code is searched for a write to the environment object. A line inside a multi-line
 * template literal, a fixture script a test writes to disk, a trailing `// ...` comment and a
 * string such as "process.env.X = undefined" therefore never flag. What it flags, however the
 * object is reached (`process.env`, `Bun.env`, `import.meta.env`, `globalThis.process.env`, a
 * `process . env` spaced out, `process["env"]`, or a local alias such as `const e = process.env`,
 * `const { env } = process` or `import { env } from "bun"`):
 *   - an assignment (`=`, `??=`, `||=`, `&&=`, with a trailing `!` allowed on the target) to a
 *     member, bracket or nested-bracket key whose right-hand side is `undefined` or `void 0`;
 *   - `Reflect.set(<env>, key, undefined)`;
 *   - `Object.assign(<env>, ...)` where any object literal source, anywhere in the argument list
 *     and however long, gives a property the value `undefined`.
 *
 * NOT FLAGGED, on purpose: an `env: { X: undefined }` option or a local object copy
 * (`const env = { ...process.env }; env.X = undefined`). Those are plain objects, not
 * `process.env`, and the spawn layer drops an undefined value rather than stringifying it.
 *
 * RESIDUAL GAPS, stated so nobody assumes more than is checked: the scan is text-level, not a
 * type-aware analysis. It cannot see `Object.defineProperty(process.env, "X", { value: undefined })`,
 * an env object passed through a function parameter or returned from a call, `(process as any).env`,
 * an alias of `process` itself (`const p = process; p.env.X = undefined`), or a name that is an
 * alias in one function and a plain object in another within the same file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCANNED_ROOTS = ["test", "backend/test", "src", "backend/src", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

type EnvUndefinedHit = { line: number; text: string };

// ---------------------------------------------------------------------------------------------
// Step 1: reduce a source file to its code.
// ---------------------------------------------------------------------------------------------

/** After one of these a `/` starts a regular expression; after anything else word-like it divides. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);
const WORD_CHAR = /[\w$]/;

/**
 * `source` with comments, string contents, template-literal text and regular-expression bodies
 * replaced by spaces. Newlines and every other character keep their offsets, so a match in the
 * result has the same line number in the original. `${ ... }` inside a template is code and is
 * kept. Two string contents survive on purpose: the bare word `env` (so `process["env"]` can be
 * read) and a module specifier after `from` (so `import { env } from "bun"` can be read); neither
 * can spell an assignment.
 */
function blankNonCode(source: string): string {
  const out: string[] = [];
  const length = source.length;
  // A frame per open template literal (`template`) or per `${` inside one (`code`, counting braces).
  const stack: Array<{ kind: "template" } | { kind: "code"; depth: number }> = [];
  const blank = (char: string) => out.push(char === "\n" ? "\n" : " ");
  const previousToken = () => {
    let at = out.length - 1;
    while (at >= 0 && /\s/.test(out[at])) at--;
    if (at < 0) return { char: "", word: "" };
    const char = out[at];
    if (!WORD_CHAR.test(char)) return { char, word: "" };
    let start = at;
    while (start > 0 && WORD_CHAR.test(out[start - 1])) start--;
    return { char, word: out.slice(start, at + 1).join("") };
  };

  let i = 0;
  while (i < length) {
    const top = stack[stack.length - 1];
    const char = source[i];

    if (top?.kind === "template") {
      if (char === "\\") {
        blank(char);
        if (i + 1 < length) blank(source[i + 1]);
        i += 2;
      } else if (char === "`") {
        out.push("`");
        stack.pop();
        i++;
      } else if (char === "$" && source[i + 1] === "{") {
        out.push("$", "{");
        stack.push({ kind: "code", depth: 0 });
        i += 2;
      } else {
        blank(char);
        i++;
      }
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      while (i < length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close < 0 ? length : close + 2;
      for (; i < stop; i++) blank(source[i]);
      continue;
    }
    if (char === '"' || char === "'") {
      const { word } = previousToken();
      out.push(char);
      i++;
      const start = i;
      while (i < length && source[i] !== char && source[i] !== "\n")
        i += source[i] === "\\" ? 2 : 1;
      const content = source.slice(start, Math.min(i, length));
      const keep = content === "env" || word === "from";
      for (const c of content) {
        if (keep) out.push(c);
        else blank(c);
      }
      if (source[i] === char) {
        out.push(char);
        i++;
      }
      continue;
    }
    if (char === "`") {
      out.push("`");
      stack.push({ kind: "template" });
      i++;
      continue;
    }
    if (top?.kind === "code") {
      if (char === "{") top.depth++;
      else if (char === "}") {
        if (top.depth === 0) {
          stack.pop();
          out.push("}");
          i++;
          continue;
        }
        top.depth--;
      }
    }
    if (char === "/") {
      const { char: before, word } = previousToken();
      const divides =
        (WORD_CHAR.test(before) && !REGEX_AFTER_WORD.has(word)) ||
        before === ")" ||
        before === "]" ||
        before === '"' ||
        before === "'" ||
        before === "`";
      if (!divides) {
        out.push("/");
        i++;
        let inClass = false;
        while (i < length && source[i] !== "\n") {
          const c = source[i];
          if (c === "\\") {
            blank(c);
            if (i + 1 < length) blank(source[i + 1]);
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          blank(c);
          i++;
        }
        if (source[i] === "/") {
          out.push("/");
          i++;
        }
        continue;
      }
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Step 2: find writes to the environment object in that code.
// ---------------------------------------------------------------------------------------------

/** The environment object itself: `process.env`, `Bun.env`, `import.meta.env`, spaced or computed. */
const ENV_OBJECT =
  "(?:(?:globalThis|global)\\s*\\.\\s*)?(?:process\\s*(?:\\.\\s*env|\\[\\s*[\"'`]env[\"'`]\\s*\\])|Bun\\s*\\.\\s*env|import\\s*\\.\\s*meta\\s*\\.\\s*env)";
const IDENT = "[A-Za-z_$][\\w$]*";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names this file binds to the environment object: `const e = process.env`, `const { env } = process`. */
function envAliases(code: string): string[] {
  const aliases = new Set<string>();
  const bound = new RegExp(
    `(?<![\\w$.])(${IDENT})\\s*(?::[^=;]*)?=\\s*${ENV_OBJECT}\\s*(?:;|,|\\n|$)`,
    "g",
  );
  for (const m of code.matchAll(bound)) aliases.add(m[1]);

  const destructured =
    /\{([^{}]*)\}\s*=\s*(?:(?:globalThis|global)\s*\.\s*)?(?:process|Bun|import\s*\.\s*meta)\s*(?:;|\n|$)/g;
  const imported = /import\s*\{([^{}]*)\}\s*from\s*["'](?:bun|node:process|process)["']/g;
  for (const [pattern, rename] of [
    [destructured, ":"],
    [imported, "as"],
  ] as const) {
    for (const m of code.matchAll(pattern)) {
      for (const item of m[1].split(",")) {
        const pair = rename === ":" ? item.split(":") : item.split(/\s+as\s+/);
        if (pair[0].trim().split("=")[0].trim() !== "env") continue;
        const name = (pair[1] ?? pair[0]).trim().split("=")[0].trim();
        if (new RegExp(`^${IDENT}$`).test(name)) aliases.add(name);
      }
    }
  }
  return [...aliases];
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchingClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text` split at top-level commas, each piece with its offset in the code. */
function splitTopLevel(
  code: string,
  from: number,
  to: number,
): Array<{ text: string; at: number }> {
  const pieces: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i <= to; i++) {
    const c = i === to ? "," : code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (code.slice(start, i).trim() !== "")
        pieces.push({ text: code.slice(start, i), at: start });
      start = i + 1;
    }
  }
  return pieces;
}

/** Whether an expression is the literal `undefined` or `void 0`, however parenthesised or cast. */
function isUndefinedValue(expression: string): boolean {
  let e = expression.trim();
  while (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  e = e
    .replace(/\s+as\s[\s\S]*$/, "")
    .replace(/!$/, "")
    .trim();
  return /^(?:undefined|void\s+0)$/.test(e);
}

/** Every place `source` writes undefined into the environment object, as 1-based lines. */
function findEnvUndefinedWrites(source: string): EnvUndefinedHit[] {
  if (!/env/.test(source)) return [];
  const code = blankNonCode(source);
  const lines = source.split("\n");
  const lineStarts = [0];
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const aliases = envAliases(code);
  const names = [ENV_OBJECT, ...aliases.map(escapeRegExp)].join("|");
  const reference = new RegExp(`(?<![\\w$.])(?:${names})`, "g");
  const isEnvObject = new RegExp(`^(?:${names})$`);
  const flagged = new Set<number>();

  // `<env>.KEY = undefined`, `<env>[expr] = undefined` and the logical-assignment forms.
  for (const ref of code.matchAll(reference)) {
    let at = ref.index + ref[0].length;
    while (/\s/.test(code[at] ?? "")) at++;
    if (code[at] === ".") {
      at++;
      while (/\s/.test(code[at] ?? "")) at++;
      const key = new RegExp(IDENT, "y");
      key.lastIndex = at;
      const named = key.exec(code);
      if (!named) continue;
      at += named[0].length;
    } else if (code[at] === "[") {
      const close = matchingClose(code, at);
      if (close < 0) continue;
      at = close + 1;
    } else {
      continue;
    }
    const operator = /\s*!?\s*(\?\?=|\|\|=|&&=|=(?![=>]))\s*/y;
    operator.lastIndex = at;
    const assignment = operator.exec(code);
    if (!assignment) continue;
    let end = operator.lastIndex;
    let depth = 0;
    while (end < code.length) {
      const c = code[end];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) break;
      } else if (depth === 0 && (c === ";" || c === "\n")) break;
      end++;
    }
    if (isUndefinedValue(code.slice(operator.lastIndex, end))) flagged.add(lineAt(ref.index));
  }

  // `Reflect.set(<env>, key, undefined)` and `Object.assign(<env>, ...sources)`.
  for (const call of code.matchAll(/(?<![\w$.])(Reflect\s*\.\s*set|Object\s*\.\s*assign)\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const args = splitTopLevel(code, open + 1, close);
    if (args.length === 0 || !isEnvObject.test(args[0].text.trim())) continue;
    if (call[1].startsWith("Reflect")) {
      if (args[2] && isUndefinedValue(args[2].text)) flagged.add(lineAt(args[2].at));
      continue;
    }
    for (const source of args.slice(1)) {
      const literal = source.text.trim();
      if (!literal.startsWith("{") || !literal.endsWith("}")) continue;
      const from = source.at + source.text.indexOf("{") + 1;
      for (const property of splitTopLevel(code, from, from + literal.length - 2)) {
        const colon = property.text.search(/:/);
        if (colon >= 0 && isUndefinedValue(property.text.slice(colon + 1))) {
          flagged.add(
            lineAt(property.at + property.text.length - property.text.trimStart().length),
          );
        }
      }
    }
  }

  return [...flagged]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: (lines[line - 1] ?? "").trim() }));
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
  // Each entry: a name, a snippet, and the 1-based lines that must be reported.
  const BAD: Array<[string, string[], number[]]> = [
    ["a member write", ["process.env.A = undefined;"], [1]],
    ["no spaces around the operator", ["process.env.A=undefined;"], [1]],
    ["a string bracket key", ['process.env["A"] = undefined;'], [1]],
    ["an identifier bracket key", ["process.env[name] = undefined"], [1]],
    ["a nested bracket key", ["process.env[keys[0]] = undefined;"], [1]],
    ["Bun.env with a bracket key", ['Bun.env["X"] = undefined;'], [1]],
    ["void 0", ["process.env.A = void 0;"], [1]],
    ["a value on the next line", ["process.env.A =", "  undefined;"], [1]],
    ["undefined with a cast", ["process.env.A = undefined as unknown as string;"], [1]],
    ["a trailing line comment after the write", ["process.env.A = undefined; // restore"], [1]],
    ["??=", ["process.env.A ??= undefined;"], [1]],
    ["||=", ["process.env.A ||= undefined;"], [1]],
    ["a non-null target", ["process.env.A! = undefined;"], [1]],
    ["a spaced-out process . env", ["process . env.A = undefined;"], [1]],
    ["import.meta.env", ["import.meta.env.A = undefined;"], [1]],
    ["globalThis.process.env", ["globalThis.process.env.A = undefined;"], [1]],
    ['process["env"]', ['process["env"].A = undefined;'], [1]],
    [
      "code after a regex literal holding a quote",
      ["const q = /[\"']/;", "process.env.A = undefined;"],
      [2],
    ],
    ["Reflect.set", ['Reflect.set(process.env, "A", undefined);'], [1]],
    ["Reflect.set with a call in the key", ["Reflect.set(process.env, key(), void 0);"], [1]],
    ["an alias const", ["const e = process.env;", "e.A = undefined;"], [2]],
    ["an alias by destructuring", ["const { env } = process;", "env.A = undefined;"], [2]],
    ["a renamed destructured alias", ["const { env: e } = Bun;", "e.A = undefined;"], [2]],
    ["an imported alias", ['import { env } from "bun";', "env.A = undefined;"], [2]],
    [
      "an alias through Object.assign",
      ["const e = process.env;", "Object.assign(e, { A: undefined });"],
      [2],
    ],
    ["Object.assign on one line", ["Object.assign(process.env, { A: undefined });"], [1]],
    [
      "Object.assign after a call argument",
      ["Object.assign(process.env, a(), { A: undefined });"],
      [1],
    ],
    [
      "Object.assign after a call value",
      ["Object.assign(process.env, { A: foo(), B: undefined });"],
      [1],
    ],
    [
      "Object.assign over several lines",
      ["Object.assign(process.env, {", '  KEPT: "1",', "  DROPPED: undefined,", "});"],
      [3],
    ],
    ["write in a template interpolation", ["const s = `${(process.env.A = undefined)}`;"], [1]],
  ];

  for (const [name, lines, expected] of BAD) {
    test(`flags ${name}`, () => {
      expect(findEnvUndefinedWrites(lines.join("\n")).map((h) => h.line)).toEqual(expected);
    });
  }

  const GOOD: Array<[string, string[]]> = [
    [
      "the accepted restores",
      [
        "const saved = process.env.A;",
        'if (saved === undefined) Reflect.deleteProperty(process.env, "A");',
        "else process.env.A = saved;",
      ],
    ],
    [
      "comparisons with undefined",
      ["if (process.env.A === undefined) run();", "const s = process.env.A == undefined;"],
    ],
    [
      "a local copy of the environment",
      ['const env = { ...process.env, KEPT: "1" };', "env.DROPPED = undefined;"],
    ],
    ["a spawn env option", ["spawn(cmd, { env: { DROPPED: undefined } });"]],
    ["a PATH built in a template", ['process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;']],
    [
      "assigning a string",
      ['process.env.A = "undefined-ish";', 'Reflect.set(process.env, "A", "1");'],
    ],
    ["Object.assign of strings", ['Object.assign(process.env, { A: "1", B: String(x) });']],
    [
      "Object.assign onto a plain object",
      ["Object.assign(local, { A: undefined });", 'Reflect.set(local, "A", undefined);'],
    ],
    ["a line comment", ["// process.env.A = undefined stores the string"]],
    ["a doc-comment line", [" * `process.env.A = undefined` does not unset anything"]],
    ["a block comment", ["/* process.env.A = undefined", "   process.env.B = undefined */"]],
    ["a trailing comment", ["run(); // process.env.A = undefined stores the string"]],
    [
      "a string literal",
      ['const s = "process.env.A = undefined";', "const t = 'process.env.B = void 0';"],
    ],
    ["a one-line template literal", ["const s = `process.env.A = undefined`;"]],
    [
      "a multi-line template literal, such as a fixture script a test writes",
      [
        "writeFileSync(path, `#!/bin/sh",
        "process.env.A = undefined",
        "Object.assign(process.env, { B: undefined })",
        "`);",
      ],
    ],
    ["a regular expression literal", ["const re = /process\\.env\\.A = undefined/;"]],
    [
      "division, which is not a regular expression",
      ["const half = total / 2;", 'process.env.A = "x"; const q = total / 4;'],
    ],
  ];

  for (const [name, lines] of GOOD) {
    test(`passes ${name}`, () => {
      expect(findEnvUndefinedWrites(lines.join("\n"))).toEqual([]);
    });
  }

  test("reports the offending line number and the text of that line", () => {
    const [hit] = findEnvUndefinedWrites("x();\n  process.env.REPORTED = undefined;\n");
    expect(hit).toEqual({ line: 2, text: "process.env.REPORTED = undefined;" });
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
