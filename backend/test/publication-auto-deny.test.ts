/**
 * The automatic denial of a publication request (ADR 0139, decisions 1 to 4 and 8), driven through
 * the real routes: the review job's result callback, its claim and inputs routes, and the admin
 * restore route, on a real bun:sqlite database with every migration.
 *
 * What is real: the Worker's routes behind their real token checks, the shared deny function the
 * admin route also takes, the cap's claim, the audit rows, and the mail builder behind the real
 * delivery fence (Resend is moved to a local server by `helpers/resend.ts`, so "no mail" is read off
 * what a real send would have posted). GitHub is the harness's `Bun.serve` stand-in, which records
 * each dispatch. Interleavings land a real write through `hookedD1` just before the deny's batch.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and local stand-ins.
 */

import { describe, expect, test } from "bun:test";
import { AUTO_DENY_STATE_COPY, CONFIRMING_MODEL } from "../../shared/publication-auto-deny";
import { PUBLICATION_PROMPT_VERSION, REVIEW_INPUTS } from "../../shared/publication-review";
import { AUTO_DENY_AUDIT_ACTION } from "../../shared/resubmission-note";
import { notifyAdminsOfScreen } from "../src/services/identifier-screen";
import { autoDenyStep, sendAutoDenyDigest } from "../src/services/publication-auto-deny";
import { sweepPublicationReviews } from "../src/services/publication-review";
import type { Bindings } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";
import {
  NOTE_SENTINEL,
  SCREENED_HEAD,
  SUMMARY_SENTINEL,
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  textOf,
} from "./helpers/publication-review";
import {
  DEV_DATASET,
  PROD_DATASET,
  createHarness,
  hookedD1,
} from "./helpers/publication-review-harness";
import { type CapturedEmail, asSend, sendsTo, withFakeResend } from "./helpers/resend";

const h = createHarness();

const ADMIN_EMAIL = "autodenyadmin@example.org";
const OWNER_EMAIL = "autodenyowner@example.org";
const DIGEST = "ab".repeat(32);
const ABSENT_INPUTS = Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"]));
const HAIKU = "claude-haiku-5-5";

interface BodyOptions {
  model?: string;
  effort?: string;
  digest?: string;
  anonymous?: boolean;
  head?: string;
  /** The failed question's blocker codes; empty for a report that passes. */
  blockers?: string[];
  steering?: boolean;
  lineage?: { outcome: string; credited: boolean } | null;
}

/**
 * A version-2 report as the job posts it, with the model's own words set to sentinels: the summary
 * and every finding's note. A first run's body is checked by the shared helper's production parse.
 */
function reportBody(o: BodyOptions = {}): Record<string, unknown> {
  const model = o.model ?? HAIKU;
  const blockers = o.blockers ?? ["readme_missing_or_stub"];
  const failed = blockers.length > 0;
  const record = (m: string, effort: string) => ({
    prompt_version: PUBLICATION_PROMPT_VERSION,
    models: [{ model: m, effort }],
    input_digest: o.digest ?? DIGEST,
    resolver_version: null,
    enrichment_source: null,
  });
  const body = goodPublicationReport({
    v: 2,
    summary: SUMMARY_SENTINEL,
    questions: {
      complete_and_honest: failed ? "fail" : "pass",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: blockers.map((code) => ({
      question: "complete_and_honest",
      severity: "blocker",
      code,
      document: "readme",
      note: NOTE_SENTINEL,
    })),
    steering: o.steering ?? false,
    evidence: {
      ...evidenceFor(o.head ?? SCREENED_HEAD, o.anonymous ?? false),
      inputs: ABSENT_INPUTS,
      lineage: o.lineage ?? null,
    },
    note_answer: "not_asked",
    record: record(HAIKU, "high"),
  });
  if (model !== HAIKU) {
    body.model = model;
    body.record = record(model, o.effort ?? "max");
  }
  return body;
}

/** The confirming run's report: the same failing body on the confirming model at max. */
function confirmingBody(o: BodyOptions = {}): Record<string, unknown> {
  return reportBody({ model: CONFIRMING_MODEL, ...o });
}

let serviceId = 0;

/** The service account and an administrator who receives the publication mail. */
async function accounts(): Promise<void> {
  serviceId = await seedUser(h.db, "nemarAdmin", "admin", "nemaradmin-key-0123456789abcdef0123", {
    email: "nemaradmin@example.org",
  });
  await seedUser(h.db, "autodenyadmin", "admin", "autodeny-admin-key-0123456789abcdef01", {
    email: ADMIN_EMAIL,
  });
}

interface FirstRun {
  requestId: number;
  userId: number;
  firstId: number;
  status: number;
}

/** A named request whose identifier screen is clean, and its first run's report posted. */
async function firstRun(
  o: BodyOptions & { datasetId?: string; env?: Bindings; mailed?: boolean } = {},
): Promise<FirstRun> {
  const datasetId = o.datasetId ?? PROD_DATASET;
  const { requestId, userId } = seedScreenedRequest(h.db, {
    datasetId,
    anonymous: o.anonymous,
    mailed: o.mailed ?? false,
  });
  const firstId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    anonymous: o.anonymous,
    state: "dispatched",
    claimed: true,
  });
  const res = await h.result(
    firstId,
    { outcome: "reported", report: reportBody(o) },
    undefined,
    o.env,
    datasetId,
  );
  expect(res.status).toBe(200);
  return { requestId, userId, firstId, status: res.status };
}

function confirmOf(firstId: number): Record<string, unknown> | null {
  return h.db
    .query("SELECT * FROM publication_reviews WHERE confirm_of = ?")
    .get(firstId) as Record<string, unknown> | null;
}

/** The job's claim and report for the confirming row, through the real routes. */
async function confirmRun(
  firstId: number,
  body: Record<string, unknown>,
  o: { datasetId?: string; env?: Bindings } = {},
): Promise<number> {
  const datasetId = o.datasetId ?? PROD_DATASET;
  const confirm = confirmOf(firstId);
  expect(confirm).not.toBeNull();
  const id = Number(confirm?.id);
  expect((await h.claim(id, undefined, o.env, datasetId)).status).toBe(200);
  const res = await h.result(id, confirmRunBody(body), undefined, o.env, datasetId);
  expect(res.status).toBe(200);
  return id;
}

function auditRows(action: string): Record<string, unknown>[] {
  return h.db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Record<
    string,
    unknown
  >[];
}

function adminMails(calls: CapturedEmail[]) {
  return sendsTo(calls, ADMIN_EMAIL);
}

function depositorMails(calls: CapturedEmail[], datasetId = PROD_DATASET) {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((m) =>
      m.subject.includes(`Publication request denied by an automated agent: ${datasetId}`),
    );
}

// ============================================================================

describe("the mode", () => {
  test("off, unset or any word but the three: an eligible fail starts no confirming run", async () => {
    await accounts();
    for (const mode of [undefined, "off", "ON", "On", " on", "1", "true", "deny", ""]) {
      h.db.run("DELETE FROM publication_reviews");
      h.db.run("DELETE FROM publication_requests");
      h.calls = [];
      h.envOverrides = mode === undefined ? {} : { PUBLICATION_AUTO_DENY_MODE: mode };
      await withFakeResend(async (calls) => {
        const { requestId, firstId } = await firstRun();
        expect(h.dispatches()).toHaveLength(0);
        expect(confirmOf(firstId)).toBeNull();
        expect(h.review(firstId).auto_deny_state).toBe("none");
        expect(h.requestRow(requestId).status).toBe("requested");
        // The administrators are told as before: the fail, and nothing about an automatic denial.
        const mail = adminMails(calls);
        expect(mail).toHaveLength(1);
        expect(textOf(mail[0]?.html ?? "")).toContain("Publication review: FAIL");
      });
    }
  });

  test("shadow: the confirming run is dispatched, agrees, and records would-deny; nothing is denied", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "shadow" };
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      // The confirming run is a row of its own, dispatched with the same coordinates.
      const confirm = confirmOf(firstId);
      expect(confirm).toMatchObject({
        request_id: requestId,
        head_sha: SCREENED_HEAD,
        anonymous: 0,
        state: "dispatched",
        confirm_of: firstId,
        auto_deny_state: "none",
      });
      expect(h.dispatches()).toHaveLength(1);
      expect(h.dispatches()[0]?.client_payload).toMatchObject({
        review_id: confirm?.id,
        request_id: requestId,
        head_sha: SCREENED_HEAD,
        anonymous: false,
      });
      // Its live row holds the administrators' mail until it decides.
      expect(adminMails(calls)).toHaveLength(0);

      await confirmRun(firstId, confirmingBody());
      expect(h.review(firstId)).toMatchObject({ auto_deny_state: "would_deny" });
      expect(h.review(firstId).auto_deny_at).not.toBeNull();
      expect(h.requestRow(requestId)).toMatchObject({ status: "requested", auto_denied: 0 });
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
      expect(depositorMails(calls)).toHaveLength(0);
      const mail = adminMails(calls);
      expect(mail).toHaveLength(1);
      expect(textOf(mail[0]?.html ?? "")).toContain("Would deny (shadow mode)");
    });
  });
});

describe("on: a confirmed fail denies, as nemarAdmin, and says so", () => {
  test("the request is denied with the closed reason codes, an audit row, and the depositor's mail", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    // The dataset's owner is another person, who is mailed too.
    const ownerId = await seedUser(
      h.db,
      "autodenyowner",
      "member",
      "owner-key-0123456789abcdef012345",
      {
        email: OWNER_EMAIL,
      },
    );
    await withFakeResend(async (calls) => {
      const { requestId, userId, firstId } = await firstRun();
      h.db.run("UPDATE datasets SET owner_user_id = ? WHERE dataset_id = ?", [
        ownerId,
        PROD_DATASET,
      ]);
      const confirmId = await confirmRun(firstId, confirmingBody());

      expect(h.requestRow(requestId)).toMatchObject({
        status: "denied",
        auto_denied: 1,
        denied_by: serviceId,
        denied_reason: "question_failed",
      });
      expect(h.review(firstId)).toMatchObject({ auto_deny_state: "denied" });
      expect(h.review(confirmId)).toMatchObject({
        state: "reported",
        verdict: "fail",
        auto_deny_state: "none",
        input_digest: DIGEST,
        models: JSON.stringify([{ model: CONFIRMING_MODEL, effort: "max" }]),
      });
      const audit = auditRows(AUTO_DENY_AUDIT_ACTION);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        user_id: serviceId,
        resource_type: "dataset",
        resource_id: PROD_DATASET,
      });
      const details = JSON.parse(String(audit[0]?.details));
      expect(details).toMatchObject({
        request_id: requestId,
        review_ids: [firstId, confirmId],
        head: SCREENED_HEAD,
        prompt_version: PUBLICATION_PROMPT_VERSION,
        input_digest: DIGEST,
        codes: ["readme_missing_or_stub"],
      });
      expect(details.models).toEqual([
        [{ model: HAIKU, effort: "high" }],
        [{ model: CONFIRMING_MODEL, effort: "max" }],
      ]);

      // The requester and the owner, once each; no administrator is mailed about it now.
      const mails = depositorMails(calls);
      expect(mails.map((m) => m.to[0]).sort()).toEqual(
        [OWNER_EMAIL, `depositor_${PROD_DATASET}@example.org`].sort(),
      );
      expect(userId).not.toBe(ownerId);
      expect(adminMails(calls)).toHaveLength(0);

      const text = textOf(mails[0]?.html ?? "");
      expect(text).toContain("An automated agent reviewed this request and denied it");
      expect(text).toContain(
        "The README is missing, or is a stub that does not describe the dataset.",
      );
      expect(text).toContain("#automatic-denial-readme-missing-or-stub");
      expect(text).toContain("nemar dataset screen --committed");
      expect(text).toContain("nemar dataset license-check");
      expect(text).toContain(`Reviewed commit: ${SCREENED_HEAD}`);
      expect(text).toContain(`Models: ${HAIKU} (effort high)`);
      expect(text).toContain(`Models: ${CONFIRMING_MODEL} (effort max)`);
      expect(text).toContain(`Input digest (SHA-256): ${DIGEST}`);
      expect(text).toContain(
        "A model's verdict may differ on another run; the inputs are what you can check.",
      );
      expect(text).toContain(`nemar dataset publish request ${PROD_DATASET} --note`);
      expect(text).toContain("Reply to this mail to reach a person.");
      // Never a word the model wrote, in either report.
      for (const m of mails) {
        expect(m.html).not.toContain(SUMMARY_SENTINEL);
        expect(m.html).not.toContain(NOTE_SENTINEL);
      }
    });

    // The status says an automated agent denied it (B3 reads the audit row).
    // Read as the dataset's owner, whom the mail also reached.
    const key = "owner-key-0123456789abcdef012345";
    const status = await h.app.request(
      `/datasets/${PROD_DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${key}` } },
      h.env(),
    );
    expect(status.status).toBe(200);
    const answer = (await status.json()) as {
      status: string;
      denied_by_kind: string;
      denied_reason: string;
      review_record: { models: { model: string }[] } | null;
    };
    expect(answer).toMatchObject({
      status: "denied",
      denied_by_kind: "agent",
      denied_reason: "question_failed",
    });
  });

  test("steering alone is confirmed by steering", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun({ blockers: [], steering: true });
      await confirmRun(firstId, confirmingBody({ blockers: [], steering: true }));
      expect(h.requestRow(requestId)).toMatchObject({
        status: "denied",
        denied_reason: "steering_attempt",
      });
    });
  });

  test("the mode is read again when the confirming run reports: switched off since, nothing is denied", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "shadow " };
      await confirmRun(firstId, confirmingBody());
      expect(h.requestRow(requestId).status).toBe("requested");
      expect(h.review(firstId).auto_deny_state).toBe("none");
    });
  });
});

describe("disagreement goes to the administrators", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["the confirming run passes", confirmingBody({ blockers: [] })],
    ["it names no code the first named", confirmingBody({ blockers: ["name_not_descriptive"] })],
    ["it fails on a code that never denies", confirmingBody({ blockers: ["provenance_unclear"] })],
    ["it was made over another input digest", confirmingBody({ digest: "cd".repeat(32) })],
  ];
  for (const [name, body] of cases) {
    test(`disagreed when ${name}`, async () => {
      await accounts();
      h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
      await withFakeResend(async (calls) => {
        const { requestId, firstId } = await firstRun();
        await confirmRun(firstId, { outcome: "reported", report: body });
        expect(h.review(firstId).auto_deny_state).toBe("disagreed");
        expect(h.requestRow(requestId)).toMatchObject({ status: "requested", auto_denied: 0 });
        expect(depositorMails(calls)).toHaveLength(0);
        const mail = adminMails(calls);
        expect(mail).toHaveLength(1);
        expect(textOf(mail[0]?.html ?? "")).toContain("Automated review disagreed");
      });
    });
  }

  test("a confirming run that errors is confirm_failed, its own state with its own line, never a deny", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      await confirmRun(firstId, { outcome: "error", error: "model_truncated" });
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
      expect(h.requestRow(requestId)).toMatchObject({ status: "requested", auto_denied: 0 });
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
      expect(depositorMails(calls)).toHaveLength(0);
      const text = textOf(adminMails(calls)[0]?.html ?? "");
      expect(text).toContain(AUTO_DENY_STATE_COPY.confirm_failed.statement);
      expect(text).not.toContain("Automated review disagreed");
    });
  });

  test("a confirming row's report on the confirming model at any effort but max is refused", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      const confirmId = await confirmRun(firstId, confirmingBody({ effort: "high" }));
      expect(h.review(confirmId)).toMatchObject({ state: "errored", detail: "report_invalid" });
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
      expect(h.requestRow(requestId).status).toBe("requested");
    });
  });

  test("a confirming row's report on the first run's model, or a first run's on the confirming model, is refused", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      const confirmId = await confirmRun(firstId, { outcome: "reported", report: reportBody() });
      expect(h.review(confirmId)).toMatchObject({ state: "errored", detail: "report_invalid" });
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
      expect(h.requestRow(requestId).status).toBe("requested");
    });
    await withFakeResend(async () => {
      const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000481", mailed: false });
      const id = seedPublicationReview(h.db, {
        requestId,
        datasetId: "nm000481",
        state: "dispatched",
        claimed: true,
      });
      await h.result(
        id,
        { outcome: "reported", report: confirmingBody() },
        undefined,
        undefined,
        "nm000481",
      );
      expect(h.review(id)).toMatchObject({ state: "errored", detail: "report_invalid" });
    });
  });
});

// Each `{ outcome, report }` passed through `confirmRun` above: a bare body is the default shape.
function confirmRunBody(body: Record<string, unknown>): Record<string, unknown> {
  return "outcome" in body ? body : { outcome: "reported", report: body };
}

describe("never eligible: no confirming run is started", () => {
  const cases: Array<[string, BodyOptions & { mailed?: boolean }]> = [
    ["an anonymous release", { anonymous: true }],
    ["a pass", { blockers: [] }],
    ["a fail on a code that never denies", { blockers: ["source_license_conflict"] }],
    ["a fail on provenance", { blockers: ["provenance_unclear"] }],
    [
      "license lineage that needs action",
      { blockers: [], lineage: { outcome: "needs_permission", credited: false } },
    ],
  ];
  for (const [name, o] of cases) {
    test(name, async () => {
      await accounts();
      h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
      await withFakeResend(async () => {
        const { requestId, firstId } = await firstRun(o);
        expect(confirmOf(firstId)).toBeNull();
        expect(h.dispatches()).toHaveLength(0);
        expect(h.requestRow(requestId).status).toBe("requested");
      });
    });
  }

  test("an infrastructure result: a run that errored", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET, mailed: false });
    const id = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "dispatched",
      claimed: true,
    });
    await withFakeResend(async () => {
      await h.result(id, { outcome: "error", error: "model_unavailable" });
      expect(confirmOf(id)).toBeNull();
      expect(h.dispatches()).toHaveLength(0);
    });
  });

  test("a dataset with two earlier automatic denials; one earlier is still eligible", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    const earlier = (n: number) => {
      const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
      h.db.run(
        `UPDATE publication_requests SET status = 'denied', denied_at = datetime('now'),
                auto_denied = 1, requested_at = datetime('now', ?) WHERE id = ?`,
        [`-${n} days`, requestId],
      );
    };
    earlier(3);
    await withFakeResend(async () => {
      const one = await firstRun();
      expect(confirmOf(one.firstId)).not.toBeNull();
      h.db.run("UPDATE publication_requests SET status = 'denied', auto_denied = 1 WHERE id = ?", [
        one.requestId,
      ]);
      const two = await firstRun();
      expect(confirmOf(two.firstId)).toBeNull();
    });
  });
});

describe("the daily cap", () => {
  test("past the cap, the request stays and the administrators' mail says recommended: deny", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on", PUBLICATION_AUTO_DENY_DAILY_CAP: "0" };
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      await confirmRun(firstId, confirmingBody());
      expect(h.review(firstId).auto_deny_state).toBe("capped");
      expect(h.requestRow(requestId)).toMatchObject({ status: "requested", auto_denied: 0 });
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
      expect(depositorMails(calls)).toHaveLength(0);
      const mail = adminMails(calls);
      expect(mail).toHaveLength(1);
      expect(textOf(mail[0]?.html ?? "")).toContain("Recommended: deny");
    });
  });

  test("two claims racing for the last place: exactly one denies, the other is capped", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on", PUBLICATION_AUTO_DENY_DAILY_CAP: "1" };
    await withFakeResend(async () => {
      const a = await firstRun({ datasetId: "nm000481" });
      const b = await firstRun({ datasetId: "nm000482" });
      const ida = Number(confirmOf(a.firstId)?.id);
      const idb = Number(confirmOf(b.firstId)?.id);
      expect((await h.claim(ida, undefined, undefined, "nm000481")).status).toBe(200);
      expect((await h.claim(idb, undefined, undefined, "nm000482")).status).toBe(200);
      const [ra, rb] = await Promise.all([
        h.result(ida, confirmRunBody(confirmingBody()), undefined, undefined, "nm000481"),
        h.result(idb, confirmRunBody(confirmingBody()), undefined, undefined, "nm000482"),
      ]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const states = [h.review(a.firstId).auto_deny_state, h.review(b.firstId).auto_deny_state];
      expect(states.sort()).toEqual(["capped", "denied"]);
      const statuses = [h.requestRow(a.requestId).status, h.requestRow(b.requestId).status];
      expect(statuses.sort()).toEqual(["denied", "requested"]);
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(1);
    });
  });

  test("shadow's would-deny counts against the same cap", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "shadow", PUBLICATION_AUTO_DENY_DAILY_CAP: "1" };
    await withFakeResend(async () => {
      const a = await firstRun({ datasetId: "nm000481" });
      await confirmRun(a.firstId, confirmingBody(), { datasetId: "nm000481" });
      const b = await firstRun({ datasetId: "nm000482" });
      await confirmRun(b.firstId, confirmingBody(), { datasetId: "nm000482" });
      expect(h.review(a.firstId).auto_deny_state).toBe("would_deny");
      expect(h.review(b.firstId).auto_deny_state).toBe("capped");
    });
  });
});

describe("races", () => {
  test("an approval that takes the request just before the deny's batch: nothing is denied, not_eligible", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      const confirmId = Number(confirmOf(firstId)?.id);
      expect((await h.claim(confirmId)).status).toBe(200);
      let landed = false;
      const raced = {
        ...h.env(),
        DB: hookedD1(realD1(h.db), {
          batch: (sqls) => {
            if (!landed && sqls.some((s) => s.includes("SET status = 'denied'"))) {
              landed = true;
              h.db.run(
                `UPDATE publication_requests SET status = 'approving', updated_at = datetime('now')
                  WHERE id = ?`,
                [requestId],
              );
            }
          },
        }),
      } as Bindings;
      const res = await h.result(confirmId, confirmRunBody(confirmingBody()), undefined, raced);
      expect(res.status).toBe(200);
      expect(landed).toBe(true);
      expect(h.requestRow(requestId)).toMatchObject({ status: "approving", auto_denied: 0 });
      expect(h.review(firstId).auto_deny_state).toBe("not_eligible");
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
      expect(depositorMails(calls)).toHaveLength(0);
    });
  });

  test("a request blocked just before the deny's batch is not denied: the write is guarded on requested", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      const confirmId = Number(confirmOf(firstId)?.id);
      expect((await h.claim(confirmId)).status).toBe(200);
      let landed = false;
      const raced = {
        ...h.env(),
        DB: hookedD1(realD1(h.db), {
          batch: (sqls) => {
            if (!landed && sqls.some((s) => s.includes("SET status = 'denied'"))) {
              landed = true;
              // Blocked in the same second the deny read it, so its `updated_at` still matches.
              h.db.run(
                `UPDATE publication_requests SET status = 'blocked', block_reason = 'min_requirements_failed'
                  WHERE id = ?`,
                [requestId],
              );
            }
          },
        }),
      } as Bindings;
      await h.result(confirmId, confirmRunBody(confirmingBody()), undefined, raced);
      expect(landed).toBe(true);
      expect(h.requestRow(requestId)).toMatchObject({ status: "blocked", auto_denied: 0 });
      expect(h.review(firstId).auto_deny_state).toBe("not_eligible");
      expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
    });
  });

  test("an approval already in flight when the confirming run reports: not_eligible, and the cap is not spent", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      const confirmId = Number(confirmOf(firstId)?.id);
      expect((await h.claim(confirmId)).status).toBe(200);
      h.db.run(
        "UPDATE publication_requests SET approval_dispatched_at = datetime('now') WHERE id = ?",
        [requestId],
      );
      await h.result(confirmId, confirmRunBody(confirmingBody()));
      expect(h.requestRow(requestId).status).toBe("requested");
      expect(h.review(firstId).auto_deny_state).toBe("not_eligible");
    });
  });
});

describe("the confirming run's inputs name its model", () => {
  test("the inputs route adds the confirming model and effort for a confirming row only", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "shadow" };
    const inputs = async (id: number) => {
      const token = await h.tokenFor(id);
      const res = await h.app.request(
        "/webhooks/publication-review-inputs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
          body: JSON.stringify({ review_id: id, dataset_id: PROD_DATASET }),
        },
        h.env(),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    await withFakeResend(async () => {
      const { firstId } = await firstRun();
      const confirmId = Number(confirmOf(firstId)?.id);
      expect((await h.claim(confirmId)).status).toBe(200);
      const confirming = await inputs(confirmId);
      expect(confirming.status).toBe(200);
      expect(confirming.body.confirm).toEqual({ model: CONFIRMING_MODEL, effort: "max" });

      const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000481" });
      const plain = seedPublicationReview(h.db, {
        requestId,
        datasetId: "nm000481",
        state: "dispatched",
        claimed: true,
      });
      const token = await h.tokenFor(plain, "nm000481");
      const res = await h.app.request(
        "/webhooks/publication-review-inputs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
          body: JSON.stringify({ review_id: plain, dataset_id: "nm000481" }),
        },
        h.env(),
      );
      expect(res.status).toBe(200);
      expect("confirm" in ((await res.json()) as Record<string, unknown>)).toBe(false);
    });
  });
});

describe("the reversal", () => {
  const restore = (datasetId: string, body: Record<string, unknown> = {}) =>
    h.app.request(
      `/admin/publish/${datasetId}/restore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer autodeny-admin-key-0123456789abcdef01",
        },
        body: JSON.stringify(body),
      },
      h.env(),
    );

  test("an administrator restores an automatic denial, with an audit row; a second restore is refused", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    let requestId = 0;
    await withFakeResend(async () => {
      const run = await firstRun();
      requestId = run.requestId;
      await confirmRun(run.firstId, confirmingBody());
    });
    expect(h.requestRow(requestId).status).toBe("denied");
    const res = await restore(PROD_DATASET, { request_id: requestId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset_id: PROD_DATASET, request_id: requestId });
    expect(h.requestRow(requestId)).toMatchObject({
      status: "requested",
      auto_denied: 0,
      denied_by: null,
      denied_reason: null,
      denied_at: null,
    });
    const audit = auditRows("publication_restore");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]?.details))).toEqual({
      request_id: requestId,
      auto_denied: true,
    });

    const again = await restore(PROD_DATASET);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("not_denied");
    expect(auditRows("publication_restore")).toHaveLength(1);
  });

  test("refused for a withdrawn request, a request that is not the newest, and a dataset with none", async () => {
    await accounts();
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    h.db.run(
      `UPDATE publication_requests SET status = 'denied', withdrawn_at = datetime('now'),
              denied_at = datetime('now') WHERE id = ?`,
      [requestId],
    );
    const withdrawn = await restore(PROD_DATASET);
    expect(withdrawn.status).toBe(409);
    expect(((await withdrawn.json()) as { code: string }).code).toBe("withdrawn");

    const older = await restore(PROD_DATASET, { request_id: requestId + 100 });
    expect(older.status).toBe(409);
    expect(((await older.json()) as { code: string }).code).toBe("newer_request");

    const none = await restore("nm000489");
    expect(none.status).toBe(404);
    expect(auditRows("publication_restore")).toHaveLength(0);
    expect(h.requestRow(requestId).status).toBe("denied");
  });

  test("a member cannot restore", async () => {
    await accounts();
    await seedUser(h.db, "plainmember", "member", "member-key-0123456789abcdef0123456789");
    const res = await h.app.request(
      `/admin/publish/${PROD_DATASET}/restore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer member-key-0123456789abcdef0123456789",
        },
        body: "{}",
      },
      h.env(),
    );
    expect(res.status).toBe(403);
  });
});

describe("the dev Worker's mail gate", () => {
  test("on the dev Worker, the denial mail reaches only DEV_EMAIL_ALLOWLIST", async () => {
    await accounts();
    const ownerId = await seedUser(
      h.db,
      "devowner",
      "member",
      "devowner-key-0123456789abcdef0123",
      {
        email: OWNER_EMAIL,
      },
    );
    const devEnv = h.env({
      ENVIRONMENT: "development",
      PUBLICATION_AUTO_DENY_MODE: "on",
      DEV_EMAIL_ALLOWLIST: `depositor_${DEV_DATASET}@example.org`,
    });
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun({ datasetId: DEV_DATASET, env: devEnv });
      h.db.run("UPDATE datasets SET owner_user_id = ? WHERE dataset_id = ?", [
        ownerId,
        DEV_DATASET,
      ]);
      await confirmRun(firstId, confirmRunBody(confirmingBody()), {
        datasetId: DEV_DATASET,
        env: devEnv,
      });
      expect(h.requestRow(requestId).status).toBe("denied");
      const sent = depositorMails(calls, DEV_DATASET).map((m) => m.to[0]);
      expect(sent).toEqual([`depositor_${DEV_DATASET}@example.org`]);
      expect(sendsTo(calls, OWNER_EMAIL)).toHaveLength(0);
      // The dev Worker sends administrators nothing (getAdminEmailsForCategory's fence).
      expect(adminMails(calls)).toHaveLength(0);
    });
  });
});

describe("the administrators' daily digest", () => {
  test("production only, once a day, listing what the automatic denial did", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const a = await firstRun({ datasetId: "nm000481" });
      await confirmRun(a.firstId, confirmingBody(), { datasetId: "nm000481" });
      const b = await firstRun({ datasetId: "nm000482" });
      await confirmRun(b.firstId, confirmRunBody(confirmingBody({ blockers: [] })), {
        datasetId: "nm000482",
      });
      const c = await firstRun({ datasetId: "nm000483" });
      await confirmRun(
        c.firstId,
        { outcome: "error", error: "model_unavailable" },
        {
          datasetId: "nm000483",
        },
      );
    });
    // Moved into the window, which closes at the digest's own instant.
    h.db.run(
      "UPDATE publication_reviews SET auto_deny_at = datetime('now', '-1 minute') WHERE auto_deny_at IS NOT NULL",
    );

    await withFakeResend(async (calls) => {
      const dev = await sendAutoDenyDigest(h.env({ ENVIRONMENT: "development" }));
      expect(dev).toMatchObject({ skipped: true, claimed: false });
      expect(calls).toHaveLength(0);

      const first = await sendAutoDenyDigest(h.env());
      expect(first).toMatchObject({ skipped: false, claimed: true, rows: 3 });
      const mail = sendsTo(calls, ADMIN_EMAIL);
      expect(mail).toHaveLength(1);
      expect(mail[0]?.subject).toBe("[NEMAR] Automatic denials: daily digest");
      const text = textOf(mail[0]?.html ?? "");
      expect(text).toContain("Denied (1)");
      expect(text).toContain("Automated review disagreed (1)");
      // Shown apart from a disagreement.
      expect(text).toContain("Confirming run did not finish (1)");
      expect(text).toContain("nm000481 request");
      expect(text).toContain("readme_missing_or_stub");
      expect(text).toContain(AUTO_DENY_STATE_COPY.denied.statement);
      expect(text).not.toContain(SUMMARY_SENTINEL);
      expect(text).not.toContain(NOTE_SENTINEL);

      const second = await sendAutoDenyDigest(h.env());
      expect(second.claimed).toBe(false);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });
});

describe("the administrators' mail for a review that passed (ADR 0139, decision 8)", () => {
  async function passMail(status: "clean" | "review"): Promise<string> {
    await accounts();
    const { requestId } = seedScreenedRequest(h.db, {
      datasetId: PROD_DATASET,
      status,
      mailed: false,
    });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: reportBody({ blockers: [], lineage: { outcome: "compatible", credited: true } }),
    });
    let text = "";
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(h.env(), requestId)).toBe("sent");
      const mail = adminMails(calls);
      expect(mail).toHaveLength(1);
      text = textOf(mail[0]?.html ?? "");
      expect(mail[0]?.html).not.toContain(SUMMARY_SENTINEL);
    });
    return text;
  }

  test("gate clear: Ready to approve, with the gate, the minimums, the lineage, the four answers and the command", async () => {
    const text = await passMail("clean");
    expect(text).toContain("Ready to approve");
    expect(text).toContain("Identifier screen gate: clear.");
    expect(text).toContain("The minimum requirements are met at the reviewed commit.");
    expect(text).toContain("License lineage: Every upstream source is in the public domain");
    expect(text).toContain(`nemar admin dataset publish license-lineage ${PROD_DATASET}`);
    expect(text).toContain("Whether the README is complete and agrees with the dataset: yes.");
    expect(text).toContain("Whether the name describes the dataset: yes.");
    expect(text).toContain(`nemar admin dataset publish approve ${PROD_DATASET}`);
    expect(text).not.toContain("still needs an acknowledgment");
  });

  test("gate acknowledge: the review passed, the screen still needs an acknowledgment, and its status line is quoted", async () => {
    const text = await passMail("review");
    expect(text).toContain("Review passed; the identifier screen still needs an acknowledgment");
    expect(text).not.toContain("Ready to approve");
    expect(text).toMatch(/The identifier screen says: "Identifier screen: [^"]+"/);
    expect(text).toContain("Identifier screen gate: needs an acknowledgment.");
    expect(text).toContain(
      `nemar admin dataset publish approve ${PROD_DATASET} --acknowledge-identifier-screen`,
    );
  });

  test("a fail is not a pass: neither headline", async () => {
    await accounts();
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET, mailed: false });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: reportBody(),
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(h.env(), requestId)).toBe("sent");
      const text = textOf(adminMails(calls)[0]?.html ?? "");
      expect(text).toContain("Publication review: FAIL");
      expect(text).not.toContain("Ready to approve");
      expect(text).not.toContain("Review passed");
    });
  });
});

describe("a confirming run and the allowances (ADR 0139: the platform's own check)", () => {
  const head = (n: number) => n.toString(16).padStart(40, "c");

  test("it is left out of the depositor's tally: a depositor whose reviews were confirmed is not held", async () => {
    await accounts();
    const { userId } = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    // Four of the depositor's own calls today, each confirmed by a confirming run: eight rows.
    for (let i = 0; i < 4; i++) {
      const { requestId } = seedScreenedRequest(h.db, {
        datasetId: `nm00049${i}`,
        requestedBy: userId,
      });
      const firstId = seedPublicationReview(h.db, {
        requestId,
        datasetId: `nm00049${i}`,
        state: "reported",
        report: reportBody(),
      });
      const c = seedPublicationReview(h.db, {
        requestId,
        datasetId: `nm00049${i}`,
        head: head(i + 1),
        state: "reported",
        report: reportBody({ head: head(i + 1) }),
      });
      h.db.run("UPDATE publication_reviews SET confirm_of = ? WHERE id = ?", [firstId, c]);
    }
    // A fifth request of the depositor starts its review: 4 + 1 is inside the cap of 5, and the
    // four confirming calls do not count.
    const { requestId } = seedScreenedRequest(h.db, {
      datasetId: "nm000485",
      requestedBy: userId,
      status: "pending",
    });
    await withFakeResend(async () => {
      expect((await h.screenResult(requestId, "nm000485")).status).toBe(200);
    });
    const started = h.db
      .query(
        "SELECT state, detail FROM publication_reviews WHERE request_id = ? AND confirm_of IS NULL",
      )
      .get(requestId);
    expect(started).toEqual({ state: "dispatched", detail: null });
  });

  test("it is held by the platform's allowance: past it, the confirming run is declined and nothing denies", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    // The platform's fifty calls today, on another dataset.
    const { requestId: other } = seedScreenedRequest(h.db, { datasetId: "nm000488" });
    for (let i = 0; i < 50; i++) {
      seedPublicationReview(h.db, {
        requestId: other,
        datasetId: "nm000488",
        head: head(100 + i),
        state: "reported",
        report: reportBody({ head: head(100 + i) }),
      });
    }
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      expect(confirmOf(firstId)).toMatchObject({ state: "declined", detail: "platform_limit" });
      expect(h.dispatches()).toHaveLength(0);
      expect(h.requestRow(requestId).status).toBe("requested");
      // Nothing will confirm it, and the first run says so.
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
    });
  });
});

// ============================================================================
// Review round 1
// ============================================================================

function mailState(firstId: number) {
  return h.db
    .query(
      "SELECT denial_mail_state AS state, denial_mail_attempts AS attempts FROM publication_reviews WHERE id = ?",
    )
    .get(firstId) as { state: string | null; attempts: number };
}

/** A new UTC day for the digest: the claim of today is moved to the past, as a day passing does. */
function nextDigestDay(): void {
  h.db.run("UPDATE publication_auto_deny_digests SET day = date(day, '-1 day')");
}

describe("the denial mail is never silent", () => {
  test("a send that fails is recorded failed, retried once by the daily tick, and listed when it fails again", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    let firstId = 0;
    let requestId = 0;
    await withFakeResend(
      async (calls) => {
        const run = await firstRun();
        firstId = run.firstId;
        requestId = run.requestId;
        await confirmRun(firstId, confirmingBody());
        expect(h.requestRow(requestId).status).toBe("denied");
        expect(depositorMails(calls).length).toBeGreaterThan(0);
      },
      { status: 500 },
    );
    expect(mailState(firstId)).toEqual({ state: "failed", attempts: 1 });

    // The daily tick tries it again; it fails again, and the digest (which reaches the
    // administrators this time) lists it.
    let tries = 0;
    await withFakeResend(
      async (calls) => {
        const r = await sendAutoDenyDigest(h.env());
        tries = depositorMails(calls).length;
        expect(r).toMatchObject({ claimed: true, retried: 1 });
      },
      { status: 500 },
    );
    expect(tries).toBeGreaterThan(0);
    expect(mailState(firstId)).toEqual({ state: "failed", attempts: 2 });

    nextDigestDay();
    await withFakeResend(async (calls) => {
      const r = await sendAutoDenyDigest(h.env());
      // Tried twice already: not tried a third time.
      expect(r).toMatchObject({ claimed: true, retried: 0, undelivered: 1 });
      expect(depositorMails(calls)).toHaveLength(0);
      const text = textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "");
      expect(text).toContain("Denial mail not delivered (1)");
      expect(text).toContain(`${PROD_DATASET} request ${requestId}`);
    });
  });

  test("a failed mail that the retry delivers is sent, and not listed", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    let firstId = 0;
    await withFakeResend(
      async () => {
        const run = await firstRun();
        firstId = run.firstId;
        await confirmRun(firstId, confirmingBody());
      },
      { status: 500 },
    );
    await withFakeResend(async (calls) => {
      const r = await sendAutoDenyDigest(h.env());
      expect(r).toMatchObject({ retried: 1, undelivered: 0 });
      expect(depositorMails(calls).length).toBeGreaterThan(0);
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).not.toContain(
        "Denial mail not delivered",
      );
    });
    expect(mailState(firstId)).toEqual({ state: "sent", attempts: 2 });
  });

  test("the dev fence holding every recipient is recorded fenced, not sent", async () => {
    await accounts();
    const devEnv = h.env({
      ENVIRONMENT: "development",
      PUBLICATION_AUTO_DENY_MODE: "on",
      DEV_EMAIL_ALLOWLIST: "",
    });
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun({ datasetId: DEV_DATASET, env: devEnv });
      await confirmRun(firstId, confirmingBody(), { datasetId: DEV_DATASET, env: devEnv });
      expect(h.requestRow(requestId).status).toBe("denied");
      expect(depositorMails(calls, DEV_DATASET)).toHaveLength(0);
      expect(mailState(firstId)).toEqual({ state: "fenced", attempts: 1 });
    });
  });
});

describe("a confirming run that never confirms is confirm_failed, and the digest shows it", () => {
  test("its dispatch fails", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    h.dispatchStatus = 500;
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      expect(confirmOf(firstId)).toMatchObject({ state: "errored", detail: "dispatch_failed" });
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
      expect(h.requestRow(requestId).status).toBe("requested");
      // The administrators are told now, with the state's line.
      expect(textOf(adminMails(calls)[0]?.html ?? "")).toContain(
        AUTO_DENY_STATE_COPY.confirm_failed.statement,
      );
    });
    await withFakeResend(async (calls) => {
      expect(await sendAutoDenyDigest(h.env())).toMatchObject({ rows: 1 });
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).toContain(
        "Confirming run did not finish (1)",
      );
    });
  });

  test("the watchdog expires it", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async (calls) => {
      const { requestId, firstId } = await firstRun();
      const confirmId = Number(confirmOf(firstId)?.id);
      expect(h.review(firstId).auto_deny_state).toBe("none");
      h.db.run(
        "UPDATE publication_reviews SET created_at = datetime('now', '-45 minutes') WHERE id = ?",
        [confirmId],
      );
      const swept = await sweepPublicationReviews(h.env());
      expect(swept.timedOut).toBe(1);
      expect(h.review(confirmId).state).toBe("unreported");
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
      expect(h.requestRow(requestId).status).toBe("requested");
      expect(textOf(adminMails(calls)[0]?.html ?? "")).toContain(
        AUTO_DENY_STATE_COPY.confirm_failed.statement,
      );
      // A late report of the expired run decides nothing.
      expect((await h.claim(confirmId)).status).toBe(200);
      await h.result(confirmId, confirmRunBody(confirmingBody()));
      expect(h.requestRow(requestId).status).toBe("requested");
      expect(h.review(firstId).auto_deny_state).toBe("confirm_failed");
    });
    await withFakeResend(async (calls) => {
      expect(await sendAutoDenyDigest(h.env())).toMatchObject({ rows: 1 });
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).toContain(
        "Confirming run did not finish (1)",
      );
    });
  });
});

describe("a stale review is never denied", () => {
  /** The request's screened head, moved as a re-screen of a new commit leaves it. */
  function rescreen(requestId: number, head: string): void {
    h.db.run(
      `UPDATE publication_requests
          SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?)
        WHERE id = ?`,
      [head, requestId],
    );
  }

  /** The common end: nothing denied, and `decide` wrote its word (so it ran). */
  function notDenied(requestId: number, firstId: number, status = "requested"): void {
    expect(h.requestRow(requestId)).toMatchObject({ status, auto_denied: 0 });
    expect(h.review(firstId).auto_deny_state).toBe("not_eligible");
    expect(h.review(firstId).auto_deny_at).not.toBeNull();
    expect(auditRows(AUTO_DENY_AUDIT_ACTION)).toHaveLength(0);
  }

  async function claimed(): Promise<{ requestId: number; firstId: number; confirmId: number }> {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    const { requestId, firstId } = await firstRun();
    const confirmId = Number(confirmOf(firstId)?.id);
    expect((await h.claim(confirmId)).status).toBe(200);
    return { requestId, firstId, confirmId };
  }

  test("a re-screen to a new head before the confirming result", async () => {
    await withFakeResend(async () => {
      const { requestId, firstId, confirmId } = await claimed();
      rescreen(requestId, "f".repeat(40));
      // `decide` itself sees the review is no longer in force: the deny's batch never runs.
      let batched = false;
      const watched = {
        ...h.env(),
        DB: hookedD1(realD1(h.db), {
          batch: (sqls) => {
            if (sqls.some((sql) => sql.includes("SET status = 'denied'"))) batched = true;
          },
        }),
      } as Bindings;
      await h.result(confirmId, confirmRunBody(confirmingBody()), undefined, watched);
      expect(batched).toBe(false);
      notDenied(requestId, firstId);
    });
  });

  test("a withdrawal before it", async () => {
    await withFakeResend(async () => {
      const { requestId, firstId, confirmId } = await claimed();
      h.db.run(
        `UPDATE publication_requests SET status = 'denied', withdrawn_at = datetime('now'),
                denied_at = datetime('now') WHERE id = ?`,
        [requestId],
      );
      await h.result(confirmId, confirmRunBody(confirmingBody()));
      // Still the depositor's own withdrawal, untouched.
      notDenied(requestId, firstId, "denied");
      expect(h.requestRow(requestId).withdrawn_at).not.toBeNull();
      expect(h.requestRow(requestId).denied_by).toBeNull();
    });
  });

  test("a newer request of the dataset", async () => {
    await withFakeResend(async () => {
      const { requestId, firstId, confirmId } = await claimed();
      const newer = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
      h.db.run(
        "UPDATE publication_requests SET requested_at = datetime('now', '+1 minute') WHERE id = ?",
        [newer.requestId],
      );
      await h.result(confirmId, confirmRunBody(confirmingBody()));
      notDenied(requestId, firstId);
      expect(h.requestRow(newer.requestId)).toMatchObject({ status: "requested", auto_denied: 0 });
    });
  });

  test("two earlier automatic denials recorded after the first run", async () => {
    // The request gets a high id (a closed request of another dataset holds id 100), so the two
    // seeded after it can be EARLIER ones.
    const other = seedScreenedRequest(h.db, { datasetId: "nm000489" });
    h.db.run("UPDATE publication_requests SET id = 100, status = 'published' WHERE id = ?", [
      other.requestId,
    ]);
    await withFakeResend(async () => {
      const { requestId, firstId, confirmId } = await claimed();
      expect(requestId).toBeGreaterThan(100);
      for (const id of [10, 11]) {
        h.db.run(
          `INSERT INTO publication_requests (id, dataset_id, requested_by, status, auto_denied,
                                              denied_at, requested_at)
           VALUES (?, ?, ?, 'denied', 1, datetime('now', '-1 day'), datetime('now', '-2 days'))`,
          [id, PROD_DATASET, Number(h.requestRow(requestId).requested_by)],
        );
      }
      await h.result(confirmId, confirmRunBody(confirmingBody()));
      notDenied(requestId, firstId);
    });
  });

  test("a head change between decide's read and the batch: the SQL guard alone stops the write", async () => {
    await withFakeResend(async () => {
      const { requestId, firstId, confirmId } = await claimed();
      let landed = false;
      const raced = {
        ...h.env(),
        DB: hookedD1(realD1(h.db), {
          batch: (sqls) => {
            if (!landed && sqls.some((s) => s.includes("SET status = 'denied'"))) {
              landed = true;
              rescreen(requestId, "e".repeat(40));
            }
          },
        }),
      } as Bindings;
      await h.result(confirmId, confirmRunBody(confirmingBody()), undefined, raced);
      // The batch ran (the claim was taken and given back): only the guard could refuse it.
      expect(landed).toBe(true);
      notDenied(requestId, firstId);
    });
  });
});

describe("restore marks the review restored", () => {
  test("restored, never denied automatically again for that head, and its cap place stays counted", async () => {
    await accounts();
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on", PUBLICATION_AUTO_DENY_DAILY_CAP: "1" };
    let run: FirstRun | null = null;
    await withFakeResend(async () => {
      run = await firstRun();
      await confirmRun(run.firstId, confirmingBody());
    });
    const { requestId, firstId } = run as unknown as FirstRun;
    const res = await h.app.request(
      `/admin/publish/${PROD_DATASET}/restore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer autodeny-admin-key-0123456789abcdef01",
        },
        body: "{}",
      },
      h.env(),
    );
    expect(res.status).toBe(200);
    expect(h.review(firstId).auto_deny_state).toBe("restored");
    expect(h.review(firstId).auto_deny_at).not.toBeNull();
    expect(h.requestRow(requestId).status).toBe("requested");

    // The same first run's step again starts nothing.
    const before = h.dispatches().length;
    expect(await autoDenyStep(h.env(), firstId)).toBe("not_eligible");
    expect(h.dispatches()).toHaveLength(before);

    // The restored denial still holds the day's only place: another agreed fail is capped.
    await withFakeResend(async () => {
      const other = await firstRun({ datasetId: "nm000481" });
      await confirmRun(other.firstId, confirmingBody(), { datasetId: "nm000481" });
      expect(h.review(other.firstId).auto_deny_state).toBe("capped");
    });
  });
});

describe("the digest's robustness", () => {
  /** `n` first runs the automatic denial disagreed on, a minute apart, oldest first. */
  function seedDisagreed(n: number): void {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000488" });
    const insert = h.db.query(
      `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous, requested_by,
                                        state, detail, decided_at, auto_deny_state, auto_deny_at)
       VALUES (?, 'nm000488', ?, 0, 1, 'errored', 'workflow_failed', datetime('now'),
               'disagreed', datetime('now', ?))`,
    );
    for (let i = 0; i < n; i++) {
      insert.run(requestId, i.toString(16).padStart(40, "0"), `-${n - i + 1} minutes`);
    }
  }

  test("past 500 rows it lists 500, says how many more, and the next digest lists the rest", async () => {
    await accounts();
    seedDisagreed(503);
    await withFakeResend(async (calls) => {
      const r = await sendAutoDenyDigest(h.env());
      expect(r).toMatchObject({ rows: 500, more: 3 });
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).toContain(
        "3 more not shown; they are in the next digest.",
      );
    });
    nextDigestDay();
    await withFakeResend(async (calls) => {
      const r = await sendAutoDenyDigest(h.env());
      expect(r).toMatchObject({ rows: 3, more: 0 });
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).toContain(
        "Automated review disagreed (3)",
      );
    });
  });

  test("a fault after the day's claim releases the claim, so the next tick sends it", async () => {
    await accounts();
    seedDisagreed(2);
    const faulty = {
      ...h.env(),
      DB: hookedD1(realD1(h.db), {
        statement: (sql) => {
          if (
            sql.includes("SELECT COUNT(*) AS n FROM publication_reviews WHERE confirm_of IS NULL")
          ) {
            throw new Error("D1_ERROR: simulated");
          }
        },
      }),
    } as Bindings;
    await withFakeResend(async (calls) => {
      await expect(sendAutoDenyDigest(faulty)).rejects.toThrow("simulated");
      expect(h.db.query("SELECT COUNT(*) AS n FROM publication_auto_deny_digests").get()).toEqual({
        n: 0,
      });
      expect(await sendAutoDenyDigest(h.env())).toMatchObject({ claimed: true, rows: 2 });
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a missing service account is recorded, and the digest says nothing was denied", async () => {
    await seedUser(h.db, "autodenyadmin", "admin", "autodeny-admin-key-0123456789abcdef01", {
      email: ADMIN_EMAIL,
    });
    h.envOverrides = { PUBLICATION_AUTO_DENY_MODE: "on" };
    await withFakeResend(async () => {
      const { requestId, firstId } = await firstRun();
      await confirmRun(firstId, confirmingBody());
      expect(h.review(firstId).auto_deny_state).toBe("no_service_account");
      expect(h.requestRow(requestId).status).toBe("requested");
    });
    await withFakeResend(async (calls) => {
      await sendAutoDenyDigest(h.env());
      expect(textOf(sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "")).toContain(
        "Service account missing; nothing was denied (1)",
      );
    });
  });
});
