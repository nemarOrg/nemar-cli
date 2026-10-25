/**
 * `nemar admin repull resume <id>` and `status <id>` past the open pull request (ADR 0111, decisions
 * 2, 3, 6 and 7; epic #1046 phase 6, #1912), driven through the real entry point
 * (`bun run src/index.ts admin repull ...`) as a subprocess against `repull-pr-world.ts`: a re-pull
 * executed to `pr_open` by the real `execute`, the real API over bun:sqlite reached through
 * TEST_API_URL in the child's environment, the real `git`, and stand-ins for GitHub and S3 only.
 * No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the identifier screen is dispatched for the recorded head, once, and waiting for it exits 3;
 *  - `gates_clear` is recorded with the screened head once the screen passes and GitHub says clean;
 *  - a verdict that asks for a person needs `--acknowledge-identifier-screen`, recorded as the
 *    administrator's own;
 *  - an enrichment commit on the release branch is accepted and recorded; any other is
 *    `head-foreign`, recorded as an error with the head left as it was;
 *  - a `main` moved by enrichment while GitHub reports `dirty` makes the commit again on the new
 *    `main` and replaces the release branch with a lease, nothing outside `.nemar/` changing;
 *  - a pull request merged while the row is `pr_open` is recorded through the verified route, and
 *    one closed unmerged ends the record `abandoned`;
 *  - a stuck claim expires through resume once it is old enough, and a recent one is kept;
 *  - an anonymous dataset is refused before anything is written.
 *
 * What only the first production runs can check: GitHub's real `mergeable_state` words for a
 * re-pull pull request, how soon its `head.sha` follows a push, and that a forced push with a
 * lease is accepted on a release branch of a dataset repository.
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
import { which } from "bun";
import { gitIn, refsOf } from "./helpers/repull-fixture";
import {
  ADMIN_ID,
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

const resume = (extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);

/** The repository dispatches the Worker sent to the central workflow (the screen's runs). */
function screenDispatches(): Array<{ ref: string; callback_url: string }> {
  return w.gh.seen
    .filter((s) => s.method === "POST" && s.path === "/repos/nemarDatasets/.github/dispatches")
    .map(
      (s) => (s.body as { client_payload: { ref: string; callback_url: string } }).client_payload,
    );
}

describe.skipIf(!awsInstalled)("the identifier screen and the gates", () => {
  test("the screen is dispatched for the recorded head, once, and waiting for it exits 3", async () => {
    const head = w.row().head_sha as string;
    const first = await resume();
    expect(first.exitCode, first.all).toBe(3);
    expect(first.all).toContain(`identifier screen of ${head.slice(0, 12)}`);
    expect(screenDispatches()).toEqual([
      expect.objectContaining({
        ref: head,
        callback_url: "https://api.test.nemar.org/webhooks/identifier-screen-repull-result",
      }),
    ]);
    const second = await resume();
    expect(second.exitCode, second.all).toBe(3);
    expect(screenDispatches()).toHaveLength(1);
    expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
  });

  test("gates_clear is recorded with the screened head once the screen passes and GitHub says clean", async () => {
    const head = w.row().head_sha as string;
    expect((await resume()).exitCode).toBe(3);
    await w.reportScreen(head, "clean");
    w.gh.pulls[prKey(w)] = { ...w.gh.pulls[prKey(w)], mergeableState: "blocked" } as never;
    const blocked = await resume();
    expect(blocked.exitCode, blocked.all).toBe(3);
    expect(blocked.all).toContain("it reports 'blocked'");
    expect(w.row().status).toBe("pr_open");
    w.gh.pulls[prKey(w)] = { ...w.gh.pulls[prKey(w)], mergeableState: "clean" } as never;
    const ready = await resume();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(ready.all).toContain(`Ready to merge: nemar admin repull merge ${w.fx.datasetId}`);
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head, last_error: null });
    // Resume never merges.
    expect(w.gh.seen.some((s) => s.method === "PUT")).toBe(false);
  });

  test("a verdict that asks for a person needs the administrator's own acknowledgment", async () => {
    const head = w.row().head_sha as string;
    await resume();
    await w.reportScreen(head, "review");
    const asks = await resume();
    expect(asks.exitCode, asks.all).toBe(3);
    expect(asks.all).toContain("--acknowledge-identifier-screen");
    expect(w.row().status).toBe("pr_open");
    const acknowledged = await resume([
      "--acknowledge-identifier-screen",
      "Read the report; the flagged header is the device's own name.",
    ]);
    expect(acknowledged.exitCode, acknowledged.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "gates_clear", gates_sha: head });
    const screen = w.db().query("SELECT ack_by, ack_reason FROM upstream_repull_screens").get();
    expect(screen).toMatchObject({ ack_by: ADMIN_ID });
  });

  test("a direct identifier stops the gates, with why recorded", async () => {
    const head = w.row().head_sha as string;
    await resume();
    await w.reportScreen(head, "direct-identifiers");
    const run = await resume(["--acknowledge-identifier-screen", "This should not be accepted."]);
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("screen-blocks");
    expect(w.row()).toMatchObject({ status: "pr_open", gates_sha: null });
    expect(w.row().last_error).toStartWith("[gates:screen-blocks]");
  });

  test("an anonymous dataset is refused before anything is written", async () => {
    // Only an unpublished dataset can be anonymous (a trigger refuses the rest).
    w.db().run("UPDATE datasets SET first_published_at = NULL, anonymous = 1");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("anonymous-dataset");
    expect(w.apiWrites).toEqual([]);
    expect(screenDispatches()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("the head and main", () => {
  test("an enrichment commit on the release branch is accepted and recorded", async () => {
    const before = w.row();
    const ref = `refs/heads/${before.branch}`;
    const enriched = await w.commitOnto(
      ref,
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, ref),
      "enrichment",
    );
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("moved by enrichment");
    expect(w.row()).toMatchObject({ status: "pr_open", head_sha: enriched });
    // The commit the record was synthesized as is unchanged; only the head moved.
    expect(w.row().synth_sha).toBe(before.synth_sha);
    expect(screenDispatches().map((d) => d.ref)).toEqual([enriched]);
  });

  test("a commit enrichment does not make is head-foreign: recorded as an error, the head kept", async () => {
    const before = w.row();
    await w.commitOnto(`refs/heads/${before.branch}`, "README.md", "Someone else's text.\n");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("head-foreign");
    expect(w.row()).toMatchObject({ status: "pr_open", head_sha: before.head_sha });
    expect(w.row().last_error).toStartWith("[gates:head-foreign]");
    expect(screenDispatches()).toEqual([]);
  });

  test("main moved by a commit enrichment does not make is main-moved", async () => {
    await w.commitOnto("refs/heads/main", "code/other.sh", "echo hi\n");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(w.row().last_error).toStartWith("[gates:main-moved]");
    expect(w.row().status).toBe("pr_open");
  });

  test("main moved by enrichment while GitHub says dirty: made again on the new main, pushed with a lease", async () => {
    const before = w.row();
    const repo = w.fx.originRepo;
    const releaseRef = `refs/heads/${before.branch}`;
    const newMain = await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(repo, "refs/heads/main"),
      "enrichment",
    );
    const refsBefore = (await refsOf(repo))
      .split("\n")
      .filter((l) => l && !l.startsWith(releaseRef));
    w.gh.pulls[prKey(w)] = { ...w.gh.pulls[prKey(w)], mergeableState: "dirty" } as never;
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("again on the new main");

    const after = w.row();
    const pushed = (await gitIn(repo, ["rev-parse", releaseRef])).trim();
    expect(after).toMatchObject({
      status: "pr_open",
      base_sha: newMain,
      synth_sha: pushed,
      head_sha: pushed,
    });
    expect(pushed).not.toBe(before.synth_sha);
    expect((await gitIn(repo, ["rev-parse", `${pushed}^@`])).trim()).toBe(newMain);
    // Outside .nemar/ the tree is the recorded one, entry for entry.
    const outside = async (rev: string) =>
      (await gitIn(repo, ["ls-tree", "-r", rev]))
        .split("\n")
        .filter((l) => l && !l.includes("\t.nemar/"))
        .join("\n");
    expect(await outside(pushed)).toBe(await outside(before.synth_sha));
    // .nemar/metadata.json is the new main's, with the IsIdenticalTo edit applied again.
    const meta = JSON.parse(await gitIn(repo, ["show", `${pushed}:.nemar/metadata.json`]));
    expect(meta.enriched_at).toBe("2026-10-25T00:00:00Z");
    const synthMeta = JSON.parse(
      await gitIn(repo, ["show", `${before.synth_sha}:.nemar/metadata.json`]),
    );
    const identical = (m: { related_identifiers?: Array<{ relation_type: string }> }) =>
      m.related_identifiers?.find((r) => r.relation_type === "IsIdenticalTo");
    expect(identical(meta)).toEqual(identical(synthMeta));
    // The ledger and the message (both trailers as its last paragraph) are the commit's own.
    const blob = (rev: string) =>
      gitIn(repo, ["show", `${rev}:.nemar/corrections.jsonl`]).catch(() => "absent");
    expect(await blob(pushed)).toBe(await blob(before.synth_sha));
    const trailers = (rev: string) => gitIn(repo, ["log", "-1", "--format=%(trailers:only)", rev]);
    expect(await trailers(pushed)).toBe(await trailers(before.synth_sha));
    expect((await trailers(pushed)).trim().split("\n")).toHaveLength(2);
    // Only the release branch moved.
    expect((await refsOf(repo)).split("\n").filter((l) => l && !l.startsWith(releaseRef))).toEqual(
      refsBefore,
    );
    // The new head is screened anew.
    expect(screenDispatches().map((d) => d.ref)).toEqual([pushed]);
  });
});

describe.skipIf(!awsInstalled)("a pull request GitHub says is no longer open", () => {
  test("one merged while the row is pr_open is recorded through the verified route", async () => {
    const pr = w.gh.pulls[prKey(w)] as { merged?: boolean };
    const merge = await w.gh.onMerge?.(w.fx.datasetId, w.row().pr_number as number, {});
    expect(merge).toMatch(/^[0-9a-f]{40}$/);
    Object.assign(pr, { merged: true, state: "closed", mergeCommitSha: merge });
    const run = await resume();
    expect(run.all).toContain("is merged");
    expect(w.row()).toMatchObject({ status: "merged", merge_sha: merge });
    expect(JSON.parse(w.row().counts)).toMatchObject({
      merged_outside_tool: 1,
      merged_unscreened_head: 1,
    });
    // The Worker read the merge itself, with its own token.
    expect(
      w.gh.seen.some(
        (s) =>
          s.method === "GET" &&
          s.path === `/repos/nemarDatasets/${w.fx.datasetId}/pulls/${w.row().pr_number}` &&
          s.token !== null &&
          s.token !== "gho_admin_own_token",
      ),
    ).toBe(true);
  });

  test("one closed unmerged ends the record abandoned", async () => {
    Object.assign(w.gh.pulls[prKey(w)] as object, { state: "closed" });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("abandoned");
    expect(w.row()).toMatchObject({ status: "abandoned" });
  });
});

describe.skipIf(!awsInstalled)("a claim to merge that is stuck", () => {
  async function heldClaim(minutesAgo: number): Promise<void> {
    const head = w.row().head_sha as string;
    await resume();
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    w.db().run(
      `UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-${minutesAgo} minutes'),
         merge_claim_sha = gates_sha`,
    );
  }

  test("expires through resume once it is old enough, and GitHub says it did not merge", async () => {
    await heldClaim(45);
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("expired");
    expect(w.row()).toMatchObject({
      status: "gates_clear",
      merge_claimed_at: null,
      merge_claim_sha: null,
    });
    const audit = w
      .db()
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_claim_released'")
      .get() as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ outcome: "expired" });
  });

  test("a recent one is kept, and resume says how to go on", async () => {
    await heldClaim(10);
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain(`nemar admin repull merge ${w.fx.datasetId}`);
    expect(w.row().merge_claim_sha).toBe(w.row().gates_sha);
  });
});

describe.skipIf(!awsInstalled)("status", () => {
  test("names the record, its pull request, its screen and what is next", async () => {
    const head = w.row().head_sha as string;
    await resume();
    const run = await w.cli(["repull", "status", w.fx.datasetId]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.stdout).toContain(`Re-pull #${w.row().id} of ${w.fx.datasetId}: pr_open`);
    expect(run.stdout).toContain(`Pull request: #${w.row().pr_number} of release/v2.0.0`);
    expect(run.stdout).toContain(`Identifier screen of ${head.slice(0, 12)} (n0)`);
    expect(run.stdout).toContain(`Next: nemar admin repull resume ${w.fx.datasetId}`);
    const json = JSON.parse((await w.cli(["repull", "status", w.fx.datasetId, "--json"])).stdout);
    expect(json.repulls[0]).toMatchObject({ status: "pr_open", head_sha: head });
    expect(json.screens.screens[0]).toMatchObject({ sha: head, gate: "wait" });
  });
});
