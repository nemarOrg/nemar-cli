/**
 * The identifier sweep's weekly report (epic #1610, phase 5, ADR 0087).
 *
 * Two halves. The pure half (`identifier-sweep-report.ts`) decides what each
 * dataset's standing is and what the week says, from stored rows and a clock;
 * those rules are pinned with rows whose reports come from the production
 * parser. The other half is the send, driven through
 * `sendIdentifierSweepWeeklyReport` and `GET /admin/identifier-sweep` against
 * real migrations, with the state built by the real tick and callback and the
 * mail caught by the shared Resend capture.
 *
 * The rules that matter most: the report arrives whether or not anything is
 * wrong; unknown is never rendered as zero; a dataset counts as screened only
 * when every condition holds; a finding stays listed when its screen ages out;
 * the week is sent once, fails closed, and never from a dev worker.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import {
  IDENTIFIER_SWEEP_CYCLE_DAYS,
  IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
  IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS,
  IDENTIFIER_SWEEP_REPORT_SENT_ACTION,
  IDENTIFIER_SWEEP_ROWS_SQL,
  runIdentifierSweepTick,
  sendIdentifierSweepWeeklyReport,
} from "../src/services/identifier-sweep";
import {
  type IdentifierSweepRow,
  attentionReasons,
  buildIdentifierWeek,
  renderIdentifierWeek,
  reportWindow,
  standingOf,
  unknownIdentifierWeek,
} from "../src/services/identifier-sweep-report";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { type CapturedEmail, asSend, withFakeResend } from "./helpers/resend";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const LEAK = "SMITH";
const DAY = 86_400_000;

function scanBody(datasetId: string, status: string, extra: Record<string, unknown> = {}) {
  const incomplete = status === "unchecked";
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete,
      incomplete_reasons: incomplete ? ["deadline", "edf-headers-unread"] : [],
      files: { total: 10, edf_bdf: 4, header_read: incomplete ? 3 : 4, header_read_failed: 0 },
      ...extra,
    },
  };
}

/** A stored report exactly as the Worker stores one: the parser's output, re-serialized. */
const stored = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify(parseScreenReport(scanBody(id, status, extra)));

/** SQLite's `datetime('now')` shape for an instant. */
const sqlite = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const NOW = new Date("2026-10-07T10:00:00.000Z"); // a Wednesday in 2026-W41
const NOW_MS = NOW.getTime();

function row(id: string, over: Partial<IdentifierSweepRow> = {}): IdentifierSweepRow {
  return {
    dataset_id: id,
    latest_version: "1.0.0",
    status: null,
    checked_at: null,
    version: null,
    report: null,
    attempt: null,
    attempt_error: null,
    attempted_at: null,
    requested_at: null,
    ...over,
  };
}

/** A dataset screened `daysAgo` with `status`, of its current version. */
function screenedRow(id: string, status: string, daysAgo = 1, extra = {}): IdentifierSweepRow {
  return row(id, {
    status,
    report: stored(id, status, extra),
    checked_at: sqlite(NOW_MS - daysAgo * DAY),
    version: "1.0.0",
    attempt: "reported",
    attempted_at: sqlite(NOW_MS - daysAgo * DAY - 600_000),
  });
}

const facts = (rows: IdentifierSweepRow[], due: number | null = 0) =>
  buildIdentifierWeek(rows, { now: NOW, due, cycleDays: IDENTIFIER_SWEEP_CYCLE_DAYS });

describe("the week a report covers", () => {
  test("is the ISO week before the one it is made in, Monday to Monday UTC", () => {
    const w = reportWindow(NOW);
    expect(w.week).toBe("2026-W40");
    expect(w.start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    // The first minute of a Monday already reports the week that just closed, and
    // the last minute of a Sunday still reports the one before it.
    expect(reportWindow(new Date("2026-10-05T00:00:00.000Z")).week).toBe("2026-W40");
    expect(reportWindow(new Date("2026-10-04T23:59:59.000Z")).week).toBe("2026-W39");
  });

  test("labels the ISO year, not the calendar year, at the boundary", () => {
    // 2027-01-04 is a Monday; the week before it began on 2026-12-28, which is 2026-W53.
    expect(reportWindow(new Date("2027-01-04T08:00:00.000Z")).week).toBe("2026-W53");
    expect(reportWindow(new Date("2027-01-11T08:00:00.000Z")).week).toBe("2027-W01");
  });
});

describe("a dataset's standing", () => {
  test("screened only when the verdict reads back, is in the cycle, is of the latest version, and is complete", () => {
    expect(standingOf(screenedRow("nm000700", "clean"), NOW_MS, 28).kind).toBe("screened");
    const reasonOf = (r: IdentifierSweepRow) => {
      const s = standingOf(r, NOW_MS, 28);
      return s.kind === "unchecked" ? s.reason : "screened";
    };
    expect(reasonOf(row("nm000701"))).toBe("never-screened");
    expect(reasonOf(screenedRow("nm000702", "clean", 29))).toBe("expired");
    expect(reasonOf(screenedRow("nm000703", "clean", 27))).toBe("screened");
    expect(reasonOf({ ...screenedRow("nm000704", "clean"), latest_version: "1.1.0" })).toBe(
      "new-version",
    );
    expect(reasonOf(screenedRow("nm000705", "unchecked"))).toBe("incomplete");
  });

  test("a verdict whose report, status or time does not read back is unreadable, never screened", () => {
    const base = screenedRow("nm000706", "clean");
    const reasonOf = (r: IdentifierSweepRow) => {
      const s = standingOf(r, NOW_MS, 28);
      return s.kind === "unchecked" ? s.reason : "screened";
    };
    expect(reasonOf({ ...base, status: "fine" })).toBe("unreadable");
    expect(reasonOf({ ...base, status: "direct-identifiers" })).toBe("unreadable");
    expect(reasonOf({ ...base, report: "{" })).toBe("unreadable");
    expect(reasonOf({ ...base, checked_at: "yesterday" })).toBe("unreadable");
    // A report edited by hand to carry a value is refused by the parser on the way out.
    const hostile = JSON.parse(base.report as string);
    hostile.scan.patient = LEAK;
    expect(reasonOf({ ...base, report: JSON.stringify(hostile) })).toBe("unreadable");
  });

  test("the version check is NULL-safe: no version on either side is the same version", () => {
    const r = { ...screenedRow("nm000707", "clean"), version: null, latest_version: null };
    expect(standingOf(r, NOW_MS, 28).kind).toBe("screened");
  });
});

describe("the week's facts and words", () => {
  test("counts screened by verdict and unchecked by reason and by last attempt", () => {
    const f = facts([
      screenedRow("nm000710", "clean"),
      screenedRow("nm000711", "dates-only"),
      screenedRow("nm000712", "direct-identifiers", 2, {
        findings_by_kind: { "edf-patient-name": 12, "edf-patient-birthdate": 12 },
        edf_bdf_files_flagged: 12,
      }),
      screenedRow("nm000713", "unchecked"),
      row("nm000714"),
      row("nm000715", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) }),
      row("nm000716", { attempt: "error", attempt_error: "dispatch-failed" }),
      row("nm000717", { attempt: "unreported", attempt_error: "no-report-in-time" }),
      { ...screenedRow("nm000718", "clean", 40), attempt: "error", attempt_error: "clone-failed" },
    ]);
    expect(f.scope).toBe(9);
    expect(f.screened).toBe(3);
    expect(f.byStatus).toEqual({ clean: 1, "dates-only": 1, "direct-identifiers": 1 });
    expect(f.unchecked).toBe(6);
    expect(f.uncheckedByReason).toEqual({
      "never-screened": 4,
      unreadable: 0,
      expired: 1,
      "new-version": 0,
      incomplete: 1,
    });
    expect(f.lastAttempt).toEqual({
      queued: 1,
      "in-flight": 1,
      "dispatch-failed": 1,
      "no-report-in-time": 1,
      "clone-failed": 1,
    });
    expect(f.incompleteReasons).toEqual({ deadline: 1, "edf-headers-unread": 1 });
    expect(f.flagged?.map((d) => d.dataset_id)).toEqual(["nm000712"]);
    const r = renderIdentifierWeek(f);
    const text = r.lines.join("\n");
    // The screen's own words for each state and cause.
    expect(text).toContain("  clean (acquisition dates only): 1");
    expect(text).toContain("  FOUND IDENTIFIERS: 1");
    expect(text).toContain("GitHub refused to start the screen workflow: 1");
    expect(text).toContain("the screen workflow started but never reported back: 1");
    expect(text).toContain("the screen workflow could not read the dataset repository: 1");
    expect(text).toContain(
      "  nm000712 (screened 2026-10-05): edf-patient-name x12, edf-patient-birthdate x12; EDF/BDF files with an identifier finding: 12",
    );
    expect(r.subject).toBe("[NEMAR] Identifier sweep 2026-W40: 1 with identifiers, 6 unchecked");
    expect(r.attention).toBe(true);
  });

  test("a finding stays listed after its screen ages out of the cycle, and says so", () => {
    const f = facts([
      screenedRow("nm000720", "direct-identifiers", 40, {
        findings_by_kind: { "edf-patient-code": 3 },
      }),
    ]);
    expect(f.screened).toBe(0);
    expect(f.flagged).toEqual([
      {
        dataset_id: "nm000720",
        screened_on: "2026-08-28",
        standing: "expired",
        findings_by_kind: { "edf-patient-code": 3 },
        edf_bdf_files_flagged: null,
      },
    ]);
    expect(renderIdentifierWeek(f).lines.join("\n")).toContain(
      "  nm000720 (screened 2026-08-28, the last screen is older than the cycle): edf-patient-code x3",
    );
  });

  test("a quiet week says nothing needs attention, and work in progress is not a problem", () => {
    const quiet = facts([
      screenedRow("nm000730", "clean", 3),
      row("nm000731"), // a new dataset, queued
      row("nm000732", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) }),
    ]);
    // A screen started in the window, so the sweep is alive.
    quiet.startedInWindow = 1;
    expect(attentionReasons(quiet)).toEqual([]);
    expect(renderIdentifierWeek(quiet).headline).toBe("Nothing needs attention this week.");
  });

  test("each kind of trouble is named in the headline", () => {
    const cases: [IdentifierSweepRow, string][] = [
      [screenedRow("nm000740", "direct-identifiers", 2), "1 datasets with direct identifiers"],
      [
        row("nm000741", { attempt: "error", attempt_error: "dispatch-unconfigured" }),
        "1 unchecked datasets whose last screen did not run or did not report",
      ],
      [screenedRow("nm000742", "unchecked"), "1 screens were incomplete"],
      [screenedRow("nm000743", "clean", 30), "1 datasets fell out of the cycle"],
      [
        { ...screenedRow("nm000744", "clean"), status: "fine" },
        "1 stored results do not read back",
      ],
    ];
    for (const [r, phrase] of cases) {
      const f = facts([r]);
      f.startedInWindow = 1;
      expect(attentionReasons(f)).toEqual([phrase]);
      expect(renderIdentifierWeek(f).headline).toBe(`Needs attention: ${phrase}.`);
    }
  });

  test("a sweep that started nothing while work was due is reported as not running", () => {
    const f = facts([row("nm000750")], 1);
    expect(f.startedInWindow).toBe(0);
    expect(attentionReasons(f)).toContain("the sweep started no screen while work was due");
    expect(renderIdentifierWeek(f).lines).toContain(
      "The sweep started no screen this week while 1 datasets were due: it is not running.",
    );
    // Nothing due and nothing started all week: silence is not evidence (ADR 0053).
    // Screened ten days before NOW, so its attempt is outside the week reported.
    const quiet = facts([screenedRow("nm000751", "clean", 10)], 0);
    expect(quiet.startedInWindow).toBe(0);
    expect(attentionReasons(quiet)).toEqual([]);
  });

  test("unknown is never zero: unreadable records make every figure unknown, and the week needs attention", () => {
    const f = unknownIdentifierWeek(NOW, null, ["the sweep's records could not be read"], 28);
    const r = renderIdentifierWeek(f);
    expect(r.attention).toBe(true);
    expect(r.subject).toBe(
      "[NEMAR] Identifier sweep 2026-W40: unknown with identifiers, unknown unchecked",
    );
    const text = r.lines.join("\n");
    for (const line of [
      "Public datasets in scope: unknown",
      "Screened this cycle: unknown",
      "Unchecked: unknown",
      "Due now: unknown",
      "Datasets with direct identifiers (last screen, kinds and counts): unknown",
      "Whether the sweep ran this week: unknown",
      "Could not read: the sweep's records could not be read.",
    ]) {
      expect(text).toContain(line);
    }
    // No figure rendered as 0 anywhere.
    expect(text).not.toMatch(/: 0\b/);
    expect(text).not.toMatch(/for 0 datasets/);
  });

  test("review is listed after the identifiers, bounded, with a count and a pointer", () => {
    const rows = Array.from({ length: 53 }, (_, i) =>
      screenedRow(`nm0008${String(i).padStart(2, "0")}`, "review", 1, {
        findings_by_kind: { "tooling-debris": 1 },
      }),
    );
    const r = renderIdentifierWeek(facts(rows));
    expect(r.lines).toContain("Datasets that need review (last screen, kinds and counts): 53");
    expect(r.lines.filter((l) => l.startsWith("  nm0008"))).toHaveLength(50);
    expect(r.lines).toContain("  and 3 more (GET /admin/identifier-sweep lists them all)");
  });
});

// ============================================================================
// The send, against real migrations and the real tick and callback
// ============================================================================

const SECRET = "sweep-report-secret";
const ADMIN_KEY = "sweep-report-admin-0123456789abcdef0123456789abcdef";
let server: Server;
let dispatches: { client_payload: { dataset_id: string; callback_token: string } }[] = [];
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push(await req.json());
        return new Response(null, { status: 204 });
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

afterEach(() => {
  dispatches = [];
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_sweep_report",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function seedUser(username: string, role: string, prefs?: Record<string, boolean>) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, email_preferences)
     VALUES (?, ?, 'x', 'approved', ?, 1, ?)`,
    [username, `${username}@example.org`, role, prefs ? JSON.stringify(prefs) : null],
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)
    ?.id as number;
}

function seedDataset(id: string, visibility = "public") {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [id, `Dataset ${id}`, ownerId, visibility, `nemarDatasets/${id}`],
  );
}

async function answer(id: string, report: unknown) {
  const d = dispatches.find((x) => x.client_payload.dataset_id === id);
  if (!d) throw new Error(`no dispatch for ${id}`);
  const res = await app.request(
    "/webhooks/identifier-sweep-result",
    {
      method: "POST",
      headers: { "X-Webhook-Token": d.client_payload.callback_token },
      body: JSON.stringify({ dataset_id: id, request_id: 0, report }),
    },
    env(),
  );
  expect(res.status).toBe(200);
}

/** The week that holds real `datetime('now')` stamps is the one a report made a week later covers. */
const nextWeek = () => new Date(Date.now() + 7 * DAY);

function auditRows(action: string) {
  return db
    .query<{ resource_id: string; details: string | null }, [string]>(
      "SELECT resource_id, details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);
  app.route("/admin", adminRoutes);
  ownerId = await seedUser("reportowner", "member");
  const adminId = await seedUser("reportadmin", "admin");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

describe("the weekly send", () => {
  test("arrives once a week, says what the sweep found in the screen's words, and records the week", async () => {
    seedDataset("nm000760");
    seedDataset("nm000761");
    seedDataset("nm000762");
    seedDataset("nm000763", "private");
    await runIdentifierSweepTick(env());
    await answer("nm000760", scanBody("nm000760", "clean"));
    await answer(
      "nm000761",
      scanBody("nm000761", "direct-identifiers", {
        findings_by_kind: { "edf-patient-name": 2 },
        edf_bdf_files_flagged: 2,
      }),
    );
    // nm000762 never reports; its attempt is still in flight.
    const when = nextWeek();
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const first = await sendIdentifierSweepWeeklyReport(env(), when);
      expect(first).toMatchObject({ claimed: true, attempted: 1, delivered: 1, attention: true });
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      const mail = sends[0] as { to: string[]; subject: string; html: string };
      expect(mail.to).toEqual(["reportadmin@example.org"]);
      expect(mail.subject).toBe(
        `[NEMAR] Identifier sweep ${reportWindow(when).week}: 1 with identifiers, 1 unchecked`,
      );
      expect(mail.html).toContain("Public datasets in scope: 3");
      expect(mail.html).toContain("Screened this cycle: 2");
      expect(mail.html).toContain("nm000761 (screened ");
      expect(mail.html).toContain("edf-patient-name x2");
      expect(mail.html).toContain("a screen is running: 1");
      expect(mail.html).not.toContain("nm000763");

      // The second tick of the week finds it sent: no claim, no mail.
      const second = await sendIdentifierSweepWeeklyReport(env(), when);
      expect(second?.claimed).toBe(false);
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
    const sent = auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.resource_id).toBe(reportWindow(when).week);
    expect(JSON.parse(sent[0]?.details as string)).toMatchObject({
      delivered: 1,
      scope: 3,
      screened: 2,
      unchecked: 1,
      with_identifiers: 1,
    });
  });

  test("arrives when nothing is wrong, too", async () => {
    seedDataset("nm000765");
    await runIdentifierSweepTick(env());
    await answer("nm000765", scanBody("nm000765", "clean"));
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport(env(), nextWeek());
      expect(out).toMatchObject({ claimed: true, delivered: 1, attention: false });
      const mail = asSend(calls.find((c) => c.path === "/emails") as CapturedEmail);
      expect(mail.html).toContain("Nothing needs attention this week.");
    });
  });

  test("records it could not read are stated as unknown, and the report still goes", async () => {
    seedDataset("nm000766");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql === IDENTIFIER_SWEEP_ROWS_SQL) throw new Error("D1 unavailable");
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, nextWeek());
      expect(out).toMatchObject({ claimed: true, delivered: 1, attention: true });
      const mail = asSend(calls.find((c) => c.path === "/emails") as CapturedEmail);
      expect(mail.subject).toContain("unknown with identifiers, unknown unchecked");
      expect(mail.html).toContain("Public datasets in scope: unknown");
      expect(mail.html).toContain("Could not read: the sweep&#39;s records could not be read.");
    });
  });

  test("a claim that cannot be written sends nothing (fails closed)", async () => {
    seedDataset("nm000767");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION) && sql.startsWith("INSERT")) {
        throw new Error("D1 unavailable");
      }
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, nextWeek());
      expect(out?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  test("a send that reached nobody is not recorded; it is retried after the lease, up to the cap", async () => {
    seedDataset("nm000768");
    const when = nextWeek();
    const week = reportWindow(when).week;
    await withFakeResend(
      async (calls: CapturedEmail[]) => {
        const out = await sendIdentifierSweepWeeklyReport(env(), when);
        expect(out).toMatchObject({ claimed: true, attempted: 1, delivered: 0 });
        expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
      },
      { status: 500 },
    );
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION)).toHaveLength(0);
    // Inside the lease, the next tick does not claim.
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
    // After it, the week is tried again and sent.
    db.run("UPDATE audit_log SET timestamp = datetime('now', '-121 minutes') WHERE action = ?", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect(await sendIdentifierSweepWeeklyReport(env(), when)).toMatchObject({
        claimed: true,
        delivered: 1,
      });
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION).map((r) => r.resource_id)).toEqual([
      week,
    ]);
    // Once sent, the week stays sent: a lapsed lease does not reopen it.
    db.run("UPDATE audit_log SET timestamp = datetime('now', '-1 days') WHERE action = ?", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  test(`no more than ${IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS} claims in a week, however the record fails`, async () => {
    seedDataset("nm000769");
    const when = nextWeek();
    const week = reportWindow(when).week;
    for (let i = 0; i < IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS; i++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, timestamp)
         VALUES (NULL, ?, 'identifier_sweep', ?, datetime('now', '-1 days'))`,
        [IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION, week],
      );
    }
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
    // One fewer, and the week is claimed again.
    db.run("DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log WHERE action = ?)", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async () => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(true);
    });
  });

  test("an admin who opted out of identifier_sweep is not mailed while another is", async () => {
    await seedUser("optedout", "admin", { identifier_sweep: false });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      await sendIdentifierSweepWeeklyReport(env(), nextWeek());
      const to = calls.filter((c) => c.path === "/emails").flatMap((c) => asSend(c).to);
      expect(to).toEqual(["reportadmin@example.org"]);
    });
  });

  for (const environment of ["development", "staging", "test"]) {
    test(`ENVIRONMENT=${environment}: nothing is claimed and nothing is mailed`, async () => {
      seedDataset("nm000770");
      await withFakeResend(async (calls: CapturedEmail[]) => {
        expect(await sendIdentifierSweepWeeklyReport(env({ ENVIRONMENT: environment }))).toBeNull();
        // The opt-in that lets staging test admin mail does not open this one either.
        expect(
          await sendIdentifierSweepWeeklyReport(
            env({ ENVIRONMENT: environment, DEV_ADMIN_NOTIFICATIONS: "1" }),
          ),
        ).toBeNull();
        expect(calls).toHaveLength(0);
      });
      expect(auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION)).toHaveLength(0);
    });
  }
});

describe("one bad row", () => {
  test("a report stamp that is not an object is that dataset's unreadable, not the week's unknown", async () => {
    seedDataset("nm000785");
    seedDataset("nm000786");
    await runIdentifierSweepTick(env());
    await answer("nm000785", scanBody("nm000785", "clean"));
    await answer("nm000786", scanBody("nm000786", "clean"));
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_report', 'not json {')
        WHERE dataset_id = 'nm000786'`,
    );
    const res = await app.request(
      "/admin/identifier-sweep",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const body = (await res.json()) as {
      facts: {
        scope: number;
        screened: number;
        errors: string[];
        uncheckedByReason: Record<string, number>;
      };
    };
    expect(body.facts.errors).toEqual([]);
    expect(body.facts.scope).toBe(2);
    expect(body.facts.screened).toBe(1);
    expect(body.facts.uncheckedByReason.unreadable).toBe(1);
  });
});

describe("GET /admin/identifier-sweep", () => {
  test("renders the report on demand, on staging too, and sends nothing", async () => {
    seedDataset("nm000780");
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const res = await app.request(
        "/admin/identifier-sweep",
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env({ ENVIRONMENT: "staging" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        facts: { scope: number; unchecked: number };
        report: { lines: string[]; attention: boolean };
      };
      expect(body.facts.scope).toBe(1);
      expect(body.facts.unchecked).toBe(1);
      expect(body.report.lines).toContain("  never screened: 1");
      expect(calls).toHaveLength(0);
    });
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION)).toHaveLength(0);
  });
});
