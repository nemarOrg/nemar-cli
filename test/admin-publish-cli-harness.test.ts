/**
 * The harness every CLI test of `nemar admin publish` runs on (`helpers/admin-publish-cli.ts`),
 * tested on its own so a later suite can trust what it reads from it.
 *
 * The claims, each against the real command and the real backend app:
 *   - a command returns what the backend really holds, and a write really lands in its database;
 *   - the stand-ins record what the backend sent them, and answer what the test told them to;
 *   - nothing leaves the machine: a mail goes to the Resend stand-in, the command runs under its
 *     own configuration directory and the signed-in account is the one the test chose;
 *   - the hooks that let a test change the world between a command's read and its write work.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SCREENED_HEAD, markScreen } from "../backend/test/helpers/identifier-screen";
import { seedScreenedRequest } from "../backend/test/helpers/publication-review";
import { PUBLICATION_STEPS } from "../shared/publication-steps";
import { type CliResult, WORKER_GITHUB_TOKEN, startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const DATASET = "nm000460";
const ADMIN_KEY = "harness-admin-key-0123456789abcdef0123456789abcdef";
const OTHER_ADMIN_KEY = "harness-other-admin-key-0123456789abcdef0123456789";
/** Every step but the two logged no-ops: a run the gates let through reaches `published`. */
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

const h = startPublishCli();
afterAll(() => h.stop());

let adminId: number;

/** Everything the command printed. The spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

beforeEach(async () => {
  h.reset();
  adminId = await h.admin("harnessadmin", ADMIN_KEY);
});

function requestRow(id: number) {
  return h.db
    .query<
      {
        status: string;
        denied_by: number | null;
        denied_reason: string | null;
        identifier_screen_status: string | null;
      },
      [number]
    >(
      "SELECT status, denied_by, denied_reason, identifier_screen_status FROM publication_requests WHERE id = ?",
    )
    .get(id);
}

/** A clean request with every step but the two no-ops done, ready for `approve --resume`. */
function seedGoldenRequest(): number {
  const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });
  h.db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(DONE),
    requestId,
  ]);
  return requestId;
}

describe("the real command against the real backend", () => {
  test("list prints what the backend's database holds, in the backend's own words", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });
    seedScreenedRequest(h.db, { datasetId: "nm000461", status: "review" });

    const r = await h.cli(["admin", "publish", "list"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (2)");
    expect(r.stdout).toContain(DATASET);
    expect(r.stdout).toContain("nm000461");
    expect(r.stdout).toContain("depositor_nm000460");
    // The screen's headline is composed by the backend and printed as it arrived.
    expect(r.stdout).toContain("Identifier screen:");
    expect(r.stdout).toContain("needs review");
    // The command asked the real route, and the route answered 200.
    expect(h.requests).toEqual([{ method: "GET", path: "/admin/publish/requests", status: 200 }]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("the status filter reaches the backend and narrows what comes back", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    seedScreenedRequest(h.db, { datasetId: "nm000461", requestStatus: "denied" });

    const r = await h.cli(["admin", "publish", "list", "--status", "denied"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (1)");
    expect(r.stdout).toContain("nm000461");
    expect(r.stdout).not.toContain(DATASET);
  });

  test("a write lands in the real database, attributed to the signed-in account", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });

    const r = await h.cli([
      "admin",
      "publish",
      "deny",
      DATASET,
      "--reason",
      "Please add the missing participants file",
      "--yes",
    ]);

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(`Publication denied for ${DATASET}`);
    expect(requestRow(requestId)).toMatchObject({
      status: "denied",
      denied_by: adminId,
      denied_reason: "Please add the missing participants file",
    });
  });

  test("a golden-path approval reaches `published` through the real orchestrator", async () => {
    const requestId = seedGoldenRequest();

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    // The command read the review once (its detail carries what the banner needs), then the
    // approval was posted once.
    expect(h.requests.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /admin/publish/${DATASET}/review`,
      `POST /admin/publish/${DATASET}/approve`,
    ]);
  });
});

describe("the stand-ins record what they were sent", () => {
  test("the GitHub stand-in records the gate's one read, made with the Worker's own token", async () => {
    seedGoldenRequest();

    await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    const reads = h.github.seen.filter((c) => c.path.endsWith("/git/ref/heads/main"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      method: "GET",
      path: `/repos/nemarDatasets/${DATASET}/git/ref/heads/main`,
      // The Worker's credential, not the administrator's API key.
      token: WORKER_GITHUB_TOKEN,
    });
    expect(h.github.seen.some((c) => c.token === ADMIN_KEY)).toBe(false);
  });

  test("the head the stand-in answers is the head the real gate compares against", async () => {
    const requestId = seedGoldenRequest();
    h.mainHead.value = "fedcba9876543210fedcba9876543210fedcba98";

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    // Refused by the Worker's screen gate (the screened commit is no longer main), not by the
    // harness: the request never started approving and nothing was published.
    expect(output(r)).toContain("main is now at fedcba987654");
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("the stand-in answers the BIDS validation run with the conclusion the test chose", async () => {
    const requestId = seedScreenedRequest(h.db, { datasetId: DATASET }).requestId;
    h.bidsConclusion.value = "failure";

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--yes"]);

    // The run stopped at the validation step the stand-in failed, a 422 the CLI does not retry.
    expect(output(r)).toContain("Fix the CI issues and retry with --resume");
    expect(
      h.github.seen.some((c) => c.path.endsWith("/actions/workflows/bids-validation.yml/runs")),
    ).toBe(true);
    expect(requestRow(requestId)?.status).toBe("approving");
  });

  test("a mail the Worker sends reaches the Resend stand-in and nowhere else", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });

    await h.cli(["admin", "publish", "deny", DATASET, "-r", "Needs a README", "-y"]);

    const sends = h.mail.filter((c) => c.path === "/emails");
    expect(sends).toHaveLength(1);
    const body = sends[0].body as { to: string[]; subject: string; html: string };
    expect(body.to).toEqual([`depositor_${DATASET}@example.org`]);
    expect(body.subject).toContain(DATASET);
    expect(body.html).toContain("Needs a README");
  });

  test("a refusing Resend still lets the denial stand, and the stand-in saw the attempt", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });

    const r = await h.cli(["admin", "publish", "deny", DATASET, "-r", "Needs a README", "-y"], {
      resend: { status: 422 },
    });

    expect(r.exitCode).toBe(0);
    expect(h.mail.filter((c) => c.path === "/emails")).toHaveLength(1);
    expect(requestRow(requestId)?.status).toBe("denied");
  });
});

describe("the account and the configuration a command runs under", () => {
  test("the command runs as the account the test names", async () => {
    await h.admin("secondadmin", OTHER_ADMIN_KEY);
    const second = h.db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'secondadmin'")
      .get()?.id;
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });

    // The last account seeded is the default; `as` picks another.
    await h.cli(["admin", "publish", "deny", DATASET, "-r", "Not ready yet", "-y"], {
      as: "harnessadmin",
    });

    expect(requestRow(requestId)?.denied_by).toBe(adminId);
    expect(adminId).not.toBe(second as number);
  });

  test("the default account is the one seeded last", async () => {
    const second = await h.admin("secondadmin", OTHER_ADMIN_KEY);
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });

    await h.cli(["admin", "publish", "deny", DATASET, "-r", "Not ready yet", "-y"]);

    expect(requestRow(requestId)?.denied_by).toBe(second);
  });

  test("a member's key reaches the backend as a member's, and is refused there", async () => {
    await h.user("harnessmember", "member", "harness-member-key-0123456789abcdef0123456789");

    const r = await h.cli(["admin", "publish", "list"]);

    expect(output(r)).toContain("This command requires admin privileges");
    expect(h.requests).toEqual([{ method: "GET", path: "/admin/publish/requests", status: 403 }]);
  });

  test("an account that was never seeded is refused loudly, not run as nobody", async () => {
    await expect(h.cli(["admin", "publish", "list"], { as: "ghost" })).rejects.toThrow(
      'no account "ghost"',
    );
  });

  test("two commands at once are refused rather than interleaved", async () => {
    const first = h.cli(["admin", "publish", "list"]);
    await expect(h.cli(["admin", "publish", "list"])).rejects.toThrow("one command at a time");
    expect((await first).exitCode).toBe(0);
  });

  test("signed out, the command is stopped before it reaches the backend", async () => {
    const r = await h.cli(["admin", "publish", "list"], { signedOut: true });

    expect(r.stdout).toContain("Not authenticated");
    expect(h.requests).toEqual([]);
  });

  test("the configuration is a throwaway directory, never the real one", async () => {
    const r = await h.cli(["auth", "status"]);

    // `auth status` names the file it read: a directory the harness made, under the system
    // temporary directory, and not the user's own.
    const config = /Config:\s+(\S+)/.exec(output(r))?.[1] ?? "";
    expect(config).toContain("nemar-publish-cli-");
    expect(config.startsWith(tmpdir())).toBe(true);
    expect(config).not.toContain(".config");
    expect(readFileSync(config, "utf8")).toContain(ADMIN_KEY);
  });
});

describe("what a test can change between a command's read and its write", () => {
  test("`after` runs once, after the matched answer and before the command's next request", async () => {
    const requestId = seedGoldenRequest();
    // `approve` reads the review, then posts the approval. Break the screen after that read: the
    // real gate, not the harness, refuses the write.
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("UPDATE publication_requests SET identifier_screen_status = 'error' WHERE id = ?", [
        requestId,
      ]);
    });

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(output(r)).toContain("Identifier screen: DID NOT RUN");
    expect(requestRow(requestId)).toMatchObject({
      status: "requested",
      identifier_screen_status: "error",
    });
    expect(h.requests.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual([
      `GET /admin/publish/${DATASET}/review 200`,
      `POST /admin/publish/${DATASET}/approve 409`,
    ]);
  });

  test("`after` runs once the answer is made: the command never sees what the hook changed", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });
    h.after("GET /admin/publish/requests", () => {
      h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);
    });

    const r = await h.cli(["admin", "publish", "list"]);

    // The list was read while the request was still waiting; the hook ran after, so the row
    // the administrator saw is one the database no longer holds.
    expect(r.stdout).toMatch(new RegExp(`${DATASET}\\s+requested`));
    expect(requestRow(requestId)?.status).toBe("denied");
  });

  test("a hook is spent after it ran once", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    let ran = 0;
    h.after("GET /admin/publish/requests", () => {
      ran++;
    });

    await h.cli(["admin", "publish", "list"]);
    await h.cli(["admin", "publish", "list"]);

    expect(ran).toBe(1);
  });

  test("`hookDb` makes a named statement of the real database fail, and the backend answers 500", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    h.hookDb({
      statement(sql) {
        if (/FROM publication_requests/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await h.cli(["admin", "publish", "list"]);

    expect(h.requests).toEqual([{ method: "GET", path: "/admin/publish/requests", status: 500 }]);
    expect(r.stdout).not.toContain("Publication Requests");
  });

  test("a screen the test marks clean again is the screen the gate reads", async () => {
    const requestId = seedGoldenRequest();
    markScreen(h.db, requestId, DATASET, { status: "review" });

    const r = await h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

    expect(output(r)).toContain("--acknowledge-identifier-screen");
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});

describe("input and isolation", () => {
  test("input is piped to the command's standard input", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: DATASET });

    // With no --reason the command asks for one on standard input.
    const r = await h.cli(["admin", "publish", "deny", DATASET, "--yes"], {
      input: "The participants file is missing\n",
    });

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.denied_reason).toBe("The participants file is missing");
  });

  test("reset gives the next test a fresh database, no accounts and empty records", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    await h.cli(["admin", "publish", "list"]);
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    h.mainHead.value = "0000000000000000000000000000000000000000";
    expect(h.env().PUBLICATION_REVIEW_ENABLED).toBe("1");

    h.reset();

    expect(h.db.query("SELECT COUNT(*) AS n FROM publication_requests").get()).toEqual({ n: 0 });
    // The only account a fresh database holds is the system one the migrations create.
    expect(h.db.query("SELECT username FROM users").all()).toEqual([{ username: "nemar-system" }]);
    expect(h.requests).toEqual([]);
    expect(h.mail).toEqual([]);
    expect(h.github.seen).toEqual([]);
    expect(h.mainHead.value).toBe(SCREENED_HEAD);
    expect(h.env().PUBLICATION_REVIEW_ENABLED).toBeUndefined();
    // With the accounts gone the command is signed out, and the old account cannot be named.
    const r = await h.cli(["admin", "publish", "list"]);
    expect(r.stdout).toContain("Not authenticated");
    await expect(h.cli(["admin", "publish", "list"], { as: "harnessadmin" })).rejects.toThrow(
      'no account "harnessadmin"',
    );
  });

  test("stop closes both servers and puts the GitHub address back", async () => {
    const address = () => (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
    const before = address();
    const second = startPublishCli();
    const during = address();
    expect(during).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(during).not.toBe(before);

    second.stop();

    expect(address()).toBe(before);
    await expect(fetch(`${during}/`)).rejects.toThrow();
  });

  test("the bindings default to production with the Worker's own GitHub credential", () => {
    expect(h.env()).toMatchObject({
      ENVIRONMENT: "production",
      GITHUB_ADMIN_PAT: WORKER_GITHUB_TOKEN,
    });
    h.setEnv({ ENVIRONMENT: "test" });
    expect(h.env().ENVIRONMENT).toBe("test");
  });
});
