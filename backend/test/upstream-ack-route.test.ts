/**
 * `POST /admin/publish/acknowledge-batch` (epic #2182, card D3; ADR 0086, amendment 2026-11-25).
 *
 * The real admin router over an in-memory D1, a local GitHub stand-in answering the head check and
 * the repository files, and the registries' RECORDED responses (test/fixtures/license-lineage/;
 * provenance in its README). Any other host is refused and noted, so a test that passed by reaching
 * the real network would fail here. The exclusions are the real D2 measurement the route bundles;
 * the dataset ids below are chosen from it (measured, or excluded, or absent), and no request
 * leaves this machine.
 *
 * The command's paging (`src/lib/upstream-ack-batch.ts`) is driven against this same route.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type ScreenReport, parseScreenReport } from "../../shared/identifier-screen-report";
import { DEFAULT_BASES } from "../../shared/license-lineage";
import type { AckBatchRequest, AckBatchResponse, AckResult } from "../../shared/upstream-ack";
import { applyEligible, dryRun, parseIdsFile } from "../../src/lib/upstream-ack-batch";
import { type StandIn, startStandIn } from "../../test/fixtures/license-lineage/stand-in";
import { adminRoutes } from "../src/routes/admin";
import { screenStateGate } from "../src/services/identifier-screen";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  dropStandInAppToken,
  seedStandInAppToken,
} from "./helpers/github-rulesets";
import { seedScreenedRequest, seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "upstream-ack-admin-key-0123456789abcdef0123456789ab";
const OTHER_KEY = "upstream-ack-other-key-0123456789abcdef0123456789ab";
const MEMBER_KEY = "upstream-ack-member-key-0123456789abcdef012345678";
const TOKEN = "ghs_upstream_ack_test";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "fedcba9876543210fedcba9876543210fedcba98";

// Measured by D2 and not excluded, unless named otherwise.
const ELIGIBLE = "nm000331";
const EXCLUDED = "nm000427"; // D2: a photo-face file.
const LOCAL_PATH = "nm000332";
const DIRECT = "nm000333";
const UNRESOLVED = "nm000337";
const NEEDS_PERMISSION = "nm000366";
const STALE = "nm000378";
const UNMEASURED = "nm000999"; // Not in D2's measurement.
const IMAGES = "nm000391";

const OPENNEURO_CC0 = JSON.stringify({
  Name: "x",
  License: "CC0",
  SourceDatasets: [{ DOI: "10.18112/openneuro.ds003645.v2.0.2" }],
});

/** Repository files and `main` heads, per repository. */
const repoFiles = new Map<string, Record<string, string>>();
const heads = new Map<string, string>();
const githubServer = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const ref = /^\/repos\/nemarDatasets\/([^/]+)\/git\/ref\/heads\/main$/.exec(path);
    if (ref) return Response.json({ object: { sha: heads.get(ref[1]) ?? HEAD } });
    const m = /^\/repos\/nemarDatasets\/([^/]+)\/contents\/(.+)$/.exec(path);
    const content = m ? repoFiles.get(m[1])?.[decodeURIComponent(m[2])] : undefined;
    if (content === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
  },
});

let registries: StandIn;
const refused: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://localhost:${githubServer.port}`;
  seedStandInAppToken(TOKEN);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    for (const [name, base] of Object.entries(DEFAULT_BASES)) {
      if (url.origin === new URL(base).origin) {
        const target = `${registries.bases[name as keyof typeof DEFAULT_BASES]}${url.pathname}${url.search}`;
        return realFetch(new Request(target, req));
      }
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(req);
    refused.push(url.hostname);
    return Promise.reject(new Error(`this test file does not reach ${url.hostname}`));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  dropStandInAppToken();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  githubServer.stop(true);
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let otherAdminId: number;
let d1: D1Database;
const requestIds = new Map<string, number>();

/** A report the production parser accepts. */
function report(
  datasetId: string,
  status: string,
  o: { kinds?: Record<string, number>; head?: string; edf?: number } = {},
): ScreenReport {
  const edf = o.edf ?? (status === "not-screened" ? 0 : 4);
  return parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: o.head ?? HEAD,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-11-20T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 40, edf_bdf: edf, header_read: edf, header_read_failed: 0 },
      ...(o.kinds ? { findings_by_kind: o.kinds } : {}),
      unscreened_formats: { ".set": 12, ".fdt": 12 },
    },
  });
}

function setScreen(datasetId: string, r: ScreenReport): void {
  db.run(
    `UPDATE publication_requests SET identifier_screen_status = ?, identifier_screen_report = ?
      WHERE id = ?`,
    [r.scan?.status ?? "error", JSON.stringify(r), requestIds.get(datasetId) as number],
  );
}

function seed(datasetId: string, r: ScreenReport, files: Record<string, string> = {}): void {
  const { requestId } = seedScreenedRequest(db, { datasetId });
  requestIds.set(datasetId, requestId);
  setScreen(datasetId, r);
  repoFiles.set(datasetId, { "dataset_description.json": OPENNEURO_CC0, ...files });
}

beforeEach(async () => {
  registries = startStandIn();
  refused.length = 0;
  repoFiles.clear();
  heads.clear();
  requestIds.clear();
  db = freshDb();
  d1 = realD1(db);
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser(db, "ack-admin", "admin", ADMIN_KEY);
  otherAdminId = await seedUser(db, "ack-other", "admin", OTHER_KEY);
  await seedUser(db, "ack-member", "member", MEMBER_KEY);

  seed(ELIGIBLE, report(ELIGIBLE, "not-screened"));
  seed(IMAGES, report(IMAGES, "review", { kinds: { "image-or-document-file": 7 } }));
  seed(EXCLUDED, report(EXCLUDED, "review", { kinds: { "image-or-document-file": 7 } }));
  seed(
    LOCAL_PATH,
    report(LOCAL_PATH, "review", { kinds: { "image-or-document-file": 2, "local-user-path": 1 } }),
  );
  seed(DIRECT, report(DIRECT, "direct-identifiers", { kinds: { "edf-patient-name": 2 } }));
  seed(UNRESOLVED, report(UNRESOLVED, "not-screened"));
  repoFiles.set(UNRESOLVED, {}); // No dataset_description.json: the lineage is unresolved.
  seed(NEEDS_PERMISSION, report(NEEDS_PERMISSION, "not-screened"), {
    "dataset_description.json": JSON.stringify({
      Name: "x",
      License: "CC0",
      SourceDatasets: [{ DOI: "10.5281/zenodo.21156617" }],
    }),
  });
  seed(STALE, report(STALE, "not-screened"));
  heads.set(STALE, MOVED);
  seed(UNMEASURED, report(UNMEASURED, "not-screened"));
});

afterEach(() => {
  registries.stop();
  expect(refused).toEqual([]);
});

function env(): Bindings {
  return { DB: d1, ENVIRONMENT: "test", ...REVIEW_APP_BINDINGS } as Bindings;
}

async function post(body: unknown, key = ADMIN_KEY) {
  const res = await app.request(
    "/admin/publish/acknowledge-batch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "X-CLI-Version": "99.0.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as AckBatchResponse & { error?: string } };
}

/** The command's transport, over the real route. */
const send =
  (key = ADMIN_KEY) =>
  async (body: AckBatchRequest): Promise<AckBatchResponse> => {
    const r = await post(body, key);
    if (r.status !== 200) throw new Error(`route answered ${r.status}`);
    return r.body;
  };

function byId(results: AckResult[]): Record<string, string> {
  return Object.fromEntries(results.map((r) => [r.dataset_id, r.outcome]));
}

function ackRow(datasetId: string) {
  return db
    .query<
      {
        identifier_screen_ack_by: number | null;
        identifier_screen_ack_reason: string | null;
        identifier_screen_ack_at: string | null;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
        status: string;
      },
      [number]
    >(
      `SELECT identifier_screen_ack_by, identifier_screen_ack_reason, identifier_screen_ack_at,
              identifier_screen_status, identifier_screen_report, status
         FROM publication_requests WHERE id = ?`,
    )
    .get(requestIds.get(datasetId) as number);
}

function auditRows() {
  return db
    .query<{ user_id: number; resource_id: string; details: string }, []>(
      "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'identifier_screen_acknowledged' ORDER BY id",
    )
    .all();
}

describe("dry run", () => {
  test("reports each request's outcome and records nothing", async () => {
    const before = db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    const { status, body } = await post({ all_requested: true });
    expect(status).toBe(200);
    expect(body.apply).toBe(false);
    expect(body.next).toBeNull();
    expect(byId(body.results)).toEqual({
      [ELIGIBLE]: "eligible",
      [LOCAL_PATH]: "not_eligible:finding_kind",
      [DIRECT]: "not_eligible:screen_state",
      [UNRESOLVED]: "not_eligible:lineage_outcome",
      [NEEDS_PERMISSION]: "not_eligible:lineage_outcome",
      [STALE]: "not_eligible:screen_stale",
      [IMAGES]: "eligible",
      [EXCLUDED]: "not_eligible:excluded",
      [UNMEASURED]: "not_eligible:not_measured",
    });
    const unresolved = body.results.find((r) => r.dataset_id === UNRESOLVED);
    expect(unresolved?.lineage_outcome).toBe("unresolved");
    const needs = body.results.find((r) => r.dataset_id === NEEDS_PERMISSION);
    expect(needs?.lineage_outcome).toBe("needs_permission");
    const eligible = body.results.find((r) => r.dataset_id === ELIGIBLE);
    expect(eligible?.reason).toContain(
      "public-upstream: same recordings as 10.18112/openneuro.ds003645.v2.0.2 (cc0 1.0, read from openneuro); not read by NEMAR: .fdt, .set;",
    );
    expect(eligible?.screen_head).toBe(HEAD);

    // Nothing recorded: no acknowledgment and no audit row.
    for (const id of requestIds.keys()) expect(ackRow(id)?.identifier_screen_ack_at).toBeNull();
    const after = db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(registries.misses).toEqual([]);
  });

  test("pages all_requested by dataset id; dataset_ids reports an unknown dataset", async () => {
    const first = await post({ all_requested: true, limit: 4 });
    expect(first.body.results).toHaveLength(4);
    expect(first.body.next).toBe(first.body.results[3].dataset_id);
    const second = await post({ all_requested: true, limit: 4, after: first.body.next });
    expect(second.body.results[0].dataset_id > (first.body.next as string)).toBe(true);

    const named = await post({ dataset_ids: [ELIGIBLE, "nm000100"] });
    expect(byId(named.body.results)).toEqual({
      [ELIGIBLE]: "eligible",
      nm000100: "not_eligible:no_request",
    });
  });

  test("a request that is not awaiting an administrator is not eligible", async () => {
    db.run("UPDATE publication_requests SET status = 'blocked' WHERE id = ?", [
      requestIds.get(ELIGIBLE) as number,
    ]);
    const { body } = await post({ dataset_ids: [ELIGIBLE] });
    expect(byId(body.results)).toEqual({ [ELIGIBLE]: "not_eligible:not_requested" });
  });
});

describe("apply", () => {
  test("records the caller's acknowledgment with the reason shown, and audits the lineage", async () => {
    const dry = await dryRun(send(), { ids: [ELIGIBLE, IMAGES, LOCAL_PATH, DIRECT] });
    const applied = await applyEligible(send(), dry);
    expect(byId(applied)).toEqual({ [ELIGIBLE]: "acknowledged", [IMAGES]: "acknowledged" });

    for (const id of [ELIGIBLE, IMAGES]) {
      const row = ackRow(id);
      expect(row?.identifier_screen_ack_by).toBe(adminId);
      const shown = dry.find((r) => r.dataset_id === id)?.reason;
      expect(row?.identifier_screen_ack_reason).toBe(shown as string);
      expect((row?.identifier_screen_ack_reason as string).length).toBeLessThanOrEqual(500);
      expect(row?.status).toBe("requested"); // Nothing was approved.
    }
    expect(ackRow(IMAGES)?.identifier_screen_ack_reason).toContain("images/documents acknowledged");
    // The ineligible ones were never sent, and nothing was recorded for them.
    for (const id of [LOCAL_PATH, DIRECT]) expect(ackRow(id)?.identifier_screen_ack_at).toBeNull();

    const audits = auditRows();
    expect(audits.map((a) => [a.user_id, a.resource_id])).toEqual([
      [adminId, ELIGIBLE],
      [adminId, IMAGES],
    ]);
    const details = JSON.parse(audits[0].details);
    expect(details.via).toBe("acknowledge-batch");
    expect(details.lineage.outcome).toBe("compatible");
    expect(details.lineage.sources[0].id).toBe("10.18112/openneuro.ds003645.v2.0.2");
    expect(details.lineage.sources[0].resolver).toBe("openneuro");
    expect(details.reason).toBe(ackRow(ELIGIBLE)?.identifier_screen_ack_reason);
  });

  test("the acknowledgment satisfies the gate for the same administrator, not another", async () => {
    const dry = await dryRun(send(), { ids: [ELIGIBLE] });
    await applyEligible(send(), dry);
    const row = {
      ...(ackRow(ELIGIBLE) as NonNullable<ReturnType<typeof ackRow>>),
    };
    // The approval gate reads these columns; `identifier_screen_needs_acknowledgment` is the
    // review's name for its `acknowledge` answer.
    const gateRow = {
      identifier_screen_status: row.identifier_screen_status,
      identifier_screen_report: row.identifier_screen_report,
      identifier_screen_ack_at: row.identifier_screen_ack_at,
      identifier_screen_ack_by: row.identifier_screen_ack_by,
    };
    expect(screenStateGate(ELIGIBLE, gateRow, false, adminId)).toEqual({ ok: true });
    const other = screenStateGate(ELIGIBLE, gateRow, false, otherAdminId);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.refusal.gate).toBe("acknowledge");

    // And through the review the CLI reads: the same request still lists the reason, now with the
    // acknowledgment it can be cleared by, naming the recording administrator.
    const res = await app.request(
      `/admin/publish/${ELIGIBLE}/review`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
      { ...env(), PUBLICATION_REVIEW_ENABLED: "1" } as Bindings,
    );
    const detail = (await res.json()) as {
      reasons: Array<{ code: string }>;
      screen_acknowledgment: { by: number } | null;
    };
    expect(detail.reasons.map((r) => r.code)).toContain("identifier_screen_needs_acknowledgment");
    expect(detail.screen_acknowledgment?.by).toBe(adminId);

    // A second batch by another administrator does not overwrite it.
    const again = await dryRun(send(OTHER_KEY), { ids: [ELIGIBLE] });
    expect(byId(again)).toEqual({ [ELIGIBLE]: "not_eligible:already_acknowledged" });
  });

  test("a screen that moved between the dry run and the apply gives state_moved", async () => {
    const dry = await dryRun(send(), { ids: [ELIGIBLE, IMAGES] });
    // The screen ran again at a new commit after the dry run.
    setScreen(ELIGIBLE, report(ELIGIBLE, "not-screened", { head: MOVED }));
    heads.set(ELIGIBLE, MOVED);
    const applied = await applyEligible(send(), dry);
    expect(byId(applied)).toEqual({ [ELIGIBLE]: "state_moved", [IMAGES]: "acknowledged" });
    expect(ackRow(ELIGIBLE)?.identifier_screen_ack_at).toBeNull();
    expect(auditRows().map((a) => a.resource_id)).toEqual([IMAGES]);
  });

  test("a report rewritten between the read and the write gives state_moved", async () => {
    const dry = await dryRun(send(), { ids: [ELIGIBLE] });
    // Land a new report, same state and commit, exactly between the route's read and its write.
    const rewritten = JSON.stringify(
      report(ELIGIBLE, "not-screened", { kinds: { "image-or-document-file": 1 } }),
    );
    d1 = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("SET identifier_screen_ack_by")) {
        db.run("UPDATE publication_requests SET identifier_screen_report = ? WHERE id = ?", [
          rewritten,
          requestIds.get(ELIGIBLE) as number,
        ]);
      }
    });
    const applied = await applyEligible(send(), dry);
    expect(byId(applied)).toEqual({ [ELIGIBLE]: "state_moved" });
    expect(ackRow(ELIGIBLE)?.identifier_screen_ack_at).toBeNull();
    expect(auditRows()).toEqual([]);
  });

  test("an apply re-runs the whole rule: a request excluded or ineligible is never recorded", async () => {
    // An apply that names a request the dry run did not call eligible, with its real state.
    const forged = [EXCLUDED, LOCAL_PATH, DIRECT].map((id) => ({
      dataset_id: id,
      request_id: requestIds.get(id) as number,
      screen_state: ackRow(id)?.identifier_screen_status as string,
      screen_head: HEAD,
    }));
    const { status, body } = await post({ apply: true, expect: forged });
    expect(status).toBe(200);
    expect(byId(body.results)).toEqual({
      [EXCLUDED]: "not_eligible:excluded",
      [LOCAL_PATH]: "not_eligible:finding_kind",
      [DIRECT]: "not_eligible:screen_state",
    });
    for (const id of [EXCLUDED, LOCAL_PATH, DIRECT]) {
      expect(ackRow(id)?.identifier_screen_ack_at).toBeNull();
    }
  });
});

describe("the body and the caller", () => {
  test("400 a malformed body, a batch over 100, or a mix of selections; 403 a member", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ dataset_ids: [] })).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `nm${String(i).padStart(6, "0")}`);
    expect((await post({ dataset_ids: many })).status).toBe(400);
    expect((await post({ all_requested: true, limit: 101 })).status).toBe(400);
    expect((await post({ all_requested: true, dataset_ids: [ELIGIBLE] })).status).toBe(400);
    expect((await post({ apply: true, dataset_ids: [ELIGIBLE] })).status).toBe(400);
    expect((await post({ apply: true, expect: [{ dataset_id: ELIGIBLE }] })).status).toBe(400);
    expect((await post({ dataset_ids: [ELIGIBLE], extra: 1 })).status).toBe(400);
    expect((await post({ dataset_ids: [ELIGIBLE] }, MEMBER_KEY)).status).toBe(403);
  });

  test("an --ids file: comments and blanks skipped, duplicates dropped, a bad line named", () => {
    expect(parseIdsFile(`# queue\n${ELIGIBLE}\n\n${IMAGES}  # images\n${ELIGIBLE}\n`)).toEqual([
      ELIGIBLE,
      IMAGES,
    ]);
    expect(() => parseIdsFile(`${ELIGIBLE}\nnot-an-id\n`)).toThrow("line 2");
    expect(() => parseIdsFile("# nothing\n")).toThrow();
  });
});
