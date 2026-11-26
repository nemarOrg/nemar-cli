/**
 * The RFC clock in the weekly import report (RFC program card R3, risk K1; ADR 0054).
 *
 * Driven through the report's own entry point, `runWeeklyImportSummary`, on real in-memory SQLite
 * with every migration. The only thing stood in for is api.github.com, by a `Bun.serve` that
 * `NEMAR_GITHUB_API_URL` points the three reads at (the README of nemarOrg/rfcs, the `rfc-clock`
 * workflow, and its newest run); OpenNeuro, the raw mirror host and the coverage sweep are stood in
 * for as in every weekly test, and no test reaches the internet.
 *
 * The properties, each with a test of its own:
 *  - an RFC that is open is listed with its close instant, and one that has closed is listed with
 *    the date its decision is due, and needs attention once that date has passed;
 *  - a draft and a decided or withdrawn RFC are not listed, and the empty list is a true zero;
 *  - a workflow GitHub switched off, a newest run older than 48 hours, no run at all and a run that
 *    failed each need attention, and a quiet week with a recent success needs none;
 *  - a read that fails (a 500, a README without the markers, a table that is not the generator's)
 *    renders unknown, lists a failed part with stage `rfcs` and needs attention, never zero;
 *  - the token is offered first, retried without it when the public repository refuses it, and left
 *    out when it cannot be obtained;
 *  - what is printed from the record is made safe for a public report.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { weeklyAttention } from "../../shared/contract/weekly-attention";
import type { ImportCoverageSweepResult } from "../src/services/import-coverage-sweep";
import { weeklyHeadline, weeklySummaryLogLine } from "../src/services/import-weekly-summary";
import {
  type WeeklySummaryDeps,
  runWeeklyImportSummary,
} from "../src/services/import-weekly-summary-sweep";
import {
  RFC_INDEX_END,
  RFC_INDEX_START,
  parseRfcIndex,
  rfcReportTitle,
} from "../src/services/rfc-weekly";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";
import { startRawHost } from "./helpers/raw-mirror-standin";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Monday 03:00 UTC, when the weekly report fires. */
const NOW = new Date(Date.UTC(2026, 10, 16, 3, 0, 0));

const openneuro = startOpenNeuroStandin();
const rawMirror = startRawHost();

// ----------------------------------------------------------------------------
// The api.github.com stand-in
// ----------------------------------------------------------------------------

interface Call {
  path: string;
  authorization: string | null;
  userAgent: string | null;
  accept: string | null;
}

type Responder = (call: Call) => Response;

const README_PATH = "/repos/nemarOrg/rfcs/contents/README.md";
const WORKFLOW_PATH = "/repos/nemarOrg/rfcs/actions/workflows/rfc-clock.yml";
const RUNS_PATH = `${WORKFLOW_PATH}/runs`;
const RUN_URL = "https://github.com/nemarOrg/rfcs/actions/runs/42";

let calls: Call[] = [];
let readme: Responder;
let workflow: Responder;
let runs: Responder;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const call: Call = {
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.get("authorization"),
      userAgent: req.headers.get("user-agent"),
      accept: req.headers.get("accept"),
    };
    calls.push(call);
    if (url.pathname === README_PATH) return readme(call);
    if (url.pathname === WORKFLOW_PATH) return workflow(call);
    if (url.pathname === RUNS_PATH) return runs(call);
    return Response.json({ message: "Not Found" }, { status: 404 });
  },
});
const priorApi = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;

beforeAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  openneuro.stop();
  rawMirror.stop();
  server.stop(true);
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = priorApi;
});

const text =
  (body: string, status = 200): Responder =>
  () =>
    new Response(body, { status });
const json =
  (body: unknown, status = 200): Responder =>
  () =>
    Response.json(body, { status });

/** The workflow's newest run, `ago` before `at`. */
function runAnswer(at: Date, ago: number, conclusion: string | null = "success"): Responder {
  return json({
    total_count: 1,
    workflow_runs: [
      {
        created_at: new Date(at.getTime() - ago).toISOString(),
        conclusion,
        html_url: RUN_URL,
      },
    ],
  });
}

beforeEach(() => {
  calls = [];
  openneuro.reset();
  rawMirror.reset();
  readme = text(readmeWith("No RFC has been proposed yet."));
  workflow = json({ state: "active" });
  runs = runAnswer(NOW, 13 * HOUR);
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const HEADER =
  "| Number | Title | Scope | Opened (UTC) | Closes (UTC) | Decision | Thread |\n| --- | --- | --- | --- | --- | --- | --- |";

const minute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}:00Z`;

interface Row {
  number: number;
  title?: string;
  scope?: string;
  opened: string | null;
  closes: string | null;
  decision: string;
}

/** A row the way `generateIndex` in nemarOrg/rfcs writes it. */
function row(r: Row): string {
  const thread =
    r.opened === null ? "-" : `[thread](https://github.com/nemarOrg/rfcs/discussions/${r.number})`;
  const num = String(r.number).padStart(4, "0");
  return `| [${num}](text/${num}-x.md) | ${r.title ?? "A title"} | ${r.scope ?? "org"} | ${r.opened ?? "-"} | ${r.closes ?? "-"} | ${r.decision} | ${thread} |`;
}

function readmeWith(index: string): string {
  return `# NEMAR Requests for Comment\n\nProse.\n\n${RFC_INDEX_START}\n${index}\n${RFC_INDEX_END}\n\n## Contents\n`;
}

const table = (...rows: Row[]): string => [HEADER, ...rows.map(row)].join("\n");

/** An RFC opened 5 days before `at` with a 21-day window: it closes 16 days after `at`. */
function openRfc(number: number, title = "Dataset versions", at = NOW): Row {
  const opened = at.getTime() - 5 * DAY;
  return {
    number,
    title,
    opened: minute(opened),
    closes: minute(opened + 21 * DAY),
    decision: "pending",
  };
}

/** An RFC that closed 9 days before `at`: its decision is due 5 days after `at`. */
function closedRfc(number: number, title = "Citing datasets", at = NOW): Row {
  const opened = at.getTime() - 30 * DAY;
  return {
    number,
    title,
    opened: minute(opened),
    closes: minute(opened + 21 * DAY),
    decision: "pending",
  };
}

function coverageResult(): ImportCoverageSweepResult {
  return {
    applied: false,
    status: "healthy",
    kind: null,
    reason: "nothing outstanding",
    enabled: true,
    lastDispatchAt: "2026-11-16 01:00:00",
    dispatchAgeHours: 2,
    lastDispatchSourceId: "ds000001",
    dispatchLost: false,
    discovered: 766,
    imported: 764,
    importedInScan: 760,
    importedNotInScan: 4,
    inFlight: 0,
    terminal: 0,
    backlog: { neverAttempted: [], untracked: [], tracked: [], blocklisted: [] },
    issue: null,
    errors: [],
  };
}

function envFor(db: Database): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    OPENNEURO_GRAPHQL_URL: openneuro.url,
    GITHUB_RAW_BASE: rawMirror.base,
    GITHUB_ADMIN_PAT: "weekly-rfc-test-pat",
  } as unknown as Bindings;
}

/** The report, produced the way the admin route produces it (a dry run). */
async function report(
  now: Date = NOW,
  token: WeeklySummaryDeps["token"] = async () => "app-token",
) {
  const r = await runWeeklyImportSummary(
    envFor(freshDb()),
    { now },
    { token, listOpenIssues: async () => [], coverage: async () => coverageResult() },
  );
  if (r.facts === null) throw new Error("the report gathered nothing");
  return { ...r, facts: r.facts, body: r.renderedBody ?? "" };
}

/** The RFC clock's section of the body, up to the next heading. */
function sectionOf(body: string): string {
  const start = body.indexOf("## RFC clock");
  if (start === -1) return "";
  const rest = body.slice(start + 3);
  const next = rest.search(/^## /m);
  return next === -1 ? body.slice(start) : body.slice(start, start + 3 + next);
}

/** The reasons of the shared rule that concern the RFC clock. */
const rfcProblems = (facts: Parameters<typeof weeklyAttention>[0]): string[] =>
  weeklyAttention(facts).problems.filter((p) => /RFC/.test(p));

const rfcErrors = (facts: { errors: { stage: string; error: string }[] }) =>
  facts.errors.filter((e) => e.stage === "rfcs");

// ----------------------------------------------------------------------------
// The list
// ----------------------------------------------------------------------------

describe("the RFCs open or awaiting a decision", () => {
  test("an open RFC is listed with its close instant and asks for nothing", async () => {
    readme = text(readmeWith(table(openRfc(1))));
    const r = await report();
    const close = minute(NOW.getTime() + 16 * DAY);
    expect(sectionOf(r.body)).toContain(`| 0001 | \`Dataset versions\` | open, closes ${close} |`);
    expect(sectionOf(r.body)).toContain("RFCs open or closed and awaiting a decision: 1.");
    expect(r.facts.rfcs?.attention).toEqual([]);
    expect(rfcProblems(r.facts)).toEqual([]);
    expect(rfcErrors(r.facts)).toEqual([]);
  });

  test("a closed RFC is listed with the date its decision is due", async () => {
    readme = text(readmeWith(table(closedRfc(2))));
    const r = await report();
    const close = minute(NOW.getTime() - 9 * DAY);
    const due = minute(NOW.getTime() + 5 * DAY);
    expect(sectionOf(r.body)).toContain(
      `| 0002 | \`Citing datasets\` | closed ${close}, decision due by ${due} |`,
    );
    // Before the due date a closed RFC is awaited, not late.
    expect(r.facts.rfcs?.attention).toEqual([]);
  });

  test("a closed RFC needs attention once its due date has passed", async () => {
    const closed = closedRfc(2);
    readme = text(readmeWith(table(closed)));
    const due = Date.parse(closed.closes as string) + 14 * DAY;

    const before = new Date(due - HOUR);
    runs = runAnswer(before, 13 * HOUR);
    expect((await report(before)).facts.rfcs?.attention).toEqual([]);

    const after = new Date(due + HOUR);
    runs = runAnswer(after, 13 * HOUR);
    const r = await report(after);
    expect(r.facts.rfcs?.attention).toEqual([
      `RFC 0002 is past its decision due date (${minute(due)}) with no decision`,
    ]);
    expect(rfcProblems(r.facts)).toHaveLength(1);
    expect(weeklyHeadline(r.facts).attention).toBe(true);
    expect(weeklyHeadline(r.facts).line).toContain("RFC 0002 is past its decision due date");
  });

  test("a draft and a decided or withdrawn RFC are not listed, and are counted in one line", async () => {
    readme = text(
      readmeWith(
        table(
          {
            number: 1,
            title: "Accepted one",
            opened: "2026-01-05T14:00:00Z",
            closes: "2026-01-26T14:00:00Z",
            decision: "accepted",
          },
          {
            number: 2,
            title: "Rejected one",
            opened: "2026-02-05T14:00:00Z",
            closes: "2026-02-26T14:00:00Z",
            decision: "rejected",
          },
          {
            number: 3,
            title: "Withdrawn one",
            opened: "2026-03-05T14:00:00Z",
            closes: "2026-03-26T14:00:00Z",
            decision: "withdrawn",
          },
          { number: 4, title: "Draft one", opened: null, closes: null, decision: "draft" },
          openRfc(5, "Pending one"),
        ),
      ),
    );
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("| 0005 | `Pending one` |");
    for (const unlisted of ["Accepted one", "Rejected one", "Withdrawn one", "Draft one"]) {
      expect(section).not.toContain(unlisted);
    }
    expect(section).toContain("RFCs open or closed and awaiting a decision: 1.");
    expect(section).toContain("Not listed: 1 draft(s) and 3 decided or withdrawn.");
    expect(r.facts.rfcs?.attention).toEqual([]);
  });

  test("the empty index is a true zero with no attention", async () => {
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("RFCs open or closed and awaiting a decision: 0.");
    expect(section).toContain("Not listed: 0 draft(s) and 0 decided or withdrawn.");
    expect(section).not.toContain("unknown");
    expect(r.facts.rfcs?.index).toEqual({ listed: [], drafts: 0, decided: 0 });
    expect(r.facts.rfcs?.attention).toEqual([]);
    expect(rfcProblems(r.facts)).toEqual([]);
    expect(rfcErrors(r.facts)).toEqual([]);
  });

  test("a title is printed inside a code span, with nothing in it that could break out", async () => {
    const hostile =
      "Ask @nemarOrg/admins about #12 `now` \\| <b>x</b> [y](http://e.x) https://evil.example www.evil.example *bold* _it_ ~~s~~ &amp; !img \\ back";
    readme = text(readmeWith(table(openRfc(1, hostile))));
    const r = await report();
    const line = sectionOf(r.body)
      .split("\n")
      .find((l) => l.startsWith("| 0001 |"));
    expect(line).toBeDefined();
    // Four cells, the title the second, wrapped in exactly one pair of backticks.
    const cells = (line as string).split("|");
    expect(cells).toHaveLength(5);
    const title = (cells[2] as string).trim();
    expect(title.startsWith("`")).toBe(true);
    expect(title.endsWith("`")).toBe(true);
    expect(title.slice(1, -1)).not.toContain("`");
    expect(title).not.toContain("@");
    expect(title).not.toContain("<");
    expect(title).not.toContain("#12");
    expect(rfcReportTitle("a".repeat(300)).length).toBeLessThanOrEqual(123);
  });
});

// ----------------------------------------------------------------------------
// The clock
// ----------------------------------------------------------------------------

describe("the clock line", () => {
  test("an active workflow with a recent success is stated and asks for nothing", async () => {
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("The `rfc-clock` workflow is `active`.");
    expect(section).toContain(
      `Newest \`rfc-clock\` run: ${minute(NOW.getTime() - 13 * HOUR).slice(0, 16)} UTC, **success** ([run](${RUN_URL}))`,
    );
    expect(r.facts.rfcs?.attention).toEqual([]);
  });

  test("a workflow GitHub switched off for inactivity needs attention", async () => {
    workflow = json({ state: "disabled_inactivity" });
    const r = await report();
    expect(r.facts.rfcs?.workflow).toEqual({ state: "disabled_inactivity" });
    expect(r.facts.rfcs?.attention).toEqual([
      "the RFC clock workflow is not active (disabled_inactivity)",
    ]);
    expect(sectionOf(r.body)).toContain("**`disabled_inactivity`**, not active");
    expect(weeklyHeadline(r.facts).attention).toBe(true);
    expect(weeklyHeadline(r.facts).line).toContain("not active (disabled_inactivity)");
  });

  test("a newest run older than 48 hours needs attention, and one inside 48 hours does not", async () => {
    runs = runAnswer(NOW, 49 * HOUR);
    const stale = await report();
    expect(stale.facts.rfcs?.attention).toEqual(["the RFC clock last ran more than 48 hours ago"]);
    expect(rfcProblems(stale.facts)).toEqual(["the RFC clock last ran more than 48 hours ago"]);

    runs = runAnswer(NOW, 47 * HOUR);
    expect((await report()).facts.rfcs?.attention).toEqual([]);
  });

  test("a workflow that has never run needs attention", async () => {
    runs = json({ total_count: 0, workflow_runs: [] });
    const r = await report();
    expect(r.facts.rfcs?.run).toEqual({ latest: null });
    expect(r.facts.rfcs?.attention).toEqual(["the RFC clock has no recorded run"]);
    expect(sectionOf(r.body)).toContain("`rfc-clock` has **no recorded run**.");
  });

  test("a newest run that failed needs attention", async () => {
    runs = runAnswer(NOW, 13 * HOUR, "failure");
    const r = await report();
    expect(r.facts.rfcs?.attention).toEqual(["the last RFC clock run failed"]);
    expect(sectionOf(r.body)).toContain("**failure**");
  });

  test.each(["timed_out", "startup_failure", "cancelled", "action_required", "neutral", "stale"])(
    "a newest run that ended %s needs attention",
    async (conclusion) => {
      runs = runAnswer(NOW, 13 * HOUR, conclusion);
      const r = await report();
      expect(r.facts.rfcs?.attention).toEqual([
        `the last RFC clock run did not succeed (${conclusion})`,
      ]);
      expect(rfcProblems(r.facts)).toHaveLength(1);
      expect(weeklyHeadline(r.facts).attention).toBe(true);
    },
  );

  test("a conclusion of a shape this report does not know is not a success", async () => {
    runs = runAnswer(NOW, 13 * HOUR, "Weird Value!");
    const r = await report();
    expect(r.facts.rfcs?.run?.latest?.conclusion).toBe("unreadable");
    expect(r.facts.rfcs?.attention).toEqual([
      "the last RFC clock run did not succeed (unreadable)",
    ]);
  });

  test("a skipped run is not a failure", async () => {
    runs = runAnswer(NOW, 13 * HOUR, "skipped");
    expect((await report()).facts.rfcs?.attention).toEqual([]);
  });

  test("a run link that is not a run of nemarOrg/rfcs is not printed", async () => {
    for (const bad of [
      "https://evil.example/nemarOrg/rfcs/actions/runs/1",
      "https://github.com/nemarOrg/rfcs/actions/runs/1/../../x",
      "https://github.com/nemarOrg/rfcs/actions/runs/abc",
      "https://github.com/nemarOrg/other/actions/runs/1",
    ]) {
      runs = json({
        workflow_runs: [
          {
            created_at: new Date(NOW.getTime() - HOUR).toISOString(),
            conclusion: "success",
            html_url: bad,
          },
        ],
      });
      const r = await report();
      expect(r.facts.rfcs?.run?.latest?.url).toBeNull();
      expect(sectionOf(r.body)).not.toContain("evil.example");
      expect(sectionOf(r.body)).not.toContain("([run]");
    }
  });

  test("a run that has not ended is not a failure", async () => {
    runs = runAnswer(NOW, 1 * HOUR, null);
    const r = await report();
    expect(r.facts.rfcs?.attention).toEqual([]);
    expect(sectionOf(r.body)).toContain("not ended");
  });
});

// ----------------------------------------------------------------------------
// A read that fails is unknown, never zero
// ----------------------------------------------------------------------------

describe("a read that fails", () => {
  test("a 500 on the README renders unknown, adds an rfcs error and needs attention", async () => {
    readme = text("boom", 500);
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("**unknown**, not zero");
    expect(section).not.toContain("awaiting a decision: 0");
    expect(r.facts.rfcs?.index).toBeNull();
    expect(rfcErrors(r.facts)).toHaveLength(1);
    expect(rfcErrors(r.facts)[0]?.error).toContain("answered 500");
    expect(r.body).toContain("- `rfcs`: RFC list:");
    expect(r.facts.rfcs?.attention).toEqual(["the list of RFCs could not be read"]);
    expect(rfcProblems(r.facts)).toContain("the list of RFCs could not be read");
    expect(weeklyHeadline(r.facts).attention).toBe(true);
    // The clock half is read independently and still reports.
    expect(section).toContain("The `rfc-clock` workflow is `active`.");
  });

  test("a README without the markers is a failed read, never an empty list", async () => {
    readme = text("# NEMAR Requests for Comment\n\nNo markers here.\n");
    const r = await report();
    expect(r.facts.rfcs?.index).toBeNull();
    expect(sectionOf(r.body)).toContain("**unknown**, not zero");
    expect(sectionOf(r.body)).not.toContain("awaiting a decision: 0");
    expect(rfcErrors(r.facts)).toHaveLength(1);
    expect(rfcErrors(r.facts)[0]?.error).toContain("markers");
    expect(rfcProblems(r.facts)).toContain("the list of RFCs could not be read");
  });

  test("markers out of order, a foreign table and an unreadable row are failed reads", () => {
    const now = NOW;
    expect(() => parseRfcIndex(`${RFC_INDEX_END}\nx\n${RFC_INDEX_START}`, now)).toThrow();
    expect(() => parseRfcIndex(readmeWith("| A | B |\n| --- | --- |\n| 1 | 2 |"), now)).toThrow(
      "columns",
    );
    expect(() => parseRfcIndex(readmeWith(HEADER), now)).toThrow("no rows");
    expect(() => parseRfcIndex(readmeWith("Some other sentence."), now)).toThrow();
    expect(() => parseRfcIndex(readmeWith(`${HEADER}\n| only | two |`), now)).toThrow("row");
    expect(() =>
      parseRfcIndex(readmeWith(table({ ...openRfc(1), decision: "maybe" })), now),
    ).toThrow("decision");
    expect(() =>
      parseRfcIndex(readmeWith(table({ ...openRfc(1), closes: "next week" })), now),
    ).toThrow("close instants");
    expect(() =>
      parseRfcIndex(readmeWith(table(openRfc(1), openRfc(1, "Same number"))), now),
    ).toThrow("unique");
  });

  test("a table the parser cannot read reaches the report as unknown", async () => {
    readme = text(readmeWith(`${HEADER}\n| not | a | record |`));
    const r = await report();
    expect(r.facts.rfcs?.index).toBeNull();
    expect(rfcErrors(r.facts)).toHaveLength(1);
    expect(rfcProblems(r.facts)).toContain("the list of RFCs could not be read");
  });

  test("a failed workflow read and a failed runs read are each their own unknown", async () => {
    workflow = text("nope", 500);
    runs = text("nope", 503);
    const r = await report();
    expect(r.facts.rfcs?.workflow).toBeNull();
    expect(r.facts.rfcs?.run).toBeNull();
    expect(rfcErrors(r.facts)).toHaveLength(2);
    expect(r.facts.rfcs?.attention).toEqual([
      "the state of the RFC clock workflow could not be read",
      "the last run of the RFC clock could not be read",
    ]);
    expect(sectionOf(r.body)).toContain("whether GitHub still has it enabled is **unknown**");
    expect(sectionOf(r.body)).toContain("could not be read: **unknown**");
  });

  test("an answer of an unexpected shape is a failed read", async () => {
    workflow = json({ state: 7 });
    runs = json({ workflow_runs: [{ created_at: "yesterday" }] });
    const r = await report();
    expect(r.facts.rfcs?.workflow).toBeNull();
    expect(r.facts.rfcs?.run).toBeNull();
    expect(rfcErrors(r.facts)).toHaveLength(2);
  });

  test("an unknown clock is a reason of the shared rule, as every other unknown is", () => {
    const base = {
      week: "2026-W46",
      coverageStatus: "healthy" as const,
      autoImportEnabled: true,
      dispatchLost: false,
      issuesClosed: 0,
      errors: [],
    };
    expect(weeklyAttention({ ...base, rfcs: null }).problems).toContain(
      "the RFC clock could not be determined",
    );
    expect(weeklyAttention(base).problems).toContain("the RFC clock could not be determined");
    expect(
      weeklyAttention({ ...base, rfcs: { attention: ["the last RFC clock run failed"] } }).problems,
    ).toContain("the last RFC clock run failed");
    expect(weeklyAttention({ ...base, rfcs: { attention: [] } }).problems).not.toContain(
      "the RFC clock could not be determined",
    );
  });
});

// ----------------------------------------------------------------------------
// The token
// ----------------------------------------------------------------------------

describe("the token", () => {
  test("every read names itself and offers the token first", async () => {
    await report();
    expect(calls.map((c) => c.path)).toEqual([
      README_PATH,
      WORKFLOW_PATH,
      `${RUNS_PATH}?per_page=1`,
    ]);
    for (const c of calls) {
      expect(c.authorization).toBe("Bearer app-token");
      expect(c.userAgent).toBe("nemar-weekly-report");
    }
    expect(calls[0]?.accept).toBe("application/vnd.github.raw");
  });

  test("a 403 with the token followed by a 200 without it gives the section", async () => {
    const answer = text(readmeWith(table(openRfc(1))));
    readme = (call) =>
      call.authorization === null ? answer(call) : new Response("forbidden", { status: 403 });
    const r = await report();
    const readmeCalls = calls.filter((c) => c.path === README_PATH);
    expect(readmeCalls.map((c) => c.authorization)).toEqual(["Bearer app-token", null]);
    expect(r.facts.rfcs?.index?.listed).toHaveLength(1);
    expect(sectionOf(r.body)).toContain("| 0001 | `Dataset versions` | open, closes");
    expect(rfcErrors(r.facts)).toEqual([]);
  });

  test("a 401 and a 404 with the token are retried without it too", async () => {
    workflow = (call) =>
      call.authorization === null
        ? Response.json({ state: "active" })
        : new Response("", { status: 401 });
    runs = (call) =>
      call.authorization === null
        ? runAnswer(NOW, 13 * HOUR)(call)
        : new Response("", { status: 404 });
    const r = await report();
    expect(calls.filter((c) => c.path === WORKFLOW_PATH).map((c) => c.authorization)).toEqual([
      "Bearer app-token",
      null,
    ]);
    expect(r.facts.rfcs?.workflow).toEqual({ state: "active" });
    expect(r.facts.rfcs?.run?.latest?.conclusion).toBe("success");
    expect(rfcErrors(r.facts)).toEqual([]);
  });

  test("a refusal that the anonymous retry also meets is a failed read", async () => {
    readme = text("forbidden", 403);
    const r = await report();
    expect(calls.filter((c) => c.path === README_PATH)).toHaveLength(2);
    expect(r.facts.rfcs?.index).toBeNull();
    expect(rfcErrors(r.facts)[0]?.error).toContain("answered 403");
  });

  test("a refusal because the rate limit is spent says so", async () => {
    readme = () =>
      new Response("limit", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const r = await report();
    expect(rfcErrors(r.facts)[0]?.error).toContain("answered 403 (rate limited)");
    // A 403 that is not a spent limit does not claim it.
    readme = text("forbidden", 403);
    const plain = await report();
    expect(rfcErrors(plain.facts)[0]?.error).not.toContain("rate limited");
  });

  test("a 500 is not retried", async () => {
    readme = text("boom", 500);
    await report();
    expect(calls.filter((c) => c.path === README_PATH)).toHaveLength(1);
  });

  test("a token function that throws still has the reads made, without a token", async () => {
    readme = text(readmeWith(table(openRfc(1))));
    const r = await report(NOW, async () => {
      throw new Error("no installation token");
    });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.authorization).toBeNull();
    expect(r.facts.rfcs?.index?.listed).toHaveLength(1);
    expect(r.facts.rfcs?.workflow).toEqual({ state: "active" });
    expect(rfcErrors(r.facts)).toEqual([]);
    // The failure to mint a token is not an RFC fact and is not printed as one.
    expect(r.body).not.toContain("no installation token");
  });
});

// ----------------------------------------------------------------------------
// The report as a whole
// ----------------------------------------------------------------------------

describe("the section in the report", () => {
  test("it arrives every week, between the re-pulls and the dispatch liveness", async () => {
    const r = await report();
    const at = r.body.indexOf("## RFC clock");
    expect(at).toBeGreaterThan(r.body.indexOf("## Upstream re-pulls"));
    expect(at).toBeLessThan(r.body.indexOf("## Dispatch liveness"));
  });

  test("the log line carries the list and the clock, and prints no title", async () => {
    readme = text(readmeWith(table(openRfc(1, "A private-sounding title"))));
    const r = await report();
    const line = weeklySummaryLogLine(r.facts, null);
    expect(line).toContain("rfc_listed=1");
    expect(line).toContain("rfc_clock=active");
    expect(line).not.toContain("private-sounding");
  });

  test("a failed README leaves the log line saying unknown", async () => {
    readme = text("boom", 500);
    const r = await report();
    expect(weeklySummaryLogLine(r.facts, null)).toContain("rfc_listed=unknown");
  });
});
