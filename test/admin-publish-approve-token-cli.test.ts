/**
 * `nemar admin publish approve` as the executor of a web approval (ADR 0080, #1604).
 *
 * A click on the website claims the request and dispatches a runner, which is handed the claim's
 * dispatch token in the environment variable `NEMAR_APPROVAL_DISPATCH_TOKEN` and runs
 * `nemar admin publish approve <id> --resume --yes`. The command presents the token on every call
 * of the run (a header the Worker checks against the claim), and the Worker records the
 * administrator who clicked as the approver. What these tests hold, against the real command and
 * the real backend app (`helpers/admin-publish-cli.ts`; the click is the real
 * `approve-dispatch` route, called in this process over the harness's database, and the token is
 * read off the dispatch the GitHub stand-in received, as the workflow would):
 *
 *  - the executor's run is recorded as the clicker, and sends no override of its own;
 *  - the same command with no token is a person's own act (the Worker refuses it for the review it
 *    has no override for, and leaves the click's claim intact);
 *  - the header rides on every call, a retry after a server error included, and on no call of a
 *    run that has no token; `next` never reads the variable (a person's shell must not turn the
 *    walk into an executor);
 *  - with a token in the environment, a flag that is the administrator's own decision (`--force`,
 *    `--acknowledge-identifier-screen`) is refused locally before anything is sent, because the
 *    click already recorded the decision and the Worker would refuse the call;
 *  - the token is a secret: it reaches neither the console nor the `--debug` log;
 *  - a stale variable in a person's shell is not a silent trap (the Opus review of Phase 3): a run
 *    that presents a token says so on standard error before it sends anything, and a refusal of
 *    that token (`dispatch_superseded`, `dispatch_expired`) is followed by the hint to unset it.
 *
 * Mutation checks (each turns a named test red): send no header (the "every call" rows); read the
 * variable in `next` (the `next` row); send the header only on the first call (the retry row); let
 * `--force` through with a token (the refusal rows); print the token, or let the log keep it (the
 * secret rows); trim nothing (the blank variable row); drop the notice, or print it after the
 * first request (the notice rows); drop the hint, or print it for a refusal that is not about the
 * token (the hint rows).
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { webClaim } from "../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../backend/test/helpers/publication-review-app";
import { REVIEW_GATE_REFUSAL_TEXT } from "../shared/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import {
  DATASET,
  seedGolden,
  seedReport,
  seedUnstarted,
  twoReasons,
} from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const CLICKER_KEY = "token-clicker-key-0123456789abcdef0123456789abcdef";
const EXECUTOR_KEY = "token-executor-key-0123456789abcdef0123456789abcdef";
const APPROVE_PATH = `/admin/publish/${DATASET}/approve`;
const TOKEN_ENV = "NEMAR_APPROVAL_DISPATCH_TOKEN";
const WHY_ACK = "Read the recording formats by hand, nothing to remove";
/** What the command says on standard error when it runs with a token, before it sends anything. */
const NOTICE = `This run presents the dispatch token in ${TOKEN_ENV} (an executor's run for a web approval); unset the variable to approve as yourself.`;
/** What follows a refusal of the token the run presented. */
const UNSET_HINT = `If you are not running a dispatched approval, unset ${TOKEN_ENV} and run it again.`;

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

let clickerId: number;
let executorId: number;

beforeEach(async () => {
  h.reset();
  clickerId = await h.admin("webclicker", CLICKER_KEY);
  executorId = await h.admin("webexecutor", EXECUTOR_KEY);
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;
const approveCalls = () => h.posted.filter((p) => p.path === APPROVE_PATH);
const requestRow = (id: number) =>
  h.db
    .query<
      {
        status: string;
        approved_by: number | null;
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
      },
      [number]
    >(
      "SELECT status, approved_by, approval_requested_by, approval_dispatched_at FROM publication_requests WHERE id = ?",
    )
    .get(id);

/** The short wait between attempts, so a test of the retry does not sleep ten seconds. */
const SHORT_RETRY = { NEMAR_APPROVE_RETRY_DELAY_MS: "0" };

/** What the click dispatched: the payload the workflow would have received. */
function dispatched(): { token: string; requestId: number } {
  const payload = h.github.dispatches.at(-1)?.client_payload ?? {};
  const token = payload.dispatch_token;
  expect(typeof token).toBe("string");
  return { token: token as string, requestId: payload.request_id as number };
}

/**
 * A request that needs an override (two override-class reasons), the clicker's click recorded
 * through the real route with that override, and the dispatch the Worker sent: what the executor
 * starts from.
 */
async function click(): Promise<{ requestId: number; reviewId: number; token: string }> {
  const requestId = seedGolden(h.db);
  const reviewId = seedReport(h.db, requestId, twoReasons());
  const res = await direct(`/admin/publish/${DATASET}/approve-dispatch`, CLICKER_KEY, {
    override_publication_review: {
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    },
  });
  expect(res.status).toBe(202);
  return { requestId, reviewId, token: dispatched().token };
}

/** The executor's command, as the workflow runs it. */
const executor = (
  token: string | undefined,
  flags: string[] = [],
  env: Record<string, string> = {},
) =>
  h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes", ...flags], {
    as: "webexecutor",
    env: { ...env, ...(token === undefined ? {} : { [TOKEN_ENV]: token }) },
  });

describe("the executor of a web approval", () => {
  test("presents the click's token, is recorded as the clicker, and sends no override of its own", async () => {
    const { requestId, token } = await click();
    expect(dispatched().requestId).toBe(requestId);

    const r = await executor(token);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    expect(requestRow(requestId)?.approved_by).toBe(clickerId);
    expect(requestRow(requestId)?.approved_by).not.toBe(executorId);
    expect(approveCalls()).toHaveLength(1);
    expect(approveCalls()[0]?.dispatchToken).toBe(true);
    expect(approveCalls()[0]?.body).not.toHaveProperty("override_publication_review");
    expect(approveCalls()[0]?.body).not.toHaveProperty("acknowledge_identifier_screen");
    // The audit row names who clicked and who ran it.
    const audit = h.db
      .query<{ user_id: number; details: string }, []>(
        "SELECT user_id, details FROM audit_log WHERE action = 'dataset_published'",
      )
      .get();
    expect(audit?.user_id).toBe(clickerId);
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({
      approved_by: "webclicker",
      executed_by: "webexecutor",
    });
  });

  test("the same command with no token is the executor's own act: refused for the override it does not have, and the claim is intact", async () => {
    // The flip of the Phase 2 pin: the clicker's recorded override covers the clicker's run, not
    // whoever happens to call inside the claim. Without the proof the call is nobody else's.
    const { requestId } = await click();
    const claim = requestRow(requestId);

    const r = await executor(undefined);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.needs_override.split(" Read it")[0]);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(approveCalls()[0]?.dispatchToken).toBe(false);
    expect(requestRow(requestId)).toEqual(claim);
    expect(requestRow(requestId)?.approved_by).toBeNull();
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("the token goes on every call of the run: a retry after a server error carries it again", async () => {
    const { requestId, token } = await click();
    // The approval's own request lookup fails once, after the command's reads, and answers 500: the
    // command retries by itself, and the retry is a call like the first.
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

    const r = await executor(token, [], SHORT_RETRY);

    expect(failed).toBe(true);
    expect(output(r)).toContain("Retrying in 0s");
    expect(approveCalls()).toHaveLength(2);
    for (const call of approveCalls()) expect(call.dispatchToken).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.approved_by).toBe(clickerId);
  });

  test("a blank variable is no token: the command is the person's, and no header is sent", async () => {
    const requestId = seedGolden(h.db);
    seedReport(h.db, requestId);

    const r = await executor("   ");

    expect(r.exitCode).toBe(0);
    expect(approveCalls()).toHaveLength(1);
    expect(approveCalls()[0]?.dispatchToken).toBe(false);
    expect(requestRow(requestId)?.approved_by).toBe(executorId);
  });

  test("a token of the claim that was replaced is refused, and the command says so", async () => {
    const { requestId, token } = await click();
    // A newer click replaced the claim (here: the same administrator, a later instant).
    h.db.run(
      "UPDATE publication_requests SET approval_dispatched_at = datetime('now', '+7 seconds') WHERE id = ?",
      [requestId],
    );
    const claim = requestRow(requestId);

    const r = await executor(token);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("no longer current");
    expect(output(r)).toContain(UNSET_HINT);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(requestRow(requestId)).toEqual(claim);
  });
});

describe("a person's shell variable", () => {
  test("is never read by next: the walk's approval is the person's own act, with no header", async () => {
    // `next` is a person's walk. A token left in the shell must not turn it into an executor, which
    // would record the click's administrator for an approval the person made.
    const requestId = seedGolden(h.db);
    seedReport(h.db, requestId);
    const stale = "a".repeat(64);

    const r = await h.cli(["admin", "publish", "next", "--once", "--dataset", DATASET], {
      as: "webexecutor",
      input: "y\n",
      env: { [TOKEN_ENV]: stale },
    });

    expect(r.exitCode).toBe(0);
    expect(approveCalls()).toHaveLength(1);
    expect(approveCalls()[0]?.dispatchToken).toBe(false);
    expect(requestRow(requestId)?.approved_by).toBe(executorId);
    // It never reads the variable, so it never says that a token is in use, and never names it.
    expect(output(r)).not.toContain(TOKEN_ENV);
    expect(output(r)).not.toContain(stale);
  });

  test("is not read by anything else of the group: a command that is not an approval sends no header", async () => {
    const requestId = seedUnstarted(h.db);
    seedReport(h.db, requestId);
    const r = await h.cli(
      ["admin", "publish", "deny", DATASET, "--reason", "Add the README", "--yes"],
      {
        as: "webexecutor",
        env: { [TOKEN_ENV]: "b".repeat(64) },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(h.posted.every((p) => !p.dispatchToken)).toBe(true);
    expect(requestRow(requestId)?.status).toBe("denied");
  });
});

describe("with a token in the environment, the administrator's own decisions are refused locally", () => {
  test("--force: exit 1 with nothing sent, the reason says why", async () => {
    const { requestId, token } = await click();
    const claim = requestRow(requestId);

    const r = await executor(token, ["--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--force");
    expect(output(r)).toContain(TOKEN_ENV);
    expect(h.posted).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(requestRow(requestId)).toEqual(claim);
  });

  test("--acknowledge-identifier-screen: exit 1 with nothing sent", async () => {
    const { requestId, token } = await click();
    const claim = requestRow(requestId);

    const r = await executor(token, ["--acknowledge-identifier-screen", WHY_ACK]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--acknowledge-identifier-screen");
    expect(output(r)).toContain(TOKEN_ENV);
    expect(h.posted).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(requestRow(requestId)).toEqual(claim);
  });

  test("the refusal does not touch a person's command: --force with no token (or a blank one) is the decision it always was", async () => {
    const requestId = seedGolden(h.db);
    const reviewId = seedReport(h.db, requestId, twoReasons());

    const r = await executor("  ", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.approved_by).toBe(executorId);
    const override = h.db
      .query<{ override_by: number | null }, [number]>(
        "SELECT override_by FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(override?.override_by).toBe(executorId);
    expect(approveCalls()[0]?.dispatchToken).toBe(false);
  });
});

describe("a variable left in a person's shell is not a silent trap", () => {
  test("a run that presents a token says so on standard error, names the variable and never the token", async () => {
    const { requestId, token } = await click();

    const r = await executor(token);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.approved_by).toBe(clickerId);
    // One line, on standard error: a script reading standard output is not touched.
    expect(r.stderr.split("\n").filter((line) => line.includes(TOKEN_ENV))).toEqual([NOTICE]);
    expect(r.stdout).not.toContain(TOKEN_ENV);
    expect(output(r)).not.toContain(token);
    // A run that went through has nothing to hint at.
    expect(output(r)).not.toContain(UNSET_HINT);
  });

  test("the notice comes before the first line the run prints for the approval, which comes before its first call", async () => {
    const { token } = await click();

    // On a terminal the two streams share one transcript, so the order they were written in is
    // readable: the notice precedes the heading the command prints before it reads the request.
    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"], {
      as: "webexecutor",
      env: { [TOKEN_ENV]: token },
      terminal: async () => undefined,
    });

    expect(r.exitCode).toBe(0);
    const notice = r.stdout.indexOf(TOKEN_ENV);
    const heading = r.stdout.indexOf(`Resume publication of ${DATASET}`);
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(heading).toBeGreaterThan(notice);
    expect(r.stdout).not.toContain(token);
  });

  test("the notice is a refusal's company too: a token-bearing run stopped by the Worker still said it first", async () => {
    const { token } = await click();
    h.db.run("UPDATE publication_requests SET approval_dispatched_at = NULL");

    const r = await executor(token);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(NOTICE);
  });

  test("no variable, and a blank one, print no notice", async () => {
    const requestId = seedGolden(h.db);
    seedReport(h.db, requestId);

    const none = await executor(undefined);
    expect(none.exitCode).toBe(0);
    expect(output(none)).not.toContain(TOKEN_ENV);

    h.reset();
    await h.admin("webexecutor", EXECUTOR_KEY);
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    seedReport(h.db, seedGolden(h.db));

    const blank = await executor("   ");
    expect(blank.exitCode).toBe(0);
    expect(output(blank)).not.toContain(TOKEN_ENV);
  });

  test("a token of a claim that lapsed (dispatch_expired) is followed by the hint", async () => {
    const requestId = seedGolden(h.db);
    seedReport(h.db, requestId);
    // A genuine token of a click made past the 15 minute lease: the Worker refuses it as expired.
    const token = await webClaim(h.db, {
      requestId,
      clickerId,
      dispatchedAt: "-16 minutes",
      secret: h.env().PRESCREEN_CALLBACK_SECRET,
    });

    const r = await executor(token);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("has expired");
    expect(output(r)).toContain(UNSET_HINT);
    expect(output(r)).not.toContain(token);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
  });

  test("a refusal that is not about the token carries no hint", async () => {
    // The click's request was denied meanwhile: the Worker has no active request to run for, which
    // says nothing about the variable, so it does not suggest unsetting it.
    const { requestId, token } = await click();
    h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);

    const r = await executor(token);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(UNSET_HINT);
    expect(output(r)).not.toContain(token);
  });

  test("a 409 that is not about the token carries no hint either: the request was blocked after the command read it", async () => {
    const { requestId, token } = await click();
    // Between the command's read of the review and its approval the request is blocked again, so
    // the Worker answers `request_blocked` (a 409, and nothing to do with the token it was sent).
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run(
        "UPDATE publication_requests SET status = 'blocked', block_reason = 'min_requirements_failed' WHERE id = ?",
        [requestId],
      );
    });

    const r = await executor(token);

    expect(r.exitCode).toBe(1);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(approveCalls()[0]?.dispatchToken).toBe(true);
    expect(output(r)).not.toContain(UNSET_HINT);
    expect(output(r)).not.toContain(token);
  });

  test("a refusal with no token carries no hint (the review's own refusal, as a person sees it)", async () => {
    await click();

    const r = await executor(undefined);

    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain(UNSET_HINT);
    expect(output(r)).not.toContain(TOKEN_ENV);
  });
});

describe("the help says the variable and the rule", () => {
  test("--help names the variable on the two flags it refuses, and --help-all says what it is and what it does", async () => {
    const concise = await h.cli(["admin", "publish", "approve", "--help"]);
    expect(concise.exitCode).toBe(0);
    const brief = concise.stdout.replace(/\s+/g, " ");
    // Both flags carry the rule where the option list shows it.
    expect(brief).toContain(`recorded with your account (refused while ${TOKEN_ENV} is set)`);
    expect(brief).toContain(`characters; refused while ${TOKEN_ENV} is set)`);

    const all = await h.cli(["admin", "publish", "approve", "--help-all"]);
    expect(all.exitCode).toBe(0);
    const help = all.stdout.replace(/\s+/g, " ");
    expect(help).toContain(`${TOKEN_ENV}, and presents it on every call`);
    expect(help).toContain("--force and --acknowledge-identifier-screen are refused here");
    expect(help).toContain("'next' never reads the variable");
    expect(help).toContain("Environment:");
  });

  test("the README's command lines name the variable", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain(TOKEN_ENV);
  });
});

describe("the token is a secret", () => {
  test("it reaches neither the console nor the --debug log, which still shows that a header was sent", async () => {
    const { requestId, token } = await click();

    const r = await h.cli(
      ["--debug", "admin", "publish", "approve", DATASET, "--resume", "--yes"],
      { as: "webexecutor", env: { [TOKEN_ENV]: token } },
    );

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.approved_by).toBe(clickerId);
    expect(output(r)).not.toContain(token);

    const logs = join(h.configDir, "logs");
    const files = readdirSync(logs);
    expect(files).toHaveLength(1);
    const log = readFileSync(join(logs, files[0] as string), "utf8");
    expect(log).not.toContain(token);
    // The header is there, redacted: the log shows the call carried one, and never its value.
    expect(log.toLowerCase()).toContain("x-approval-dispatch-token");
    expect(log).toContain("[REDACTED]");
    // Nor does it appear in a file name, the log path the command prints, or the command label.
    for (const name of files) expect(name).not.toContain(token);
  });

  test("the command's own lines never carry it, on a refusal either", async () => {
    const { token } = await click();
    // The claim is gone (released), so the Worker refuses the token.
    h.db.run("UPDATE publication_requests SET approval_dispatched_at = NULL");
    const r = await executor(token);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("no longer current");
    expect(output(r)).not.toContain(token);
  });
});
