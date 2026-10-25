/**
 * The re-pull's commit made again on a `main` that moved by enrichment
 * (`src/lib/repull/execute/resynthesize.ts`; ADR 0111, decision 2; epic #1046 phase 6), on real
 * git repositories built here: a bare origin with a base, the re-pull's commit on its release
 * branch, and a `main` that enrichment moved in all three of its shapes. No stand-in: the scratch
 * repository, the leased push and every read are the real `git`.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - what enrichment did on `main` outside `.nemar/` is applied to the new tree, never undone: the
 *    `.nemar/` line in `.bidsignore` is kept beside upstream's lines, and a root `participants.tsv`
 *    enrichment added is the placeholder of the new tree's subjects;
 *  - under `.nemar/` the tree is the new `main`'s, with the `IsIdenticalTo` edit applied again and
 *    the re-pull commit's own ledger;
 *  - a recorded commit whose message lacks a trailer is refused, and nothing is pushed;
 *  - a re-synthesis a run pushed and did not record is recognized from the head, also beneath an
 *    enrichment commit, and a foreign commit is not.
 *
 * CI TIER: unit-pure (local git repositories in a temporary directory; no server, no network).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepullRow } from "../shared/repull-state";
import { withBidsignoreEntry } from "../shared/standard-edits/bidsignore";
import { buildPlaceholderParticipantsTsv } from "../shared/standard-edits/participants";
import { runCommand } from "../src/lib/git-annex/run-command";
import { openOriginScratch } from "../src/lib/repull/execute/origin";
import { checkMain } from "../src/lib/repull/execute/pull-request";
import {
  recognizeResynthesis,
  resynthesize,
  resynthesizedCommit,
} from "../src/lib/repull/execute/resynthesize";
import { withIsolatedGit } from "../src/lib/repull/execute/workdir";

const DATASET = "xx090555";
const DIGEST = `sha256:${"cd".repeat(32)}`;
const ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let root: string;
let originBase: string;
let origin: string;

async function git(cwd: string, args: string[], stdin?: string): Promise<string> {
  const r = await runCommand(["git", ...args], {
    cwd,
    env: ENV,
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A commit on `parent` holding `files` (path to content; null removes), with `message`. */
async function commit(
  parent: string | null,
  files: Record<string, string | null>,
  message: string,
  env: Record<string, string> = {},
): Promise<string> {
  const index = join(root, `index-${Math.random().toString(36).slice(2)}`);
  const run = (args: string[], stdin?: string) =>
    runCommand(["git", ...args], {
      cwd: origin,
      env: { ...ENV, GIT_INDEX_FILE: index, ...env },
      ...(stdin !== undefined ? { stdin } : {}),
    });
  if (parent) await run(["read-tree", parent]);
  else await run(["read-tree", "--empty"]);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await run(["update-index", "--remove", "--force-remove", path]);
      continue;
    }
    const blob = (await run(["hash-object", "-w", "--stdin"], content)).stdout.trim();
    await run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = (await run(["write-tree"])).stdout.trim();
  const out = await run(
    ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"],
    message,
  );
  rmSync(index, { force: true });
  return out.stdout.trim();
}

const meta = (identical: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ related_identifiers: [{ relation_type: "IsIdenticalTo", identifier: identical }], ...extra }, null, 2)}\n`;

const TRAILERS = `Upstream-Snapshot: ds000001@1.1.0\nRepull-Plan: ${DIGEST}\n`;
const REPULL_DATES = {
  GIT_AUTHOR_NAME: "NEMAR re-pull",
  GIT_AUTHOR_EMAIL: "noreply@nemar.org",
  GIT_AUTHOR_DATE: "1790000000 +0000",
  GIT_COMMITTER_NAME: "NEMAR re-pull",
  GIT_COMMITTER_EMAIL: "noreply@nemar.org",
  GIT_COMMITTER_DATE: "1790000000 +0000",
};

interface World {
  base: string;
  synth: string;
  main: string;
  row: RepullRow;
}

/** A base, the re-pull's commit on it, and a main enrichment moved in all three shapes. */
async function build(o: { synthMessage?: string } = {}): Promise<World> {
  const base = await commit(
    null,
    {
      "dataset_description.json": '{"Name":"x"}\n',
      "sub-01/anat/a.txt": "a\n",
      "sub-02/anat/b.txt": "b\n",
      ".bidsignore": "extra/\n",
      ".nemar/metadata.json": meta("openneuro.ds000001.v1.0.0"),
      ".nemar/corrections.jsonl": '{"line":1}\n',
    },
    "base",
  );
  const synth = await commit(
    base,
    {
      "sub-03/anat/c.txt": "c\n",
      ".bidsignore": "extra/\nmore/\n",
      ".nemar/metadata.json": meta("openneuro.ds000001.v1.1.0"),
    },
    o.synthMessage ?? `Re-pull ds000001 1.0.0 to 1.1.0 as v2.0.0\n\nCounts only.\n\n${TRAILERS}`,
    REPULL_DATES,
  );
  const main = await commit(
    base,
    {
      ".nemar/metadata.json": meta("openneuro.ds000001.v1.0.0", { enriched_at: "2026-10-25" }),
      ".bidsignore": withBidsignoreEntry("extra/\n", ".nemar/").content,
      "participants.tsv": buildPlaceholderParticipantsTsv(["sub-01", "sub-02"]),
    },
    "enrichment",
  );
  await git(origin, ["update-ref", "refs/heads/main", main]);
  await git(origin, ["update-ref", "refs/heads/release/v2.0.0", synth]);
  const row = {
    id: 1,
    dataset_id: DATASET,
    upstream_ds: "ds000001",
    to_tag: "1.1.0",
    to_version: "2.0.0",
    plan_digest: DIGEST,
    base_sha: base,
    synth_sha: synth,
    branch: "release/v2.0.0",
  } as unknown as RepullRow;
  return { base, synth, main, row };
}

async function scratchOf(
  purpose: "resume" | "merge" = "resume",
): Promise<Awaited<ReturnType<typeof openOriginScratch>>> {
  return openOriginScratch({
    configDir: join(root, "config"),
    datasetId: DATASET,
    digest: DIGEST,
    purpose,
    env: { NEMAR_REPULL_ORIGIN_BASE: originBase },
    token: null,
  });
}

const show = (rev: string, path: string) => git(origin, ["show", `${rev}:${path}`]);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "nemar-repull-resynth-"));
  originBase = join(root, "origins");
  origin = join(originBase, DATASET);
  await runCommand(["mkdir", "-p", origin], {});
  await git(origin, ["init", "--quiet", "--bare", "--initial-branch", "main"]);
  await git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("what enrichment did on main is kept", () => {
  test("the .bidsignore line and the participants placeholder; .nemar/ is main's with the edit again", async () => {
    await withIsolatedGit(async () => {
      const w = await build();
      const scratch = await scratchOf();
      try {
        const main = await checkMain({ work: scratch.dir, baseSha: w.base, env: scratch.env });
        expect(main).toBe(w.main);
        const made = await resynthesize({ scratch, row: w.row, newMain: main, liveHead: w.synth });
        const pushed = await git(origin, ["rev-parse", "refs/heads/release/v2.0.0"]);
        expect(pushed).toBe(made.synthSha);
        expect(await git(origin, ["rev-parse", `${pushed}^@`])).toBe(w.main);
        // Upstream's .bidsignore lines stay, and enrichment's line is kept.
        expect(await show(pushed, ".bidsignore")).toBe(
          withBidsignoreEntry("extra/\nmore/\n", ".nemar/").content.trim(),
        );
        // The placeholder enrichment added, of the NEW tree's subjects.
        expect(`${await show(pushed, "participants.tsv")}\n`).toBe(
          buildPlaceholderParticipantsTsv(["sub-01", "sub-02", "sub-03"]),
        );
        // .nemar/: main's metadata with IsIdenticalTo edited again; the re-pull commit's ledger.
        const m = JSON.parse(await show(pushed, ".nemar/metadata.json"));
        expect(m).toMatchObject({ enriched_at: "2026-10-25" });
        expect(m.related_identifiers[0].identifier).toBe("openneuro.ds000001.v1.1.0");
        expect(await show(pushed, ".nemar/corrections.jsonl")).toBe(
          await show(w.synth, ".nemar/corrections.jsonl"),
        );
        // Every other path is the recorded commit's.
        expect(await show(pushed, "sub-03/anat/c.txt")).toBe("c");
        expect(await git(origin, ["log", "-1", "--format=%B", pushed])).toBe(
          await git(origin, ["log", "-1", "--format=%B", w.synth]),
        );
      } finally {
        scratch.close();
      }
    });
  });
});

describe("the recorded commit's message", () => {
  test("one that lacks a trailer is refused, and nothing is pushed", async () => {
    await withIsolatedGit(async () => {
      const w = await build({
        synthMessage: `Re-pull ds000001 1.0.0 to 1.1.0\n\nCounts only.\n\nUpstream-Snapshot: ds000001@1.1.0\n`,
      });
      const scratch = await scratchOf();
      try {
        await checkMain({ work: scratch.dir, baseSha: w.base, env: scratch.env });
        await expect(
          resynthesize({ scratch, row: w.row, newMain: w.main, liveHead: w.synth }),
        ).rejects.toMatchObject({ code: "synthesis-mismatch" });
        expect(await git(origin, ["rev-parse", "refs/heads/release/v2.0.0"])).toBe(w.synth);
      } finally {
        scratch.close();
      }
    });
  });
});

describe("a re-synthesis pushed and not recorded", () => {
  test("is recognized from the head, beneath an enrichment commit too; a foreign commit is not", async () => {
    await withIsolatedGit(async () => {
      const w = await build();
      const scratch = await scratchOf();
      try {
        await checkMain({ work: scratch.dir, baseSha: w.base, env: scratch.env });
        const made = await resynthesize({
          scratch,
          row: w.row,
          newMain: w.main,
          liveHead: w.synth,
        });
        // Enrichment commits onto the release branch after the push.
        const enriched = await commit(
          made.synthSha,
          {
            ".nemar/metadata.json": meta("openneuro.ds000001.v1.1.0", {
              enriched_at: "2026-10-26",
            }),
          },
          "enrichment",
        );
        await git(origin, ["update-ref", "refs/heads/release/v2.0.0", enriched]);
        // A later run's own scratch repository, which holds only what it fetched.
        const fresh = await scratchOf("merge");
        try {
          await runCommand(
            [
              "git",
              "fetch",
              "--quiet",
              "--depth=22",
              "origin",
              "+refs/heads/release/v2.0.0:refs/remotes/origin/release/v2.0.0",
            ],
            { cwd: fresh.dir, env: ENV },
          );
          for (const head of [made.synthSha, enriched]) {
            expect(await recognizeResynthesis({ scratch: fresh, row: w.row, head })).toEqual({
              synthSha: made.synthSha,
              synthTree: made.synthTree,
              baseSha: w.main,
            });
          }
          // The same commit is made again from the same inputs: that is what recognition reads.
          expect(
            (await resynthesizedCommit({ scratch: fresh, row: w.row, newMain: w.main })).synthSha,
          ).toBe(made.synthSha);
          const foreign = await commit(made.synthSha, { "README.md": "by hand\n" }, "by hand");
          await git(origin, ["update-ref", "refs/heads/release/v2.0.0", foreign]);
          await runCommand(
            [
              "git",
              "fetch",
              "--quiet",
              "--depth=22",
              "origin",
              "+refs/heads/release/v2.0.0:refs/remotes/origin/release/v2.0.0",
            ],
            { cwd: fresh.dir, env: ENV },
          );
          expect(await recognizeResynthesis({ scratch: fresh, row: w.row, head: foreign })).toBe(
            null,
          );
        } finally {
          fresh.close();
        }
      } finally {
        scratch.close();
      }
    });
  });
});
