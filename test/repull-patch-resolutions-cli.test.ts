/**
 * N.0.1's resolutions and its annexed replay (ADR 0111: a conflict stays out of N.0.1 until an
 * administrator resolves it, and N.0.1 copies nothing; epic #1046 phase 6, #1912), driven through
 * the real entry point against `repull-pr-world.ts` in two worlds other than the default one:
 *
 *  - every conflict and correction subtype, a README NEMAR edited, and a clean recording NEMAR
 *    replaced with its own annexed content (a correction whose identity is `A:<key>`):
 *    five conflicts and three corrections;
 *  - a README NEMAR edited and nothing else: conflicts (the README family) and no correction;
 *  - no `participants.tsv` on either side, so enrichment can add its placeholder to `main` after a
 *    pull request's gates.
 *
 * The real CLI and the real Worker routes over bun:sqlite, reached through TEST_API_URL in the
 * child's environment; GitHub and S3 are stand-ins. No mocks.
 *
 * The properties, each with a test:
 *  - naming one conflict of several with `--take-ours` waits, and pushes nothing, until the others
 *    are named or `--keep-upstream` leaves them on upstream's side; the run then says how many
 *    were resolved and how many were left;
 *  - the annexed correction is replayed as NEMAR's own entry, byte for byte, and only when its key
 *    is in NEMAR's bucket at its declared size (`patch-key-absent`) and not dead on NEMAR's
 *    git-annex branch (`patch-key-dead`);
 *  - with no correction, `--keep-upstream` completes the record without an N.0.1;
 *  - enrichment that writes outside `.nemar/` and `.github/` on `main` after the gates makes the
 *    merge refuse before any claim (`merge-main-moved`), for N.0.0 and N.0.1 alike, and resume
 *    then makes the commit again on the new main, which is screened, gated, merged and released.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { which } from "bun";
import { hashDirLower } from "../scripts/scrub/git/git-lib";
import { ensureParticipantsTsv } from "../shared/standard-edits/participants";
import { PATHS, gitIn, writeAnnexBranchFile } from "./helpers/repull-fixture";
import { type RepullWorld, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const hasRef = async (w: RepullWorld, ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";
const resume = (w: RepullWorld, extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);

/** N.0.0 merged by the real gate, tagged v2.0.0, its version row written, and its lock recorded. */
async function releasedAndLocked(w: RepullWorld): Promise<void> {
  const head = w.row().head_sha as string;
  expect((await resume(w)).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume(w)).exitCode).toBe(0);
  const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(merged.exitCode, merged.all).toBe(0);
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  // The release and the lock; the plan's conflicts then wait for a decision.
  const locked = await resume(w);
  expect(locked.exitCode, locked.all).toBe(3);
  expect(w.row().status).toBe("released");
  expect(JSON.parse(w.row().counts).locked).toBeGreaterThan(0);
}

describe.skipIf(!awsInstalled)("several conflicts and an annexed correction", () => {
  let w: RepullWorld;
  beforeAll(async () => {
    w = await startRepullWorld({
      fixture: {
        subtypes: true,
        readmeEdit: true,
        noContributorEdits: true,
        annexedCorrection: true,
      },
    });
  });
  afterAll(() => w?.stop());
  beforeEach(async () => {
    await w.restore();
  });

  /** The key the plan names as NEMAR's side of the replaced recording. */
  function correctedKey(): string {
    const plan = JSON.parse(readFileSync(w.plan, "utf8")) as {
      paths: Array<{ path: string; ours: string; class: string }>;
    };
    const row = plan.paths.find((p) => p.path === PATHS.cleanEdf);
    // Read before any matcher sees the row.
    const ours = String(row?.ours);
    expect(row?.class).toBe("correction");
    expect(ours).toMatch(/^A:/);
    return ours.slice(2);
  }

  test("the plan counts five conflicts (the README family's two among them) and three corrections", () => {
    expect(JSON.parse(w.row().counts)).toMatchObject({ conflicts: 5, corrections: 3 });
  });

  test("naming one conflict of five waits until the rest are named or left upstream's", async () => {
    await releasedAndLocked(w);
    const partial = await resume(w, ["--take-ours", PATHS.channels]);
    expect(partial.exitCode, partial.all).toBe(3);
    expect(partial.all).toContain("4 conflict(s) the plan lists that no --take-ours names");
    expect(w.row().status).toBe("released");
    expect(await hasRef(w, "refs/heads/release/v2.0.1")).toBe(false);

    const decided = await resume(w, ["--take-ours", PATHS.channels, "--keep-upstream"]);
    expect(decided.exitCode, decided.all).toBe(3);
    expect(decided.all).toContain(
      "1 conflict(s) resolved to NEMAR's side, 4 left on upstream's side",
    );
    expect(w.row().status).toBe("patch_synthesized");
    expect(JSON.parse(w.row().counts)).toMatchObject({ resolutions: 1 });
    // NEMAR deleted the channels file, so its side is the deletion.
    const patch = w.row().patch_head_sha as string;
    const listed = await gitIn(w.fx.originRepo, ["ls-tree", "-r", "--name-only", patch]);
    expect(listed.split("\n")).not.toContain(PATHS.channels);
  });

  test("the annexed correction is NEMAR's own entry again, byte for byte", async () => {
    await releasedAndLocked(w);
    const run = await resume(w, ["--keep-upstream"]);
    expect(run.exitCode, run.all).toBe(3);
    const row = w.row();
    expect(row.status).toBe("patch_synthesized");
    const oid = async (rev: string) =>
      (await gitIn(w.fx.originRepo, ["rev-parse", `${rev}:${PATHS.cleanEdf}`])).trim();
    expect(await oid(row.patch_head_sha as string)).toBe(await oid(row.base_sha));
    expect(await oid(row.merge_sha as string)).not.toBe(await oid(row.base_sha));
  });

  test("an annexed key not in NEMAR's bucket at its declared size refuses: patch-key-absent", async () => {
    await releasedAndLocked(w);
    w.s3.putObject("nemar", `${w.fx.datasetId}/objects/${correctedKey()}`, new Uint8Array(3));
    const run = await resume(w, ["--keep-upstream"]);
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("patch-key-absent");
    expect(w.row().status).toBe("released");
    expect(String(w.row().last_error)).toContain("patch-key-absent");
    expect(await hasRef(w, "refs/heads/release/v2.0.1")).toBe(false);
  });

  test("an annexed key dead on NEMAR's git-annex branch refuses: patch-key-dead", async () => {
    await releasedAndLocked(w);
    const key = correctedKey();
    await writeAnnexBranchFile(
      w.fx.originRepo,
      `${hashDirLower(key)}${key}.log`,
      `1790000001s 1 ${w.fx.nemarUuid}\n1790000999s X ${w.fx.nemarUuid}\n`,
    );
    const run = await resume(w, ["--keep-upstream"]);
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("patch-key-dead");
    expect(w.row().status).toBe("released");
    expect(await hasRef(w, "refs/heads/release/v2.0.1")).toBe(false);
  });
});

describe.skipIf(!awsInstalled)("a conflict and no correction", () => {
  let w: RepullWorld;
  beforeAll(async () => {
    w = await startRepullWorld({ fixture: { noContributorEdits: true, readmeEdit: true } });
  });
  afterAll(() => w?.stop());

  test("--keep-upstream completes the record, and no N.0.1 is made", async () => {
    const counts = JSON.parse(w.row().counts);
    expect(counts.corrections).toBe(0);
    expect(counts.conflicts).toBeGreaterThan(0);
    await releasedAndLocked(w);
    const run = await resume(w, ["--keep-upstream"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("every conflict stays on upstream's side");
    expect(w.row()).toMatchObject({ status: "complete", patch_version: null });
    expect(await hasRef(w, "refs/heads/release/v2.0.1")).toBe(false);
  });
});

describe.skipIf(!awsInstalled)("enrichment between the gates and the merge", () => {
  let w: RepullWorld;
  beforeAll(async () => {
    w = await startRepullWorld({ fixture: { generatedParticipants: "none" } });
  });
  afterAll(() => w?.stop());
  beforeEach(async () => {
    await w.restore();
  });

  const merge = () => w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  const mainHead = async () =>
    (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
  const merges = () => w.gh.seen.filter((x) => x.method === "PUT" && x.path.endsWith("/merge"));
  /** What enrichment does to a tree with subjects and no file of its own: its placeholder. */
  async function enrichParticipants(): Promise<string> {
    const listed = (
      await gitIn(w.fx.originRepo, ["ls-tree", "-r", "--name-only", "refs/heads/main"])
    )
      .split("\n")
      .filter(Boolean);
    const placeholder = ensureParticipantsTsv(listed.map((path) => ({ path }))).contentToCommit;
    if (placeholder === null) throw new Error("main already has a participants.tsv");
    return w.commitOnto("refs/heads/main", "participants.tsv", placeholder, "Add participants.tsv");
  }
  /** The screen of the record's current head of `column`, reported clean, then the gates. */
  async function gate(column: "head_sha" | "patch_head_sha"): Promise<void> {
    await w.reportScreen(w.row()[column] as string, "clean");
    const run = await resume(w);
    expect(run.exitCode, run.all).toBe(0);
  }

  test("N.0.0: the merge refuses before any claim, and resume makes the commit again", async () => {
    expect((await resume(w)).exitCode).toBe(3);
    await gate("head_sha");
    expect(w.row().status).toBe("gates_clear");
    const before = w.row();
    const moved = await enrichParticipants();

    const refused = await merge();
    expect(refused.exitCode, refused.all).not.toBe(0);
    expect(refused.all).toContain("merge-main-moved");
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });

    const again = await resume(w);
    expect(again.exitCode, again.all).toBe(3);
    expect(w.row()).toMatchObject({ status: "pr_open", base_sha: moved });
    expect(w.row().head_sha).not.toBe(before.head_sha);
    await gate("head_sha");
    const merged = await merge();
    expect(merged.exitCode, merged.all).toBe(0);
    expect(w.row().status).toBe("merged");
    expect(await mainHead()).toBe(w.row().merge_sha);
  });

  test("N.0.1: the merge refuses before any claim, and the made-again N.0.1 is released", async () => {
    expect((await resume(w)).exitCode).toBe(3);
    await gate("head_sha");
    expect((await merge()).exitCode).toBe(0);
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");
    // No conflict: the release, the lock and N.0.1 in one run, which waits for N.0.1's screen.
    const made = await resume(w);
    expect(made.exitCode, made.all).toBe(3);
    expect(w.row().status).toBe("patch_synthesized");
    await gate("patch_head_sha");
    expect(w.row().status).toBe("patch_gates_clear");
    const before = w.row();
    const moved = await enrichParticipants();
    const n1 = before.patch_pr_number as number;
    const n1Merges = () => merges().filter((x) => x.path.endsWith(`/pulls/${n1}/merge`));

    const refused = await merge();
    expect(refused.exitCode, refused.all).not.toBe(0);
    expect(refused.all).toContain("merge-main-moved");
    expect(n1Merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "patch_gates_clear", patch_merge_claim_sha: null });

    const again = await resume(w);
    expect(again.exitCode, again.all).toBe(3);
    expect(w.row()).toMatchObject({ status: "patch_synthesized", patch_base_sha: moved });
    expect(w.row().patch_head_sha).not.toBe(before.patch_head_sha);
    await gate("patch_head_sha");
    expect((await merge()).exitCode).toBe(0);
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const done = await resume(w);
    expect(done.exitCode, done.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
  });
});
