/**
 * The canonical spelling of a JSON key exists three times: `canonical` in shared/identifier-scan.ts
 * (what a plan lists), `canonicalKey` in git-lib.ts (what verify looks for) and `canon` in
 * rewrite_history.py (what the rewrite blanks). They must agree on every key, or a key the scanner
 * flagged is left in the history by the rewrite, or verify reports a clean tree that is not.
 *
 * The Python side runs for real (uv, git-filter-repo, the module itself). The scanner strips what
 * JavaScript's `\s` matches, which is not what Python's `\s` matches (Python adds U+001C to U+001F
 * and U+0085 and lacks U+FEFF), so the comparison covers EVERY code point, not a few hand-picked
 * ones, plus a table of edge keys.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FILTER_REPO_REQUIREMENT, canonicalKey } from "../../../scripts/scrub/git/git-lib";
import { canonical } from "../../../shared/identifier-scan";
import { ENV, HAVE_REWRITE_TOOLS } from "./fixture";

const REWRITE = join(import.meta.dir, "../../../scripts/scrub/git/rewrite_history.py");

/** Reads {"keys": [...], "codePoints": N} on stdin; answers each key's `canon` and, per code point, whether it is removed. */
const HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rewrite_history", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
removed = "".join(
    "1" if module.canon("a" + chr(cp) + "b") == "ab" else "0" for cp in range(request["codePoints"])
)
json.dump({"canon": [module.canon(k) for k in request["keys"]], "removed": removed}, sys.stdout)
`;

/** Edge keys the three must spell alike. Escapes, so the file stays ASCII and each character is visible. */
const EDGE_KEYS = [
  "PartName",
  "Part Name",
  "Part_Name",
  "Part-Name",
  "part - _ name",
  "Part Name", // no-break space
  "Part\tName",
  "Part\nName",
  "Part\rName",
  "Part\u000bName", // vertical tab
  "Part\u000cName", // form feed
  "Part Name", // line separator
  "Part Name", // paragraph separator
  "Part　Name", // ideographic space
  "Part Name", // ogham space mark
  "Part Name",
  "Part Name", // hair space, the last of the U+2000 range
  "Part Name", // narrow no-break space
  "Part Name", // medium mathematical space
  "Part﻿Name", // byte order mark: JavaScript calls it whitespace, Python does not
  " PartName ",
  " \tPart_Name　",
  // Not whitespace to JavaScript, so kept by all three (Python's `\s` would strip them).
  "Part\u0085Name", // next line
  "Part\u001cName",
  "Part\u001fName",
  // Not whitespace to either: a zero-width space and the Mongolian vowel separator.
  "Part​Name",
  "Part᠎Name",
  "Part⁠Name", // word joiner
  // Case folding that is more than ASCII.
  "PARTİD", // I with dot above
  "ΑΣ", // Alpha Sigma: a final sigma
  "ΑΣ Β",
  "ẞSS", // capital sharp s
  "",
  " ",
  "-_ ",
];

interface Answer {
  canon: string[];
  removed: string;
}

function askPython(keys: string[], codePoints: number): Answer {
  const proc = Bun.spawnSync(
    [
      "uv",
      "run",
      "--quiet",
      "--with",
      FILTER_REPO_REQUIREMENT,
      "python",
      "-I",
      "-c",
      HARNESS,
      REWRITE,
    ],
    {
      env: ENV,
      stdin: Buffer.from(JSON.stringify({ keys, codePoints })),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) throw new Error(`python failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString()) as Answer;
}

const SUITE = HAVE_REWRITE_TOOLS ? describe : describe.skip;

SUITE("the canonical spelling of a JSON key (scanner, verify, rewrite)", () => {
  // The whole of Unicode, lone surrogates included: a JSON key can carry any of them.
  const CODE_POINTS = 0x110000;
  let python: Answer;
  // One interpreter for everything below, started only when the suite runs (not when it is skipped).
  beforeAll(() => {
    python = askPython(EDGE_KEYS, CODE_POINTS);
  }, 120_000);

  test("the edge keys are spelled alike by all three", () => {
    expect(python.canon.length).toBe(EDGE_KEYS.length);
    EDGE_KEYS.forEach((key, i) => {
      const expected = canonical(key);
      expect(canonicalKey(key), JSON.stringify(key)).toBe(expected);
      expect(python.canon[i], JSON.stringify(key)).toBe(expected);
    });
  });

  test("a no-break space, a tab and a byte order mark are removed, a next-line character is not", () => {
    // Pinned apart from the comparison above, which would pass if all three were wrong alike.
    expect(canonical("Part Name")).toBe("partname");
    expect(canonical("Part\tName")).toBe("partname");
    expect(canonical("Part﻿Name")).toBe("partname");
    expect(canonical("Part\u0085Name")).toBe("part\u0085name");
    expect(canonical("Part​Name")).toBe("part​name");
  });

  test("every code point is either removed by all three or kept by all three", () => {
    expect(python.removed.length).toBe(CODE_POINTS);
    const mismatches: string[] = [];
    let removedCount = 0;
    for (let cp = 0; cp < CODE_POINTS; cp++) {
      const key = `a${String.fromCodePoint(cp)}b`;
      const removed = canonical(key) === "ab";
      if (removed) removedCount++;
      if (canonicalKey(key) !== canonical(key) || (python.removed[cp] === "1") !== removed) {
        mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
    expect(mismatches).toEqual([]);
    // The scanner strips JavaScript's `\s` (25 characters) plus the underscore and the hyphen.
    expect(removedCount).toBe(25 + 2);
  });
});
