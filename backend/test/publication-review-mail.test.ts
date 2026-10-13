/**
 * The admin mail and the publication review (ADR 0101, section 6), end to end through the real
 * mail lease, the real watchdog and the real screen callback route.
 *
 * The mail of a publication request WAITS for the identifier screen's verdict (ADR 0086), and
 * while the review is on it also waits for a review of the screened commit that is in flight and
 * not overdue. What it must never do is wait for good (the review reports, or ages past its
 * deadline), wait for the wrong request (another commit, the other kind of release, another
 * status), wait while the review is off, or carry a word the model wrote.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, review rows seeded
 * through the production parser (`helpers/publication-review.ts`), the real `/webhooks` route,
 * and Resend captured at the network boundary (`helpers/resend.ts`), so the mail checked is the
 * mail that would go. Mail goes only to the seeded admin; nothing leaves the machine.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  NOT_ASSESSED_LINE,
  REASONS,
  describePublicationReview,
  parsePublicationReviewReport,
} from "../../shared/publication-review";
import webhooks from "../src/routes/webhooks";
import { sendPublicationRequestEmail } from "../src/services/email";
import { signIdentifierScreenCallbackToken } from "../src/services/github";
import {
  SCREEN_SWEEP_LIMIT,
  notifyAdminsOfScreen,
  screenEmailSection,
  sweepIdentifierScreens,
} from "../src/services/identifier-screen";
import { SUMMARY_LINE_PREFIX } from "../src/services/publication-review-view";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody } from "./helpers/identifier-screen";
import {
  type SeedReview,
  type SeedScreenedRequest,
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "./helpers/publication-review";
import { type CapturedEmail, type ResendSendBody, asSend, withFakeResend } from "./helpers/resend";

const ADMIN_EMAIL = "reviewadmin@example.org";
const SECRET = "publication-review-mail-secret";
const OTHER_HEAD = "f".repeat(40);
/** Words a depositor could influence: they must never reach an inbox through the review section. */
const SUMMARY_SENTINEL = "SUMMARY-SENTINEL-the-model-wrote-this";
const NOTE_SENTINEL = "NOTE-SENTINEL-the-model-wrote-this-too";

let db: Database;
let counter = 0;

beforeEach(() => {
  db = freshDb();
  counter = 0;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES ('reviewadmin', ?, 'x', 'approved', 'admin', 1, 1, 1, 'Grace', 'Hopper')`,
    [ADMIN_EMAIL],
  );
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    PUBLICATION_REVIEW_ENABLED: "1",
    ...over,
  } as Bindings;
}

/** A fresh native dataset id per request, so one test can seed several. */
function nextDataset(): string {
  counter += 1;
  return `nm0006${String(counter).padStart(2, "0")}`;
}

/** A native request whose screen reported and whose admin mail has not gone out. */
function unmailed(over: Partial<SeedScreenedRequest> = {}) {
  const datasetId = over.datasetId ?? nextDataset();
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId, mailed: false });
  return { requestId, datasetId };
}

function sends(calls: CapturedEmail[]): ResendSendBody[] {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => b.to.includes(ADMIN_EMAIL));
}

/** The visible text of a mail: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function mailState(requestId: number) {
  return db
    .query<{ emailed: string | null; claimed: string | null }, [number]>(
      `SELECT identifier_screen_emailed_at AS emailed, identifier_screen_mail_claimed_at AS claimed
         FROM publication_requests WHERE id = ?`,
    )
    .get(requestId) as { emailed: string | null; claimed: string | null };
}

/** A report whose first question failed with a finding, and whose model wrote the two sentinels. */
function failingReport(head = SCREENED_HEAD) {
  return goodPublicationReport({
    summary: SUMMARY_SENTINEL,
    questions: {
      complete_and_honest: "fail",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: [
      {
        question: "complete_and_honest",
        severity: "blocker",
        code: "readme_mismatch",
        document: "readme",
        note: NOTE_SENTINEL,
      },
    ],
    evidence: evidenceFor(head),
  });
}

// ============================================================================

describe("the mail waits for a review that is in flight", () => {
  test("a young dispatched review of the screened commit and flag holds the mail, and takes no lease", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
    });
    expect(mailState(requestId)).toEqual({ emailed: null, claimed: null });
  });

  test("the review reporting releases it, and the mail carries the review's headline and the next command", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const mail = sends(calls);
      expect(mail).toHaveLength(1);
      const text = textOf(mail[0].html);
      expect(text).toContain("Publication review: pass");
      expect(text).toContain(`nemar admin publish approve ${datasetId}`);
      expect(text).toContain(NOT_ASSESSED_LINE);
      // The identifier screen's own section is still there, before the review's.
      expect(text.indexOf("Identifier screen")).toBeLessThan(text.indexOf("Publication review"));
      // The subject is the screen's, unchanged.
      expect(mail[0].subject).toEndWith("IDENTIFIER SCREEN: clean");
    });
    expect(mailState(requestId).emailed).not.toBeNull();
  });

  const settled: Array<{
    name: string;
    seed: Omit<SeedReview, "requestId" | "datasetId">;
    headline: string;
    reasons: Array<keyof typeof REASONS>;
    words: string[];
    next: string;
  }> = [
    {
      name: "errored",
      seed: { state: "errored", detail: "workflow_failed" },
      headline: "Publication review: action required",
      reasons: ["review_could_not_run"],
      words: ["the review job failed before it finished"],
      next: "nemar admin publish start",
    },
    {
      name: "declined",
      seed: { state: "declined", detail: "depositor_limit" },
      headline: "Publication review: action required",
      reasons: ["review_limit_reached"],
      words: ["this depositor's daily limit"],
      next: "nemar admin publish start",
    },
    {
      name: "unreported",
      seed: { state: "unreported" },
      headline: "Publication review: action required",
      reasons: ["review_did_not_report"],
      words: [],
      next: "nemar admin publish start",
    },
    {
      name: "dispatched past the 30-minute deadline",
      seed: { state: "dispatched", createdMinutesAgo: 31 },
      headline: "Publication review: action required",
      // The view's own bound is 60 minutes (a watchdog tick longer): the mail goes at 30 and
      // says the review is running until then.
      reasons: ["review_running"],
      words: [],
      next: "nemar admin publish show",
    },
    {
      name: "dispatched past the view's overdue bound",
      seed: { state: "dispatched", createdMinutesAgo: 61 },
      headline: "Publication review: action required",
      reasons: ["review_did_not_report"],
      words: [],
      next: "nemar admin publish start",
    },
    {
      name: "reported with a failed question",
      seed: { state: "reported", report: failingReport() },
      headline: "Publication review: FAIL",
      reasons: ["question_failed"],
      words: ["findings: README does not match the dataset"],
      next: "--force",
    },
  ];

  for (const c of settled) {
    test(`${c.name}: the mail goes once, with each reason's sentence and cure and the next command`, async () => {
      const { requestId, datasetId } = unmailed();
      seedPublicationReview(db, { requestId, datasetId, ...c.seed });
      await withFakeResend(async (calls) => {
        expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
        expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
        const mail = sends(calls);
        expect(mail).toHaveLength(1);
        const text = textOf(mail[0].html);
        expect(text).toContain(c.headline);
        for (const code of c.reasons) {
          const rule = REASONS[code];
          expect(text).toContain(rule.sentence.replace(/\.$/, ""));
          expect(text).toContain(rule.cure.replaceAll("<dataset>", datasetId));
        }
        for (const w of c.words) expect(text).toContain(w);
        expect(text).toContain(c.next);
        expect(text).toContain(NOT_ASSESSED_LINE);
      });
    });
  }

  test("a review of another commit does not hold the mail, and is not the review in force", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      head: OTHER_HEAD,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      // The other commit's row is history: this commit has no review.
      expect(text).toContain(REASONS.review_not_started.sentence);
      expect(text).not.toContain(REASONS.review_running.sentence);
    });
  });

  test("a review of the other kind of release does not hold the mail", async () => {
    const { requestId, datasetId } = unmailed({ anonymous: false });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      anonymous: true,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      expect(textOf(sends(calls)[0].html)).toContain(REASONS.review_not_started.sentence);
    });
  });

  test("a review of another request does not hold this one", async () => {
    const first = unmailed();
    const second = unmailed();
    seedPublicationReview(db, {
      requestId: second.requestId,
      datasetId: second.datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), first.requestId)).toBe("sent");
      expect(await notifyAdminsOfScreen(env(), second.requestId)).toBe("not-claimed");
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("only a request in requested waits: a blocked request is mailed at once", async () => {
    const { requestId, datasetId } = unmailed({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      // Never an in-flight wait for a request that is not reviewed: it reads as not reported.
      expect(text).toContain(REASONS.request_blocked.sentence.replace(/\.$/, ""));
      expect(text).not.toContain(REASONS.review_running.sentence);
    });
  });

  test("a screen that needs an acknowledgment is reviewed and held the same way", async () => {
    const { requestId, datasetId } = unmailed({ status: "review" });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      // A clean review does not clear the screen's own reason: the outcome still needs a person.
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain("Publication review: action required");
      expect(text).toContain(
        REASONS.identifier_screen_needs_acknowledgment.sentence.replace(/\.$/, ""),
      );
    });
  });
});

// ============================================================================

describe("with the review off, the mail is what it was before the review existed", () => {
  test("a young dispatched review does not hold the mail, and the section says the review is off", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    for (const flag of [undefined, "0", "true", "yes", " 1", "1 "]) {
      db.run(
        "UPDATE publication_requests SET identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL WHERE id = ?",
        [requestId],
      );
      await withFakeResend(async (calls) => {
        expect(
          await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: flag }), requestId),
        ).toBe("sent");
        const text = textOf(sends(calls)[0].html);
        expect(text).toContain("advice only, the automated review is off");
        expect(text).toContain("this review is advice and gates nothing");
        expect(text).toContain(NOT_ASSESSED_LINE);
        // Off is never green: nothing in the section reads as a pass.
        expect(text).not.toContain("Publication review: pass");
      });
    }
  });

  // The publication-request mail as it was sent before the review section existed, for inputs
  // that are all literal here: the hash of the subject, a newline and the HTML, taken from the
  // commit before the section was added. Not a snapshot of wording: it pins that the template
  // changed by not one byte (whitespace included) when there is no review to add. A deliberate
  // edit to the mail updates these hashes in the same commit and says so.
  const MAIL_BEFORE_THE_REVIEW: Array<{
    name: string;
    opts: Parameters<typeof sendPublicationRequestEmail>[8];
    sha256: string;
  }> = [
    {
      name: "a named request with the screen's section",
      opts: {
        anonymous: false,
        screen: {
          headline: "Identifier screen: clean",
          tone: "ok",
          lines: ["a <b>", "c"],
          next: "next & step",
        },
      },
      sha256: "5d95f3c4105c5351eea61a6e1bca201fa9cca342ea79f65d75dd9679d47b80b3",
    },
    {
      name: "an anonymous release with a stopping screen",
      opts: {
        anonymous: true,
        screen: { headline: "Identifier screen: FOUND IDENTIFIERS", tone: "stop", lines: [] },
      },
      sha256: "1e491a8558d772d564d4a10d75f4ec55faff36170560048e28c0d4f0426a2a55",
    },
    {
      name: "no sections at all",
      opts: {},
      sha256: "909739632837b8af2525ab29495747d8481ab0754304dd538aaf37350e2e9b8c",
    },
  ];

  for (const c of MAIL_BEFORE_THE_REVIEW) {
    test(`the template is byte for byte what it was before the review existed: ${c.name}`, async () => {
      await withFakeResend(async (calls) => {
        await sendPublicationRequestEmail(
          [ADMIN_EMAIL],
          "nm000450",
          "ada",
          "re_test",
          "NEMAR <noreply@nemar.org>",
          undefined,
          false,
          { ENVIRONMENT: "production" },
          c.opts,
        );
        const mail = sends(calls)[0];
        const hash = createHash("sha256").update(`${mail.subject}\n${mail.html}`).digest("hex");
        expect(hash).toBe(c.sha256);
      });
    });
  }

  test("with the review off and no review row the mail carries nothing the screen's does not", async () => {
    const { requestId, datasetId } = unmailed();
    const row = db
      .query<{ s: string; r: string }, [number]>(
        "SELECT identifier_screen_status AS s, identifier_screen_report AS r FROM publication_requests WHERE id = ?",
      )
      .get(requestId) as { s: string; r: string };
    await withFakeResend(async (calls) => {
      // The same mail, built directly from the screen's section alone.
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        datasetId,
        `depositor_${datasetId}`,
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        { ENVIRONMENT: "production" },
        { anonymous: false, screen: screenEmailSection(datasetId, row.s, row.r) },
      );
      expect(
        await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: undefined }), requestId),
      ).toBe("sent");
      const [direct, viaRoute] = sends(calls);
      expect(viaRoute.html).toBe(direct.html);
      expect(viaRoute.subject).toBe(direct.subject);
      expect(viaRoute.html).not.toContain("Publication review");
    });
  });

  test("a request the review does not apply to says so only while the review is on", async () => {
    const exempt: Array<Partial<SeedScreenedRequest>> = [
      { source: "openneuro" },
      { isExemplar: 1 },
    ];
    for (const apply of exempt) {
      const on = unmailed(apply);
      const off = unmailed(apply);
      await withFakeResend(async (calls) => {
        expect(await notifyAdminsOfScreen(env(), on.requestId)).toBe("sent");
        expect(textOf(sends(calls)[0].html)).toContain("Publication review: not applicable");
        expect(textOf(sends(calls)[0].html)).toContain(NOT_ASSESSED_LINE);
      });
      await withFakeResend(async (calls) => {
        expect(
          await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: undefined }), off.requestId),
        ).toBe("sent");
        expect(sends(calls)[0].html).not.toContain("Publication review");
      });
    }
  });
});

// ============================================================================

describe("the watchdog's unmailed pass", () => {
  /** The watchdog only takes a result its own path has had five minutes to mail. */
  function ageScreen(requestId: number) {
    db.run(
      "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
      [requestId],
    );
  }

  test("skips a row held for a review, and mails it once the review has reported", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      const held = await sweepIdentifierScreens(env());
      expect(held.emailed).toBe(0);
      expect(held.undelivered).toBe(0);
      expect(calls).toHaveLength(0);

      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      const released = await sweepIdentifierScreens(env());
      expect(released.emailed).toBe(1);
      expect(textOf(sends(calls)[0].html)).toContain("Publication review: pass");

      // Mailed once: the next tick finds nothing.
      expect((await sweepIdentifierScreens(env())).emailed).toBe(0);
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("rows held for a review do not fill the tick's slots", async () => {
    // One more held row than a tick takes, all older than the one that is ready: without the
    // exclusion in the query the ready request would never be reached.
    for (let i = 0; i < SCREEN_SWEEP_LIMIT + 1; i++) {
      const held = unmailed();
      ageScreen(held.requestId);
      seedPublicationReview(db, {
        requestId: held.requestId,
        datasetId: held.datasetId,
        state: "dispatched",
        createdMinutesAgo: 2,
      });
    }
    const ready = unmailed();
    ageScreen(ready.requestId);
    await withFakeResend(async (calls) => {
      const result = await sweepIdentifierScreens(env());
      expect(result.emailed).toBe(1);
      expect(sends(calls)).toHaveLength(1);
      expect(mailState(ready.requestId).emailed).not.toBeNull();
    });
  });

  test("a review that never reports cannot hold the mail for good", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 31 });
    await withFakeResend(async (calls) => {
      // No watchdog marked the row, and it is past the deadline: the mail goes.
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("with the review off, a young dispatched row is mailed like any other", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(
        (await sweepIdentifierScreens(env({ PUBLICATION_REVIEW_ENABLED: undefined }))).emailed,
      ).toBe(1);
      expect(sends(calls)).toHaveLength(1);
    });
  });
});

// ============================================================================

describe("what the mail may carry", () => {
  test("never a nonce, never the model's summary, never a finding's note", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const html = sends(calls)[0].html;
      expect(html).toContain("Publication review: FAIL");
      // The model's words reach a person in the detail view and nowhere else.
      expect(html).not.toContain(SUMMARY_SENTINEL);
      expect(html).not.toContain(NOTE_SENTINEL);
      expect(html).not.toContain("Reviewer&#39;s summary");
    });
  });

  test("no nonce of a row that can still be answered is ever in the mail", async () => {
    const { requestId, datasetId } = unmailed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "unreported",
      nonce: "NONCE-SENTINEL-0123456789abcdef",
    });
    expect(
      db
        .query<{ nonce: string }, [number]>("SELECT nonce FROM publication_reviews WHERE id = ?")
        .get(reviewId)?.nonce,
    ).toBe("NONCE-SENTINEL-0123456789abcdef");
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      expect(sends(calls)[0].html).not.toContain("NONCE-SENTINEL");
    });
  });

  test("the shared module still says the summary on a line of its own, which the mail leaves out", () => {
    // The mail drops that line by its prefix. If the shared words ever change the prefix, this
    // fails and the filter has to follow, instead of the summary reaching an inbox quietly.
    const report = parsePublicationReviewReport(failingReport());
    const described = describePublicationReview({
      datasetId: "nm000601",
      applies: true,
      enabled: true,
      outcome: "fail",
      reasons: [],
      row: { kind: "reported", report, stored: "fail" },
      model: report.model,
      head: SCREENED_HEAD,
      version: "1.0.0",
    });
    expect(described.lines.some((l) => l.startsWith(SUMMARY_LINE_PREFIX))).toBe(true);
    expect(described.lines.find((l) => l.startsWith(SUMMARY_LINE_PREFIX))).toContain(
      SUMMARY_SENTINEL,
    );
  });

  test("an anonymous release's notice is unchanged, and its review is the anonymous one", async () => {
    const { requestId, datasetId } = unmailed({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain(
        "Anonymous release. Approving this publishes the data while withholding the depositor",
      );
      expect(text).toContain("Publication review: pass");
    });
  });

  test("a review that cannot be read is said so, never passed over and never a pass", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const failing = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        // The review row's read, not the lease (which only checks that one exists).
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql))
          throw new Error("D1_ERROR: simulated");
      }),
    } as Bindings;
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(failing, requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain("Publication review: could not be read");
      expect(text).toContain("This is not a pass.");
      expect(text).toContain(`nemar admin publish show ${datasetId}`);
      expect(text).toContain(NOT_ASSESSED_LINE);
      expect(text).not.toContain("Publication review: pass");
    });
  });
});

// ============================================================================

describe("through the real screen callback", () => {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);

  test("the result is stored and the mail waits for the review; the watchdog mails it once the review has reported", async () => {
    const datasetId = "nm000660";
    const { requestId } = seedScreenedRequest(db, { datasetId, status: "pending" });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    // The nonce `seedScreenedRequest` stores for a pending screen.
    const token = await signIdentifierScreenCallbackToken(
      { datasetId, requestId, nonce: "n" },
      SECRET,
    );
    await withFakeResend(async (calls) => {
      const res = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataset_id: datasetId,
            request_id: requestId,
            report: cleanScreenReportBody(datasetId),
          }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, state: "clean" });
      // Stored, and not mailed: the review of this commit is still in flight.
      expect(mailState(requestId).emailed).toBeNull();
      expect(calls).toHaveLength(0);

      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      db.run(
        "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
        [requestId],
      );
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      const mail = sends(calls);
      expect(mail).toHaveLength(1);
      expect(textOf(mail[0].html)).toContain("Publication review: pass");
    });
  });
});
