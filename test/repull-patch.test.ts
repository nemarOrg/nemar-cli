/**
 * N.0.1's selection and its commit (`src/lib/repull/patch.ts`; ADR 0111, decisions 1 and 3; epic
 * #1046 phase 6, #1912), on real git repositories built by plumbing: what the plan's corrections and
 * an administrator's resolutions select, the README family as a unit, the replayed entries byte for
 * byte (an annexed symlink, a git blob, a deletion), the description's keys and version, the
 * refusals when the base no longer holds what the plan read, the keys' presence and dead marks, and
 * the commit made again on a `main` enrichment moved. The integration of these with the real CLI and
 * Worker is `repull-patch-cli.test.ts`.
 *
 * CI TIER: unit-pure (local git repositories in a temporary directory; no server, no network).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDirLower } from "../scripts/scrub/git/git-lib";
import type { RepullRow } from "../shared/repull-state";
import { runCommand } from "../src/lib/git-annex/run-command";
import type { PlanBody } from "../src/lib/repull/digest";
import type { OriginScratch } from "../src/lib/repull/execute/origin";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";
import {
  type PatchSelection,
  assertPatchLedger,
  assertReplayedKeys,
  findPatchCommit,
  patchCommit,
  patchResynthesizedCommit,
  patchSelection,
} from "../src/lib/repull/patch";

const KEY = `SHA256E-s10--${"a".repeat(64)}.edf`;
const OTHER_KEY = `SHA256E-s12--${"b".repeat(64)}.edf`;
const UUID = "11111111-2222-3333-4444-555555555555";
const DIGEST = `sha256:${"c".repeat(64)}`;
const symlinkTo = (key: string) => `../../.git/annex/objects/Xx/Yy/${key}/${key}`;

async function git(dir: string, args: string[], stdin?: string, env?: Record<string, string>) {
  const r = await runCommand(["git", ...args], {
    cwd: dir,
    ...(stdin !== undefined ? { stdin } : {}),
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "1790000000 +0000",
      GIT_COMMITTER_DATE: "1790000000 +0000",
      ...env,
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let dir: string;
const blob = (text: string) => git(dir, ["hash-object", "-w", "--stdin"], text);

/** A commit of `files` (path -> [mode, content]) on `parent`, through a private index. */
async function commit(
  files: Record<string, [string, string]>,
  parent: string | null,
  message = "c",
  date = "1790000000 +0000",
): Promise<string> {
  const index = join(dir, `index-${Math.random()}`);
  const env = { GIT_INDEX_FILE: index };
  await git(dir, ["read-tree", "--empty"], undefined, env);
  const lines: string[] = [];
  for (const [path, [mode, content]] of Object.entries(files)) {
    lines.push(`${mode} ${await blob(content)}\t${path}`);
  }
  await git(dir, ["update-index", "-z", "--index-info"], `${lines.join("\0")}\0`, env);
  const tree = await git(dir, ["write-tree"], undefined, env);
  return git(
    dir,
    ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message],
    undefined,
    {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  );
}

const DESC_BASE = `${JSON.stringify({ Name: "x", Version: "1.0.0", Extra: "nemar" }, null, 2)}\n`;
const DESC_N0 = `${JSON.stringify({ Name: "x", Version: "2.0.0", Upstream: "u" }, null, 2)}\n`;

let base: string;
let merge: string;
let scratch: OriginScratch;

function row(over: Partial<RepullRow> = {}): RepullRow {
  return {
    id: 7,
    dataset_id: "xx090123",
    upstream_ds: "ds099999",
    from_tag: "1.0.0",
    to_tag: "1.1.0",
    to_version: "2.0.0",
    from_version: "1.0.0",
    plan_digest: DIGEST,
    base_sha: base,
    merge_sha: merge,
    patch_base_sha: merge,
    counts: { corrections: 2, conflicts: 1 },
    ...over,
  } as RepullRow;
}

const sel = (over: Partial<PatchSelection> = {}): PatchSelection => ({
  paths: [],
  keys: [],
  corrections: 2,
  resolutions: 0,
  unresolved: 0,
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nemar-repull-patch-"));
  await git(dir, ["init", "-q", "--bare"]);
  base = await commit(
    {
      "sub-01/eeg/x.edf": ["120000", symlinkTo(KEY)],
      "notes.txt": ["100644", "NEMAR's notes\n"],
      "participants.tsv": ["100644", "participant_id\nsub-01\n"],
      "dataset_description.json": ["100644", DESC_BASE],
    },
    null,
  );
  merge = await commit(
    {
      "sub-01/eeg/x.edf": ["120000", symlinkTo(OTHER_KEY)],
      "participants.tsv": ["100644", "participant_id\nsub-01\nsub-02\n"],
      "dataset_description.json": ["100644", DESC_N0],
    },
    base,
    "Release v2.0.0 (#1)",
    "1790000500 +0000",
  );
  scratch = { dir, env: undefined, close: () => {} };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A plan body shaped as the planner writes the parts N.0.1 reads. */
function body(over: Record<string, unknown> = {}): PlanBody {
  return {
    paths: [
      { path: "notes.txt", group: null, ours: "G:100644:x", class: "correction" },
      { path: "participants.tsv", group: null, ours: "G:100644:y", class: "conflict" },
      { path: "README", group: "readme", ours: "absent", class: "correction" },
      { path: "README.md", group: "readme", ours: "G:100644:z", class: "correction" },
      {
        path: "dataset_description.json",
        group: "description",
        ours: "G:100644:d",
        class: "correction",
      },
      { path: "code/x.sh", group: null, ours: "G:100644:q", class: "take-theirs" },
    ],
    description: {
      keys: [
        { key: "Extra", class: "correction", ours: '"nemar"' },
        { key: "Funding", class: "conflict", ours: '["NEMAR"]' },
        { key: "Name", class: "take-theirs", ours: '"x"' },
      ],
    },
    counts: { corrections: 4 },
    ledger: { recorded_corrections: 0 },
    ...over,
  } as unknown as PlanBody;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ExecuteRefused) return err.code;
    throw err;
  }
  return "none";
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExecuteRefused) return err.code;
    throw err;
  }
  return "none";
}

describe("what N.0.1 replays", () => {
  test("every correction, the README family as a unit, and the corrected description keys", () => {
    const s = patchSelection(body(), []);
    expect(s.paths.map((p) => p.path)).toEqual(["README", "README.md", "notes.txt"]);
    expect(s.keys).toEqual([{ key: "Extra", ours: '"nemar"' }]);
    expect(s).toMatchObject({ corrections: 4, resolutions: 0 });
  });

  test("a conflict is replayed only when an administrator names it", () => {
    const s = patchSelection(body(), ["participants.tsv", "dataset_description.json#Funding"]);
    expect(s.paths.map((p) => p.path)).toContain("participants.tsv");
    expect(s.keys.map((k) => k.key)).toEqual(["Extra", "Funding"]);
    expect(s.resolutions).toBe(2);
  });

  test("a resolution of one README member takes the whole family", () => {
    const b = body({
      paths: [
        { path: "README", group: "readme", ours: "absent", class: "conflict" },
        { path: "README.md", group: "readme", ours: "G:100644:z", class: "conflict" },
      ],
      counts: { corrections: 0 },
    });
    expect(patchSelection(b, ["README.md"]).paths.map((p) => p.path)).toEqual([
      "README",
      "README.md",
    ]);
  });

  test("a --take-ours that is not a conflict of the plan refuses", () => {
    for (const name of [
      "notes.txt",
      "code/x.sh",
      "no/such/file",
      "dataset_description.json",
      "dataset_description.json#Extra",
      "dataset_description.json#Name",
      "dataset_description.json#Nope",
    ]) {
      expect([name, refusal(() => patchSelection(body(), [name]))]).toEqual([
        name,
        "take-ours-invalid",
      ]);
    }
  });

  test("a plan that does not state its corrections is not read as having none", () => {
    expect(refusal(() => patchSelection(body({ counts: {} }), []))).toBe("plan-schema");
  });

  test("the ledger must say it records no correction", () => {
    expect(refusal(() => assertPatchLedger(body()))).toBe("none");
    for (const ledger of [{ recorded_corrections: 1 }, {}, null]) {
      expect(refusal(() => assertPatchLedger(body({ ledger })))).toBe("patch-ledger");
    }
  });
});

describe("N.0.1's commit", () => {
  test("replays each entry byte for byte, sets the description, and is the same every time", async () => {
    const notes = await git(dir, ["rev-parse", `${base}:notes.txt`]);
    const s = sel({
      paths: [
        { path: "notes.txt", ours: `G:100644:${notes}` },
        { path: "sub-01/eeg/x.edf", ours: `A:${KEY}` },
      ],
      keys: [
        { key: "Extra", ours: '"nemar"' },
        { key: "Upstream", ours: null },
      ],
    });
    const made = await patchCommit({ scratch, row: row(), selection: s, parent: merge });
    const again = await patchCommit({ scratch, row: row(), selection: s, parent: merge });
    expect(again.sha).toBe(made.sha);
    expect(made.keys).toEqual([KEY]);
    for (const path of ["notes.txt", "sub-01/eeg/x.edf"]) {
      expect(await git(dir, ["rev-parse", `${made.sha}:${path}`])).toBe(
        await git(dir, ["rev-parse", `${base}:${path}`]),
      );
    }
    // A path N.0.1 does not replay stays N.0.0's.
    expect(await git(dir, ["rev-parse", `${made.sha}:participants.tsv`])).toBe(
      await git(dir, ["rev-parse", `${merge}:participants.tsv`]),
    );
    expect(JSON.parse(await git(dir, ["show", `${made.sha}:dataset_description.json`]))).toEqual({
      Name: "x",
      Version: "2.0.1",
      Extra: "nemar",
    });
    expect(await git(dir, ["rev-parse", `${made.sha}^`])).toBe(merge);
    // The merge's committer time, the re-pull's identity, and the trailers last.
    expect(await git(dir, ["log", "-1", "--format=%an %ct", made.sha])).toBe(
      "NEMAR re-pull 1790000500",
    );
    expect(await git(dir, ["log", "-1", "--format=%(trailers:only,unfold)", made.sha])).toBe(
      `Upstream-Snapshot: ds099999@1.1.0\nRepull-Plan: ${DIGEST}\nRepull-Patch: corrections=2`,
    );
  });

  test("a path NEMAR did not have is deleted; `absent` where the base holds the path refuses", async () => {
    // N.0.0 itself added the file: its merge is the parent.
    const parent = await commit(
      {
        "participants.tsv": ["100644", "x\n"],
        "added.txt": ["100644", "upstream added this\n"],
        "dataset_description.json": ["100644", DESC_N0],
      },
      base,
      "Release v2.0.0 (#1)",
      "1790000500 +0000",
    );
    const made = await patchCommit({
      scratch,
      row: row({ merge_sha: parent }),
      selection: sel({ paths: [{ path: "added.txt", ours: "absent" }] }),
      parent,
    });
    const listed = await git(dir, ["ls-tree", "-r", "--name-only", made.sha]);
    expect(listed.split("\n")).not.toContain("added.txt");
    expect(listed.split("\n")).toContain("participants.tsv");
    expect(
      await refusalOf(
        patchCommit({
          scratch,
          row: row({ merge_sha: parent }),
          selection: sel({ paths: [{ path: "participants.tsv", ours: "absent" }] }),
          parent,
        }),
      ),
    ).toBe("patch-ours-moved");
  });

  test("a replayed path enrichment wrote after the merge refuses: patch-main-moved", async () => {
    const files: Record<string, [string, string]> = {
      "sub-01/eeg/x.edf": ["120000", symlinkTo(OTHER_KEY)],
      "participants.tsv": ["100644", "participant_id\nsub-01\nsub-02\n"],
      "dataset_description.json": ["100644", DESC_N0],
    };
    const pBase = await commit({ ...files, ".bidsignore": ["100644", "extra/\n"] }, null);
    const pMerge = await commit(
      { ...files, ".bidsignore": ["100644", "upstream/\n"] },
      pBase,
      "Release v2.0.0 (#1)",
      "1790000500 +0000",
    );
    // Enrichment adds NEMAR's line to the .bidsignore N.0.1 replays.
    const enriched = await commit(
      { ...files, ".bidsignore": ["100644", "upstream/\n.nemar/\n"] },
      pMerge,
      "enrichment",
    );
    const ours = await git(dir, ["rev-parse", `${pBase}:.bidsignore`]);
    const make = (parent: string) =>
      patchCommit({
        scratch,
        row: row({ base_sha: pBase, merge_sha: pMerge }),
        selection: sel({ paths: [{ path: ".bidsignore", ours: `G:100644:${ours}` }] }),
        parent,
      });
    expect(await refusalOf(make(enriched))).toBe("patch-main-moved");
    // On the merge itself, and on enrichment that left the path alone, it is made.
    expect(await refusalOf(make(pMerge))).toBe("none");
    const elsewhere = await commit(
      {
        ...files,
        ".bidsignore": ["100644", "upstream/\n"],
        ".nemar/metadata.json": ["100644", "{}\n"],
      },
      pMerge,
      "enrichment",
    );
    expect(await refusalOf(make(elsewhere))).toBe("none");
  });

  test("a privacy ledger on main that records a correction, or does not parse, refuses: patch-ledger", async () => {
    const entry = (action: string) =>
      JSON.stringify({
        version: 1,
        at: "2026-10-01T00:00:00.000Z",
        dataset: "xx090123",
        action,
        versions: action === "repull-scrubbed" ? [] : ["v1.0.0"],
        counts: { headers: 1 },
        scanner: "identifier-scan@abcdef1",
        verification: "scanner-clean",
        actor: "yahya",
      });
    const files: Record<string, [string, string]> = {
      "sub-01/eeg/x.edf": ["120000", symlinkTo(OTHER_KEY)],
      "participants.tsv": ["100644", "participant_id\nsub-01\nsub-02\n"],
      "dataset_description.json": ["100644", DESC_N0],
    };
    const withLedger = (text: string) =>
      commit({ ...files, ".nemar/corrections.jsonl": ["100644", text] }, merge, "enrichment");
    /** The refusal's code and message, or "none". */
    const make = async (text: string) => {
      try {
        await patchCommit({
          scratch,
          row: row(),
          selection: sel(),
          parent: await withLedger(text),
        });
      } catch (err) {
        if (err instanceof ExecuteRefused) return `${err.code}: ${err.message}`;
        throw err;
      }
      return "none";
    };
    expect(await make(`${entry("repull-scrubbed")}\n`)).toBe("none");
    expect(await make(`${entry("repull-scrubbed")}\n${entry("headers-scrubbed")}\n`)).toContain(
      "patch-ledger: The privacy ledger on NEMAR's main records 1 correction(s)",
    );
    expect(await make("{not json\n")).toContain(
      "patch-ledger: The privacy ledger on NEMAR's main does not parse",
    );
  });

  test("a description value or key N.0.1 cannot write refuses: patch-description-unreadable", async () => {
    for (const keys of [
      [{ key: "Extra", ours: "not json" }],
      [{ key: "__proto__", ours: '{"polluted": true}' }],
    ]) {
      expect([
        keys[0]?.key,
        await refusalOf(
          patchCommit({ scratch, row: row(), selection: sel({ keys }), parent: merge }),
        ),
      ]).toEqual([keys[0]?.key, "patch-description-unreadable"]);
    }
  });

  test("an entry the base no longer holds as the plan read it refuses: patch-ours-moved", async () => {
    for (const ours of [
      `G:100644:${"0".repeat(40)}`,
      `A:${OTHER_KEY}`,
      `G:100755:${"1".repeat(40)}`,
    ]) {
      const code = await refusalOf(
        patchCommit({
          scratch,
          row: row(),
          selection: sel({
            paths: [{ path: ours.startsWith("A:") ? "sub-01/eeg/x.edf" : "notes.txt", ours }],
          }),
          parent: merge,
        }),
      );
      expect([ours, code]).toEqual([ours, "patch-ours-moved"]);
    }
  });

  test("a replayed file where N.0.0 holds a directory refuses: patch-path-conflict", async () => {
    const notes = await git(dir, ["rev-parse", `${base}:notes.txt`]);
    const parent = await commit(
      {
        "notes.txt/inside.txt": ["100644", "a directory now\n"],
        "dataset_description.json": ["100644", DESC_N0],
      },
      merge,
    );
    expect(
      await refusalOf(
        patchCommit({
          scratch,
          row: row(),
          selection: sel({ paths: [{ path: "notes.txt", ours: `G:100644:${notes}` }] }),
          parent,
        }),
      ),
    ).toBe("patch-path-conflict");
  });

  test("made again on a main enrichment moved: the same changes, the same message and dates", async () => {
    const notes = await git(dir, ["rev-parse", `${base}:notes.txt`]);
    const made = await patchCommit({
      scratch,
      row: row(),
      selection: sel({ paths: [{ path: "notes.txt", ours: `G:100644:${notes}` }] }),
      parent: merge,
    });
    // Enrichment on main: a .nemar/ file added.
    const files = {
      "sub-01/eeg/x.edf": ["120000", symlinkTo(OTHER_KEY)] as [string, string],
      "participants.tsv": ["100644", "participant_id\nsub-01\nsub-02\n"] as [string, string],
      "dataset_description.json": ["100644", DESC_N0] as [string, string],
      ".nemar/metadata.json": ["100644", "{}\n"] as [string, string],
    };
    const moved = await commit(files, merge, "enrichment");
    const again = await patchResynthesizedCommit({ dir, commit: made.sha, newMain: moved });
    expect(await git(dir, ["rev-parse", `${again.sha}^`])).toBe(moved);
    expect(await git(dir, ["rev-parse", `${again.sha}:notes.txt`])).toBe(notes);
    expect(await git(dir, ["rev-parse", `${again.sha}:.nemar/metadata.json`])).toBe(
      await git(dir, ["rev-parse", `${moved}:.nemar/metadata.json`]),
    );
    expect(await git(dir, ["log", "-1", "--format=%B%ct", again.sha])).toBe(
      await git(dir, ["log", "-1", "--format=%B%ct", made.sha]),
    );
    // A main that moved on a path N.0.1 replays is not merged by hand.
    const touched = await commit({ ...files, "notes.txt": ["100644", "upstream's\n"] }, merge);
    expect(
      await refusalOf(patchResynthesizedCommit({ dir, commit: made.sha, newMain: touched })),
    ).toBe("patch-main-moved");
  });

  test("found beneath enrichment commits on its branch", async () => {
    const notes = await git(dir, ["rev-parse", `${base}:notes.txt`]);
    const made = await patchCommit({
      scratch,
      row: row(),
      selection: sel({ paths: [{ path: "notes.txt", ours: `G:100644:${notes}` }] }),
      parent: merge,
    });
    const tree = await git(dir, ["rev-parse", `${made.sha}^{tree}`]);
    const index = join(dir, "index-enrich");
    await git(dir, ["read-tree", tree], undefined, { GIT_INDEX_FILE: index });
    await git(
      dir,
      ["update-index", "--add", "--cacheinfo", `100644,${await blob("{}\n")},.nemar/metadata.json`],
      undefined,
      { GIT_INDEX_FILE: index },
    );
    const enrichedTree = await git(dir, ["write-tree"], undefined, { GIT_INDEX_FILE: index });
    const head = await git(dir, ["commit-tree", enrichedTree, "-p", made.sha, "-m", "enrich"]);
    expect(await findPatchCommit({ dir, row: row(), head })).toEqual({
      commit: made.sha,
      parent: merge,
    });
    // A branch with no N.0.1 commit in it is none.
    expect(await findPatchCommit({ dir, row: row(), head: merge })).toBeNull();
  });
});

describe("the keys N.0.1 replays are NEMAR's", () => {
  async function annexBranch(log: string): Promise<string> {
    const index = join(dir, `index-annex-${Math.random()}`);
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["read-tree", "--empty"], undefined, env);
    await git(
      dir,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${await blob(`${UUID} nemar-s3\n`)},uuid.log`,
      ],
      undefined,
      env,
    );
    await git(
      dir,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${await blob(log)},${hashDirLower(KEY)}${KEY}.log`,
      ],
      undefined,
      env,
    );
    const tree = await git(dir, ["write-tree"], undefined, env);
    const c = await git(dir, ["commit-tree", tree, "-m", "annex"]);
    await git(dir, ["update-ref", "refs/heads/git-annex", c]);
    return "refs/heads/git-annex";
  }
  const check = async (log: string, listing: Map<string, number>) =>
    refusalOf(
      assertReplayedKeys({
        dir,
        annexRef: await annexBranch(log),
        keys: [KEY],
        nemarUuid: UUID,
        listing,
      }),
    );
  const atSize = new Map([[KEY, 10]]);

  test("in the bucket at its size, present at nemar-s3, not dead", async () => {
    expect(await check(`1790000001s 1 ${UUID}\n`, atSize)).toBe("none");
  });
  test("absent from the bucket, or at another size: patch-key-absent", async () => {
    expect(await check(`1790000001s 1 ${UUID}\n`, new Map())).toBe("patch-key-absent");
    expect(await check(`1790000001s 1 ${UUID}\n`, new Map([[KEY, 9]]))).toBe("patch-key-absent");
  });
  test("dead on NEMAR's git-annex branch: patch-key-dead", async () => {
    expect(await check(`1790000001s X ${UUID}\n`, atSize)).toBe("patch-key-dead");
  });
  test("not recorded at nemar-s3: patch-key-absent", async () => {
    expect(await check("1790000001s 1 99999999-2222-3333-4444-555555555555\n", atSize)).toBe(
      "patch-key-absent",
    );
  });
});
