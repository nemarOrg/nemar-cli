/**
 * The three-shape head check (`src/lib/repull/execute/head.ts`; ADR 0111, decision 2; epic #1046
 * phase 6): a branch that moved only by what NEMAR's enrichment writes is still the re-pull's, and
 * any other commit is not. Driven on REAL git repositories made here, one shape and one negative
 * per test, because a head check that accepts a foreign commit lets the re-pull push over someone
 * else's work, and one that refuses enrichment strands every re-pull.
 *
 * `checkMain` and `pushRelease` map the verdict to fixed words; their `unreadable` case is driven
 * here on a real clone of a real bare repository.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeAcceptanceLine } from "../shared/repull-merge-acceptance";
import { NEMAR_BIDSIGNORE_ENTRY, withBidsignoreEntry } from "../shared/standard-edits/bidsignore";
import {
  buildPlaceholderParticipantsTsv,
  enumerateBidsSubjects,
} from "../shared/standard-edits/participants";
import {
  ENRICHMENT_MAX_COMMITS,
  type HeadVerdict,
  enrichmentOnlySince,
} from "../src/lib/repull/execute/head";
import { checkMain, pushRelease } from "../src/lib/repull/execute/pull-request";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function g(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let root: string;
let repo: string;
let n = 0;

function put(path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Commit everything staged by `change`, returning the new commit id. */
function commit(change: () => void): string {
  change();
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "--allow-empty", "-m", `c${++n}`);
  return g(repo, "rev-parse", "HEAD");
}

const SUBJECT_FILES = ["sub-01/eeg/sub-01_task-a_eeg.edf", "sub-02/eeg/sub-02_task-a_eeg.edf"];

function placeholder(): string {
  return buildPlaceholderParticipantsTsv(
    enumerateBidsSubjects(SUBJECT_FILES.map((path) => ({ path }))),
  );
}

let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-repull-head-"));
  repo = join(root, "work");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  base = commit(() => {
    put("dataset_description.json", '{"Name":"x"}\n');
    put("README.md", "readme\n");
    for (const f of SUBJECT_FILES) put(f, "data\n");
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function verdict(to: string, from = base): Promise<HeadVerdict> {
  return enrichmentOnlySince(repo, from, to);
}

function foreign(v: HeadVerdict, detail?: string): void {
  expect(v.ok).toBe(false);
  if (!v.ok) {
    expect(v.code).toBe("head-foreign");
    if (detail) expect(v.detail).toContain(detail);
  }
}

describe("the head is the re-pull's: the three shapes enrichment writes", () => {
  test("the same commit, and no commits, are the re-pull's own", async () => {
    expect(await verdict(base)).toEqual({ ok: true, head: base, commits: 0 });
  });

  test("a regular file added or changed under .nemar/ is enrichment's metadata", async () => {
    const a = commit(() => put(".nemar/metadata.json", '{"a":1}\n'));
    const b = commit(() => put(".nemar/metadata.json", '{"a":2}\n'));
    expect(await verdict(a)).toEqual({ ok: true, head: a, commits: 1 });
    expect(await verdict(b)).toEqual({ ok: true, head: b, commits: 2 });
  });

  test("the .nemar/ line added to .bidsignore, exactly as withBidsignoreEntry adds it, is accepted", async () => {
    const withEntry = commit(() =>
      put(".bidsignore", withBidsignoreEntry("", NEMAR_BIDSIGNORE_ENTRY).content),
    );
    expect((await verdict(withEntry)).ok).toBe(true);
    // An existing file gains the line after its own, trailing whitespace trimmed.
    g(repo, "reset", "-q", "--hard", base);
    const existing = commit(() => put(".bidsignore", "*.tmp  \n"));
    const added = commit(() =>
      put(".bidsignore", withBidsignoreEntry("*.tmp  \n", NEMAR_BIDSIGNORE_ENTRY).content),
    );
    expect((await verdict(added, existing)).ok).toBe(true);
  });

  test("a root participants.tsv that is, byte for byte, the placeholder of the commit's subjects is accepted", async () => {
    const head = commit(() => put("participants.tsv", placeholder()));
    expect((await verdict(head)).ok).toBe(true);
  });
});

describe("main past N.0.0's merge: NEMAR's acceptance of a merge made without its trailers", () => {
  const plan = `sha256:${"a".repeat(64)}`;
  const scrubLine = `${JSON.stringify({
    version: 1,
    at: "2026-10-08T00:00:00.000Z",
    dataset: "on099999",
    action: "repull-scrubbed",
    versions: [],
    counts: { json_values_blanked: 1 },
    scanner: "identifier-scan@abcdef1",
    verification: "scanner-clean",
    actor: "nemar-repull",
  })}\n`;
  const acceptanceOf = (merge: string) =>
    `${mergeAcceptanceLine({
      dataset: "on099999",
      version: "2.0.0",
      mergeSha: merge,
      planDigest: plan,
      scanner: "identifier-scan@abcdef1",
      at: "2026-10-29T12:00:00.000Z",
    })}\n`;
  /** The merge: the scrub's line beside a file of the delta. Then main's ledger as it stands. */
  const merged = () =>
    commit(() => {
      put(".nemar/corrections.jsonl", scrubLine);
      put("sub-03/eeg/sub-03_task-a_eeg.edf", "data\n");
    });

  test("a commit of its own appending the acceptance line is accepted on main only", async () => {
    const merge = merged();
    const attested = commit(() =>
      put(".nemar/corrections.jsonl", `${scrubLine}${acceptanceOf(merge)}`),
    );
    expect(await enrichmentOnlySince(repo, merge, attested, { acceptances: true })).toEqual({
      ok: true,
      head: attested,
      commits: 1,
    });
    // Beneath enrichment too, as main moves on after it.
    const enriched = commit(() => put(".nemar/metadata.json", '{"a":1}\n'));
    expect((await enrichmentOnlySince(repo, merge, enriched, { acceptances: true })).ok).toBe(true);
    // Never on a release branch, where the check is made without it.
    foreign(await enrichmentOnlySince(repo, merge, attested));
  });

  test("the acceptance beside another file, an edited earlier line, another word or an invalid line is foreign", async () => {
    const cases: Array<[string, () => void]> = [
      [
        "beside another file",
        () => {
          put(".nemar/corrections.jsonl", `${scrubLine}${acceptanceOf("0".repeat(40))}`);
          put(".nemar/metadata.json", "{}\n");
        },
      ],
      [
        "an earlier line edited",
        () =>
          put(
            ".nemar/corrections.jsonl",
            `${scrubLine.replace("json_values_blanked", "headers_scrubbed")}${acceptanceOf("0".repeat(40))}`,
          ),
      ],
      [
        "another word",
        () =>
          put(
            ".nemar/corrections.jsonl",
            `${scrubLine}${scrubLine.replace("2026-10-08", "2026-10-09")}`,
          ),
      ],
      [
        "an invalid acceptance line",
        () =>
          put(
            ".nemar/corrections.jsonl",
            `${scrubLine}${acceptanceOf("0".repeat(40)).replace("0".repeat(40), "0".repeat(12))}`,
          ),
      ],
    ];
    for (const [label, change] of cases) {
      g(repo, "reset", "-q", "--hard", base);
      const merge = merged();
      const head = commit(change);
      const v = await enrichmentOnlySince(repo, merge, head, { acceptances: true });
      expect(v.ok, label).toBe(false);
    }
  });
});

describe("the head is someone else's", () => {
  test("a merge commit is foreign", async () => {
    g(repo, "checkout", "-q", "-b", "side");
    commit(() => put(".nemar/side.json", "{}\n"));
    g(repo, "checkout", "-q", "main");
    commit(() => put(".nemar/main.json", "{}\n"));
    g(repo, "merge", "-q", "--no-ff", "-m", "merge", "side");
    foreign(await verdict(g(repo, "rev-parse", "HEAD")), "a merge commit");
  });

  test("the privacy ledger is never enrichment's: its new line would change what a plan refuses", async () => {
    foreign(await verdict(commit(() => put(".nemar/corrections.jsonl", "{}\n"))));
    // Not even beside an ordinary metadata file in the same commit.
    g(repo, "reset", "-q", "--hard", base);
    foreign(
      await verdict(
        commit(() => {
          put(".nemar/metadata.json", "{}\n");
          put(".nemar/corrections.jsonl", "{}\n");
        }),
      ),
    );
  });

  test("a deletion under .nemar/ is foreign", async () => {
    const meta = commit(() => put(".nemar/metadata.json", "{}\n"));
    const removed = commit(() => rmSync(join(repo, ".nemar/metadata.json")));
    foreign(await verdict(removed, meta));
  });

  test("a file under .nemar/ that is not a regular file is foreign", async () => {
    const exec = commit(() => {
      put(".nemar/run.sh", "#!/bin/sh\n");
      chmodSync(join(repo, ".nemar/run.sh"), 0o755);
    });
    foreign(await verdict(exec));
    g(repo, "reset", "-q", "--hard", base);
    const link = commit(() => {
      mkdirSync(join(repo, ".nemar"), { recursive: true });
      symlinkSync("../README.md", join(repo, ".nemar/link"));
    });
    foreign(await verdict(link));
  });

  test(".bidsignore content other than the .nemar/ line is foreign", async () => {
    foreign(await verdict(commit(() => put(".bidsignore", "*.tmp\n"))));
    g(repo, "reset", "-q", "--hard", base);
    // The right line plus another, and the right line missing its newline.
    foreign(await verdict(commit(() => put(".bidsignore", ".nemar/\n*.tmp\n"))));
    g(repo, "reset", "-q", "--hard", base);
    foreign(await verdict(commit(() => put(".bidsignore", ".nemar/"))));
    g(repo, "reset", "-q", "--hard", base);
    // A change that does not add the line (it was there already) is not enrichment either.
    const had = commit(() => put(".bidsignore", ".nemar/\n"));
    foreign(
      await verdict(
        commit(() => put(".bidsignore", ".nemar/\n*.tmp\n")),
        had,
      ),
    );
  });

  test("a root participants.tsv that is not the placeholder is foreign; so is one that replaces another", async () => {
    foreign(await verdict(commit(() => put("participants.tsv", "participant_id\nsub-01\n"))));
    g(repo, "reset", "-q", "--hard", base);
    const had = commit(() => put("participants.tsv", placeholder()));
    foreign(
      await verdict(
        commit(() => put("participants.tsv", `${placeholder()}extra\n`)),
        had,
      ),
    );
    // A tree with no subjects has no placeholder to match.
    const empty = join(root, "empty");
    mkdirSync(empty);
    g(empty, "init", "-q", "-b", "main");
    writeFileSync(join(empty, "README.md"), "x\n");
    g(empty, "add", "-A");
    g(empty, "commit", "-q", "-m", "a");
    const emptyBase = g(empty, "rev-parse", "HEAD");
    writeFileSync(join(empty, "participants.tsv"), "participant_id\tage\tsex\n");
    g(empty, "add", "-A");
    g(empty, "commit", "-q", "-m", "b");
    foreign(await enrichmentOnlySince(empty, emptyBase, g(empty, "rev-parse", "HEAD")));
  });

  test("a commit touching any path outside the three shapes is foreign, even beside a valid one", async () => {
    foreign(await verdict(commit(() => put("README.md", "changed\n"))), "does not write");
    g(repo, "reset", "-q", "--hard", base);
    foreign(
      await verdict(
        commit(() => {
          put(".nemar/metadata.json", "{}\n");
          put("sub-01/eeg/sub-01_task-a_eeg.edf", "other\n");
        }),
      ),
    );
    g(repo, "reset", "-q", "--hard", base);
    // A later commit in a series is judged too.
    commit(() => put(".nemar/metadata.json", "{}\n"));
    foreign(await verdict(commit(() => put("dataset_description.json", '{"Name":"y"}\n'))));
  });

  test("more than the cap of commits is foreign, and exactly the cap is not", async () => {
    let head = base;
    for (let i = 1; i <= ENRICHMENT_MAX_COMMITS; i++) {
      head = commit(() => put(".nemar/metadata.json", `{"i":${i}}\n`));
    }
    expect(await verdict(head)).toEqual({ ok: true, head, commits: ENRICHMENT_MAX_COMMITS });
    const over = commit(() => put(".nemar/metadata.json", '{"i":"over"}\n'));
    foreign(await verdict(over), `${ENRICHMENT_MAX_COMMITS + 1} commits`);
  });

  test("a commit that does not descend from the recorded one is foreign; one not in the clone is unreadable", async () => {
    g(repo, "checkout", "-q", "-b", "other", base);
    const side = commit(() => put(".nemar/other.json", "{}\n"));
    g(repo, "checkout", "-q", "main");
    const main = commit(() => put(".nemar/main.json", "{}\n"));
    foreign(await verdict(side, main), "not a descendant");
    const missing = "1".repeat(40);
    const v = await verdict(missing);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("unreadable");
  });
});

describe("what the callers say of an unreadable head", () => {
  test("main that cannot be judged from this clone is main-unreadable, not main-moved", async () => {
    // A real bare origin whose main is a commit the clone does not have the base of: the recorded
    // base is a commit that exists nowhere, so the clone cannot tell and must not say "moved".
    const origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", "-b", "main", origin);
    g(repo, "push", "-q", origin, "main");
    g(repo, "remote", "add", "origin", origin);
    const refused = await checkMain({ work: repo, baseSha: "2".repeat(40), env: undefined }).catch(
      (e) => e,
    );
    expect(refused).toBeInstanceOf(ExecuteRefused);
    expect((refused as ExecuteRefused).code).toBe("main-unreadable");
    // The same origin judged against a real base that main has moved from by a foreign commit.
    commit(() => put("README.md", "moved\n"));
    g(repo, "push", "-q", origin, "main");
    const moved = await checkMain({ work: repo, baseSha: base, env: undefined }).catch((e) => e);
    expect((moved as ExecuteRefused).code).toBe("main-moved");
    // And by an enrichment commit it is accepted.
    g(repo, "reset", "-q", "--hard", base);
    commit(() => put(".nemar/metadata.json", "{}\n"));
    g(repo, "push", "-q", "-f", origin, "main");
    expect(await checkMain({ work: repo, baseSha: base, env: undefined })).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  test("a release branch judged against a commit the clone lacks is branch-unreadable, and nothing is pushed", async () => {
    // Origin's release branch holds a commit made elsewhere; the recorded synthesized commit is not
    // in this clone (a lost or pruned working clone), so the clone cannot tell whose the branch is
    // and must not call it foreign.
    const origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", "-b", "main", origin);
    g(repo, "remote", "add", "origin", origin);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    g(elsewhere, "init", "-q", "-b", "main");
    writeFileSync(join(elsewhere, "x.txt"), "x\n");
    g(elsewhere, "add", "-A");
    g(elsewhere, "commit", "-q", "-m", "x");
    const held = g(elsewhere, "rev-parse", "HEAD");
    const ref = "refs/heads/release/v2.0.0";
    g(elsewhere, "push", "-q", origin, `${held}:${ref}`);
    const refused = await pushRelease({
      work: repo,
      synthSha: "3".repeat(40),
      version: "2.0.0",
      push: { versions: ["2.0.0"] },
      env: undefined,
    }).catch((e) => e);
    expect(refused).toBeInstanceOf(ExecuteRefused);
    expect((refused as ExecuteRefused).code).toBe("branch-unreadable");
    expect(g(origin, "rev-parse", ref)).toBe(held);
  });
});
