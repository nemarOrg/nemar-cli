/**
 * License permission evidence (ADR 0139, decision 7 and its amendment of 2026-11-25; epic #2182,
 * card B6), driven through the real routes on a real bun:sqlite database with every migration:
 * the review job's inputs and result callbacks, `POST /admin/publish/:id/license-permission`,
 * `GET /admin/publish/:id/review` and the depositor's `GET /datasets/:id/publish/status`.
 *
 * What is real: the routes behind their real token and key checks, the derivation the approval
 * gate also reads, the ticket visibility predicate (ADR 0112), the audit row, and the notice mail
 * behind the real delivery fence (Resend is moved to a local server by `helpers/resend.ts`, so "no
 * mail" is read off what a real send would have posted). GitHub is the harness's stand-in.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and local stand-ins.
 */

import { describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  LICENSE_PERMISSION_AUDIT_ACTION,
  TICKET_SENDER_WARNING,
} from "../../shared/license-permission";
import { READY_TO_APPROVE_HEADLINE } from "../../shared/publication-auto-deny";
import { PUBLICATION_PROMPT_VERSION, REVIEW_INPUTS } from "../../shared/publication-review";
import { afterPermissionRecorded, licenseNoticeAfterStore } from "../src/services/license-notice";
import {
  derivePublicationReview,
  publicationReviewEmailSection,
  readReviewContext,
} from "../src/services/publication-review-view";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import {
  SCREENED_HEAD,
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  textOf,
} from "./helpers/publication-review";
import { PROD_DATASET, createHarness, hookedD1 } from "./helpers/publication-review-harness";
import { type CapturedEmail, asSend, withFakeResend } from "./helpers/resend";

const h = createHarness();

const ADMIN_KEY = "licperm-admin-key-0123456789abcdef0123";
const DEPOSITOR_KEY = "licperm-depositor-key-0123456789abcdef";
const DEPOSITOR_EMAIL = "licperm-depositor@example.org";
/** The administrator's evidence summary: it must never reach a depositor, a model or a log. */
const EVIDENCE = "EVIDENCE-SENTINEL authors' email chain of 2026-11-20 accepting cc-by";
const ABSENT_INPUTS = Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"]));
const SOURCE = "10.18112/openneuro.ds000001.v1.0.0";
const OTHER_SOURCE = "10.5281/zenodo.1234567";
const AUTHORS_EMAIL = "licperm-authors@example.org";
const TICKET_SUBJECT = "Fwd: our permission for the nm000480 copy";
const NOTICE_SUBJECT = `Publication request needs license evidence: ${PROD_DATASET}`;

interface Basis {
  outcome: string;
  target_license: string | null;
  target_license_declared?: string | null;
  sources: {
    id: string;
    license: string | null;
    license_version: string | null;
    outcome: string;
  }[];
}

function basisOf(ids: string[], outcome = "needs_permission", target = "cc-by"): Basis {
  return {
    outcome,
    target_license: target,
    sources: ids.map((id) => ({
      id,
      license: "cc-by-nc-nd",
      license_version: "4.0",
      outcome,
    })),
  };
}

/** A version-2 report whose lineage outcome is `lineage`; `fail` fails the first question too. */
function reportBody(lineage: string | null, o: { fail?: boolean } = {}): Record<string, unknown> {
  return goodPublicationReport({
    v: 2,
    questions: {
      complete_and_honest: o.fail ? "fail" : "pass",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: o.fail
      ? [
          {
            question: "complete_and_honest",
            severity: "blocker",
            code: "readme_missing_or_stub",
            document: "readme",
            note: "The README is a stub.",
          },
        ]
      : [],
    evidence: {
      ...evidenceFor(SCREENED_HEAD, false),
      inputs: ABSENT_INPUTS,
      lineage: lineage === null ? null : { outcome: lineage, credited: true },
    },
    note_answer: "not_asked",
    record: {
      prompt_version: PUBLICATION_PROMPT_VERSION,
      models: [{ model: "claude-haiku-5-5", effort: "high" }],
      input_digest: "cd".repeat(32),
      resolver_version: null,
      enrichment_source: null,
    },
  });
}

let adminId = 0;
let depositorId = 0;

async function accounts(): Promise<void> {
  adminId = await seedUser(h.db, "licpermadmin", "admin", ADMIN_KEY, {
    email: "licpermadmin@example.org",
  });
  depositorId = await seedUser(h.db, "licpermdepositor", "member", DEPOSITOR_KEY, {
    email: DEPOSITOR_EMAIL,
  });
}

/** A support ticket; `restricted` puts it in a queue only owners see (ADR 0112). */
function ticket(ref: string, restricted = false, sender = AUTHORS_EMAIL): number {
  const row = h.db
    .query<{ id: number }, [string, string, string, number]>(
      `INSERT INTO mail_tickets (ref, queue_tag, requester_email, subject, restricted)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(ref, restricted ? "security" : "support", sender, TICKET_SUBJECT, restricted ? 1 : 0);
  return row?.id as number;
}

/**
 * A request whose first run has reported, as the job would leave it: the Worker served the inputs
 * (so the row holds the basis), then the job posted the report. The result goes through the real
 * callback, so the after-store steps (the notice among them) run.
 */
async function reviewed(
  basis: Basis | null,
  lineage: string | null = basis?.outcome ?? null,
  o: { fail?: boolean } = {},
): Promise<{ requestId: number; reviewId: number }> {
  const { requestId } = seedScreenedRequest(h.db, {
    datasetId: PROD_DATASET,
    requestedBy: depositorId,
  });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId: PROD_DATASET,
    state: "dispatched",
    claimed: true,
  });
  if (basis !== null) {
    h.db.run("UPDATE publication_reviews SET lineage_basis = ? WHERE id = ?", [
      JSON.stringify(basis),
      reviewId,
    ]);
  }
  const res = await h.result(reviewId, { outcome: "reported", report: reportBody(lineage, o) });
  expect(res.status).toBe(200);
  return { requestId, reviewId };
}

/** End a request, so that the dataset's next request is its active one. */
function close(requestId: number): void {
  h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);
}

async function record(body: Record<string, unknown>, key = ADMIN_KEY) {
  const res = await h.app.request(
    `/admin/publish/${PROD_DATASET}/license-permission`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    },
    h.env(),
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function detail() {
  const res = await h.app.request(
    `/admin/publish/${PROD_DATASET}/review`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    h.env(),
  );
  const text = await res.text();
  expect(res.status).toBe(200);
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

async function status() {
  const res = await h.app.request(
    `/datasets/${PROD_DATASET}/publish/status`,
    { headers: { Authorization: `Bearer ${DEPOSITOR_KEY}` } },
    h.env(),
  );
  const text = await res.text();
  expect(res.status).toBe(200);
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

function reasonCodes(d: Record<string, unknown>): string[] {
  return (d.reasons as { code: string }[]).map((r) => r.code);
}

function noticesTo(calls: CapturedEmail[]) {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((m) => m.subject === NOTICE_SUBJECT);
}

function permissions(): Record<string, unknown>[] {
  return h.db.query("SELECT * FROM license_permissions ORDER BY id").all() as Record<
    string,
    unknown
  >[];
}

function audits(): Record<string, unknown>[] {
  return h.db
    .query("SELECT * FROM audit_log WHERE action = ? ORDER BY id")
    .all(LICENSE_PERMISSION_AUDIT_ACTION) as Record<string, unknown>[];
}

// ============================================================================

describe("the inputs route stores the review's basis", () => {
  test("serving the inputs writes the lineage served, as the permission rule reads it", async () => {
    await accounts();
    const { requestId } = seedScreenedRequest(h.db, {
      datasetId: PROD_DATASET,
      requestedBy: depositorId,
    });
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "dispatched",
      claimed: true,
    });
    expect(h.review(reviewId).lineage_basis).toBeNull();
    const res = await h.app.request(
      "/webhooks/publication-review-inputs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Token": await h.tokenFor(reviewId),
        },
        body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
      },
      h.env(),
    );
    expect(res.status).toBe(200);
    // The stand-in's description declares no source and no license.
    expect(JSON.parse(String(h.review(reviewId).lineage_basis))).toEqual({
      outcome: "no_upstream_declared",
      target_license: "none",
      target_license_declared: null,
      sources: [],
    });
  });
});

describe("the depositor's notice", () => {
  test("a lineage that needs action mails the requester the outcome's message once per request and outcome", async () => {
    await accounts();
    await withFakeResend(async (calls) => {
      const { requestId, reviewId } = await reviewed(basisOf([SOURCE]));
      const mails = noticesTo(calls);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.to).toEqual([DEPOSITOR_EMAIL]);
      const text = textOf(mails[0]?.html ?? "");
      expect(text).toContain(
        `The license of the upstream data (${SOURCE}, cc-by-nc-nd 4.0) does not permit this copy under cc-by. Please send evidence from the original authors that they accept this copy being published under cc-by, for example an email from them, to support@nemar.org, quoting ${PROD_DATASET}. An administrator will record it and the review will continue.`,
      );
      // Production replies go to support, where they become the ticket the evidence is recorded on.
      expect((mails[0] as unknown as { reply_to?: string }).reply_to).toEqual("support@nemar.org");
      expect(
        h.db.query("SELECT * FROM license_permission_notices WHERE request_id = ?").get(requestId),
      ).toMatchObject({ outcome: "needs_permission", review_id: reviewId, mail_state: "sent" });

      // A second review of the same request with the same outcome sends nothing more.
      h.db.run("UPDATE publication_reviews SET head_sha = ? WHERE id = ?", [
        "f".repeat(40),
        reviewId,
      ]);
      const second = seedPublicationReview(h.db, {
        requestId,
        datasetId: PROD_DATASET,
        state: "dispatched",
        claimed: true,
      });
      const res = await h.result(second, {
        outcome: "reported",
        report: reportBody("needs_permission"),
      });
      expect(res.status).toBe(200);
      expect(noticesTo(calls)).toHaveLength(1);
    });
  });

  test("the dev Worker fences the notice: nothing reaches the provider, and the notice says fenced", async () => {
    await accounts();
    h.envOverrides = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "" };
    await withFakeResend(async (calls) => {
      const { requestId } = await reviewed(basisOf([SOURCE]));
      expect(noticesTo(calls)).toHaveLength(0);
      expect(
        h.db
          .query("SELECT mail_state FROM license_permission_notices WHERE request_id = ?")
          .get(requestId),
      ).toEqual({ mail_state: "fenced" });
    });
  });

  test("a compatible lineage, and no lineage at all, send no notice", async () => {
    await accounts();
    await withFakeResend(async (calls) => {
      const a = await reviewed(null, "compatible_attribution");
      close(a.requestId);
      await reviewed(null, null);
      expect(noticesTo(calls)).toHaveLength(0);
      expect(h.db.query("SELECT COUNT(*) AS n FROM license_permission_notices").get()).toEqual({
        n: 0,
      });
    });
  });

  test("an unresolved lineage mails nobody: NEMAR could not read a registry, and administrators still see it", async () => {
    await accounts();
    await withFakeResend(async (calls) => {
      const logged: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      let again: string;
      let reviewId: number;
      try {
        ({ reviewId } = await reviewed(basisOf([SOURCE], "unresolved")));
        // The after-store step, run again on the same review, says why it sent nothing.
        again = await licenseNoticeAfterStore(h.env(), reviewId);
      } finally {
        console.log = log;
      }
      expect(again).toBe("unresolved_not_mailed");
      expect(noticesTo(calls)).toHaveLength(0);
      expect(h.db.query("SELECT COUNT(*) AS n FROM license_permission_notices").get()).toEqual({
        n: 0,
      });
      expect(logged).toContain(
        `[license-notice] review ${reviewId}: lineage unresolved, no depositor mail (NEMAR could not read an upstream record)`,
      );
    });
    // The outcome still holds the request for the administrators, on the card and in show.
    const d = await detail();
    expect(reasonCodes(d.body)).toContain("license_lineage_unconfirmed");
    expect(d.body.outcome).toBe("action_required");
  });

  test("a publication named as the source gets its own message, naming the declared license", async () => {
    await accounts();
    const article = "10.1371/journal.pone.0211710";
    await withFakeResend(async (calls) => {
      await reviewed({
        outcome: "source_is_publication",
        target_license: "cc-by",
        target_license_declared: "CC-BY-4.0",
        sources: [
          {
            id: article,
            license: "cc-by",
            license_version: "4.0",
            outcome: "source_is_publication",
          },
        ],
      });
      const mails = noticesTo(calls);
      expect(mails).toHaveLength(1);
      const text = textOf(mails[0]?.html ?? "");
      expect(text).toContain(
        `The upstream source you named (${article}, cc-by 4.0) is a publication, not a dataset, so its license is not the data's license. Name the dataset the data came from in dataset_description.json SourceDatasets (its DOI or repository URL), or send evidence that the original authors accept this copy under CC-BY-4.0, to support@nemar.org, quoting ${PROD_DATASET}.`,
      );
      expect(text).not.toContain("does not permit this copy");
    });
  });

  test("the depositor's status prints the same message", async () => {
    await accounts();
    await withFakeResend(async () => {
      await reviewed(basisOf([SOURCE], "redistribution_prohibited"));
    });
    const s = await status();
    const lines = s.body.license_permission_lines as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("from the repository that holds the upstream data");
    expect(lines[0]).toContain(`quoting ${PROD_DATASET}`);
  });
});

describe("recording a permission", () => {
  test("the dry run records nothing; --apply records the permission with its audit row", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const { requestId, reviewId } = await withFakeResend(() => reviewed(basisOf([SOURCE])));

    const dry = await record({ ticket_id: ticketId, evidence: EVIDENCE });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      applied: false,
      request_id: requestId,
      review_id: reviewId,
      outcome: "needs_permission",
      target_license: "cc-by",
      ticket_id: ticketId,
      // The ticket is shown so the administrator confirms it holds the evidence; its sender is not
      // the depositor, so the dry run says so.
      ticket_subject: TICKET_SUBJECT,
      ticket_sender: AUTHORS_EMAIL,
      ticket_sender_is_depositor: false,
      ticket_warning: TICKET_SENDER_WARNING,
    });
    expect((dry.body.sources as { id: string }[]).map((s) => s.id)).toEqual([SOURCE]);
    expect(dry.text).not.toContain("EVIDENCE-SENTINEL");
    expect(permissions()).toHaveLength(0);
    expect(audits()).toHaveLength(0);

    const applied = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.text).not.toContain("EVIDENCE-SENTINEL");
    expect(String(applied.body.line)).toMatch(
      new RegExp(
        `^License permission recorded on \\d{4}-\\d{2}-\\d{2} by licpermadmin, ticket ${ticketId}\\.$`,
      ),
    );
    const rows = permissions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dataset_id: PROD_DATASET,
      request_id: requestId,
      outcome: "needs_permission",
      target_license: "cc-by",
      source_ids: JSON.stringify([SOURCE]),
      ticket_id: ticketId,
      evidence: EVIDENCE,
      recorded_by: adminId,
    });
    const audit = audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: adminId,
      resource_type: "dataset",
      resource_id: PROD_DATASET,
    });
    expect(String(audit[0]?.details)).not.toContain("EVIDENCE-SENTINEL");
    expect(JSON.parse(String(audit[0]?.details))).toEqual({
      request_id: requestId,
      review_id: reviewId,
      outcome: "needs_permission",
      target_license: "cc-by",
      source_ids: [SOURCE],
      ticket_id: ticketId,
      ticket_sender: AUTHORS_EMAIL,
      ticket_subject: TICKET_SUBJECT,
    });

    // A second apply is refused: the request is already covered.
    const again = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_covered");
    expect(permissions()).toHaveLength(1);
  });

  test("a ticket from the depositor's own address carries no warning", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river", false, DEPOSITOR_EMAIL.toUpperCase());
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    const dry = await record({ ticket_id: ticketId, evidence: EVIDENCE });
    expect(dry.body).toMatchObject({ ticket_sender_is_depositor: true, ticket_warning: null });
  });

  test("two applies at once write one row and one audit row, and mail once", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    // Hold the first apply's batch until the second reaches its own, so both have passed every
    // check before either writes: the race the unique index settles.
    let arrivals = 0;
    let release: (() => void) | null = null;
    h.envOverrides = {
      DB: hookedD1(h.env().DB, {
        batch: async (sqls) => {
          if (!sqls.some((q) => /INSERT INTO license_permissions/.test(q))) return;
          arrivals++;
          if (arrivals === 1) {
            await new Promise<void>((r) => {
              release = r;
            });
          } else release?.();
        },
      }),
    };
    await withFakeResend(async (calls) => {
      const [a, b] = await Promise.all([
        record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true }),
        record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true }),
      ]);
      expect(arrivals).toBe(2);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.body.code, b.body.code]).toContain("already_covered");
      expect(permissions()).toHaveLength(1);
      expect(audits()).toHaveLength(1);
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(
        sends.filter((m) => m.subject === `License evidence recorded: ${PROD_DATASET}`),
      ).toHaveLength(1);
      expect(sends.filter((m) => m.to.includes("licpermadmin@example.org"))).toHaveLength(1);
    });
  });

  test("an unknown ticket, and one the administrator may not see, are refused and record nothing", async () => {
    await accounts();
    const hidden = ticket("cedar-otter-plain", true);
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    for (const ticketId of [999_999, hidden]) {
      const res = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ticket_not_found");
    }
    expect(permissions()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  test("nothing to clear, no stored basis, or the dataset's own files unreadable: refused", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const a = await withFakeResend(() => reviewed(null, "compatible"));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE })).body.code).toBe(
      "no_lineage_reason",
    );
    close(a.requestId);
    const b = await withFakeResend(() => reviewed(null, "needs_permission"));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE })).body.code).toBe(
      "basis_unrecorded",
    );
    close(b.requestId);
    await withFakeResend(() =>
      reviewed({
        outcome: "unresolved",
        target_license: null,
        sources: [
          {
            id: "dataset_description.json",
            license: null,
            license_version: null,
            outcome: "unresolved",
          },
        ],
      }),
    );
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE })).body.code).toBe(
      "dataset_files_unreadable",
    );
    expect(permissions()).toHaveLength(0);
  });
});

describe("what a permission clears", () => {
  test("it clears the reason for that request and for a later request with the same sources, not one with a different source", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const first = await withFakeResend(() => reviewed(basisOf([SOURCE])));
    const before = await detail();
    expect(reasonCodes(before.body)).toContain("license_lineage_unconfirmed");
    expect(before.body.outcome).toBe("action_required");
    expect(before.body.license_permission).toBeNull();

    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true })).status).toBe(
      200,
    );
    const after = await detail();
    expect(reasonCodes(after.body)).not.toContain("license_lineage_unconfirmed");
    // The lineage was the only reason, so the review continues to a pass; nothing approved it.
    expect(after.body.outcome).toBe("pass");
    expect(h.requestRow(first.requestId).status).toBe("requested");
    expect(String((after.body.license_permission as { line: string }).line)).toContain(
      `ticket ${ticketId}`,
    );
    expect(after.text).not.toContain("EVIDENCE-SENTINEL");

    // A later request of the dataset with the same basis is covered by the same permission, and
    // its depositor is not asked again.
    close(first.requestId);
    await withFakeResend(async (calls) => {
      await reviewed(basisOf([SOURCE]));
      expect(noticesTo(calls)).toHaveLength(0);
    });
    const later = await detail();
    expect(reasonCodes(later.body)).not.toContain("license_lineage_unconfirmed");
    expect(later.body.outcome).toBe("pass");

    // One with a source the permission does not name is not, even though it shares one.
    close(Number(later.body.request_id));
    await withFakeResend(() => reviewed(basisOf([SOURCE, OTHER_SOURCE])));
    const different = await detail();
    expect(reasonCodes(different.body)).toContain("license_lineage_unconfirmed");
    expect(different.body.outcome).toBe("action_required");
    expect(different.body.license_permission).toBeNull();

    // Nor is one under another target license.
    close(Number(different.body.request_id));
    await withFakeResend(() => reviewed(basisOf([SOURCE], "needs_permission", "cc0")));
    expect(reasonCodes((await detail()).body)).toContain("license_lineage_unconfirmed");
  });

  test("a permission recorded on a later request does not reach back to an earlier one", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const earlier = await withFakeResend(() => reviewed(basisOf([SOURCE])));
    close(earlier.requestId);
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true })).status).toBe(
      200,
    );
    const env = h.env();
    const ctx = await readReviewContext(env, earlier.requestId);
    if (ctx === null) throw new Error("the earlier request is gone");
    const d = await derivePublicationReview({ env, nowMs: Date.now(), ...ctx });
    expect(d.permission).toBeNull();
    expect(d.reasons.map((r) => r.code)).toContain("license_lineage_unconfirmed");
  });

  test("the administrators' mail says the permission was recorded, and when the review passes it is ready to approve", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const { requestId } = await withFakeResend(() => reviewed(basisOf([SOURCE])));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true })).status).toBe(
      200,
    );
    const section = await publicationReviewEmailSection(h.env(), requestId);
    expect(section?.headline).toBe(READY_TO_APPROVE_HEADLINE);
    expect(section?.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^License permission recorded on \\d{4}-\\d{2}-\\d{2} by licpermadmin, ticket ${ticketId}\\.$`,
        ),
      ),
    );
    expect(JSON.stringify(section)).not.toContain("EVIDENCE-SENTINEL");
  });

  test("--apply closes the loop: 'Ready to approve' to the administrators when it now passes, and the depositor is told", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    await withFakeResend(async (calls) => {
      const res = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
      expect(res.status).toBe(200);
      expect(res.body.mail).toEqual({ administrators: "sent", depositor: "sent" });
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      const ready = sends.filter((m) => m.to.includes("licpermadmin@example.org"));
      expect(ready).toHaveLength(1);
      expect(textOf(ready[0]?.html ?? "")).toContain(READY_TO_APPROVE_HEADLINE);
      const told = sends.filter((m) => m.subject === `License evidence recorded: ${PROD_DATASET}`);
      expect(told.map((m) => m.to)).toEqual([[DEPOSITOR_EMAIL]]);
      expect(textOf(told[0]?.html ?? "")).toContain(
        `Your evidence for ${PROD_DATASET} was recorded by an administrator; the review continues.`,
      );
      expect(JSON.stringify(sends)).not.toContain("EVIDENCE-SENTINEL");
    });
  });

  test("a request that still does not pass gets no 'Ready to approve'; the depositor is still told", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    await withFakeResend(() => reviewed(basisOf([SOURCE]), "needs_permission", { fail: true }));
    await withFakeResend(async (calls) => {
      const res = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
      expect(res.body.mail).toEqual({ administrators: "not_ready", depositor: "sent" });
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends.filter((m) => m.to.includes("licpermadmin@example.org"))).toHaveLength(0);
      expect(sends.filter((m) => m.to.includes(DEPOSITOR_EMAIL))).toHaveLength(1);
    });
  });

  test("on the dev Worker both mails are fenced: nothing reaches the provider", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    h.envOverrides = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "" };
    await withFakeResend(() => reviewed(basisOf([SOURCE])));
    await withFakeResend(async (calls) => {
      const res = await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });
      expect(res.status).toBe(200);
      expect(res.body.mail).toEqual({ administrators: "undelivered", depositor: "fenced" });
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(0);
    });
  });

  test("a review that cannot be read after the record is review_unreadable, never not_ready", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const { requestId } = await withFakeResend(() => reviewed(basisOf([SOURCE])));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true })).status).toBe(
      200,
    );
    // The review's read fails while the mails are decided.
    const env = h.env({
      DB: hookedD1(h.env().DB, {
        statement: (sql) => {
          if (/FROM license_permissions/.test(sql)) throw new Error("read failed");
        },
      }),
    });
    const mail = await withFakeResend(() => afterPermissionRecorded(env, requestId));
    expect(mail).toEqual({ administrators: "review_unreadable", depositor: "sent" });
  });

  test("a depositor with no address to mail is no_recipient, and the notice records it", async () => {
    await accounts();
    h.db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [depositorId]);
    await withFakeResend(async (calls) => {
      const { requestId } = await reviewed(basisOf([SOURCE]));
      expect(noticesTo(calls)).toHaveLength(0);
      expect(
        h.db
          .query("SELECT mail_state FROM license_permission_notices WHERE request_id = ?")
          .get(requestId),
      ).toEqual({ mail_state: "no_recipient" });
      expect(await afterPermissionRecorded(h.env(), requestId)).toMatchObject({
        depositor: "no_recipient",
      });
    });
  });

  test("it never clears another reason: a failed question still fails the request", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    await withFakeResend(() => reviewed(basisOf([SOURCE]), "needs_permission", { fail: true }));
    expect((await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true })).status).toBe(
      200,
    );
    const d = await detail();
    expect(reasonCodes(d.body)).toEqual(["question_failed"]);
    expect(d.body.outcome).toBe("fail");
  });

  test("the evidence text never reaches the depositor's status or the review's model inputs", async () => {
    await accounts();
    const ticketId = ticket("amber-falcon-river");
    const first = await withFakeResend(() => reviewed(basisOf([SOURCE])));
    await record({ ticket_id: ticketId, evidence: EVIDENCE, apply: true });

    const s = await status();
    expect(s.text).not.toContain("EVIDENCE-SENTINEL");
    expect(s.body.license_permission_lines).toEqual([
      expect.stringMatching(
        new RegExp(`^License permission recorded on \\d{4}-\\d{2}-\\d{2}, ticket ${ticketId};`),
      ),
    ]);

    // The next review's inputs, everything the model is given besides git.
    close(first.requestId);
    const { requestId } = seedScreenedRequest(h.db, {
      datasetId: PROD_DATASET,
      requestedBy: depositorId,
    });
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "dispatched",
      claimed: true,
    });
    const res = await h.app.request(
      "/webhooks/publication-review-inputs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Token": await h.tokenFor(reviewId),
        },
        body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
      },
      h.env(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("EVIDENCE-SENTINEL");
  });
});

describe("migration 0154 on Miniflare's D1", () => {
  test("it applies, and holds the evidence to 1,000 characters and the outcome to the five", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      d1Databases: ["DB1"],
    });
    try {
      const db = (await mf.getD1Database("DB1")) as unknown as D1Database;
      await applyMigrations(db, migrationFiles());
      const insert = (outcome: string, evidence: string) =>
        db
          .prepare(
            `INSERT INTO license_permissions
               (dataset_id, request_id, outcome, target_license, source_ids, ticket_id, evidence,
                recorded_by)
             VALUES ('nm000480', 1, ?, 'cc-by', '["10.5281/zenodo.1"]', 1, ?, 1)`,
          )
          .bind(outcome, evidence)
          .run();
      await insert("needs_permission", "x".repeat(1000));
      await expect(insert("needs_permission", "x".repeat(1001))).rejects.toThrow();
      await expect(insert("compatible", "ok")).rejects.toThrow();
      // The basis column takes JSON or nothing.
      const review = (basis: string | null) =>
        db
          .prepare(
            `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous,
               requested_by, state, nonce, lineage_basis)
             VALUES (1, 'nm000480', ?, 0, 1, 'dispatched', 'n', ?)`,
          )
          .bind(SCREENED_HEAD, basis)
          .run();
      await review('{"outcome":"compatible","target_license":null,"sources":[]}');
      await expect(review("not json")).rejects.toThrow();
    } finally {
      await mf.dispose();
    }
  });
});
