/**
 * `nemar admin repull merge <id>`: the one gate a re-pull's pull request merges through (ADR 0111,
 * decisions 1, 6 and 7; epic #1046 phase 6, #1912), driven through the real entry point against
 * `repull-pr-world.ts` (a re-pull executed to `pr_open` by the real `execute`, then taken to
 * `gates_clear` by the real `resume`; the real API over bun:sqlite on a loopback port named in the
 * child's environment; stand-ins for GitHub and S3 only, GitHub's squash merge committing onto
 * the bare origin's `main`). No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the merge is a squash at the screened `sha`, sent after the claim, with a message whose last
 *    paragraph is both of the re-pull commit's trailers as git reads them, and is recorded;
 *  - a cap that is used up sends no merge; a `main` moved by a commit enrichment does not make, a
 *    state that is not `clean`, and a review that is still running are refused before the claim;
 *  - a pull request whose head or base repository is not `nemarDatasets/<dataset_id>` (a fork's, a
 *    deleted fork's, another base) is refused before the claim, the name compared without case;
 *  - a squash message without both trailers as its last paragraph is refused at the gate;
 *  - a head that moves between the gate's last read and the merge is refused by GitHub, because
 *    the merge carries the screened `sha`, and the claim is then kept, not repeated;
 *  - a merge whose answer is lost keeps its claim, and the next `resume` records the merge.
 *
 * What only the canary and the first production runs can check: that GitHub's real merge endpoint
 * refuses a moved head for `sha` as the stand-in does (a 409), that it writes `commit_title` and
 * `commit_message` as the squash commit's message unchanged, and how it answers a ruleset.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
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
import { which } from "bun";
import { seedReview } from "../backend/test/helpers/pr-queue-fixtures";
import { ADMIN_TOKEN } from "./helpers/github-standin";
import { gitIn } from "./helpers/repull-fixture";
import {
  type RepullWorld,
  enrichedMetadata,
  prKey,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

let w: RepullWorld;

beforeAll(async () => {
  if (awsInstalled) w = await startRepullWorld();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const resume = () => w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
const merge = (extra: string[] = []) =>
  w.cli(["repull", "merge", w.fx.datasetId, "--yes", ...extra]);

/** The record taken to gates_clear the way an administrator takes it: resume, the screen, resume. */
async function toGates(): Promise<string> {
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
  return head;
}

const merges = () => w.gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));
const mainOf = async () => (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();

describe.skipIf(!awsInstalled)("the merge", () => {
  test("squashes at the screened sha after the claim, its message ends with both trailers, and is recorded", async () => {
    const head = await toGates();
    const mainBefore = await mainOf();
    // When the claim reaches the API, no merge has been sent yet.
    let mergesAtClaim = -1;
    w.setApiHook(async (req) => {
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")) {
        const body = (await req.json()) as { fields?: Record<string, unknown> };
        if (body.fields?.merge_claim_sha) mergesAtClaim = merges().length;
      }
    });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(mergesAtClaim).toBe(0);

    const sent = merges();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe(ADMIN_TOKEN);
    expect(sent[0]?.body).toMatchObject({
      sha: head,
      merge_method: "squash",
      commit_title: `Release v2.0.0 (#${w.row().pr_number})`,
    });
    // On main: one squash commit, the synthesized tree, both trailers as git reads them.
    const mainAfter = await mainOf();
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${mainAfter}^@`])).trim()).toBe(mainBefore);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${mainAfter}^{tree}`])).trim()).toBe(
      w.row().synth_tree,
    );
    const trailers = (
      await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", mainAfter])
    )
      .trim()
      .split("\n");
    const synthTrailers = (
      await gitIn(w.fx.originRepo, [
        "log",
        "-1",
        "--format=%(trailers:only,unfold)",
        w.row().synth_sha,
      ])
    )
      .trim()
      .split("\n");
    expect(trailers).toEqual(synthTrailers);
    expect(trailers).toHaveLength(2);

    expect(w.row()).toMatchObject({
      status: "merged",
      merge_sha: mainAfter,
      merge_claim_sha: head,
    });
    // A claim was held and the head was the screened one: neither count is written.
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_outside_tool");
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_unscreened_head");
  });

  test("a cap that is used up sends no merge", async () => {
    await toGates();
    w.workerEnv.REPULL_DAILY_MERGE_CAP = "0";
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(cap)");
    expect(merges()).toEqual([]);
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
  });

  test("main moved by a commit enrichment does not make: refused before the claim", async () => {
    await toGates();
    await w.commitOnto("refs/heads/main", "README.md", "A change by hand.\n");
    const writes = w.apiWrites.length;
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(main-moved)");
    expect(w.apiWrites.length).toBe(writes);
    expect(merges()).toEqual([]);
  });

  test("main moved by enrichment only is merged", async () => {
    await toGates();
    await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
      "enrichment",
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("merged");
  });

  test("a state that is not clean is refused before the claim", async () => {
    await toGates();
    Object.assign(w.gh.pulls[prKey(w)] as object, { mergeableState: "blocked" });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(github)");
    expect(w.row().merge_claim_sha).toBeNull();
    expect(merges()).toEqual([]);
  });

  test("the review of the re-pull's own head is waived at the merge: one still running or failed needs no --force", async () => {
    const head = await toGates();
    // A review of the head that ran before NEMAR recorded it, and failed, as the contributor review
    // fails an upstream delta; then one restarted on the same head. Neither holds the merge (ADR
    // 0116), and the confirmation says why instead.
    seedReview(w.db(), {
      ds: w.fx.datasetId,
      n: w.row().pr_number as number,
      sha: head,
      state: "reported",
      verdict: "fail",
    });
    w.db().run(
      "UPDATE pr_reviews SET state = 'dispatched', verdict = NULL, report = NULL, decided_at = NULL, created_at = datetime('now')",
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("The automated review is waived for this commit");
    expect(run.all).not.toContain("(review)");
    expect(w.row().status).toBe("merged");
  });

  test("a record that is not gates_clear is not ready, and names resume", async () => {
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(not-ready)");
    expect(run.all).toContain(`nemar admin repull resume ${w.fx.datasetId}`);
    expect(merges()).toEqual([]);
  });

  test("a squash message without both trailers as its last paragraph is refused at the gate", async () => {
    await toGates();
    // A record whose tag the ledger proof's pattern cannot read as a trailer value: the message the
    // gate would send could not prove the commit is the re-pull's.
    w.db().run("UPDATE upstream_repulls SET to_tag = '1.1.0 (final)'");
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(message)");
    expect(w.row().merge_claim_sha).toBeNull();
    expect(merges()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("what GitHub answers after the claim", () => {
  test("a head that moves between the gate and the merge is refused by GitHub, and the claim is kept", async () => {
    const head = await toGates();
    const ref = `refs/heads/${w.row().branch}`;
    const mainBefore = await mainOf();
    w.gh.beforeMerge = async () => {
      w.gh.beforeMerge = null;
      await w.commitOnto(
        ref,
        ".nemar/metadata.json",
        await enrichedMetadata(w.fx.originRepo, ref),
        "enrichment",
      );
    };
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body?.sha).toBe(head);
    expect(await mainOf()).toBe(mainBefore);
    // The claim is kept (it is younger than the Worker's bound), so the unit is not repeated.
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: head });
    // Merging again is not ready (the head moved since the gates), and makes no second claim.
    const claims = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
    const before = claims();
    const again = await merge();
    expect(again.exitCode, again.all).toBe(1);
    expect(again.all).toContain("(not-ready)");
    expect(claims()).toBe(before);
    expect(merges()).toHaveLength(1);
  });

  test("a merge whose answer is lost keeps its claim, and the next resume records the merge", async () => {
    const head = await toGates();
    w.gh.lostMergeAnswers = true;
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("may have merged it");
    expect(w.row()).toMatchObject({ status: "gates_clear", merge_claim_sha: head });
    const mainNow = await mainOf();
    expect(mainNow).not.toBe(w.row().base_sha);
    const next = await resume();
    expect(next.all).toContain("is merged");
    expect(w.row()).toMatchObject({ status: "merged", merge_sha: mainNow });
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("merged_outside_tool");
  });
});

const transitions = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;

describe.skipIf(!awsInstalled)("the gate's own checks, before the claim", () => {
  test("a draft, and a pull request into another branch, are not ready; nothing is claimed", async () => {
    await toGates();
    for (const change of [{ draft: true }, { draft: false, base: "dev" }]) {
      Object.assign(w.gh.pulls[prKey(w)] as object, change);
      const before = transitions();
      const run = await merge();
      expect([JSON.stringify(change), run.exitCode]).toEqual([JSON.stringify(change), 1]);
      expect(run.all).toContain("(not-ready)");
      expect(transitions()).toBe(before);
    }
    expect(merges()).toEqual([]);
  });

  test("a fork's head, and a deleted fork's, are not ready: nothing is claimed or sent", async () => {
    await toGates();
    for (const headRepo of [`someone/${w.fx.datasetId}`, null]) {
      Object.assign(w.gh.pulls[prKey(w)] as object, { headRepo });
      const before = transitions();
      const run = await merge();
      expect([headRepo, run.exitCode]).toEqual([headRepo, 1]);
      expect(run.all).toContain("(not-ready)");
      expect(run.all).toContain("a fork's pull request is never merged");
      expect(transitions()).toBe(before);
    }
    expect(merges()).toEqual([]);
    expect(w.row().merge_claim_sha).toBeNull();
  });

  test("a pull request into another repository is not ready: nothing is claimed or sent", async () => {
    await toGates();
    Object.assign(w.gh.pulls[prKey(w)] as object, { baseRepo: `someone/${w.fx.datasetId}` });
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(not-ready)");
    expect(run.all).toContain(`its base someone/${w.fx.datasetId}`);
    expect(run.all).toContain("a fork's pull request is never merged");
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
    expect(w.row().merge_claim_sha).toBeNull();
  });

  test("the dataset's own repository named in another case is its own, and merges", async () => {
    await toGates();
    Object.assign(w.gh.pulls[prKey(w)] as object, {
      headRepo: `NemarDatasets/${w.fx.datasetId.toUpperCase()}`,
    });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("merged");
  });

  test("a screen that no longer passes is refused at the gate, before any claim is asked for", async () => {
    await toGates();
    w.db().run("UPDATE upstream_repull_screens SET status = 'review'");
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(screen)");
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
  });

  test("an anonymous dataset is refused at the gate, before any claim is asked for", async () => {
    await toGates();
    w.db().run("UPDATE datasets SET first_published_at = NULL, anonymous = 1");
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("anonymous");
    expect(transitions()).toBe(before);
    expect(merges()).toEqual([]);
  });

  test("not confirmed: nothing is claimed or merged", async () => {
    await toGates();
    // No --yes, and no terminal to answer on.
    const before = transitions();
    const run = await w.cli(["repull", "merge", w.fx.datasetId]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("(declined)");
    expect(transitions()).toBe(before);
    expect(w.row().merge_claim_sha).toBeNull();
  });

  test("the review is read again at the merge, and a pass reset to running after the gate's read does not hold a waived head", async () => {
    const head = await toGates();
    seedReview(w.db(), {
      ds: w.fx.datasetId,
      n: w.row().pr_number as number,
      sha: head,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    // `pr-reviews start --redo` resets the stored pass between the gate's read and the claim.
    let reads = 0;
    w.setApiHook(async (req) => {
      if (req.method === "GET" && new URL(req.url).pathname.startsWith("/admin/pr-reviews/")) {
        reads++;
        if (reads === 2) {
          w.db().run(
            "UPDATE pr_reviews SET state = 'dispatched', verdict = NULL, report = NULL, decided_at = NULL, created_at = datetime('now')",
          );
        }
      }
    });
    const run = await merge();
    // Read twice, at the gate and again at the merge, and waived both times (ADR 0116).
    expect(reads).toBe(2);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("The automated review is waived for this commit");
    expect(merges()).toHaveLength(1);
  });
});

describe.skipIf(!awsInstalled)("a claim already held", () => {
  /** gates_clear, with a claim on the screened head made `minutesAgo` minutes ago. */
  async function heldClaim(minutesAgo: number): Promise<string> {
    const head = await toGates();
    w.db().run(
      `UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-${minutesAgo} minutes'),
         merge_claim_sha = gates_sha`,
    );
    return head;
  }

  test("is used again after the Worker's check: no second claim, the merge sent and recorded", async () => {
    const head = await heldClaim(2);
    const before = transitions();
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    expect(transitions()).toBe(before);
    expect(w.apiWrites).toContain(`POST /admin/repulls/${w.row().id}/merge-claim/check`);
    expect(merges()).toHaveLength(1);
    expect(w.row()).toMatchObject({ status: "merged", merge_claim_sha: head });
  });

  test("a dataset withdrawn after the claim is refused, and no merge is sent", async () => {
    await heldClaim(2);
    w.db().run("UPDATE datasets SET withdrawn_at = datetime('now')");
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("withdrawn");
    expect(merges()).toEqual([]);
  });

  test("another administrator's acknowledgment is not this one's: refused, no merge sent", async () => {
    await heldClaim(2);
    w.db().run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (7, 'otheradmin', 'otheradmin@example.org', 'x', 'approved', 'admin', 1)`,
    );
    w.db().run(
      `UPDATE upstream_repull_screens SET status = 'review', ack_by = 7,
         ack_reason = 'Read it; the header names the device.', ack_at = datetime('now')`,
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("screen-not-clear");
    expect(merges()).toEqual([]);
  });

  test("one 25 minutes old or more is not used: refused, no merge sent", async () => {
    await heldClaim(26);
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("claim-too-old");
    expect(merges()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("while the merge is out", () => {
  test("a resume of the record cannot run, so it cannot free a claim whose merge landed", async () => {
    await toGates();
    let concurrent: Awaited<ReturnType<typeof resume>> | null = null;
    w.gh.beforeMerge = async () => {
      w.gh.beforeMerge = null;
      concurrent = await resume();
    };
    const run = await merge();
    expect(run.exitCode, run.all).toBe(0);
    const during = concurrent as unknown as { exitCode: number; all: string };
    expect(during.exitCode, during.all).toBe(1);
    expect(during.all).toContain("execution-locked");
    expect(w.row()).toMatchObject({ status: "merged" });
  });

  test("a claim whose answer is lost may be held: exit 3, and no merge is sent", async () => {
    await toGates();
    w.setApiAfter((req) =>
      req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")
        ? Response.json({ error: "bad gateway" }, { status: 502 })
        : null,
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("may be held");
    expect(w.row().merge_claim_sha).toBe(w.row().gates_sha);
    expect(merges()).toEqual([]);
  });

  test("merged on GitHub but not recorded exits 3, and says resume records it", async () => {
    await toGates();
    w.setApiOverride((req) =>
      req.method === "POST" && new URL(req.url).pathname.endsWith("/merged")
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : null,
    );
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("not recorded yet");
    expect(merges()).toHaveLength(1);
    expect(w.row().status).toBe("gates_clear");
  });

  test("a merge GitHub did not make keeps its claim, in the gate's own words", async () => {
    await toGates();
    // GitHub's state turns to blocked between the gate's read and the merge's last look: when the
    // claim reaches the API.
    w.setApiHook(async (req) => {
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")) {
        Object.assign(w.gh.pulls[prKey(w)] as object, { mergeableState: "blocked" });
      }
    });
    const run = await merge();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("The claim to merge is kept");
    expect(run.all).toContain("within 25 minutes of the claim");
    expect(run.all).not.toMatch(/approv/i);
    expect(merges()).toEqual([]);
    expect(w.row().merge_claim_sha).toBe(w.row().gates_sha);
  });
});
