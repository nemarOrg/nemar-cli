/**
 * `nemar admin publish approve` against the publication review (ADR 0102, sections 8 and 9).
 *
 * The real command (`bun run src/index.ts ...`) against the real backend app, over a real D1
 * (`helpers/admin-publish-cli.ts`). What the command printed, what it posted and what the backend
 * recorded are all read from where they really are; GitHub and Resend are the only stand-ins, and
 * no NEMAR answer is canned, so a refusal in these tests is one the Worker or the command made.
 *
 * Two kinds of test, named so a red one says what is missing:
 *
 *  - "the command decides": the CLI refuses, or proceeds, from the review it READ, and the test
 *    asserts what it did before the Worker could. These do not need the Worker's review gate: each
 *    asserts that nothing was posted, or what exactly was.
 *  - "with the Worker's gate": the refusal or the record is the Worker's own (the 409 the command
 *    prints, the override on the row, the web executor's run). These need the gate
 *    (`publication-review-gate.ts`, WP2) and stay red until it is in the tree.
 *
 * Mutation checks (each turns a named test red; the diff is shown in the work package's report):
 * treat `--yes` as `--force` (the `--yes without --force` rows); build the override from a second
 * read (the in-between row); refuse when a recorded override covers (the executor row); let a hard
 * reason through with `--force` (the hard rows); let `--skip-ci-check` stand for `--force` (the
 * skip row); skip the acknowledgment step (the acknowledgment rows); proceed for a blocked request
 * when the flag is off (the blocked rows); refuse a started-publishing run that has `--resume`
 * (the resume rows); drop the override from a retry call (the retry row, in `publish-progress`).
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  failingReport,
  seedScreenedRequest,
} from "../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../backend/test/helpers/publication-review-app";
import { NOT_ASSESSED_LINE, REASONS, REVIEW_GATE_REFUSAL_TEXT } from "../shared/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import {
  DATASET,
  hardReport,
  reportWith,
  seedGolden as seedGoldenIn,
  seedOverride,
  seedReport as seedReportIn,
  twoReasons,
} from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "approve-admin-key-0123456789abcdef0123456789abcdef";
const OTHER_ADMIN_KEY = "approve-other-key-0123456789abcdef0123456789abcdef";
const EXECUTOR_KEY = "approve-executor-key-0123456789abcdef0123456789abcdef";
const APPROVE_PATH = `/admin/publish/${DATASET}/approve`;

const h = startPublishCli();
const api = makePublicationReviewApp();
afterAll(() => h.stop());

/** A POST to the real routes, in this process and over the harness's database, as `key`'s account. */
const direct = async (path: string, key: string, body: Record<string, unknown>) =>
  api.handle(
    new Request(`http://api.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    h.env(),
  );

let adminId: number;

beforeEach(async () => {
  h.reset();
  adminId = await h.admin("approveradmin", ADMIN_KEY);
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
});

/** Everything the command printed. The spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

const approveBodies = () => h.posted.filter((p) => p.path === APPROVE_PATH).map((p) => p.body);

const requestRow = (id: number) =>
  h.db
    .query<{ status: string; approved_by: number | null }, [number]>(
      "SELECT status, approved_by FROM publication_requests WHERE id = ?",
    )
    .get(id);

const seedGolden = (over?: Parameters<typeof seedGoldenIn>[1]) => seedGoldenIn(h.db, over);
const seedReport = (requestId: number, report?: Record<string, unknown>) =>
  seedReportIn(h.db, requestId, report);

const WHY_ACK = "Read the recording formats by hand, nothing to remove";

const approve = (flags: string[], opts: Parameters<typeof h.cli>[1] = {}) =>
  h.cli(["admin", "publish", "approve", DATASET, ...flags], opts);

describe("the command decides: a pass", () => {
  test("approves, posts no override, and shows the screen and the review first", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(r.stdout).toContain("Identifier screen: clean");
    expect(r.stdout).toContain("Publication review: pass");
    expect(r.stdout).toContain("Gate: enforced");
    expect(r.stdout).toContain(NOT_ASSESSED_LINE);
    // The banner is still the step list the request will run.
    expect(r.stdout).toContain("This will run the following 16-step orchestrator:");
  });

  test("--force over a pass sends nothing: there is nothing to override", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: a review that is not a pass", () => {
  test("without --force it prints each reason with its cure, exits 1 and posts nothing", async () => {
    const requestId = seedGolden();
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Publication review: FAIL");
    expect(r.stdout).toContain(REASONS.question_failed.sentence.replace(/\.$/, ""));
    expect(r.stdout).toContain(REASONS.version_missing.sentence);
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain(`nemar admin publish approve ${DATASET} --resume --force`);
    // The model's own words never reach the approval screen.
    expect(output(r)).not.toContain(SUMMARY_SENTINEL);
    expect(output(r)).not.toContain(NOTE_SENTINEL);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--yes is the answer to the question, not to the reason: without --force it is the same", async () => {
    const requestId = seedGolden();
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain("--force");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--force --yes posts the override of the review shown and exactly the reasons shown", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approving over: question_failed, version_missing");
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a hard reason is refused with its cure, even with --force --yes, and nothing is posted", async () => {
    const requestId = seedGolden();
    seedReport(requestId, hardReport());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain(REASONS.submission_minimum_failed.cure);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--skip-ci-check skips the orchestrator's live check and clears no review reason", async () => {
    const requestId = seedGolden();
    seedReport(requestId, reportWith({ bids: "fail" }));

    const r = await approve(["--resume", "--yes", "--skip-ci-check"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(REASONS.bids_failed_at_review.sentence);
    expect(r.stdout).toContain("Not approved:");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("a review that never started is a reason too, and --force names it (no review row: id null)", async () => {
    const requestId = seedGolden();

    const refused = await approve(["--resume", "--yes"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain(REASONS.review_not_started.sentence);
    expect(h.posted).toEqual([]);

    const forced = await approve(["--resume", "--yes", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: null,
      reasons: ["review_not_started"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: what is sent is what was shown", () => {
  test("a reason that comes up after the review was read is not in the override", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    // Between the command's read of the review and its post, a release of the version appears.
    // The override names the review and the reasons that were SHOWN; the Worker, which is the gate,
    // is the one that sees the new reason (refused in "with the Worker's gate" below). Its answer
    // is not asserted here: with no gate the run goes through, with one it is refused.
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.late",
      ]);
    });

    await approve(["--resume", "--yes", "--force"]);

    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
  });

  test("a retry after a 5xx sends the override and the acknowledgment again", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    const reviewId = seedReport(requestId, twoReasons());
    // The approval's own request lookup fails once, after the command's reads, and answers 500: the
    // command retries on its own after a wait. A retry that lands before the run is marked
    // approving passes the gates again, so it must carry what the first call carried.
    let armed = false;
    let failed = false;
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      armed = true;
    });
    h.hookDb({
      statement(sql) {
        if (armed && !failed && /FROM publication_requests/.test(sql)) {
          failed = true;
          throw new Error("simulated read failure");
        }
      },
    });

    const r = await approve([
      "--resume",
      "--yes",
      "--force",
      "--acknowledge-identifier-screen",
      WHY_ACK,
    ]);

    expect(failed).toBe(true);
    expect(output(r)).toContain("Retrying in 10s");
    expect(approveBodies()).toHaveLength(2);
    for (const body of approveBodies()) {
      expect(body?.override_publication_review).toEqual({
        review_id: reviewId,
        reasons: ["question_failed", "version_missing"],
      });
      expect(body?.acknowledge_identifier_screen).toBe(WHY_ACK);
    }
    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: the screen's acknowledgment is its own flag", () => {
  const WHY = WHY_ACK;

  test("not given: refused before anything is posted, and --force does not stand in for it", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);

    for (const flags of [
      ["--resume", "--yes"],
      ["--resume", "--yes", "--force"],
    ]) {
      const r = await approve(flags);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Not approved:");
      expect(r.stdout).toContain(REASONS.identifier_screen_needs_acknowledgment.sentence);
      expect(r.stdout).toContain("--acknowledge-identifier-screen");
    }
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("given: the trimmed reason is posted, with no override, and the run publishes", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--acknowledge-identifier-screen", `  ${WHY}  `]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()[0]?.acknowledge_identifier_screen).toBe(WHY);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("when the review is not a pass either, the refusal says --force is needed as well", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      `nemar admin publish approve ${DATASET} --resume --acknowledge-identifier-screen "<reason>" --force`,
    );
    expect(h.posted).toEqual([]);
  });
});

describe("the command decides: a blocked request is refused with the flag off and on", () => {
  for (const flag of ["on", "off"] as const) {
    test(`with the review ${flag}: exits 1 before posting, with the block reason`, async () => {
      if (flag === "off") h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
      const requestId = seedGolden({
        requestStatus: "blocked",
        blockReason: "min_requirements_failed",
      });

      const r = await approve(["--resume", "--yes", "--force"]);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Not approved:");
      expect(r.stdout).toContain("The request is blocked (min_requirements_failed).");
      expect(r.stdout).toContain(REASONS.request_blocked.cure);
      expect(h.posted).toEqual([]);
      expect(requestRow(requestId)?.status).toBe("blocked");
    });
  }
});

describe("the command decides: a run that has started publishing", () => {
  test("without --resume it exits 1 with the resume cure and posts nothing", async () => {
    const requestId = seedGolden({ requestStatus: "approving" });
    seedReport(requestId, failingReport());

    const r = await approve(["--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("This approval has already started publishing.");
    expect(r.stdout).toContain(`nemar admin publish approve ${DATASET} --resume`);
    expect(h.posted).toEqual([]);
  });

  test("with --resume it publishes with no review gate and no override, whatever the review says", async () => {
    const requestId = seedGolden({ requestStatus: "approving" });
    seedReport(requestId, failingReport());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("a resume that has started publishing is not gated again");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: a gate that is off or does not apply", () => {
  test("the review off: a stored failing review is advice, --force changes nothing and says so", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    const requestId = seedGolden();
    seedReport(requestId, failingReport());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Gate: off");
    expect(r.stdout).toContain("--force changes nothing: the review gate is off.");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a mirror: the review does not apply, whatever it says", async () => {
    const requestId = seedGolden({ source: "openneuro" });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Gate: n/a");
    expect(r.stdout).toContain("--force changes nothing: the review gate is n/a.");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: a review that cannot be read is the Worker's to judge", () => {
  const failReads = () =>
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

  test("the command says so, and sends no override even with --force: nothing was shown to override", async () => {
    const requestId = seedGolden();
    seedReport(requestId, failingReport());
    failReads();

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.stdout).toContain(
      "The publication review could not be read (HTTP 500); the API still checks it.",
    );
    // It went on to the Worker, which is the gate, and sent no override of its own making.
    expect(approveBodies().length).toBeGreaterThan(0);
    for (const body of approveBodies()) {
      expect(body).not.toHaveProperty("override_publication_review");
    }
    expect(h.requests.find((c) => c.path === `/admin/publish/${DATASET}/review`)?.status).toBe(500);
  });

  test("a dataset with no active request: the Worker's 404 is what ends it", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    h.db.run("DELETE FROM publication_requests");

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      `No active publication request was found for ${DATASET}; the API decides.`,
    );
    expect(output(r)).toContain("No active publication request found");
    expect(h.requests.at(-1)?.status).toBe(404);
  });
});

describe("with the Worker's gate: what the Worker refuses is printed, and exits 1", () => {
  test("the review cannot be read by the Worker either: it refuses unverified, the command prints that", async () => {
    const requestId = seedGolden();
    seedReport(requestId);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.unverified);
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(requestRow(requestId)?.approved_by).toBeNull();
  });

  test("a blocked request the command could not see is refused by the Worker with the block reason", async () => {
    const requestId = seedGolden({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("The request is blocked");
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(requestRow(requestId)?.status).toBe("blocked");
  });

  test("--force records the override on the review it was shown, for the reasons shown", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    const row = h.db
      .query<{ override_by: number | null; override_reasons: string | null }, [number]>(
        "SELECT override_by, override_reasons FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(row?.override_by).toBe(adminId);
    expect(JSON.parse(row?.override_reasons ?? "[]")).toEqual([
      "question_failed",
      "version_missing",
    ]);
    const audit = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'publication_review_overridden'",
      )
      .get();
    expect(audit?.n).toBe(1);
  });

  test("a reason that came up after it was shown is refused, the sentence and the new reason are printed", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    // Between the command's read of the review and its approval, a release of the version appears.
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.late",
      ]);
    });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.override_not_covering.split(" (nemar")[0]);
    expect(output(r)).toContain(REASONS.version_already_released.sentence);
    expect(output(r)).toContain(`Next: nemar admin publish show ${DATASET}`);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    const row = h.db
      .query<{ override_by: number | null }, [number]>(
        "SELECT override_by FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(row?.override_by).toBeNull();
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--skip-ci-check over a BIDS reason needs --force, and the skip is recorded in the audit row", async () => {
    const requestId = seedGolden();
    seedReport(requestId, reportWith({ bids: "fail" }));

    const r = await approve(["--resume", "--yes", "--force", "--skip-ci-check"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    const published = h.db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'dataset_published' ORDER BY id DESC LIMIT 1",
      )
      .get();
    const details = JSON.parse(published?.details ?? "{}");
    expect(details.skip_ci_check).toBe(true);
    expect(details.review_gate).toBe("enforced");
  });

  test("the web executor's --yes run proceeds on the clicker's recorded override, sends none, and publishes", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    const executorId = await h.admin("executor", EXECUTOR_KEY);
    // The clicker's confirmation, recorded through the real route (the page's body) before the
    // executor runs; the claim it leaves is the live lease that makes the clicker the approver.
    const dispatched = await direct(`/admin/publish/${DATASET}/approve-dispatch`, ADMIN_KEY, {
      override_publication_review: {
        review_id: reviewId,
        reasons: ["question_failed", "version_missing"],
      },
    });
    expect(dispatched.status).toBe(202);

    const r = await approve(["--resume", "--yes"], { as: "executor" });

    expect(r.stdout).toContain(`An override by administrator #${adminId}`);
    expect(r.exitCode).toBe(0);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
    expect(requestRow(requestId)?.approved_by).toBe(adminId);
    expect(requestRow(requestId)?.approved_by).not.toBe(executorId);
  });

  test("another administrator's recorded override covers nothing for this run: the Worker refuses and the command prints it", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    const otherId = await h.admin("otheradmin", OTHER_ADMIN_KEY);
    seedOverride(h.db, reviewId, otherId, ["question_failed", "version_missing"]);

    // The command cannot know whose key is whose, so it goes on; the Worker is the gate.
    const r = await approve(["--resume", "--yes"], { as: "approveradmin" });

    expect(r.stdout).toContain(`An override by administrator #${otherId}`);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.needs_override.split(" Read it")[0]);
    expect(output(r)).toContain(REASONS.question_failed.sentence.replace(/\.$/, ""));
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});
