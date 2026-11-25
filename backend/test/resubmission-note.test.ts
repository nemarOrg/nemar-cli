/**
 * The resubmission note of a publication request (ADR 0139, decision 5, card B3).
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied (0151 among them), the
 * real auth middleware, and the real dataset, admin and webhook routes through Hono. GitHub is a
 * `Bun.serve()` stand-in for api.github.com (NEMAR_GITHUB_API_URL); Resend is `withFakeResend`,
 * which moves only the destination of the real `services/email.ts` fetch, so a mail a test reads
 * is the mail the Worker built and nothing leaves the machine.
 *
 * What is pinned, each against its control:
 *   - the rule: trimmed, empty is NULL, 2,000 code points, no control character but a line break;
 *   - a refused note changes nothing (no row, no mail);
 *   - `previous_request_id` links a denial and never a withdrawal;
 *   - the status answer says who denied (an `auto_deny` audit row names an agent);
 *   - an administrator sees the note in the list row, the review detail and the mail, the mail
 *     escapes it, and the depositor's own mail never carries it.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { AUTO_DENY_AUDIT_ACTION, resubmissionNoteUnreadable } from "../../shared/resubmission-note";
import { mailPublicationRequest } from "../src/services/identifier-screen";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { SCREENED_HEAD, mainRefAnswer } from "./helpers/identifier-screen";
import {
  type PublicationReviewApp,
  makePublicationReviewApp,
} from "./helpers/publication-review-app";
import { hookedD1 } from "./helpers/publication-review-harness";
import { asSend, sendsTo, withFakeResend } from "./helpers/resend";

const OWNER_KEY = "note-owner-key-0123456789abcdef0123456789abcdef0123";
const ADMIN_KEY = "note-admin-key-0123456789abcdef0123456789abcdef0123";
const DATASET = "nm000470";
const OWNER_EMAIL = "noteowner@example.org";
const ADMIN_EMAIL = "noteadmin@example.org";

const DESCRIPTION = JSON.stringify({
  Name: "A sufficiently descriptive dataset title",
  Authors: ["Ada Lovelace"],
  EthicsApprovals: ["Approved by an institutional review board"],
});

let server: Server;
let bidsRuns: "success" | "none" = "success";
let db: Database;
let app: PublicationReviewApp;
let ownerId: number;
let adminId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const ref = mainRefAnswer(req, SCREENED_HEAD);
      if (ref) return ref;
      if (req.method === "POST" && path === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(null, { status: 204 });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(path)) {
        return Response.json({ name: "bids-validation.yml" });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(path)) {
        return Response.json({
          workflow_runs:
            bidsRuns === "none"
              ? []
              : [{ status: "completed", conclusion: "success", html_url: "x" }],
        });
      }
      if (/\/contents\/dataset_description\.json$/.test(path)) {
        return Response.json({ encoding: "base64", content: btoa(DESCRIPTION) });
      }
      if (/\/contents\/README\.md$/.test(path)) {
        return Response.json({ encoding: "base64", content: btoa("# README") });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_note_test",
    PRESCREEN_CALLBACK_SECRET: "note-callback-secret",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_note_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

async function addUser(
  username: string,
  role: string,
  key: string,
  email: string,
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

beforeEach(async () => {
  bidsRuns = "success";
  db = freshDb();
  app = makePublicationReviewApp();
  ownerId = await addUser("noteowner", "member", OWNER_KEY, OWNER_EMAIL);
  adminId = await addUser("noteadmin", "admin", ADMIN_KEY, ADMIN_EMAIL);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo)
     VALUES (?, 'A sufficiently descriptive title', ?, 'active', 'private', 0, ?)`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
});

async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.key ?? OWNER_KEY}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: opts.rawBody ?? JSON.stringify(opts.body) } : {}),
    }),
    env(),
  );
  const body = (await res.json()) as Record<string, unknown>;
  await app.settled();
  return { status: res.status, body };
}

const requestWith = (note: unknown) =>
  call("POST", `/datasets/${DATASET}/publish/request`, {
    body: note === undefined ? {} : { resubmission_note: note },
  });

interface Row {
  id: number;
  status: string;
  resubmission_note: string | null;
  previous_request_id: number | null;
}

function rows(): Row[] {
  return db
    .query<Row, [string]>(
      `SELECT id, status, resubmission_note, previous_request_id
         FROM publication_requests WHERE dataset_id = ? ORDER BY id`,
    )
    .all(DATASET);
}

const lastRow = (): Row => rows().at(-1) as Row;

/** A finished request, as a denial or a withdrawal leaves it. */
function seedEnded(kind: "denied" | "withdrawn", ago = "-2 days"): number {
  db.run(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, requested_at, updated_at,
                                       denied_at, denied_by, denied_reason, withdrawn_at)
     VALUES (?, ?, 'denied', datetime('now', ?), datetime('now', ?),
             CASE WHEN ? = 'denied' THEN datetime('now', ?) END,
             CASE WHEN ? = 'denied' THEN ? END,
             CASE WHEN ? = 'denied' THEN 'README missing' END,
             CASE WHEN ? = 'withdrawn' THEN datetime('now', ?) END)`,
    [DATASET, ownerId, ago, ago, kind, ago, kind, adminId, kind, kind, ago],
  );
  return (db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

describe("the request route keeps a note by one rule", () => {
  test("a note is stored trimmed, with its line breaks, and echoed as recorded", async () => {
    const r = await requestWith("  Added the participants file.\r\nSee the new commit.  ");
    expect(r.status).toBe(200);
    expect(r.body.resubmission_note_recorded).toBe(true);
    expect(lastRow().resubmission_note).toBe("Added the participants file.\nSee the new commit.");
  });

  test("control: no note, an empty note and a blank note are all NULL, and not recorded", async () => {
    for (const note of [undefined, "", "   \n  "]) {
      db.run("DELETE FROM publication_requests");
      const r = await requestWith(note);
      expect(r.status).toBe(200);
      expect(r.body.resubmission_note_recorded).toBe(false);
      expect(lastRow().resubmission_note).toBeNull();
    }
  });

  test("2000 characters are kept and 2001 are refused, with no row and no trimming to fit", async () => {
    const ok = await requestWith("a".repeat(2000));
    expect(ok.status).toBe(200);
    expect(lastRow().resubmission_note?.length).toBe(2000);

    db.run("DELETE FROM publication_requests");
    const refused = await requestWith("a".repeat(2001));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_resubmission_note");
    expect(refused.body.reason).toBe("too_long");
    expect(String(refused.body.error)).toContain("2000");
    expect(rows()).toEqual([]);
  });

  test("the limit counts characters, not UTF-16 units: 2000 emoji are kept", async () => {
    const r = await requestWith("\u{1F9E0}".repeat(2000));
    expect(r.status).toBe(200);
    expect([...(lastRow().resubmission_note ?? "")].length).toBe(2000);
  });

  test("the length is measured after trimming: padding does not count", async () => {
    const r = await requestWith(`${" ".repeat(300)}${"b".repeat(2000)}${"\n".repeat(300)}`);
    expect(r.status).toBe(200);
    expect(lastRow().resubmission_note).toBe("b".repeat(2000));
  });

  test("a control character other than a line break is refused, and a line break is not", async () => {
    for (const bad of ["a\u0007b", "a\tb", "a\u001b[31mb", "a\rb", "a\u0000b"]) {
      const r = await requestWith(bad);
      expect(r.status).toBe(400);
      expect(r.body.reason).toBe("control_character");
    }
    expect(rows()).toEqual([]);
    const ok = await requestWith("line one\nline two\r\nline three");
    expect(ok.status).toBe(200);
    expect(lastRow().resubmission_note).toBe("line one\nline two\nline three");
  });

  test("a note that is not text is refused, never coerced", async () => {
    for (const bad of [42, true, ["a"], { text: "a" }]) {
      const r = await requestWith(bad);
      expect(r.status).toBe(400);
      expect(r.body.reason).toBe("not_text");
    }
    expect(rows()).toEqual([]);
  });

  test("a refused note sends no mail and starts no screen", async () => {
    const sent = await withFakeResend(async (calls) => {
      await requestWith("a".repeat(2001));
      await app.settled();
      return calls.length;
    });
    expect(sent).toBe(0);
  });

  test("a note on a request held for validation is recorded, kept when the retry sends none, and replaced by a new one", async () => {
    bidsRuns = "none";
    const first = await requestWith("First words");
    expect(first.status).toBe(422);
    expect(lastRow().status).toBe("blocked");
    expect(lastRow().resubmission_note).toBe("First words");

    const again = await requestWith(undefined);
    expect(again.status).toBe(422);
    expect(lastRow().resubmission_note).toBe("First words");
    expect(rows().length).toBe(1);

    const replaced = await requestWith("Second words");
    expect(replaced.status).toBe(422);
    expect(lastRow().resubmission_note).toBe("Second words");

    bidsRuns = "success";
    const released = await requestWith(undefined);
    expect(released.status).toBe(200);
    expect(lastRow().status).toBe("requested");
    expect(lastRow().resubmission_note).toBe("Second words");
  });
});

describe("previous_request_id links a denial and never a withdrawal", () => {
  test("a request after a denial points at it", async () => {
    const denied = seedEnded("denied");
    await requestWith("What changed");
    expect(lastRow().previous_request_id).toBe(denied);
  });

  test("control: a first request points at nothing", async () => {
    await requestWith(undefined);
    expect(lastRow().previous_request_id).toBeNull();
  });

  test("a request after a withdrawal points at nothing, though a withdrawal is stored as denied", async () => {
    seedEnded("withdrawn");
    await requestWith(undefined);
    expect(lastRow().previous_request_id).toBeNull();
  });

  test("only the most recent earlier request counts: a withdrawal after a denial unlinks it", async () => {
    seedEnded("denied", "-3 days");
    seedEnded("withdrawn", "-1 days");
    await requestWith(undefined);
    expect(lastRow().previous_request_id).toBeNull();
  });
});

describe("the status answer says who denied, for the question the CLI asks", () => {
  const status = () => call("GET", `/datasets/${DATASET}/publish/status`);

  test("an administrator's denial is read as an administrator's", async () => {
    seedEnded("denied");
    const r = await status();
    expect(r.body.status).toBe("denied");
    expect(r.body.denied_by_kind).toBe("administrator");
  });

  test("an auto_deny audit row naming the request makes it an agent's", async () => {
    const id = seedEnded("denied");
    db.run(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, 'dataset', ?, ?)",
      [adminId, AUTO_DENY_AUDIT_ACTION, DATASET, JSON.stringify({ request_id: id })],
    );
    expect((await status()).body.denied_by_kind).toBe("agent");
  });

  test("an auto_deny row for another request, or with a payload that is not JSON, changes nothing", async () => {
    const id = seedEnded("denied");
    db.run(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, 'dataset', ?, ?)",
      [adminId, AUTO_DENY_AUDIT_ACTION, DATASET, JSON.stringify({ request_id: id + 100 })],
    );
    db.run(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, 'dataset', ?, 'not json {')",
      [adminId, AUTO_DENY_AUDIT_ACTION, DATASET],
    );
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body.denied_by_kind).toBe("administrator");
  });

  test("a withdrawal says nobody denied it", async () => {
    seedEnded("withdrawn");
    const r = await status();
    expect(r.body.withdrawn).toBe(true);
    expect(r.body.denied_by_kind).toBeNull();
  });
});

describe("administrators see the note where they see the request", () => {
  const NOTE = "I fixed the README.\nThe <b>license</b> is CC0 & stated.";

  test("the list row and the review detail carry the note and the denial it answers", async () => {
    const denied = seedEnded("denied");
    await requestWith(NOTE);

    const list = await call("GET", "/admin/publish/requests", { key: ADMIN_KEY });
    const mine = (list.body.requests as Array<Record<string, unknown>>).find(
      (r) => r.status === "requested",
    );
    expect(mine?.resubmission_note).toBe(NOTE);
    expect(mine?.previous_request_id).toBe(denied);

    const detail = await call("GET", `/admin/publish/${DATASET}/review`, { key: ADMIN_KEY });
    expect(detail.status).toBe(200);
    expect(detail.body.resubmission_note).toBe(NOTE);
    expect(detail.body.previous_request_id).toBe(denied);
  });

  test("control: a request with no note reads null in both, not missing", async () => {
    await requestWith(undefined);
    const detail = await call("GET", `/admin/publish/${DATASET}/review`, { key: ADMIN_KEY });
    expect(detail.body.resubmission_note).toBeNull();
    expect(detail.body.previous_request_id).toBeNull();
  });

  test("the depositor's own status carries no note", async () => {
    await requestWith(NOTE);
    const r = await call("GET", `/datasets/${DATASET}/publish/status`);
    expect(JSON.stringify(r.body)).not.toContain("I fixed the README");
  });
});

describe("the administrators' mail", () => {
  async function mailFor(note: string | undefined): Promise<{ html: string; text?: string }> {
    const mail = await withFakeResend(async (calls) => {
      await requestWith(note);
      // The mail of a screened request goes when the screen reports; a request made for a
      // dataset the screen could not start is mailed at once. Either way it is the real mail
      // function, so read it through the reminder route when none went yet.
      await app.settled();
      const first = sendsTo(calls, ADMIN_EMAIL)[0];
      if (first) return first;
      db.run(
        `UPDATE publication_requests SET identifier_screen_status = 'clean',
                updated_at = datetime('now', '-2 hours')`,
      );
      const resent = await call("POST", `/datasets/${DATASET}/publish/resend`);
      expect(resent.status).toBe(200);
      return sendsTo(calls, ADMIN_EMAIL)[0];
    });
    return mail;
  }

  test("a note is a labeled, quoted block, escaped whole", async () => {
    const { html } = await mailFor(
      "Fixed. <script>alert(1)</script> **not bold** [link](https://example.org) & <img src=x>",
    );
    expect(html).toContain("Depositor&#39;s note");
    expect(html).toContain("<blockquote");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("**not bold** [link](https://example.org) &amp; &lt;img src=x&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("Written by the depositor");
  });

  test("control: a request with no note has no note block", async () => {
    const { html, text } = await mailFor(undefined);
    expect(html).not.toContain("Depositor");
    expect(html).not.toContain("<blockquote");
    // No note, no text part of our own: the mail is what it was before the note existed.
    expect(text).toBeUndefined();
  });

  test("the plain-text part quotes the note line by line, between a label line and a blank line", async () => {
    const { text } = await mailFor("Line one <b>kept</b>\n\nLine three & more");
    expect(text).toBeDefined();
    expect(text).toContain(
      "Depositor's note (Written by the depositor. It is not verified and it is not NEMAR's.)\n> Line one <b>kept</b>\n>\n> Line three & more\n\n",
    );
    // Plain text: the characters as typed, not HTML escapes.
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("NEMAR-RESUBMISSION-NOTE-HERE");
  });

  test("a note that could not be read is said so in a fixed sentence, and the mail still goes", async () => {
    await requestWith("Words that cannot be read now");
    const id = lastRow().id;
    const failing: Bindings = {
      ...env(),
      DB: hookedD1(realD1(db), {
        statement: (sql) => {
          if (sql.includes("SELECT resubmission_note FROM publication_requests")) {
            throw new Error("simulated read failure");
          }
        },
      }),
    };
    const mail = await withFakeResend(async (calls) => {
      await mailPublicationRequest(failing, {
        requestId: id,
        datasetId: DATASET,
        username: "noteowner",
        anonymous: false,
        screen: { headline: "Identifier screen: clean", tone: "ok", lines: [] },
      });
      return sendsTo(calls, ADMIN_EMAIL)[0];
    });
    expect(mail.html).toContain(resubmissionNoteUnreadable(DATASET));
    expect(mail.html).not.toContain("Words that cannot be read now");
    expect(mail.html).not.toContain("<blockquote");
  });

  test("mailPublicationRequest reads the note from the row whichever caller sends the mail", async () => {
    await requestWith("Read from the row");
    const id = lastRow().id;
    const html = await withFakeResend(async (calls) => {
      await mailPublicationRequest(env(), {
        requestId: id,
        datasetId: DATASET,
        username: "noteowner",
        anonymous: false,
        screen: { headline: "Identifier screen: clean", tone: "ok", lines: [] },
      });
      return sendsTo(calls, ADMIN_EMAIL)[0].html;
    });
    expect(html).toContain("Read from the row");
    const without = await withFakeResend(async (calls) => {
      await mailPublicationRequest(env(), {
        requestId: null,
        datasetId: DATASET,
        username: "noteowner",
        anonymous: false,
        screen: { headline: "Identifier screen: clean", tone: "ok", lines: [] },
      });
      return sendsTo(calls, ADMIN_EMAIL)[0].html;
    });
    expect(without).not.toContain("Read from the row");
  });

  test("a denial mail to the depositor never carries the note", async () => {
    await requestWith("Private words for the reviewer");
    const sent = await withFakeResend(async (calls) => {
      const denied = await call("POST", `/admin/publish/${DATASET}/deny`, {
        key: ADMIN_KEY,
        body: { reason: "README is missing" },
      });
      expect(denied.status).toBe(200);
      await app.settled();
      return calls.filter((c) => c.path === "/emails").map(asSend);
    });
    const toOwner = sent.filter((m) => m.to.includes(OWNER_EMAIL));
    expect(toOwner.length).toBeGreaterThan(0);
    for (const mail of sent) {
      expect(mail.subject).not.toContain("Private words");
      expect(mail.html).not.toContain("Private words for the reviewer");
      expect(mail.text ?? "").not.toContain("Private words for the reviewer");
    }
  });
});
