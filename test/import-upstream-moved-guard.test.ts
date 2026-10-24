/**
 * Step 4c's guard (#993; epic #1046 Phase 3, ADR 0111 decision 10): a re-import of a RELEASED mirror
 * whose recorded upstream tag differs from the tag being imported refuses with
 * `[openneuro-upstream-moved]` before anything is reset or pushed, and an UNRELEASED one is moved to
 * the new tag as a fast-forward (the lead's ruling, 2026-10-23: retarget, not hard reset).
 *
 * Real git and git-annex: a bare repository stands in for `nemarDatasets/<id>`, recorded at 1.0.0 by
 * a first import, and the re-import's clone is at 1.0.1 of the same OpenNeuro-shaped upstream. The
 * recorded tag is written in each form the reader accepts (the entry's `Version`, its DOI only, its
 * URL only), and in the forms it does not (nothing, or entries that disagree), which must never
 * trip the guard.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyImportFailure } from "../backend/src/services/import-failure-cause";
import { decideRetryAction } from "../backend/src/services/import-retry";
import { pushToGitHub } from "../src/lib/git-annex/clone-push";
import { ImportRefused, OPENNEURO_UPSTREAM_MOVED_MARKER } from "../src/lib/import-markers";
import {
  baseOnOriginMain,
  cloneOpenNeuroAtTag,
  sourceDatasetEntry,
} from "../src/lib/import-openneuro";
import { makeScratch, run } from "./helpers/annex-repo";
import {
  type TaggedUpstream,
  UPSTREAM_ID,
  buildTaggedUpstream,
  startUnavailableGraphql,
} from "./helpers/tagged-upstream";

const NEMAR_ID = "on000001";
const scratch = makeScratch("import-upstream-moved");
let upstream: TaggedUpstream;
let graphql: ReturnType<typeof startUnavailableGraphql>;
let n = 0;

beforeAll(async () => {
  upstream = await buildTaggedUpstream(scratch.root);
  graphql = startUnavailableGraphql();
}, 60_000);

afterAll(() => {
  graphql.stop();
  scratch.cleanup();
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run(["git", ...args], dir);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function fresh(name: string): string {
  n += 1;
  const dir = join(scratch.root, `${name}-${n}`);
  return dir;
}

/** How origin's `main` records upstream 1.0.0, in each form the guard meets. */
const RECORDED = {
  // What this import writes from now on: the guard must read the entry its own import wrote.
  entry: [sourceDatasetEntry(UPSTREAM_ID, "1.0.0")],
  // What publication leaves on every mirror today (on004362, on003645).
  doiOnly: [{ DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.0` }],
  urlOnly: [{ URL: `https://openneuro.org/datasets/${UPSTREAM_ID}/versions/1.0.0` }],
  nothing: undefined,
  disagreeing: [
    { DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.0` },
    { URL: `https://openneuro.org/datasets/${UPSTREAM_ID}/versions/0.9.0` },
  ],
} as const;

/**
 * A first import at 1.0.0 pushed to a bare origin, with `sourceDatasets` in its description and
 * NEMAR's own top-level `Version` (which records nothing about upstream).
 */
async function originRecordedAt(
  sourceDatasets: readonly unknown[] | undefined,
): Promise<{ bare: string; tip: string }> {
  const first = fresh("first");
  await cloneOpenNeuroAtTag(UPSTREAM_ID, first, {
    tag: "1.0.0",
    repoUrl: upstream.dir,
    lookup: graphql.lookup,
  });
  await git(first, "config", "user.email", "test@test.com");
  await git(first, "config", "user.name", "Test");
  const descPath = join(first, "dataset_description.json");
  const desc = JSON.parse(readFileSync(descPath, "utf8"));
  desc.Version = "1.0.0";
  if (sourceDatasets !== undefined) desc.SourceDatasets = sourceDatasets;
  writeFileSync(descPath, `${JSON.stringify(desc, null, 2)}\n`);
  mkdirSync(join(first, ".nemar"), { recursive: true });
  writeFileSync(join(first, ".nemar", "metadata.json"), '{"version":"2.0"}\n');
  await git(first, "add", "dataset_description.json", ".nemar/metadata.json");
  await git(first, "commit", "-q", "-m", "Add NEMAR metadata (imported from OpenNeuro ds000001)");
  const bare = fresh("origin");
  mkdirSync(bare, { recursive: true });
  await git(bare, "init", "-q", "--bare", "-b", "main");
  await git(first, "remote", "remove", "origin");
  await git(first, "remote", "add", "origin", bare);
  const pushed = await pushToGitHub(first, "origin");
  if (!pushed.success) throw new Error(`first push: ${pushed.error}`);
  return { bare, tip: await git(bare, "rev-parse", "main") };
}

/** The re-import's clone, at `tag`, with origin pointed at `bare` and its git-annex branch merged. */
async function reimportClone(bare: string, tag: "1.0.0" | "1.0.1"): Promise<string> {
  const dir = fresh("retry");
  await cloneOpenNeuroAtTag(UPSTREAM_ID, dir, {
    tag,
    repoUrl: upstream.dir,
    lookup: graphql.lookup,
  });
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "remote", "remove", "origin");
  await git(dir, "remote", "add", "origin", bare);
  // Step 4b, as prepare runs it.
  await run(["git", "fetch", "origin", "git-annex"], dir);
  await run(["git", "annex", "merge"], dir);
  return dir;
}

function releaseState(released: boolean) {
  const calls = { n: 0 };
  return {
    calls,
    released: async () => {
      calls.n += 1;
      return released;
    },
  };
}

describe("a released mirror whose upstream moved refuses, before anything moves", () => {
  for (const form of ["entry", "doiOnly", "urlOnly"] as const) {
    test(`recorded by ${form}: refused with the marker; origin and the clone are untouched`, async () => {
      const { bare, tip } = await originRecordedAt(RECORDED[form]);
      const dir = await reimportClone(bare, "1.0.1");
      const state = releaseState(true);

      let err: unknown;
      try {
        await baseOnOriginMain(dir, {
          sourceId: UPSTREAM_ID,
          importTag: "1.0.1",
          nemarId: NEMAR_ID,
          released: state.released,
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ImportRefused);
      const refusal = err as ImportRefused;
      expect(refusal.marker).toBe(OPENNEURO_UPSTREAM_MOVED_MARKER);
      expect(refusal.message.startsWith(`${OPENNEURO_UPSTREAM_MOVED_MARKER} ${UPSTREAM_ID}:`)).toBe(
        true,
      );
      expect(refusal.message).toContain("1.0.0");
      expect(refusal.message).toContain("1.0.1");
      // The repair that passes the guard: the recorded tag, named.
      expect(
        refusal.message.endsWith(`nemar admin import-openneuro ${UPSTREAM_ID} --tag 1.0.0`),
      ).toBe(true);
      expect(refusal.message.length).toBeLessThan(600);
      expect(state.calls.n).toBe(1);
      // Nothing reset: the clone is still at the tag it cloned, with a clean tree.
      expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
      expect(await git(dir, "status", "--porcelain")).toBe("");
      // Nothing pushed.
      expect(await git(bare, "rev-parse", "main")).toBe(tip);

      // What the Worker does with the line it receives: upstream_moved, parked at once.
      expect(classifyImportFailure({ stage: "prepare", lastError: refusal.message }).cause).toBe(
        "upstream_moved",
      );
      const now = Date.now();
      expect(
        decideRetryAction({
          now,
          verified: { complete: false },
          firstIncompleteAtMs: now,
          lastError: refusal.message,
          recoveryAttempts: 0,
          hasSourceId: true,
        }),
      ).toEqual({ action: "blocklist", reason: "upstream_moved" });
    }, 60_000);
  }

  test("not knowing whether it is released is a plain failure, never a retarget", async () => {
    const { bare, tip } = await originRecordedAt(RECORDED.doiOnly);
    const dir = await reimportClone(bare, "1.0.1");
    const p = baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: async () => {
        throw new Error("HTTP 502");
      },
    });
    await expect(p).rejects.toThrow(/could not be read \(HTTP 502\)/);
    await p.catch((e) => expect(e).not.toBeInstanceOf(ImportRefused));
    expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
    expect(await git(bare, "rev-parse", "main")).toBe(tip);
  }, 60_000);
});

describe("the guard cannot be skipped by a branch or a failed fetch", () => {
  test("a detached HEAD on a moved, released mirror is still refused", async () => {
    const { bare, tip } = await originRecordedAt(RECORDED.doiOnly);
    const dir = await reimportClone(bare, "1.0.1");
    await git(dir, "checkout", "-q", "--detach");
    const p = baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: async () => true,
    });
    await expect(p).rejects.toBeInstanceOf(ImportRefused);
    expect(await git(bare, "rev-parse", "main")).toBe(tip);
  }, 60_000);

  test("an origin that cannot be fetched fails closed, never reads as a first import", async () => {
    const { bare } = await originRecordedAt(RECORDED.doiOnly);
    const dir = await reimportClone(bare, "1.0.1");
    await git(dir, "remote", "set-url", "origin", join(scratch.root, "no-such-origin"));
    const state = releaseState(true);
    const p = baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: state.released,
    });
    await expect(p).rejects.toThrow(/Could not fetch on000001's main from origin/);
    await p.catch((e) => expect(e).not.toBeInstanceOf(ImportRefused));
    expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
  }, 60_000);

  test("an unreleased import off main is not retargeted", async () => {
    const { bare, tip } = await originRecordedAt(RECORDED.doiOnly);
    const dir = await reimportClone(bare, "1.0.1");
    await git(dir, "checkout", "-q", "--detach");
    const p = baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: async () => false,
    });
    await expect(p).rejects.toThrow(/cannot be retargeted safely/);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
    expect(await git(bare, "rev-parse", "main")).toBe(tip);
  }, 60_000);
});

describe("an unreleased import whose upstream moved is retargeted to the new tag", () => {
  test("HEAD becomes origin's tip, the tree stays the new tag's, and the push fast-forwards", async () => {
    const { bare, tip } = await originRecordedAt(RECORDED.doiOnly);
    const dir = await reimportClone(bare, "1.0.1");
    const state = releaseState(false);

    const base = await baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: state.released,
    });

    expect(base).toEqual({ kind: "retarget", recordedTag: "1.0.0" });
    expect(state.calls.n).toBe(1);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
    // The index is the new tag's tree: what the next commit records.
    expect(await git(dir, "write-tree")).toBe(await git(upstream.dir, "rev-parse", "1.0.1^{tree}"));
    expect(readFileSync(join(dir, "README"), "utf8")).toBe("README at 1.0.1\n");

    // Steps 5b and 6 commit on top of it; the push is a plain fast-forward of origin.
    mkdirSync(join(dir, ".nemar"), { recursive: true });
    writeFileSync(join(dir, ".nemar", "metadata.json"), '{"version":"2.0"}\n');
    await git(dir, "add", ".nemar/metadata.json");
    await git(dir, "commit", "-q", "-m", "Add NEMAR metadata (imported from OpenNeuro ds000001)");
    const pushed = await pushToGitHub(dir, "origin");
    expect(pushed.success).toBe(true);
    expect(pushed.warning).toBeUndefined();
    const newTip = await git(bare, "rev-parse", "main");
    expect(newTip).not.toBe(tip);
    expect((await run(["git", "merge-base", "--is-ancestor", tip, newTip], bare)).exitCode).toBe(0);
    expect(await git(bare, "show", "main:README")).toBe("README at 1.0.1");
    // Upstream's 1.0.1 commit is not pushed into NEMAR's history; only its tree is.
    expect(
      (await run(["git", "merge-base", "--is-ancestor", upstream.commits["1.0.1"], newTip], bare))
        .exitCode,
    ).not.toBe(0);
  }, 60_000);
});

describe("a retarget never drops a recorded privacy correction (ADR 0085)", () => {
  /** Put `lines` in origin/main's ledger, as an earlier attempt or a correction would have. */
  async function withLedger(bare: string, lines: string[]): Promise<string> {
    const editor = fresh("ledger");
    await run(["git", "clone", "-q", bare, editor]);
    await git(editor, "config", "user.email", "test@test.com");
    await git(editor, "config", "user.name", "Test");
    mkdirSync(join(editor, ".nemar"), { recursive: true });
    writeFileSync(join(editor, ".nemar", "corrections.jsonl"), `${lines.join("\n")}\n`);
    await git(editor, "add", ".nemar/corrections.jsonl");
    await git(editor, "commit", "-q", "-m", "ledger");
    await git(editor, "push", "-q", "origin", "main");
    return git(bare, "rev-parse", "main");
  }
  const scrubbed = JSON.stringify({ version: 1, action: "import-scrubbed", counts: {} });

  test("the importer's own import-scrubbed line does not stop a retarget", async () => {
    const { bare } = await originRecordedAt(RECORDED.doiOnly);
    const tip = await withLedger(bare, [scrubbed]);
    const dir = await reimportClone(bare, "1.0.1");
    const base = await baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: async () => false,
    });
    expect(base.kind).toBe("retarget");
    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
  }, 60_000);

  test("any other line, or one that is not JSON, refuses before any reset", async () => {
    for (const extra of [
      JSON.stringify({ version: 1, action: "headers-scrubbed", counts: { headers: 2 } }),
      "{not json",
    ]) {
      const { bare } = await originRecordedAt(RECORDED.doiOnly);
      const tip = await withLedger(bare, [scrubbed, extra]);
      const dir = await reimportClone(bare, "1.0.1");
      const p = baseOnOriginMain(dir, {
        sourceId: UPSTREAM_ID,
        importTag: "1.0.1",
        nemarId: NEMAR_ID,
        released: async () => false,
      });
      await expect(p).rejects.toThrow(/records 1 line\(s\) in \.nemar\/corrections\.jsonl/);
      expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
      expect(await git(bare, "rev-parse", "main")).toBe(tip);
    }
  }, 120_000);
});

describe("a retarget never loses the hold an import scrub put on origin's history (ADR 0089)", () => {
  async function withLedger(bare: string, lines: string[]): Promise<string> {
    const editor = fresh("ledger-hold");
    await run(["git", "clone", "-q", bare, editor]);
    await git(editor, "config", "user.email", "test@test.com");
    await git(editor, "config", "user.name", "Test");
    mkdirSync(join(editor, ".nemar"), { recursive: true });
    writeFileSync(join(editor, ".nemar", "corrections.jsonl"), `${lines.join("\n")}\n`);
    await git(editor, "add", ".nemar/corrections.jsonl");
    await git(editor, "commit", "-q", "-m", "ledger");
    await git(editor, "push", "-q", "origin", "main");
    return git(bare, "rev-parse", "main");
  }

  test("an import scrub that blanked JSON or scrubbed a git-held recording refuses the retarget", async () => {
    // The pushed history still holds those originals. A hard reset keeps the ledger line, so the
    // hold (earlierHistoryHold) survives; a retarget would drop it and report no hold.
    for (const counts of [
      { json_values_blanked: 2, git_held_recordings_scrubbed: 0, headers_scrubbed: 1 },
      { json_values_blanked: 0, git_held_recordings_scrubbed: 1 },
    ]) {
      const { bare } = await originRecordedAt(RECORDED.doiOnly);
      const tip = await withLedger(bare, [
        JSON.stringify({ version: 1, action: "import-scrubbed", counts }),
      ]);
      const dir = await reimportClone(bare, "1.0.1");
      const p = baseOnOriginMain(dir, {
        sourceId: UPSTREAM_ID,
        importTag: "1.0.1",
        nemarId: NEMAR_ID,
        released: async () => false,
      });
      await expect(p).rejects.toThrow(/originals origin's history still holds, ADR 0089/);
      expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
      expect(await git(bare, "rev-parse", "main")).toBe(tip);
    }
  }, 120_000);

  test("an import scrub that changed nothing in git does not stop it", async () => {
    const { bare } = await originRecordedAt(RECORDED.doiOnly);
    const tip = await withLedger(bare, [
      JSON.stringify({
        version: 1,
        action: "import-scrubbed",
        counts: { json_values_blanked: 0, git_held_recordings_scrubbed: 0, headers_scrubbed: 3 },
      }),
    ]);
    const dir = await reimportClone(bare, "1.0.1");
    const base = await baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: async () => false,
    });
    expect(base.kind).toBe("retarget");
    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
  }, 60_000);
});

describe("an unrecorded or unchanged tag never trips the guard", () => {
  for (const form of ["nothing", "disagreeing"] as const) {
    test(`recorded ${form}: the same-version hard reset, and release state is never asked`, async () => {
      const { bare, tip } = await originRecordedAt(RECORDED[form]);
      const dir = await reimportClone(bare, "1.0.1");
      const state = releaseState(true);
      const base = await baseOnOriginMain(dir, {
        sourceId: UPSTREAM_ID,
        importTag: "1.0.1",
        nemarId: NEMAR_ID,
        released: state.released,
      });
      // Inert, and said: the reason travels with the result and is printed by baseOnOriginMain.
      expect(base).toEqual({
        kind: "hard-reset",
        recordedTag: null,
        unrecorded:
          form === "nothing"
            ? `records no upstream tag for ${UPSTREAM_ID}`
            : `records disagreeing upstream tags for ${UPSTREAM_ID} (0.9.0, 1.0.0)`,
      });
      expect(state.calls.n).toBe(0);
      expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
      expect(await git(dir, "status", "--porcelain")).toBe("");
    }, 60_000);
  }

  test("a description that is missing or not JSON is said, never swallowed", async () => {
    for (const [content, reason] of [
      [null, "has no dataset_description.json"],
      ["../../.git/annex/objects/xx/yy/SHA256E-s10--abc.json", "is not JSON"],
    ] as const) {
      const { bare } = await originRecordedAt(RECORDED.doiOnly);
      // Change origin's description the way a legacy import left it.
      const editor = fresh("editor");
      await run(["git", "clone", "-q", bare, editor]);
      await git(editor, "config", "user.email", "test@test.com");
      await git(editor, "config", "user.name", "Test");
      if (content === null) await git(editor, "rm", "-q", "dataset_description.json");
      else {
        writeFileSync(join(editor, "dataset_description.json"), content);
        await git(editor, "add", "dataset_description.json");
      }
      await git(editor, "commit", "-q", "-m", "legacy description");
      await git(editor, "push", "-q", "origin", "main");

      const dir = await reimportClone(bare, "1.0.1");
      const state = releaseState(true);
      const base = await baseOnOriginMain(dir, {
        sourceId: UPSTREAM_ID,
        importTag: "1.0.1",
        nemarId: NEMAR_ID,
        released: state.released,
      });
      expect(base.kind).toBe("hard-reset");
      expect(base.unrecorded).toContain(reason);
      expect(state.calls.n).toBe(0);
    }
  }, 120_000);

  test("recorded at the tag being imported: the hard reset, release state never asked", async () => {
    const { bare, tip } = await originRecordedAt(RECORDED.entry);
    const dir = await reimportClone(bare, "1.0.0");
    const state = releaseState(true);
    const base = await baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.0",
      nemarId: NEMAR_ID,
      released: state.released,
    });
    expect(base).toEqual({ kind: "hard-reset", recordedTag: "1.0.0" });
    expect(state.calls.n).toBe(0);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
  }, 60_000);

  test("a first import (origin has no main) is left as cloned", async () => {
    const bare = fresh("empty-origin");
    mkdirSync(bare, { recursive: true });
    await git(bare, "init", "-q", "--bare", "-b", "main");
    const dir = await reimportClone(bare, "1.0.1");
    const state = releaseState(true);
    const base = await baseOnOriginMain(dir, {
      sourceId: UPSTREAM_ID,
      importTag: "1.0.1",
      nemarId: NEMAR_ID,
      released: state.released,
    });
    expect(base).toEqual({ kind: "none", recordedTag: null });
    expect(state.calls.n).toBe(0);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits["1.0.1"]);
  }, 60_000);
});
