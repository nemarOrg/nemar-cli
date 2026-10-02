/**
 * The Neurobagel verification sweep, through its entry point (epic #1586, phase 6; ADR 0067's
 * amendment).
 *
 * REAL ENGINES. A D1 carrying every production migration, the R2 simulator `wrangler dev` runs,
 * the real writer (for the store a writer actually produced), and three REAL LOCAL HTTP SERVERS
 * standing where the network is: the private node, the public federation, and GitHub's public
 * API. Their answers are recordings of the real services (`fixtures/neurobagel-verify/`,
 * `test/fixtures/neurobagel-node/`, each with its provenance); where a test needs a state the
 * real service was not in (an upstream that has moved, a registered node, a served deposit) it
 * changes ONE value of a parsed copy and says so. Nothing replaces the sweep's own logic.
 *
 * The assertions that matter are about what CANNOT happen:
 *   - an alarm without outstanding work, or a healthy that is really "could not look";
 *   - a check that is not configured reading as healthy;
 *   - a heartbeat that stops when the sweep throws;
 *   - any write other than the heartbeat (and the one audit row of an anonymity-class case);
 *   - a dataset named in anything a person reads, when it may be an anonymous deposit.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  NeurobagelCheckName,
  NeurobagelVerifyResult,
} from "../../shared/contract/neurobagel-admin";
import { datasetName, nbIdentifier } from "../../shared/neurobagel/identifiers";
import { VOCAB } from "../../shared/neurobagel/vocab";
import { NEUROBAGEL_PLAN_ROWS_SQL } from "../src/services/neurobagel-plan";
import {
  ARTIFACT_KINDS,
  META,
  NEUROBAGEL_INDEX_KEY,
  artifactName,
  buildIndexDocument,
  listStore,
  serializeIndex,
  sha256OfBytes,
} from "../src/services/neurobagel-store";
import {
  type VerifyOptions,
  runNeurobagelVerificationSweep,
  runNeurobagelVerificationSweepCron,
} from "../src/services/neurobagel-verify";
import { runNeurobagelWriter } from "../src/services/neurobagel-writer";
import type { Bindings } from "../src/types/bindings";
import { realD1, wrapD1 } from "./helpers/d1";
import {
  type Harness,
  seedDatasetRow,
  seedSynthetic,
  startHarness,
} from "./helpers/neurobagel-harness";
import { withFakeResend } from "./helpers/resend";

const ROOT = join(import.meta.dir, "../..");
const VERIFY_FIXTURES = join(import.meta.dir, "fixtures/neurobagel-verify");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const fixture = (name: string): unknown => readJson(join(VERIFY_FIXTURES, name));

/** The node's real answer to the empty datasets query, 21 datasets. */
const NODE_DATASETS = readJson(
  join(ROOT, "test/fixtures/neurobagel-node/node-datasets-goldens.json"),
) as Record<string, unknown>[];
const SERVED_IDS = NODE_DATASETS.map((d) => (d.homepage as string).split("/").pop() as string);
const NODES = fixture("federation-nodes.json") as Record<string, unknown>[];
const DIAGNOSES = fixture("federation-diagnoses.json") as {
  errors: { node_name: string; error: string }[];
};
const GITHUB: Record<string, unknown> = {
  "/repos/neurobagel/api/releases/latest": fixture("github-release-api.json"),
  "/repos/neurobagel/federation-api/releases/latest": fixture("github-release-federation-api.json"),
  "/repos/neurobagel/query-tool/releases/latest": fixture("github-release-query-tool.json"),
  "/repos/neurobagel/communities/contents/configs/Neurobagel": fixture(
    "github-contents-communities-configs.json",
  ),
  "/repos/neurobagel/communities/contents/config_metadata": fixture(
    "github-contents-communities-config-metadata.json",
  ),
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Seen {
  method: string;
  path: string;
  body: string;
  userAgent: string | null;
  authorization: string | null;
}
const seen: Seen[] = [];
/** What each local server answers; reset before every test. */
const world: {
  node: () => Response | Promise<Response>;
  nodes: () => Response | Promise<Response>;
  diagnoses: () => Response | Promise<Response>;
  github: (path: string) => Response | Promise<Response>;
} = {
  node: () => json(NODE_DATASETS),
  nodes: () => json(NODES),
  diagnoses: () => json(DIAGNOSES, 207),
  github: (path) => (path in GITHUB ? json(GITHUB[path]) : new Response("{}", { status: 404 })),
};
function resetWorld(): void {
  world.node = () => json(NODE_DATASETS);
  world.nodes = () => json(NODES);
  world.diagnoses = () => json(DIAGNOSES, 207);
  world.github = (path) =>
    path in GITHUB ? json(GITHUB[path]) : new Response("{}", { status: 404 });
}

let h: Harness;
let server: ReturnType<typeof Bun.serve>;
const base = (): string => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        body: await req.text(),
        userAgent: req.headers.get("user-agent"),
        authorization: req.headers.get("authorization"),
      });
      if (url.pathname === "/node/datasets" && req.method === "POST") return world.node();
      if (url.pathname === "/fed/nodes") return world.nodes();
      if (url.pathname === "/fed/diagnoses") return world.diagnoses();
      if (url.pathname.startsWith("/gh/")) return world.github(url.pathname.slice("/gh".length));
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_NEUROBAGEL_UPSTREAM_URL?: string }).NEMAR_NEUROBAGEL_UPSTREAM_URL =
    `${base()}/gh`;
  h = await startHarness();
});
afterAll(async () => {
  (globalThis as { NEMAR_NEUROBAGEL_UPSTREAM_URL?: string }).NEMAR_NEUROBAGEL_UPSTREAM_URL =
    undefined;
  await h.dispose();
  server.stop(true);
});
beforeEach(async () => {
  await h.reset();
  resetWorld();
  seen.length = 0;
});

const realConsoleError = console.error;
afterEach(() => {
  console.error = realConsoleError;
});
/** The sweep logs a failed check at error level; keep a deliberate failure out of the test output. */
function muteErrors(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  return lines;
}

const NODE_URL = () => `${base()}/node`;
const FED_URL = () => `${base()}/fed`;

function sweep(
  over: Partial<Bindings> = {},
  opts: VerifyOptions = {},
): Promise<NeurobagelVerifyResult> {
  return runNeurobagelVerificationSweep(h.env(over), {
    trigger: "admin",
    timeoutMs: 4000,
    ...opts,
  });
}
const verdictOf = (r: NeurobagelVerifyResult, check: NeurobagelCheckName) =>
  r.checks[check].verdict;

function seedEligible(ids: string[]): void {
  for (const id of ids) seedDatasetRow(h.db, id);
}

/**
 * Artifacts as a writer would leave them, and the index the store's own code builds from the
 * listing: the test stands in for the WRITER (it puts the bytes), never for the index logic.
 */
async function plantStore(ids: string[], indexed: string[] = ids): Promise<void> {
  for (const id of ids) {
    for (const kind of ARTIFACT_KINDS) {
      const bytes = new TextEncoder().encode(JSON.stringify({ id, kind }));
      await h.bucket.put(artifactName(id, kind), bytes, {
        customMetadata: {
          [META.sha256]: await sha256OfBytes(bytes),
          [META.kind]: kind,
          ...(kind === "jsonld" ? { [META.fingerprint]: `sha256:${"0".repeat(64)}` } : {}),
        },
      });
    }
  }
  const listing = await listStore(h.bucket);
  const built = await buildIndexDocument(listing, new Set(indexed), null, new Date().toISOString());
  await h.bucket.put(NEUROBAGEL_INDEX_KEY, serializeIndex(built.document));
}

async function bucketState(): Promise<string> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await h.bucket.list({ cursor });
    for (const o of listed.objects) out.push(`${o.key}@${o.etag}`);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out.sort().join("\n");
}

function catalogState(): string {
  const tables = ["datasets", "dataset_versions", "users", "tokens"];
  return JSON.stringify(tables.map((t) => h.db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
}

function auditRows(
  action?: string,
): { action: string; resource_id: string | null; details: string | null; timestamp: string }[] {
  return h.db
    .query(
      `SELECT action, resource_id, details, timestamp FROM audit_log ${action ? "WHERE action = ?" : ""} ORDER BY id`,
    )
    .all(...(action ? [action] : [])) as never;
}

/** A real writer run for a dataset, so the store holds what the writer produced. */
async function writerRan(id: string): Promise<void> {
  seedSynthetic(h, id);
  const run = await runNeurobagelWriter(h.env(), { trigger: "admin", execute: true });
  expect(run.status).toBe("ok");
  expect(run.results.map((r) => r.outcome)).toEqual(["written"]);
}

// ----------------------------------------------------------------------------
// The store, against the predicate
// ----------------------------------------------------------------------------

describe("the store check", () => {
  test("a store the real writer produced is healthy, and the sweep changed nothing but its heartbeat", async () => {
    await writerRan("nm000800");
    const bucketBefore = await bucketState();
    const catalogBefore = catalogState();
    const auditBefore = auditRows().map((r) => r.action);

    const r = await sweep();

    expect(verdictOf(r, "store")).toBe("healthy");
    expect(r.checks.store.counts).toMatchObject({
      eligible: 1,
      written: 1,
      index_entries: 1,
      missing: 0,
      residue: 0,
    });
    // REPORTS, NEVER REPAIRS: the bucket (every key and etag), the catalog and the users are
    // byte for byte what they were, and the audit log gained exactly the heartbeat.
    expect(await bucketState()).toBe(bucketBefore);
    expect(catalogState()).toBe(catalogBefore);
    expect(auditRows().map((x) => x.action)).toEqual([...auditBefore, "neurobagel_verification"]);
  });

  test("nothing eligible and nothing stored is healthy: an empty store is not an alarm", async () => {
    const r = await sweep();
    expect(verdictOf(r, "store")).toBe("healthy");
    expect(r.checks.store.counts).toMatchObject({
      eligible: 0,
      written: 0,
      residue: 0,
      missing: 0,
    });
  });

  test("no bucket, and a writer that is off, are unchecked: the store is not judged, and neither is healthy", async () => {
    seedEligible(["nm000801"]);
    const noBucket = await sweep({ NEUROBAGEL: undefined });
    expect(verdictOf(noBucket, "store")).toBe("unchecked");
    const off = await sweep({ NEUROBAGEL_WRITER_ENABLED: undefined });
    expect(verdictOf(off, "store")).toBe("unchecked");
    // An eligible dataset missing from a store nobody maintains is not "outstanding work".
    expect(off.checks.store.reason).toMatch(/writer is off/);
  });

  test("residue is first seen as healthy, and an alarm when it is still there a day later", async () => {
    // nm000802 is eligible and written; nm000803 was written, then went private.
    seedEligible(["nm000802"]);
    seedDatasetRow(h.db, "nm000803", { visibility: "private" });
    await plantStore(["nm000802", "nm000803"]);

    const day0 = new Date();
    const first = await sweep({}, { now: day0 });
    expect(verdictOf(first, "store")).toBe("healthy");
    expect(first.checks.store.counts).toMatchObject({ residue: 1, residue_persisting: 0 });

    // An on-demand run an hour later is not "a day later": the writer's daily reconcile has not
    // had a chance, and an alarm here would fire after every takedown.
    const hour = await sweep({}, { now: new Date(day0.getTime() + 3_600_000) });
    expect(verdictOf(hour, "store")).toBe("healthy");
    expect(hour.checks.store.counts.residue_persisting).toBe(0);

    const day1 = await sweep({}, { now: new Date(day0.getTime() + 24 * 3_600_000) });
    expect(verdictOf(day1, "store")).toBe("alarm");
    expect(day1.checks.store.counts).toMatchObject({ residue: 1, residue_persisting: 1 });
  });

  test("residue the writer removed in between is healthy the next day", async () => {
    seedEligible(["nm000802"]);
    seedDatasetRow(h.db, "nm000803", { visibility: "private" });
    await plantStore(["nm000802", "nm000803"]);
    const day0 = new Date();
    expect(verdictOf(await sweep({}, { now: day0 }), "store")).toBe("healthy");
    // The writer's removal: artifacts first (the test acts as the writer), then the index.
    for (const kind of ARTIFACT_KINDS) await h.bucket.delete(artifactName("nm000803", kind));
    const listing = await listStore(h.bucket);
    await h.bucket.put(
      NEUROBAGEL_INDEX_KEY,
      serializeIndex(
        (await buildIndexDocument(listing, new Set(["nm000802"]), null, day0.toISOString()))
          .document,
      ),
    );
    const day1 = await sweep({}, { now: new Date(day0.getTime() + 24 * 3_600_000) });
    expect(verdictOf(day1, "store")).toBe("healthy");
    expect(day1.checks.store.counts.residue).toBe(0);
  });

  test("an index entry for a dataset that is no longer eligible is residue, even with no artifacts behind it", async () => {
    seedEligible(["nm000802"]);
    seedDatasetRow(h.db, "nm000803", { visibility: "private" });
    await plantStore(["nm000802", "nm000803"]);
    for (const kind of ARTIFACT_KINDS) await h.bucket.delete(artifactName("nm000803", kind));
    // The index still lists nm000803.
    const r = await sweep();
    expect(r.checks.store.counts.residue).toBe(1);
  });

  test("an eligible dataset missing from the store is an alarm only after 48 hours", async () => {
    const now = new Date();
    const old = (ms: number) =>
      new Date(now.getTime() - ms).toISOString().slice(0, 19).replace("T", " ");
    // The writer has been running for a month, so the clock starts at publication.
    h.db
      .query(
        "INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp) VALUES ('neurobagel_run', 'neurobagel', 'cron', '{}', ?)",
      )
      .run(old(30 * 24 * 3_600_000));
    seedDatasetRow(h.db, "nm000804", { firstPublishedAt: old(47 * 3_600_000) });
    const young = await sweep({}, { now });
    expect(verdictOf(young, "store")).toBe("healthy");
    expect(young.checks.store.counts).toMatchObject({ missing: 1, missing_overdue: 0 });

    seedDatasetRow(h.db, "nm000805", { firstPublishedAt: old(49 * 3_600_000) });
    const overdue = await sweep({}, { now });
    expect(verdictOf(overdue, "store")).toBe("alarm");
    expect(overdue.checks.store.counts).toMatchObject({ missing: 2, missing_overdue: 1 });
  });

  test("artifacts without an index entry, and an index entry without all three artifacts, are each missing", async () => {
    const now = new Date();
    const old = (ms: number) =>
      new Date(now.getTime() - ms).toISOString().slice(0, 19).replace("T", " ");
    h.db
      .query(
        "INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp) VALUES ('neurobagel_run', 'neurobagel', 'cron', '{}', ?)",
      )
      .run(old(30 * 24 * 3_600_000));
    // nm000808: all three artifacts, and an index that does not list it.
    seedDatasetRow(h.db, "nm000808", { firstPublishedAt: "2026-01-01 00:00:00" });
    await plantStore(["nm000808"], []);
    // nm000809: the index lists it, but only the JSON-LD is stored.
    seedDatasetRow(h.db, "nm000809", { firstPublishedAt: "2026-01-01 00:00:00" });
    await plantStore(["nm000809"], ["nm000809"]);
    for (const kind of ["dictionary", "description"] as const) {
      await h.bucket.delete(artifactName("nm000809", kind));
    }
    const r = await sweep({}, { now });
    expect(r.checks.store.counts).toMatchObject({
      eligible: 2,
      written: 0,
      missing: 2,
      missing_overdue: 2,
    });
    expect(verdictOf(r, "store")).toBe("alarm");
  });

  test("a writer that was only just switched on gets 48 hours from its first run, however old the datasets are", async () => {
    const now = new Date();
    const old = (ms: number) =>
      new Date(now.getTime() - ms).toISOString().slice(0, 19).replace("T", " ");
    seedDatasetRow(h.db, "nm000806", { firstPublishedAt: "2025-01-01 00:00:00" });
    h.db
      .query(
        "INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp) VALUES ('neurobagel_run', 'neurobagel', 'cron', '{}', ?)",
      )
      .run(old(3_600_000));
    expect(verdictOf(await sweep({}, { now }), "store")).toBe("healthy");
    const later = await sweep({}, { now: new Date(now.getTime() + 49 * 3_600_000) });
    expect(verdictOf(later, "store")).toBe("alarm");
  });

  test("a writer that is enabled and NEVER runs still ages: the first sweep remembers when it began to wait", async () => {
    seedDatasetRow(h.db, "nm000807", { firstPublishedAt: "2025-01-01 00:00:00" });
    const day0 = new Date();
    const first = await sweep({}, { now: day0 });
    expect(verdictOf(first, "store")).toBe("healthy");
    const stored = JSON.parse(auditRows("neurobagel_verification")[0]?.details ?? "{}");
    expect(stored.memory.origin).toBe(day0.toISOString());
    const day3 = await sweep({}, { now: new Date(day0.getTime() + 3 * 24 * 3_600_000) });
    expect(verdictOf(day3, "store")).toBe("alarm");
  });

  test("a listing that fails is unknown, the heartbeat is still written, and nothing is reported as absent", async () => {
    seedEligible(["nm000802"]);
    await plantStore(["nm000802"]);
    const failing = new Proxy(h.bucket, {
      get(target, prop, receiver) {
        if (prop === "list") return async () => Promise.reject(new Error("R2 unavailable"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const lines = muteErrors();
    const r = await runNeurobagelVerificationSweep(h.env({ NEUROBAGEL: failing as R2Bucket }), {
      trigger: "admin",
      timeoutMs: 4000,
    });
    expect(verdictOf(r, "store")).toBe("unknown");
    expect(r.overall).not.toBe("healthy");
    expect(r.heartbeat_written).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/store: R2 unavailable/);
    expect(lines.join("\n")).toMatch(/verification check store failed/);
    expect(auditRows("neurobagel_verification")).toHaveLength(1);
  });

  test("a catalog that cannot be read makes the store and the node unknown, never healthy and never an alarm", async () => {
    seedEligible(["nm000802"]);
    await plantStore(["nm000802"]);
    const broken = wrapD1(realD1(h.db), (sql) => {
      if (sql === NEUROBAGEL_PLAN_ROWS_SQL) throw new Error("D1 down");
    });
    const r = await runNeurobagelVerificationSweep(
      h.env({ DB: broken, NEUROBAGEL_NODE_URL: NODE_URL() }),
      { trigger: "admin", timeoutMs: 4000 },
    );
    expect(verdictOf(r, "store")).toBe("unknown");
    expect(verdictOf(r, "node")).toBe("unknown");
    expect(r.warnings.join(" ")).toMatch(/D1 down/);
    expect(seen.filter((s) => s.path === "/node/datasets")).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// The node, as seen over the network
// ----------------------------------------------------------------------------

describe("the node probe", () => {
  test("with no address it is unchecked, asks nothing, and is not healthy", async () => {
    seedEligible(SERVED_IDS);
    const r = await sweep();
    expect(verdictOf(r, "node")).toBe("unchecked");
    expect(r.checks.node.reason).toMatch(/NEUROBAGEL_NODE_URL/);
    expect(seen.filter((s) => s.path.startsWith("/node"))).toEqual([]);
    // A blank address is no address.
    expect(verdictOf(await sweep({ NEUROBAGEL_NODE_URL: "   " }), "node")).toBe("unchecked");
  });

  test("the node's real answer, for datasets that are all eligible, is healthy after exactly one empty datasets query", async () => {
    seedEligible(SERVED_IDS);
    const r = await sweep({ NEUROBAGEL_NODE_URL: `${NODE_URL()}/` });
    expect(verdictOf(r, "node")).toBe("healthy");
    expect(r.checks.node.counts).toMatchObject({
      records: SERVED_IDS.length,
      invalid: 0,
      unprotected: 0,
      ineligible_served: 0,
      anonymous_served: 0,
      eligible_not_served: 0,
    });
    const asked = seen.filter((s) => s.path.startsWith("/node"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ method: "POST", path: "/node/datasets", body: "{}" });
    expect(asked[0]?.userAgent).toMatch(/^nemar-neurobagel-verify\//);
  });

  test("a served dataset that has since gone private is an alarm, counted and never named", async () => {
    seedEligible(SERVED_IDS.filter((id) => id !== "nm000103"));
    seedDatasetRow(h.db, "nm000103", { visibility: "private" });
    const r = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() });
    expect(verdictOf(r, "node")).toBe("alarm");
    expect(r.checks.node.counts).toMatchObject({ ineligible_served: 1, anonymous_served: 0 });
    expect(JSON.stringify(r)).not.toContain("nm000103");
    // And it is the NODE's finding, not a thing the sweep went and fixed.
    expect(auditRows("neurobagel_verify_anonymity_finding")).toEqual([]);
  });

  test("a served record that is an anonymous deposit's is an alarm recorded in the audit log, with no mail and nothing sent to GitHub", async () => {
    // nm099998 is the anonymous negative control (AGENTS.md): public row, anonymous, never published.
    seedEligible(SERVED_IDS);
    seedDatasetRow(h.db, "nm099998", { anonymous: 1, firstPublishedAt: null });
    const iri = `${VOCAB.namespaces.nb}${(await nbIdentifier(datasetName("nm099998"))).slice(3)}`;
    // The real answer with one more record: a copy of a real one under the deposit's identifier.
    const withDeposit = [...NODE_DATASETS, { ...NODE_DATASETS[0], dataset_uuid: iri }];
    world.node = () => json(withDeposit);

    const calls = await withFakeResend(async (mail) => {
      const r = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL(), RESEND_API_KEY: "re_test" });
      expect(verdictOf(r, "node")).toBe("alarm");
      expect(r.checks.node.counts).toMatchObject({ ineligible_served: 1, anonymous_served: 1 });
      expect(r.checks.node.reason).toMatch(/anonymity-class/);
      // Nothing a person reads names the deposit or its identifier.
      expect(JSON.stringify(r)).not.toContain("nm099998");
      expect(JSON.stringify(r)).not.toContain(iri.slice(-36));
      for (const row of auditRows("neurobagel_verification")) {
        expect(row.details).not.toContain("nm099998");
        expect(row.details).not.toContain(iri.slice(-36));
      }
      return mail;
    });
    // The audit log, and nowhere else: one row, naming the dataset, with a check code only.
    const rows = auditRows("neurobagel_verify_anonymity_finding");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe("nm099998");
    expect(JSON.parse(rows[0]?.details ?? "{}")).toEqual({ check: "node_serves_anonymous_record" });
    expect(calls).toEqual([]);
    // Every request this sweep made to the stand-in for GitHub was a plain, unauthenticated GET.
    const github = seen.filter((s) => s.path.startsWith("/gh/"));
    expect(github.length).toBeGreaterThan(0);
    expect(github.every((s) => s.method === "GET" && s.authorization === null)).toBe(true);
    expect(github.some((s) => /issues|dispatches|pulls/.test(s.path))).toBe(false);
  });

  test("a record that does not validate is an alarm: one bad record can take the whole federation down", async () => {
    seedEligible(SERVED_IDS);
    const broken = NODE_DATASETS.map((d, i) => {
      if (i !== 3) return d;
      const { dataset_name: _gone, ...rest } = d;
      return rest;
    });
    world.node = () => json(broken);
    const r = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() });
    expect(verdictOf(r, "node")).toBe("alarm");
    expect(r.checks.node.counts.invalid).toBe(1);
    expect(r.checks.node.reason).toMatch(/do not validate/);
  });

  test("a record that is not protected is an alarm", async () => {
    seedEligible(SERVED_IDS);
    world.node = () =>
      json(NODE_DATASETS.map((d, i) => (i === 0 ? { ...d, records_protected: false } : d)));
    const r = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() });
    expect(verdictOf(r, "node")).toBe("alarm");
    expect(r.checks.node.counts.unprotected).toBe(1);
  });

  test("an answer that is not a list is an alarm; an empty list over eligible datasets is healthy and says what is waiting", async () => {
    seedEligible(SERVED_IDS);
    world.node = () => json({ detail: "something else" });
    expect(verdictOf(await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() }), "node")).toBe("alarm");
    world.node = () => json([]);
    const empty = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() });
    expect(verdictOf(empty, "node")).toBe("healthy");
    expect(empty.checks.node.counts.eligible_not_served).toBe(SERVED_IDS.length);
    expect(empty.checks.node.reason).toMatch(/not served yet/);
  });

  test("an empty node with nothing eligible is healthy", async () => {
    world.node = () => json([]);
    expect(verdictOf(await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() }), "node")).toBe("healthy");
  });

  test("a node that cannot be asked is unknown in every way it can fail, and never an alarm or healthy", async () => {
    seedEligible(SERVED_IDS);
    const cases: [string, () => Response | Promise<Response>, RegExp][] = [
      ["an HTTP 500", () => new Response("{}", { status: 500 }), /HTTP 500/],
      ["a body that is not JSON", () => new Response("<html>", { status: 200 }), /not JSON/],
      [
        "an answer that outlasts the timeout",
        async () => {
          await Bun.sleep(600);
          return json(NODE_DATASETS);
        },
        /timed out/,
      ],
    ];
    for (const [label, answer, why] of cases) {
      world.node = answer;
      const r = await sweep({ NEUROBAGEL_NODE_URL: NODE_URL() }, { timeoutMs: 150 });
      expect(verdictOf(r, "node"), label).toBe("unknown");
      expect(r.checks.node.reason, label).toMatch(why);
    }
    // Nothing is listening at all.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);
    const refused = await sweep({ NEUROBAGEL_NODE_URL: `http://127.0.0.1:${port}` });
    expect(verdictOf(refused, "node")).toBe("unknown");
    expect(refused.checks.node.reason).toMatch(/network error/);
  });
});

// ----------------------------------------------------------------------------
// Registration with the public federation
// ----------------------------------------------------------------------------

describe("the registration check", () => {
  const withNemar = () => [...NODES, { NodeName: "NEMAR", ApiURL: "https://node.example.org/" }];

  test("with no address it is unchecked and asks nothing", async () => {
    const r = await sweep();
    expect(verdictOf(r, "registration")).toBe("unchecked");
    expect(r.checks.registration.reason).toMatch(/NEUROBAGEL_FEDERATION_URL/);
    expect(seen.filter((s) => s.path.startsWith("/fed"))).toEqual([]);
  });

  test("the real directory does not list NEMAR: an alarm, found with one request", async () => {
    const r = await sweep({ NEUROBAGEL_FEDERATION_URL: `${FED_URL()}/` });
    expect(verdictOf(r, "registration")).toBe("alarm");
    expect(r.checks.registration.counts).toMatchObject({
      nemar_listed: 0,
      nodes_listed: NODES.length,
    });
    expect(
      seen.filter((s) => s.path.startsWith("/fed")).map((s) => `${s.method} ${s.path}`),
    ).toEqual(["GET /fed/nodes"]);
  });

  test("listed, with the real diagnoses (HTTP 207, naming other nodes) is healthy", async () => {
    world.nodes = () => json(withNemar());
    const r = await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() });
    expect(verdictOf(r, "registration")).toBe("healthy");
    expect(r.checks.registration.counts).toMatchObject({ nemar_listed: 1, nemar_errors: 0 });
    expect(seen.filter((s) => s.path.startsWith("/fed")).map((s) => s.path)).toEqual([
      "/fed/nodes",
      "/fed/diagnoses",
    ]);
  });

  test("listed but reported in the diagnoses' errors is an alarm", async () => {
    world.nodes = () => json(withNemar());
    world.diagnoses = () =>
      json(
        {
          ...DIAGNOSES,
          errors: [...DIAGNOSES.errors, { node_name: "NEMAR", error: "unreachable" }],
        },
        207,
      );
    const r = await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() });
    expect(verdictOf(r, "registration")).toBe("alarm");
    expect(r.checks.registration.counts.nemar_errors).toBe(1);
  });

  test("a federation that cannot be read is unknown at each step, never an alarm and never healthy", async () => {
    world.nodes = () => new Response("{}", { status: 503 });
    const down = await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() });
    expect(verdictOf(down, "registration")).toBe("unknown");

    world.nodes = () => json(withNemar());
    world.diagnoses = () => new Response("{}", { status: 502 });
    const noDiagnoses = await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() });
    expect(verdictOf(noDiagnoses, "registration")).toBe("unknown");

    world.diagnoses = () => json({ responses: {} });
    const noErrorList = await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() });
    expect(verdictOf(noErrorList, "registration")).toBe("unknown");

    world.nodes = () => json({ not: "a list" });
    expect(verdictOf(await sweep({ NEUROBAGEL_FEDERATION_URL: FED_URL() }), "registration")).toBe(
      "unknown",
    );
  });
});

// ----------------------------------------------------------------------------
// Upstream drift
// ----------------------------------------------------------------------------

describe("the upstream drift check", () => {
  const changed = (path: string, edit: (body: Record<string, unknown>) => unknown) => {
    const real = GITHUB[path];
    world.github = (p) => {
      if (p !== path) return path in GITHUB ? json(GITHUB[p]) : new Response("{}", { status: 404 });
      return json(edit(JSON.parse(JSON.stringify(real))));
    };
  };

  test("against the real recordings, which equal the pins, nothing has drifted: five plain GETs", async () => {
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("healthy");
    expect(r.checks.drift.counts).toEqual({ checked: 3 + 6, drifted: 0, reads_failed: 0 });
    const asked = seen.filter((s) => s.path.startsWith("/gh/"));
    expect(asked.map((s) => `${s.method} ${s.path}`).sort()).toEqual([
      "GET /gh/repos/neurobagel/api/releases/latest",
      "GET /gh/repos/neurobagel/communities/contents/config_metadata",
      "GET /gh/repos/neurobagel/communities/contents/configs/Neurobagel",
      "GET /gh/repos/neurobagel/federation-api/releases/latest",
      "GET /gh/repos/neurobagel/query-tool/releases/latest",
    ]);
    for (const s of asked) {
      expect(s.userAgent).toMatch(/^nemar-neurobagel-verify\//);
      expect(s.authorization).toBeNull();
      expect(s.body).toBe("");
    }
  });

  test("a release tag that has moved is an alarm naming the pin and the new tag", async () => {
    changed("/repos/neurobagel/api/releases/latest", (b) => ({ ...b, tag_name: "v0.12.0" }));
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("alarm");
    expect(r.checks.drift.reason).toContain("node API v0.11.0 -> v0.12.0");
    expect(r.checks.drift.counts.drifted).toBe(1);
  });

  test("a pinned vocabulary file whose blob has changed, or is gone, is an alarm", async () => {
    changed("/repos/neurobagel/communities/contents/configs/Neurobagel", (b) =>
      (b as unknown as { path: string; sha: string }[]).map((e) =>
        e.path === "configs/Neurobagel/diagnosis.json" ? { ...e, sha: "0".repeat(40) } : e,
      ),
    );
    const moved = await sweep();
    expect(verdictOf(moved, "drift")).toBe("alarm");
    expect(moved.checks.drift.reason).toContain("configs/Neurobagel/diagnosis.json changed");

    changed("/repos/neurobagel/communities/contents/config_metadata", () => []);
    const gone = await sweep();
    expect(verdictOf(gone, "drift")).toBe("alarm");
    expect(gone.checks.drift.reason).toContain(
      "config_metadata/config_namespace_map.json is gone upstream",
    );
  });

  test("a rate limit is unknown and says so: not an alarm, and not 'no drift'", async () => {
    world.github = (p) =>
      p.includes("query-tool")
        ? new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
        : json(GITHUB[p]);
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("unknown");
    expect(r.checks.drift.reason).toMatch(/query tool release \(rate limited\)/);
    expect(r.checks.drift.reason).toMatch(/not "no drift"/);
    expect(r.checks.drift.counts).toMatchObject({ drifted: 0, reads_failed: 1 });
  });

  test("known drift survives a failed read elsewhere: an alarm that says how many reads failed", async () => {
    world.github = (p) => {
      if (p.includes("federation-api")) return new Response("{}", { status: 500 });
      if (p.endsWith("/api/releases/latest")) {
        return json({ ...(GITHUB[p] as object), tag_name: "v9.9.9" });
      }
      return json(GITHUB[p]);
    };
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("alarm");
    expect(r.checks.drift.reason).toMatch(/1 read\(s\) failed/);
  });

  test("when GitHub cannot be reached at all the verdict is unknown, never healthy", async () => {
    world.github = () => new Response("down", { status: 503 });
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("unknown");
    expect(r.checks.drift.counts).toMatchObject({ checked: 0, reads_failed: 5 });
    expect(r.overall).toBe("unknown");
  });

  test("an answer without a tag, or a listing that is not a listing, is a failed read", async () => {
    changed("/repos/neurobagel/api/releases/latest", () => ({ message: "no tag here" }));
    expect(verdictOf(await sweep(), "drift")).toBe("unknown");
    resetWorld();
    changed("/repos/neurobagel/communities/contents/configs/Neurobagel", () => ({ type: "file" }));
    const r = await sweep();
    expect(verdictOf(r, "drift")).toBe("unknown");
    expect(r.checks.drift.reason).toMatch(/not a directory listing/);
  });
});

// ----------------------------------------------------------------------------
// The run
// ----------------------------------------------------------------------------

describe("the run and its heartbeat", () => {
  test("the heartbeat is written even when the sweep itself throws, as unknown in every check and a logged failure", async () => {
    const lines = muteErrors();
    const opts = {
      trigger: "cron",
      get timeoutMs(): number {
        throw new Error("boom");
      },
    } as unknown as VerifyOptions;
    const r = await runNeurobagelVerificationSweep(h.env(), opts);
    expect(r.failed).toBe(true);
    expect(r.error).toBe("boom");
    expect(r.overall).toBe("unknown");
    for (const c of ["store", "node", "registration", "drift"] as const) {
      expect(verdictOf(r, c)).toBe("unknown");
    }
    expect(r.heartbeat_written).toBe(true);
    expect(lines.join("\n")).toMatch(/verification sweep failed/);
    const rows = auditRows("neurobagel_verification");
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0]?.details ?? "{}");
    expect(stored).toMatchObject({
      failed: true,
      error: "boom",
      overall: "unknown",
      trigger: "cron",
    });
  });

  test("a heartbeat that cannot be written is reported, and the sweep still answers", async () => {
    const lines = muteErrors();
    const noAudit = wrapD1(realD1(h.db), (sql) => {
      if (/INSERT INTO audit_log/.test(sql)) throw new Error("audit insert refused");
    });
    const r = await runNeurobagelVerificationSweep(h.env({ DB: noAudit }), {
      trigger: "admin",
      timeoutMs: 4000,
    });
    expect(r.heartbeat_written).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/heartbeat could not be written: audit insert refused/);
    expect(lines.join("\n")).toMatch(/heartbeat failed/);
    expect(auditRows("neurobagel_verification")).toEqual([]);
    expect(r.checks.drift.verdict).toBe("healthy");
  });

  test("a run that names no trigger is an on-demand one: it is never the daily job's evidence of being alive", async () => {
    // The weekly report counts only `cron` rows, so the default must fail toward "admin".
    const r = await runNeurobagelVerificationSweep(h.env(), { timeoutMs: 4000 });
    expect(r.trigger).toBe("admin");
    expect(JSON.parse(auditRows("neurobagel_verification")[0]?.details ?? "{}").trigger).toBe(
      "admin",
    );
  });

  test("every run writes one heartbeat, with its trigger, whatever the verdicts", async () => {
    await sweep();
    await sweep({}, { trigger: "cron" });
    const rows = auditRows("neurobagel_verification");
    expect(rows.map((r) => JSON.parse(r.details ?? "{}").trigger)).toEqual(["admin", "cron"]);
    expect(rows.map((r) => r.resource_id)).toEqual(["admin", "cron"]);
  });

  test("a sweep that runs every check and finds everything fine is healthy overall; one with an alarm is not", async () => {
    seedEligible(SERVED_IDS);
    await plantStore(SERVED_IDS);
    world.nodes = () =>
      json([...NODES, { NodeName: "NEMAR", ApiURL: "https://node.example.org/" }]);
    const ok = await sweep({
      NEUROBAGEL_NODE_URL: NODE_URL(),
      NEUROBAGEL_FEDERATION_URL: FED_URL(),
    });
    expect(ok.overall).toBe("healthy");
    expect(Object.values(ok.checks).map((c) => c.verdict)).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "healthy",
    ]);
    world.nodes = () => json(NODES);
    const bad = await sweep({
      NEUROBAGEL_NODE_URL: NODE_URL(),
      NEUROBAGEL_FEDERATION_URL: FED_URL(),
    });
    expect(bad.overall).toBe("alarm");
  });

  test("a check that throws becomes unknown for that check alone; the others still answer", async () => {
    const lines = muteErrors();
    seedEligible(SERVED_IDS);
    // The node check reads the anonymous rows after it has the node's answer: make that read fail.
    const broken = wrapD1(realD1(h.db), (sql) => {
      if (/WHERE anonymous IS NOT 0/.test(sql)) throw new Error("anonymous read refused");
    });
    const r = await runNeurobagelVerificationSweep(
      h.env({ DB: broken, NEUROBAGEL_NODE_URL: NODE_URL() }),
      { trigger: "admin", timeoutMs: 4000 },
    );
    expect(verdictOf(r, "node")).toBe("unknown");
    expect(verdictOf(r, "drift")).toBe("healthy");
    expect(verdictOf(r, "store")).toBe("healthy");
    expect(r.failed).toBe(false);
    expect(lines.join("\n")).toMatch(/verification check node failed/);
  });

  test("the daily wrapper does nothing outside production, and runs as the daily job inside it", async () => {
    const skipped = await runNeurobagelVerificationSweepCron(h.env({ ENVIRONMENT: "staging" }));
    expect(skipped).toBeNull();
    expect(auditRows()).toEqual([]);
    expect(seen).toEqual([]);

    const ran = await runNeurobagelVerificationSweepCron(h.env({ ENVIRONMENT: "production" }));
    expect(ran?.trigger).toBe("cron");
    expect(ran?.heartbeat_written).toBe(true);
    expect(auditRows("neurobagel_verification")).toHaveLength(1);
  });

  test("the sweep sends no mail from a worker that holds a live mail key, and writes no bucket object", async () => {
    seedEligible(["nm000802"]);
    await plantStore(["nm000802"]);
    seedDatasetRow(h.db, "nm000803", { visibility: "private" });
    await plantStore(["nm000803"], ["nm000802", "nm000803"]);
    const before = await bucketState();
    const mail = await withFakeResend(async (calls) => {
      await sweep(
        { ENVIRONMENT: "production", RESEND_API_KEY: "re_live_key" },
        { now: new Date(Date.now() + 24 * 3_600_000) },
      );
      await sweep(
        { ENVIRONMENT: "production", RESEND_API_KEY: "re_live_key" },
        { now: new Date(Date.now() + 48 * 3_600_000) },
      );
      return calls;
    });
    expect(mail).toEqual([]);
    expect(await bucketState()).toBe(before);
  });
});
