/**
 * A re-pull merged outside NEMAR's gate, with GitHub's own merge button, and its acceptance
 * (`nemar admin repull resume <id> --accept-merge-trailers "<reason>"`; epic #1046; ADR 0111, the
 * amendment of 2026-10-29; issue #1996), driven through the real entry point against
 * `repull-pr-world.ts` with a plan that has no corrections, so the record can reach `complete`.
 *
 * Everything NEMAR's is real: the CLI, the Worker's routes over bun:sqlite with every migration,
 * the real `git` and `git-annex` repositories served as bare origins, and the privacy ledger's own
 * fresh-clone rule (`ledgerChecks` in `scripts/scrub/git/git-lib.ts`) run on a fresh clone of the
 * origin the re-pull and the Worker wrote. GitHub is the suites' stand-in: its squash merge
 * commits onto the origin's `main` with the message it is sent, and its Git Data and Contents
 * answers are read from, and written to, the same origin. No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a merge without the trailers is refused at the release without the flag, and the dataset
 *    then fails the fresh-clone proof (`ledger-commit-not-alone`): the premise;
 *  - with a reason, the merge is verified, accepted, the ledger line naming it is written to
 *    `main` in a commit of its own, the release goes on to `complete`, and the proof passes;
 *  - a line that could not be written leaves the acceptance recorded, the Worker refuses the
 *    release until the line is on `main`, and the next run writes it once;
 *  - a parent, a head or a tree that is not the record's, a record the automatic path opened or
 *    another administrator's, and a merge commit that is not the record's are refused, by the CLI
 *    and by the Worker on its own, and nothing is written;
 *  - a head or a parent enrichment moved is accepted.
 *
 * What only production can check: that GitHub's Contents API takes the leased write of the ledger
 * on `main` and answers a stale `sha` with 409, and that GitHub's comparison names the files as
 * the stand-in does.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import type { LedgerEntry } from "../scripts/scrub/contract";
import { isAnnexRef, ledgerChecks } from "../scripts/scrub/git/git-lib";
import { validateLedgerEntry } from "../scripts/scrub/ledger";
import { mergeAcceptanceLine } from "../shared/repull-merge-acceptance";
import { gitIn } from "./helpers/repull-fixture";
import {
  ADMIN_ID,
  ADMIN_KEY,
  type RepullWorld,
  type WorldPoint,
  enrichedMetadata,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const LEDGER = ".nemar/corrections.jsonl";
const REASON =
  "Merged with GitHub's button by mistake; the merge was read and is the re-pull's own";

let w: RepullWorld;
/** The record at `gates_clear`, its screen passed: where a merge on GitHub's page is made from. */
let gated: WorldPoint;
/** GitHub's merge button pressed at `gated`: the record still at `gates_clear`. */
let mergedOnGitHub: WorldPoint;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({ fixture: { noContributorEdits: true, identifierJsonB: true } });
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  expect(w.row().status).toBe("gates_clear");
  gated = await w.save();
  await w.mergeOnGitHub();
  mergedOnGitHub = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const resume = (extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);
const accepting = () => resume(["--accept-merge-trailers", REASON]);
const mainHead = async () =>
  (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
const acceptances = () =>
  w.db().query("SELECT * FROM upstream_repull_merge_acceptances").all() as Array<
    Record<string, unknown>
  >;
/** Tag v2.0.0 at main and write its version row, as the dataset workflow and the DOI leave them. */
async function tagged(): Promise<string> {
  const tag = await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  return tag;
}

/** The Worker's route, called as an administrator's CLI would, with no check made before it. */
async function acceptRoute(
  body: Record<string, unknown>,
): Promise<{ status: number; code: string }> {
  const res = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/merge-trailers/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as { code?: string };
  return { status: res.status, code: answer.code ?? "" };
}

/**
 * The privacy ledger's fresh-clone rule (ADR 0085) on a new clone of the origin: the refs
 * `git-scrub verify --fresh-clone` scans (every ref but git-annex's), as it reads them.
 */
async function proof() {
  const dir = mkdtempSync(join(tmpdir(), "nemar-accept-proof-"));
  try {
    await gitIn(dir, ["clone", "-q", "--no-local", w.fx.originRepo, "clone"]);
    const repo = join(dir, "clone");
    const refs = (await gitIn(repo, ["for-each-ref", "--format=%(refname)"]))
      .split("\n")
      .filter((r) => r !== "" && !isAnnexRef(r));
    return await ledgerChecks(repo, refs, w.fx.datasetId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The requests the CLI sent to the acceptance route: the first asks whether one is recorded (no
 * reason), and a second carries the reason. One means the CLI refused on its own reading first.
 */
const acceptRequests = () => w.apiWrites.filter((p) => p.endsWith("/merge-trailers/accept"));

/** Nothing written: no acceptance, no ledger write, `main` where it was. */
async function nothingWritten(main: string): Promise<void> {
  expect(acceptances()).toEqual([]);
  expect(w.ledgerWrites()).toBe(0);
  expect(await mainHead()).toBe(main);
  expect(w.row().status).toBe("merged");
}

describe.skipIf(!awsInstalled)("a merge made outside the gate", () => {
  test("without --accept-merge-trailers the release refuses, and the dataset fails the proof", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("merge-trailers");
    expect(run.all).toContain("--accept-merge-trailers");
    expect(w.row()).toMatchObject({ status: "merged", merge_sha: merge, tag_sha: null });
    expect(w.row().last_error).toStartWith("[release:merge-trailers]");
    await nothingWritten(merge);
    // The premise: the squash commit appends the delta scrub's line beside the re-pull's files and
    // carries no trailers, so the fresh-clone proof fails it for good.
    expect(
      (await gitIn(w.fx.originRepo, ["diff", "--name-only", `${merge}^`, merge])).split("\n"),
    ).toContain(LEDGER);
    const before = await proof();
    expect(before).toMatchObject({ notAlone: 1, unmatched: 0, invalid: 0, accepted: 0 });
  });

  test("with a reason it is verified, accepted, attested on main, and the release completes", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledgerAtMerge = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    // What was verified, and what was accepted, in plain words.
    expect(run.all).toContain("does not end with the re-pull commit's two trailers");
    expect(run.all).toContain("Verified before it was accepted");
    expect(run.all).toContain(`is GitHub's squash merge of pull request #${w.row().pr_number}`);
    expect(run.all).toContain("the recorded head");
    expect(run.all).toContain("its one parent");
    expect(run.all).toContain("is the record's base");
    expect(run.all).toContain("its tree is the re-pull's commit");
    expect(run.all).toContain("repull-scrubbed");
    expect(run.all).toContain(`Accepted on your reason: ${REASON}`);
    expect(run.all).toContain(`the line that names ${merge.slice(0, 12)}`);
    expect(run.all).toContain("is complete");

    // The record went on as for a gated merge: released at the tag, lineage, the lock, complete.
    const row = w.row();
    expect(row).toMatchObject({ status: "complete", tag_sha: merge, last_error: null });
    expect(JSON.parse(row.counts).locked).toBeGreaterThan(0);
    expect(
      w
        .db()
        .query("SELECT source_version_basis FROM dataset_versions WHERE version = '2.0.0'")
        .get(),
    ).toEqual({ source_version_basis: "lineage" });

    // The acceptance, with the reason, recorded once; the reason is in the audit row too.
    const [accepted, ...more] = acceptances();
    expect(more).toEqual([]);
    expect(accepted).toMatchObject({
      repull_id: row.id,
      pr: "n0",
      merge_sha: merge,
      reason: REASON,
      accepted_by: ADMIN_ID,
      attestation_needed: 1,
    });
    expect(accepted?.attested_at).not.toBeNull();
    const audit = w
      .db()
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_trailers_accepted'")
      .all() as Array<{ details: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details as string)).toMatchObject({
      merge_sha: merge,
      reason: REASON,
    });

    // One commit of NEMAR's on main, after the merge, touching the ledger only, appending one line.
    const main = await mainHead();
    expect(accepted?.attestation_sha).toBe(main);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${main}^`])).trim()).toBe(merge);
    expect((await gitIn(w.fx.originRepo, ["diff", "--name-only", merge, main])).trim()).toBe(
      LEDGER,
    );
    const ledgerOnMain = await gitIn(w.fx.originRepo, ["show", `${main}:${LEDGER}`]);
    expect(ledgerOnMain.startsWith(ledgerAtMerge)).toBe(true);
    const added = ledgerOnMain.slice(ledgerAtMerge.length).split("\n").filter(Boolean);
    expect(added).toHaveLength(1);
    const entry = validateLedgerEntry(JSON.parse(added[0] as string) as LedgerEntry);
    expect(entry).toMatchObject({
      dataset: w.fx.datasetId,
      action: "repull-merge-accepted",
      versions: ["v2.0.0"],
      verification: "squash-merge-verified",
      actor: "nemar-repull",
      commit: merge,
      plan: row.plan_digest,
    });
    // The reason never reaches the public ledger.
    expect(ledgerOnMain).not.toContain("GitHub's button");
    expect(w.ledgerWrites()).toBe(1);

    // And the fresh-clone proof now passes, vouching for exactly that merge.
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 1 });
  });

  test("a line that could not be written: the acceptance stands, the release waits, the next run writes it once", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    const tag = await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    const first = await accepting();
    expect(first.exitCode, first.all).toBe(3);
    expect(first.all).toContain("attestation-unwritten");
    expect(w.row().status).toBe("merged");
    expect(acceptances()).toHaveLength(1);
    expect(acceptances()[0]).toMatchObject({ attested_at: null, attestation_sha: null });
    expect(await mainHead()).toBe(merge);
    // The Worker refuses the release until the line is on main, whatever a caller says.
    const released = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/released`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "n0", tag_sha: tag, tree_verified: true }),
    });
    expect(released.status).toBe(409);
    expect(((await released.json()) as { code: string }).code).toBe("acceptance-unattested");

    // Recorded once: the same request for another merge commit is refused.
    const parent = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    expect(await acceptRoute({ pr: "n0", merge_sha: parent, reason: REASON })).toEqual({
      status: 409,
      code: "merge-mismatch",
    });
    // The next run needs no reason: the acceptance is recorded, and its line is written once.
    w.setLedgerWriteFault(null);
    const second = await resume();
    expect(second.exitCode, second.all).toBe(0);
    expect(second.all).toContain("accepted it at");
    expect(w.row().status).toBe("complete");
    expect(acceptances()).toHaveLength(1);
    expect(w.ledgerWrites()).toBe(2);
    const ledger = await gitIn(w.fx.originRepo, ["show", `refs/heads/main:${LEDGER}`]);
    expect(ledger.split("\n").filter((l) => l.includes("repull-merge-accepted"))).toHaveLength(1);
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, accepted: 1 });
    // A third run finds nothing open, and writes nothing.
    expect((await resume()).exitCode).toBe(1);
    expect(w.ledgerWrites()).toBe(2);
  });

  test("a parent that is not the base moved by enrichment is refused by the CLI and by the Worker", async () => {
    await w.restore(gated);
    await w.commitOnto("refs/heads/main", "README.md", "Changed by hand on main.\n");
    await w.mergeOnGitHub();
    const merge = await mainHead();
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-parent-foreign");
    expect(run.all).toContain("Nothing was accepted or written");
    expect(acceptRequests()).toHaveLength(1);
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a parent that enrichment moved is accepted, and said so", async () => {
    await w.restore(gated);
    await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
      "Update NEMAR metadata",
    );
    await w.mergeOnGitHub();
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("moved by enrichment only");
    expect(w.row().status).toBe("complete");
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, accepted: 1 });
  });

  test("a head enrichment moved is accepted; a head moved by any other commit is refused", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    await w.commitOnto(
      branch,
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, branch),
      "Update NEMAR metadata",
    );
    await w.mergeOnGitHub();
    await tagged();
    const ok = await accepting();
    expect(ok.exitCode, ok.all).toBe(0);
    expect(ok.all).toContain("which enrichment moved the recorded head");
    expect(w.row().status).toBe("complete");

    await w.restore(gated);
    await w.commitOnto(branch, "README.md", "Changed by hand on the release branch.\n");
    await w.mergeOnGitHub();
    const merge = await mainHead();
    await tagged();
    const foreign = await accepting();
    expect(foreign.exitCode, foreign.all).toBe(1);
    expect(foreign.all).toContain("merge-head-foreign");
    expect(acceptRequests()).toHaveLength(1);
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-head-foreign",
    });
    await nothingWritten(merge);
  });

  test("a tree that is not the re-pull's commit is refused by the CLI and by the Worker", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3); // records the merge; refuses merge-trailers
    // The record's synthesized commit, as if it were another: the base's.
    const base = w.row().base_sha;
    const baseTree = (await gitIn(w.fx.originRepo, ["rev-parse", `${base}^{tree}`])).trim();
    w.db().run("UPDATE upstream_repulls SET synth_sha = ?, synth_tree = ?", [base, baseTree]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-tree-mismatch");
    expect(acceptRequests()).toHaveLength(2); // the resume that recorded the merge, and this one
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-tree-mismatch",
    });
    await nothingWritten(merge);
  });

  test("a record the automatic path opened, or another administrator's, is not accepted", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const automatic = await accepting();
    expect(automatic.exitCode, automatic.all).toBe(1);
    expect(automatic.all).toContain("accept-automatic");
    // Refused by this run before any reason was sent: the earlier resume's request and this one's.
    expect(acceptRequests()).toHaveLength(2);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "accept-automatic",
    });
    await nothingWritten(merge);

    w.db().run("UPDATE upstream_repulls SET origin = 'administrator', actor_user_id = 1");
    const before = acceptRequests().length;
    const theirs = await accepting();
    expect(theirs.exitCode, theirs.all).toBe(1);
    expect(theirs.all).toContain("accept-not-yours");
    // The CLI cannot tell whose the record is: the Worker refused the request with the reason.
    expect(acceptRequests().length - before).toBe(2);
    await nothingWritten(merge);
  });

  test("the Worker takes only the record's merge commit, and a reason only for a first acceptance", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const other = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    expect(await acceptRoute({ pr: "n0", merge_sha: other, reason: REASON })).toEqual({
      status: 409,
      code: "merge-mismatch",
    });
    expect(await acceptRoute({ pr: "n0", merge_sha: merge })).toEqual({
      status: 409,
      code: "merge-trailers-not-accepted",
    });
    expect((await acceptRoute({ pr: "n0", merge_sha: merge, reason: "too short" })).status).toBe(
      400,
    );
    await nothingWritten(merge);
  });

  test("a line another writer appended while NEMAR wrote is kept: the write is leased on the ledger it read", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledger = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const other = `${JSON.stringify({
      version: 1,
      at: "2026-10-29T11:00:00.000Z",
      dataset: w.fx.datasetId,
      action: "published-again",
      versions: ["v2.0.0"],
      counts: {},
      scanner: "identifier-scan@abcdef1",
      verification: "none",
      actor: "someone",
    })}\n`;
    // The first write finds that another writer appended a line to the ledger first.
    let once = true;
    w.setLedgerWriteFault(async () => {
      if (!once) return null;
      once = false;
      await w.commitOnto("refs/heads/main", LEDGER, `${ledger}${other}`, "Record the publication");
      return Response.json({ message: `${LEDGER} does not match` }, { status: 409 });
    });
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.ledgerWrites()).toBe(2);
    const onMain = await gitIn(w.fx.originRepo, ["show", `refs/heads/main:${LEDGER}`]);
    expect(onMain.startsWith(`${ledger}${other}`)).toBe(true);
    expect(onMain.slice(ledger.length + other.length)).toContain(
      '"action":"repull-merge-accepted"',
    );
    expect(w.row().status).toBe("complete");
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 1 });
  });

  test("a line the Worker was told is written and main does not show stops the release: attestation-unseen", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    // A GitHub that answers the write as made, and made nothing.
    w.setLedgerWriteFault(() =>
      Response.json(
        { content: { sha: "e".repeat(40) }, commit: { sha: "d".repeat(40) } },
        { status: 201 },
      ),
    );
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("attestation-unseen");
    expect(w.row()).toMatchObject({ status: "merged", tag_sha: null });
    expect(await mainHead()).toBe(merge);
  });

  test("a line on main already naming the merge is not NEMAR's: refused, nothing written", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledger = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const handMade = `${mergeAcceptanceLine({
      dataset: w.fx.datasetId,
      version: "2.0.0",
      mergeSha: merge,
      planDigest: w.row().plan_digest,
      scanner: "identifier-scan@abcdef1",
      at: "2026-10-01T00:00:00.000Z",
    })}\n`;
    const main = await w.commitOnto("refs/heads/main", LEDGER, `${ledger}${handMade}`, "By hand");
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("attestation-conflict");
    expect(acceptances()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);
    expect(await mainHead()).toBe(main);
    expect(w.row().status).toBe("merged");
  });

  test("a reason outside 10 to 500 characters is a usage error, before anything is read", async () => {
    await w.restore(mergedOnGitHub);
    const run = await resume(["--accept-merge-trailers", "short"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.all).toContain("a reason of 10 to 500 characters is required");
    expect(w.row().status).toBe("gates_clear");
    expect(acceptances()).toEqual([]);
  });
});
