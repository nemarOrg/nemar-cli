/**
 * `nemar admin publish list | show | start` with the publication review (ADR 0102, section 8),
 * the real command against the real backend app (`helpers/admin-publish-cli.ts`).
 *
 * Every answer a test reads is one the Worker itself made from rows seeded the way the Worker
 * leaves them: review reports go through the production parser, the screen's report through the
 * production screen parser, and the list, the detail and the start are the real routes behind
 * their real auth. GitHub (the dispatch a start sends) and Resend are the only stand-ins.
 *
 * What these tests hold the CLI to: it prints the Worker's words and decides nothing itself (which
 * requests need a person, which a start is offered for), what the model wrote is printed only under
 * a label that says so and never carries a terminal control, and every command's exit code says
 * whether the thing asked for happened.
 *
 * Mutation checks (each turns a named test red): drop the `*` marker (list); count a blocked
 * request or an approval in flight as needing a person, or one whose only reasons are waits
 * (`needsAdministrator`); print the review line for a request that is not assessed; print the
 * model's summary without its label or a note without `plain()` (show); let `--json` print a line
 * besides the JSON; exit 0 for a refused start other than `running` and `has_result`; recompute
 * `start --all`'s candidates from reason codes; continue `start --all` after `platform_limit`;
 * start without a confirmation in a pipe.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SCREENED_HEAD } from "../backend/test/helpers/identifier-screen";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "../backend/test/helpers/publication-review";
import type { PublicationReviewDetail } from "../shared/contract/publication-review-admin";
import {
  NOT_ASSESSED_LINE,
  PUBLICATION_FINDING_LABEL,
  QUESTION_FACT_TEXT,
  QUESTION_LABEL,
  REASONS,
  cureOf,
} from "../shared/publication-review";
import type { PublishRequestsResponse } from "../src/lib/api/publish";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const ADMIN_KEY = "review-cli-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  // The review is on unless a test says otherwise: the flag is the Worker's own binding.
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
  await h.admin("reviewadmin", ADMIN_KEY);
});

/**
 * The generic nudge the exit hook prints on a non-zero exit (src/index.ts). Where exit 1 is the
 * command's answer it is noise, and `markReportedExit` suppresses it; where the Worker itself
 * failed it stays, because that may be a bug worth a report.
 */
const BUG_HINT = "attach the log to a new issue";

/** Anything a terminal could act on, in any line of what was printed. */
const DANGEROUS_IN_LINES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** What the command printed, standard output and standard error together. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

/** The block of lines that belongs to one dataset in `list`: its own line and what is indented under it. */
function blockOf(stdout: string, datasetId: string): string[] {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`  ${datasetId}  `));
  if (at < 0) return [];
  const block = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

/** A request whose review reported the failing report (one failed question, one blocker finding). */
function seedFailing(datasetId: string, over: Partial<SeedScreenedRequest> = {}) {
  const { requestId } = seedScreenedRequest(h.db, { datasetId, ...over });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report: failingReport(),
    claimed: true,
  });
  return { requestId, reviewId };
}

/** A request whose review reported a clean pass. */
function seedPassing(datasetId: string) {
  const { requestId } = seedScreenedRequest(h.db, { datasetId });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report: goodPublicationReport(),
    claimed: true,
  });
  return { requestId, reviewId };
}

const LIST = ["admin", "publish", "list"];

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

describe("list with the review", () => {
  /** One request of each kind an administrator has to tell apart, and what the marker should say. */
  function seedQueue() {
    seedFailing("nm000480");
    // A review that is running: only waiting.
    const running = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    seedPublicationReview(h.db, {
      requestId: running.requestId,
      datasetId: "nm000481",
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    // Blocked: the depositor acts.
    seedScreenedRequest(h.db, {
      datasetId: "nm000482",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    // An approval running right now (an approving request touched a moment ago holds its lease).
    seedScreenedRequest(h.db, { datasetId: "nm000483", requestStatus: "approving" });
    seedPassing("nm000484");
    // The identifier screen is still running: only waiting.
    seedScreenedRequest(h.db, { datasetId: "nm000485", status: "pending" });
    // A stopped approval: approving, and nothing has touched it for hours.
    seedScreenedRequest(h.db, { datasetId: "nm000486", requestStatus: "approving" });
    h.db.run(
      "UPDATE publication_requests SET updated_at = datetime('now', '-2 hours') WHERE dataset_id = 'nm000486'",
    );
  }

  test("prints the review line with its reason codes, and a * on exactly the requests that need a person", async () => {
    seedQueue();

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (7)");

    const failing = blockOf(r.stdout, "nm000480");
    expect(failing[0].trimEnd().endsWith("*")).toBe(true);
    expect(failing.join("\n")).toContain("Publication review: FAIL  question_failed");
    // The review line follows the screen's, under the request.
    const screenAt = failing.findIndex((l) => l.includes("Identifier screen:"));
    const reviewAt = failing.findIndex((l) => l.includes("Publication review:"));
    expect(screenAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(screenAt);

    const passing = blockOf(r.stdout, "nm000484");
    expect(passing[0].trimEnd().endsWith("*")).toBe(true);
    expect(passing.join("\n")).toContain("Publication review: pass");

    // A request whose approval was stopped is the administrator's to resume.
    expect(blockOf(r.stdout, "nm000486")[0].trimEnd().endsWith("*")).toBe(true);

    // Waiting for the review, waiting for the screen, blocked, and an approval in flight: no mark.
    for (const id of ["nm000481", "nm000485", "nm000482", "nm000483"]) {
      expect(blockOf(r.stdout, id)[0].trimEnd().endsWith("*")).toBe(false);
    }
    expect(blockOf(r.stdout, "nm000481").join("\n")).toContain("review_running");
    expect(blockOf(r.stdout, "nm000485").join("\n")).toContain("identifier_screen_pending");
    expect(blockOf(r.stdout, "nm000482").join("\n")).toContain("request_blocked");
    expect(blockOf(r.stdout, "nm000483")[0]).toContain("(approval running)");

    expect(r.stdout).toContain("7 requests, 3 you can act on.");
    expect(r.stdout).toContain("nemar admin publish next | show <dataset> | approve <dataset>");
    // The review is on, so nothing says it is off.
    expect(r.stdout).not.toContain("The automated review is off");
  });

  test("--needs-me keeps exactly the requests a person can act on and says how many it hid", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--needs-me"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (3)");
    for (const id of ["nm000480", "nm000484", "nm000486"]) expect(r.stdout).toContain(id);
    for (const id of ["nm000481", "nm000482", "nm000483", "nm000485"]) {
      expect(r.stdout).not.toContain(id);
    }
    expect(r.stdout).toContain("Showing 3 of 7 requests, 3 you can act on.");
  });

  test("--json prints the response and nothing else on standard output", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--json"]);

    expect(r.exitCode).toBe(0);
    // One document: parsing the whole of standard output is the check that nothing else was printed.
    const body = JSON.parse(r.stdout) as PublishRequestsResponse;
    expect(body.count).toBe(7);
    expect(body.requests).toHaveLength(7);
    const failing = body.requests.find((q) => q.dataset_id === "nm000480");
    expect(failing?.publication_review).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
  });

  test("--json with --needs-me prints the rows a person can act on, counted", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--json", "--needs-me"]);

    const body = JSON.parse(r.stdout) as PublishRequestsResponse;
    expect(body.requests.map((q) => q.dataset_id).sort()).toEqual([
      "nm000480",
      "nm000484",
      "nm000486",
    ]);
    expect(body.count).toBe(3);
  });

  test("--json sends an error to standard error and leaves standard output empty", async () => {
    const r = await h.cli([...LIST, "--json"], { signedOut: true });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not authenticated");
  });

  test("--status accepts blocked and the help says so", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--status", "blocked"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (1)");
    expect(r.stdout).toContain("nm000482");
    const help = await h.cli([...LIST, "--help"]);
    expect(help.stdout).toContain("blocked");
  });
});

describe("list with the review off", () => {
  beforeEach(() => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
  });

  test("a request with no review has no review line, and the footer says the review is off", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedScreenedRequest(h.db, { datasetId: "nm000481" });

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    for (const id of ["nm000480", "nm000481"]) {
      const block = blockOf(r.stdout, id);
      expect(block.length).toBeGreaterThan(0);
      expect(block.join("\n")).not.toContain("Publication review");
      // Not assessed is not a pass and not a wait: a person can still decide it.
      expect(block[0].trimEnd().endsWith("*")).toBe(true);
    }
    expect(r.stdout).toContain(
      "The automated review is off on this Worker, so no review gates an approval.",
    );
  });

  test("a stored review is printed as advice, and the footer still says the review is off", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedFailing("nm000481");

    const r = await h.cli(LIST);

    const stored = blockOf(r.stdout, "nm000481").join("\n");
    expect(stored).toContain(
      "Publication review (advice only, the automated review is off): FAIL  question_failed",
    );
    expect(blockOf(r.stdout, "nm000480").join("\n")).not.toContain("Publication review");
    // Every row says the review is off, whether or not it holds a review.
    expect(r.stdout).toContain("The automated review is off on this Worker");
  });
});

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

const ACK_AT = "2026-10-13 10:01:00";
const OVERRIDE_AT = "2026-10-13 10:02:11";

/**
 * A request whose review has everything `show` prints: a question the platform's own facts failed
 * (no README), a finding and a summary in the model's words, a cut and a withheld document, an
 * older review of another commit, an override on record and a screen acknowledgment.
 */
function seedRich(datasetId: string): { requestId: number; reviewId: number } {
  const adminId = h.db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'reviewadmin'")
    .get()?.id as number;
  const { requestId } = seedScreenedRequest(h.db, { datasetId, status: "review" });
  h.db.run(
    `UPDATE publication_requests
        SET identifier_screen_ack_by = ?, identifier_screen_ack_reason = 'dates only, read them',
            identifier_screen_ack_at = ?
      WHERE id = ?`,
    [adminId, ACK_AT, requestId],
  );
  const report = goodPublicationReport({
    summary: SUMMARY_SENTINEL,
    findings: [
      {
        question: "meets_standards",
        severity: "concern",
        code: "ethics_statement_inadequate",
        document: "dataset_description",
        note: NOTE_SENTINEL,
      },
    ],
    evidence: evidenceFor(SCREENED_HEAD, false, {
      version: "1.2.0",
      documents: {
        readme: "absent",
        dataset_description: "sent",
        changes: "absent",
        license: "sent_cut",
        participants_json: "withheld_finding",
      },
      withheld_findings: { "edf-patient-name": 1 },
    }),
  });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report,
    claimed: true,
    createdMinutesAgo: 5,
  });
  h.db.run(
    `UPDATE publication_reviews
        SET override_by = ?, override_at = ?, override_reasons = '["question_failed","text_withheld"]'
      WHERE id = ?`,
    [adminId, OVERRIDE_AT, reviewId],
  );
  // An earlier attempt on another commit: history, not the review in force.
  seedPublicationReview(h.db, {
    requestId,
    datasetId,
    head: "a".repeat(40),
    state: "errored",
    detail: "model_unavailable",
    createdMinutesAgo: 120,
  });
  return { requestId, reviewId };
}

/** The detail as the Worker answered it: the oracle for the words `show` must print as they are. */
async function detailOf(datasetId: string): Promise<PublicationReviewDetail> {
  const r = await h.cli(["admin", "publish", "show", datasetId, "--json"]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as PublicationReviewDetail;
}

/** The positions of `markers` in `text`, which must all be found and in this order. */
function expectInOrder(text: string, markers: string[]): void {
  let from = 0;
  for (const marker of markers) {
    const at = text.indexOf(marker, from);
    expect(at, `"${marker}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = at + marker.length;
  }
}

describe("show", () => {
  test("prints the screen, the headline, the gate, the reasons with their cures, the questions, the facts, the findings and summary under their labels, the evidence, what was shown, the standing line and the next command", async () => {
    const { requestId } = seedRich("nm000480");
    const detail = await detailOf("nm000480");
    // The words come from the Worker; the test reads what it said and holds the CLI to printing it.
    expect(detail.description.headline).toBe("Publication review: FAIL");
    expect(detail.description.next).not.toBeNull();

    const before = h.requests.length;
    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    const questionFailed = REASONS.question_failed.sentence.replace(/\.$/, "");
    expectInOrder(r.stdout, [
      `nm000480  request ${requestId}, requested, named publication`,
      "Identifier screen:",
      `Acknowledged by administrator ${detail.screen_acknowledgment?.by} at ${ACK_AT}.`,
      detail.description.headline,
      "Gate: enforced",
      questionFailed,
      cureOf("question_failed", "nm000480", true),
      "Questions:",
      "complete_and_honest",
      "fail",
      QUESTION_LABEL.complete_and_honest,
      "Platform facts that lowered an answer:",
      `complete_and_honest: ${QUESTION_FACT_TEXT.readme_absent}`,
      "Findings (written by the model; the depositor's text can steer them):",
      `[concern] ${PUBLICATION_FINDING_LABEL.ethics_statement_inadequate} (dataset_description.json): ${NOTE_SENTINEL}`,
      "Summary (written by the model; the depositor's text can steer it):",
      SUMMARY_SENTINEL,
      "Evidence: version 1.2.0 (tag absent), BIDS pass, minimums met, 4 subjects, 0 sessions, 4 recordings (.edf 4), datatypes eeg, sampling rates 256 Hz, channel counts 32, sidecars read 4 of 4",
      "Shown to the model: README absent, dataset_description.json sent (9 keys shown, 1 not), CHANGES absent, LICENSE sent (cut), participants.json withheld (finding)",
      "Withheld for findings: edf-patient-name 1",
      `Override: by administrator ${detail.review?.override?.by} at ${OVERRIDE_AT} for question_failed, text_withheld`,
      NOT_ASSESSED_LINE,
      `Next: ${detail.description.next}`,
      "History",
    ]);
    // Every line of the Worker's description is printed as it came.
    for (const line of detail.description.lines) expect(r.stdout).toContain(line);
    // The history lists the reviews, the one in force marked.
    const history = r.stdout.slice(r.stdout.indexOf("History"));
    expect(history).toContain("reported");
    expect(history).toContain("errored");
    expect(history).toContain("in force");
    // Read-only: the command wrote nothing.
    expect(h.requests.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /admin/publish/nm000480/review",
    ]);
  });

  test("the model's words are printed once, under their labels, and nowhere else", async () => {
    seedRich("nm000480");

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    const lines = r.stdout.split("\n");
    expect(lines.filter((l) => l.includes(SUMMARY_SENTINEL))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(NOTE_SENTINEL))).toHaveLength(1);
    const labelAt = lines.findIndex((l) => l.includes("Summary (written by the model;"));
    expect(lines[labelAt + 1]).toContain(SUMMARY_SENTINEL);
    const findingsAt = lines.findIndex((l) => l.includes("Findings (written by the model;"));
    expect(lines[findingsAt + 1]).toContain(NOTE_SENTINEL);
    // The list, which an administrator reads at a glance, carries neither.
    const list = await h.cli(LIST);
    expect(list.stdout).not.toContain(SUMMARY_SENTINEL);
    expect(list.stdout).not.toContain(NOTE_SENTINEL);
  });

  test("a passing review prints its pass, no findings and no reason, and the approve command", async () => {
    seedPassing("nm000484");

    const r = await h.cli(["admin", "publish", "show", "nm000484"]);

    expect(r.exitCode).toBe(0);
    const detail = await detailOf("nm000484");
    expectInOrder(r.stdout, [
      "nm000484  request",
      "Identifier screen:",
      "Publication review: pass",
      "Gate: enforced",
      "Questions:",
      "Summary (written by the model; the depositor's text can steer it):",
      "Evidence:",
      "Shown to the model:",
      NOT_ASSESSED_LINE,
      `Next: ${detail.description.next}`,
    ]);
    expect(r.stdout).not.toContain("Findings (");
    expect(r.stdout).not.toContain("Platform facts");
    expect(r.stdout).not.toContain("Override:");
    expect(r.stdout).not.toContain("History");
  });

  test("a request with no review says so in the Worker's words, and the flag off says the gate is off", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    const detail = await detailOf("nm000480");
    expectInOrder(r.stdout, [
      detail.description.headline,
      "Gate: off (advice only)",
      NOT_ASSESSED_LINE,
    ]);
    expect(r.stdout).not.toContain("Questions:");
  });

  test("a blocked request shows why, even with the review off and no reasons", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedScreenedRequest(h.db, {
      datasetId: "nm000480",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout).toContain("blocked (min_requirements_failed)");
  });

  test("an anonymous release says so up front", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480", anonymous: true });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout.split("\n")[1]).toContain("ANONYMOUS RELEASE");
  });

  test("the non-production Worker says it is not production", async () => {
    h.setEnv({ ENVIRONMENT: "staging" });
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout).toContain("This is the non-production Worker.");
    const production = await h.cli(LIST);
    expect(production.stdout).not.toContain("non-production");
  });

  test("--json prints the detail and nothing else", async () => {
    seedRich("nm000480");

    const r = await h.cli(["admin", "publish", "show", "nm000480", "--json"]);

    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as PublicationReviewDetail;
    expect(body.dataset_id).toBe("nm000480");
    expect(body.review?.summary).toBe(SUMMARY_SENTINEL);
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("}")).toBe(true);
  });

  test("a model's text carrying a terminal escape and a bidirectional override prints without them", async () => {
    // The Worker reduces the model's words to plain ones before it sends them; this is the end of
    // the chain, a stored report that carries the controls, read back through the real route. The
    // CLI's own `plain()` is held to the same by publication-review-display.unit.test.ts, which
    // feeds it hostile text the Worker would never send.
    const ESC = String.fromCharCode(27);
    const hostile = `${ESC}[2J${ESC}]0;title\u0007steered‮reversed​ end`;
    const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000480" });
    const base = failingReport() as { findings: Array<{ note: string }>; summary: string };
    base.summary = hostile;
    base.findings[0].note = hostile;
    seedPublicationReview(h.db, {
      requestId,
      datasetId: "nm000480",
      state: "reported",
      rawReport: JSON.stringify(base),
      verdict: "fail",
      claimed: true,
    });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Summary (written by the model;");
    // Every line, split on the newline that separates them: any other control is hostile (the run
    // has no colour, so none of it is the CLI's own).
    for (const line of r.stdout.split("\n")) expect(line).not.toMatch(DANGEROUS_IN_LINES);
  });

  test("a dataset with no active request exits 1 with the Worker's sentence and no bug-report hint", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480", requestStatus: "published" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("nm000480 has no active publication request.");
    expect(output(r)).not.toContain(BUG_HINT);
    expect(h.requests.at(-1)?.status).toBe(404);
  });

  test("a malformed id exits 1 before any request is made", async () => {
    const r = await h.cli(["admin", "publish", "show", "not-a-dataset"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain('"not-a-dataset" is not a dataset id');
    expect(output(r)).not.toContain(BUG_HINT);
    expect(h.requests).toEqual([]);
  });

  test("signed out exits 1 and says so on standard output, or on standard error under --json", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const text = await h.cli(["admin", "publish", "show", "nm000480"], { signedOut: true });
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("Not authenticated");

    const json = await h.cli(["admin", "publish", "show", "nm000480", "--json"], {
      signedOut: true,
    });
    expect(json.exitCode).toBe(1);
    expect(json.stdout).toBe("");
    expect(json.stderr).toContain("Not authenticated");
    expect(h.requests).toEqual([]);
  });

  test("a read the Worker could not make exits 1 and keeps the bug-report hint", async () => {
    seedPassing("nm000484");
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await h.cli(["admin", "publish", "show", "nm000484"]);

    expect(r.exitCode).toBe(1);
    expect(h.requests.at(-1)?.status).toBe(500);
    expect(output(r)).toContain("The publication review could not be read. Try again.");
    expect(output(r)).toContain(BUG_HINT);
  });
});
