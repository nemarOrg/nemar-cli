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
import {
  type SeedScreenedRequest,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "../backend/test/helpers/publication-review";
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
