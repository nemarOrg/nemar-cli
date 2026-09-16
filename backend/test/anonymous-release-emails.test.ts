/**
 * What the two notification mails SAY about an anonymous release (#1408).
 *
 * Both are the last human checkpoint on their side of the flow, and both said
 * the wrong thing:
 *
 *   * The admin notification did not distinguish an anonymous release from a
 *     publication, so an admin approving one believed they were approving the
 *     other. The two are not reversible in either direction.
 *   * The approval mail told the depositor "Dataset Published!" and handed
 *     them `https://doi.org/<doi>` for a DOI that is registered `reserved`
 *     and does NOT resolve. The recipient is mid-submission to a double-blind
 *     venue: the single most likely thing they do with that line is paste it
 *     into a blinded manuscript, where it is a dead link for every reviewer.
 *
 * Real engine: the real `services/email.ts` builds real HTML and issues a real
 * `fetch`; only the destination moves (`helpers/resend.ts` redirects
 * api.resend.com to a local server). Every assertion has its non-anonymous
 * control, and the controls carry the NEGATIVES -- "does not contain
 * doi.org" is the one that would have caught the original bug, and a test
 * that only checked the anonymous branch's new sentences would not have.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { sendPublicationApprovedEmail, sendPublicationRequestEmail } from "../src/services/email";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const ADMIN_EMAIL = "anonadmin@nemar.test";
const OWNER_EMAIL = "anonowner@nemar.test";
const DOI = "10.82901/FK2-reserved";

const RESEND_KEY = "fake-resend-key";
const FROM = "NEMAR <noreply@nemar.org>";

describe("the admin notification names the run it is approving", () => {
  test("an anonymous release says so in the subject and explains the consequence", async () => {
    const sent = await withFakeResend(async (calls) => {
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        "nm000901",
        "depositor",
        RESEND_KEY,
        FROM,
        undefined,
        true,
        { ENVIRONMENT: "test", DEV_EMAIL_ALLOWLIST: "@nemar.test" } as unknown as Bindings,
        { anonymous: true },
      );
      return sendsTo(calls, ADMIN_EMAIL);
    });
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toContain("Anonymous release request");
    expect(sent[0].html).toContain("repository stays private");
    expect(sent[0].html).toContain("reserved");
  });

  test("an ordinary request reads exactly as it always did", async () => {
    // The control. Without it, a template that shouted "anonymous" at every
    // admin for every request would satisfy the assertions above.
    const sent = await withFakeResend(async (calls) => {
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        "nm000902",
        "depositor",
        RESEND_KEY,
        FROM,
        undefined,
        true,
        { ENVIRONMENT: "test", DEV_EMAIL_ALLOWLIST: "@nemar.test" } as unknown as Bindings,
        { anonymous: false },
      );
      return sendsTo(calls, ADMIN_EMAIL);
    });
    expect(sent[0].subject).toContain("Publication request");
    expect(sent[0].subject).not.toContain("Anonymous");
    expect(sent[0].html).not.toContain("Anonymous release");
  });

  test("an omitted option is treated as an ordinary request, never as anonymous", async () => {
    // Every caller that predates #1408 passes no options object at all.
    const sent = await withFakeResend(async (calls) => {
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        "nm000903",
        "depositor",
        RESEND_KEY,
        FROM,
        undefined,
        true,
        { ENVIRONMENT: "test", DEV_EMAIL_ALLOWLIST: "@nemar.test" } as unknown as Bindings,
      );
      return sendsTo(calls, ADMIN_EMAIL);
    });
    expect(sent[0].subject).toContain("Publication request");
  });
});

describe("the approval mail never offers a reserved DOI as citable", () => {
  async function approved(anonymous: boolean | undefined): Promise<string> {
    const sent = await withFakeResend(async (calls) => {
      await sendPublicationApprovedEmail(
        OWNER_EMAIL,
        "depositor",
        "nm000904",
        DOI,
        RESEND_KEY,
        FROM,
        undefined,
        true,
        { ENVIRONMENT: "test", DEV_EMAIL_ALLOWLIST: "@nemar.test" } as unknown as Bindings,
        anonymous === undefined ? undefined : { anonymous },
      );
      return sendsTo(calls, OWNER_EMAIL);
    });
    expect(sent.length).toBe(1);
    return sent[0].html;
  }

  test("an anonymous release is handed the landing page, and NOT a doi.org link", async () => {
    // The negative is the assertion that matters: the original template built
    // `<a href="https://doi.org/${doi}">` unconditionally.
    const html = await approved(true);
    expect(html).not.toContain("https://doi.org/");
    expect(html).toContain("nemar.org/dataset/nm000904");
    expect(html).toContain("Do not cite it yet");
    expect(html).toContain("without");
  });

  test("an ordinary publication still gets its DOI link", async () => {
    // The control that keeps the rule above from being "never link a DOI".
    const html = await approved(false);
    expect(html).toContain(`https://doi.org/${DOI}`);
    expect(html).not.toContain("Do not cite it yet");
  });

  test("an omitted option keeps the pre-#1408 behavior", async () => {
    const html = await approved(undefined);
    expect(html).toContain(`https://doi.org/${DOI}`);
  });
});

describe("the resend reminder says the same thing the first mail said", () => {
  // The reminder is the mail an admin is most likely to act on, because it is
  // the one that arrives when the request has been sitting. An admin reading
  // only this one must not approve an anonymous release believing it is a
  // publication.
  const OWNER_KEY = "anon-resend-owner-0123456789abcdef0123456789";

  async function seed(db: Database, anonymous: number): Promise<void> {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          service_access)
       VALUES ('resend-admin', ?, 'x', 'approved', 'admin', 1, 1)`,
      [ADMIN_EMAIL],
    );
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          service_access)
       VALUES ('resend-owner', ?, 'x', 'approved', 'member', 1, 1)`,
      [OWNER_EMAIL],
    );
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='resend-owner'")
      .get();
    if (!owner) throw new Error("seed failed");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      owner.id,
      await hashApiKey(OWNER_KEY),
      OWNER_KEY.slice(0, 8),
    );
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES ('nm000905', 'A sufficiently descriptive dataset title', ?, 'active', 'private', 0)`,
    ).run(owner.id);
    db.query(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous, requested_at, updated_at)
       VALUES ('nm000905', ?, 'requested', ?, datetime('now','-2 days'), datetime('now','-2 days'))`,
    ).run(owner.id, anonymous);
  }

  function env(db: Database): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "test",
      // Admin mail is production-only by default; this is the documented
      // opt-in for a deliberate test of admin notification content.
      DEV_ADMIN_NOTIFICATIONS: "1",
      DEV_EMAIL_ALLOWLIST: "@nemar.test",
      RESEND_API_KEY: RESEND_KEY,
      FROM_EMAIL: FROM,
      API_BASE_URL: "https://api.test",
    } as unknown as Bindings;
  }

  async function resend(db: Database): Promise<string[]> {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/datasets", datasetRoutes);
    return withFakeResend(async (calls) => {
      const res = await app.request(
        "/datasets/nm000905/publish/resend",
        { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(db),
      );
      expect(res.status).toBe(200);
      return sendsTo(calls, ADMIN_EMAIL).map((s) => s.subject);
    });
  }

  test("a reminder for an anonymous release is marked as one", async () => {
    const db = freshDb();
    await seed(db, 1);
    expect((await resend(db)).join(" ")).toContain("Anonymous release request");
    db.close();
  });

  test("a reminder for an ordinary request is not", async () => {
    const db = freshDb();
    await seed(db, 0);
    const subjects = (await resend(db)).join(" ");
    expect(subjects).toContain("Publication request");
    expect(subjects).not.toContain("Anonymous");
    db.close();
  });
});
