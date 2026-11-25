/**
 * ONE SET OF CAPS (epic #2021 phase D3b, #2024; the acceptance criterion "CLI and Worker read one set of
 * caps from `shared/contract/compute-bundle.ts`"): the same bundle is judged by the CLI's packer
 * (`refuseCollected`, before a byte is read or a request made) and by the REAL `POST /compute/jobs` route
 * (over real migrated SQLite and the real Worker bindings), and the two give the SAME word at the SAME
 * boundary: the file count, one file's size, the running total, an unsafe or hidden-traversal path, a path
 * over the length cap, and an entry that is not in the bundle. At each cap the bundle that fits is taken by
 * both and the bundle one over is refused by both.
 *
 * The mutation of the phase report changes one cap on ONE side (the CLI's limits object, or the Worker's
 * policy default) and fails the boundary that side owns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type World,
  call,
  newPerson,
  resetWorld,
  startWorld,
} from "../backend/test/helpers/compute-submit-world";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import {
  BUNDLE_DEFAULT_LIMITS,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  BUNDLE_PATH_MAX,
} from "../shared/contract/compute-bundle";
import { type Collected, refuseCollected } from "../src/lib/compute/pack";

let w: World;

beforeAll(async () => {
  w = await startWorld();
}, 120_000);
beforeEach(async () => {
  await resetWorld(w);
});
afterAll(async () => {
  await w?.fx.dispose();
}, 30_000);

type Entry = { path: string; size: number };

const collected = (files: Entry[]): Collected => ({
  files: files.map((f) => ({ ...f, abs: "/nonexistent", executable: false })),
  skipped: { symlinks: 0, special: 0, ignored: 0, directories: 0, tooLarge: [] },
  overFileCap: false,
});

const DIGEST = createHash("sha256").update("x").digest("hex");

/** What the Worker answers for a manifest of these files and an entry: its word, or "accepted". */
async function workerSays(files: Entry[], entry: string): Promise<string> {
  const p = await newPerson(w);
  const r = await call(w, "POST", "/compute/jobs", {
    key: p.key,
    json: {
      spec: {
        name: "parity",
        runtime: "python",
        entry,
        bundle: { size: 1024, sha256: DIGEST },
        partition: "shared",
        cores: 1,
        minutes: 30,
      },
      manifest: { files: files.map((f) => ({ path: f.path, size: f.size, sha256: DIGEST })) },
    },
  });
  return r.status === 201 ? "accepted" : (r.body.code as string);
}

/** What the CLI's packer says for the same files. */
function cliSays(files: Entry[], entry: string): string {
  return refuseCollected(collected(files), { entry })?.code ?? "accepted";
}

const small = (n: number): Entry[] =>
  Array.from({ length: n }, (_, i) => ({ path: i === 0 ? "run.py" : `f${i}.txt`, size: 1 }));

const cases: Array<[string, Entry[], string, string]> = [
  ["the file count at the cap", small(BUNDLE_MAX_FILES), "run.py", "accepted"],
  ["one file over the count cap", small(BUNDLE_MAX_FILES + 1), "run.py", "bundle_too_many_files"],
  [
    "one file at the per-file cap",
    [{ path: "run.py", size: BUNDLE_MAX_FILE_BYTES }],
    "run.py",
    "accepted",
  ],
  [
    "one file a byte over the per-file cap",
    [{ path: "run.py", size: BUNDLE_MAX_FILE_BYTES + 1 }],
    "run.py",
    "bundle_too_large",
  ],
  [
    "the running total at the cap",
    Array.from({ length: BUNDLE_MAX_TOTAL_BYTES / BUNDLE_MAX_FILE_BYTES }, (_, i) => ({
      path: i === 0 ? "run.py" : `f${i}.bin`,
      size: BUNDLE_MAX_FILE_BYTES,
    })),
    "run.py",
    "accepted",
  ],
  [
    "the running total a byte over the cap",
    [
      ...Array.from({ length: BUNDLE_MAX_TOTAL_BYTES / BUNDLE_MAX_FILE_BYTES }, (_, i) => ({
        path: i === 0 ? "run.py" : `f${i}.bin`,
        size: BUNDLE_MAX_FILE_BYTES,
      })),
      { path: "extra.bin", size: 1 },
    ],
    "run.py",
    "bundle_too_large",
  ],
  [
    "a path at the length cap",
    [
      { path: "run.py", size: 1 },
      { path: `${"d".repeat(BUNDLE_PATH_MAX - 2)}/x`.slice(0, BUNDLE_PATH_MAX), size: 1 },
    ],
    "run.py",
    "accepted",
  ],
  [
    "a path a character over the length cap",
    [
      { path: "run.py", size: 1 },
      { path: "d".repeat(BUNDLE_PATH_MAX + 1), size: 1 },
    ],
    "run.py",
    "invalid_spec",
  ],
  [
    "a control character in a path",
    [
      { path: "run.py", size: 1 },
      { path: "bad\u0007.txt", size: 1 },
    ],
    "run.py",
    "invalid_spec",
  ],
  [
    "a backslash in a path",
    [
      { path: "run.py", size: 1 },
      { path: "a\\b.txt", size: 1 },
    ],
    "run.py",
    "invalid_spec",
  ],
  [
    "a traversal hidden in a percent encoding",
    [
      { path: "run.py", size: 1 },
      { path: "%2e%2e/x.txt", size: 1 },
    ],
    "run.py",
    "invalid_spec",
  ],
  ["an entry that is not in the bundle", small(3), "other.py", "entry_not_in_bundle"],
];

describe("the same bundle, the same word, from the CLI's packer and from the Worker", () => {
  for (const [what, files, entry, expected] of cases) {
    test(what, async () => {
      expect(cliSays(files, entry)).toBe(expected);
      expect(await workerSays(files, entry)).toBe(expected);
    }, 60_000);
  }
});

describe("one set of numbers", () => {
  test("the Worker's default policy and the CLI's limits are the shared constants, and nothing else", () => {
    const policy = DEFAULT_COMPUTE_POLICY.bundleLimits;
    expect(policy).toEqual({
      maxTotalBytes: BUNDLE_MAX_TOTAL_BYTES,
      maxFiles: BUNDLE_MAX_FILES,
      maxFileBytes: BUNDLE_MAX_FILE_BYTES,
    });
    expect({ ...BUNDLE_DEFAULT_LIMITS }).toEqual(policy);
  });
});
