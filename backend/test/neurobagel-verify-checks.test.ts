/**
 * The verification sweep's RULES (epic #1586, phase 6; ADR 0067's amendment), and the facts the
 * rules read, without a database or a network.
 *
 * Supplements, not coverage: `neurobagel-verify.test.ts` drives the sweep through its entry
 * point against a real store, a real catalog and real local servers. What lives here is what a
 * boundary needs pinned exactly: the 48-hour edge, the persistence rule, what an unconfigured
 * check may say, the worst-verdict rule, and that the pins a Worker carries are the pins the
 * deployment carries.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  NeurobagelCheckName,
  NeurobagelCheckResult,
  NeurobagelVerdict,
} from "../../shared/contract/neurobagel-admin";
import { VOCAB } from "../../shared/neurobagel/vocab";
import { TAG_PINS, vocabularyPins } from "../src/services/neurobagel-drift";
import {
  MISSING_GRACE_MS,
  NEMAR_NODE_NAME,
  PERSISTENCE_MIN_AGE_MS,
  RESIDUE_MEMORY_CAP,
  type StoreObservation,
  failedVerification,
  judgeNode,
  judgeRegistration,
  judgeStore,
  nemarListed,
  overallVerdict,
  parseHeartbeat,
  recordProblems,
} from "../src/services/neurobagel-verify";

const ROOT = join(import.meta.dir, "../..");
const NODE_DATASETS = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/neurobagel-node/node-datasets-goldens.json"), "utf8"),
) as Record<string, unknown>[];
const NODES = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/neurobagel-verify/federation-nodes.json"), "utf8"),
) as Record<string, unknown>[];
const DIAGNOSES = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/neurobagel-verify/federation-diagnoses.json"),
    "utf8",
  ),
) as { errors: { node_name: string }[] };

const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOUR = 3_600_000;
const sqlite = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

function obs(over: Partial<StoreObservation> = {}): StoreObservation {
  return {
    eligible: 10,
    written: 10,
    index_entries: 10,
    missing: [],
    residue: [],
    previousResidue: null,
    origin: new Date(NOW.getTime() - 30 * 24 * HOUR),
    ...over,
  };
}

describe("the pins a Worker carries are the pins the deployment carries", () => {
  // The Worker cannot read deploy/neurobagel/pins.env, so the tags are copied into
  // neurobagel-drift.ts. A copy nothing compares is a copy that drifts: bumping the deployment
  // would leave the sweep comparing upstream with the OLD pin and alarming for ever, or worse,
  // not alarming at the new one.
  const env = Object.fromEntries(
    readFileSync(join(ROOT, "deploy/neurobagel/pins.env"), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;
  const tagOf = (name: string): string => (env[name] ?? "").split("@")[0] as string;

  test("each pinned release tag equals the one in pins.env", () => {
    const byRepo = Object.fromEntries(TAG_PINS.map((p) => [p.repo, p.tag]));
    expect(byRepo).toEqual({
      "neurobagel/api": tagOf("NB_NAPI_TAG"),
      "neurobagel/federation-api": tagOf("NB_FAPI_TAG"),
      "neurobagel/query-tool": tagOf("NB_QUERY_TAG"),
    });
    for (const p of TAG_PINS) expect(p.tag).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("the vocabulary pins are the transform snapshot's, every file, with its blob hash", () => {
    const pins = vocabularyPins();
    expect(pins.repo).toBe("neurobagel/communities");
    expect(Object.keys(pins.files).sort()).toEqual(
      Object.keys(VOCAB.pins.communities.files).sort(),
    );
    expect(Object.keys(pins.files).length).toBeGreaterThanOrEqual(6);
    for (const [path, sha] of Object.entries(pins.files)) {
      expect(sha, path).toMatch(/^[0-9a-f]{40}$/);
      expect(sha).toBe(VOCAB.pins.communities.files[path]?.blob_sha as string);
    }
  });
});

describe("overall: the worst verdict among the checks that ran", () => {
  const checks = (v: Record<NeurobagelCheckName, NeurobagelVerdict>) =>
    Object.fromEntries(
      Object.entries(v).map(([k, verdict]) => [k, { verdict, reason: "x", counts: {} }]),
    ) as Record<NeurobagelCheckName, NeurobagelCheckResult>;
  const all = (verdict: NeurobagelVerdict) =>
    checks({ store: verdict, node: verdict, registration: verdict, drift: verdict });

  test("an alarm beats an unknown beats healthy", () => {
    expect(
      overallVerdict(
        checks({ store: "healthy", node: "unknown", registration: "alarm", drift: "healthy" }),
      ),
    ).toBe("alarm");
    expect(
      overallVerdict(
        checks({ store: "healthy", node: "unknown", registration: "unchecked", drift: "healthy" }),
      ),
    ).toBe("unknown");
    expect(overallVerdict(all("healthy"))).toBe("healthy");
  });

  test("an unchecked check neither spoils nor supplies health", () => {
    // Two checks that did not run and two that did: the overall speaks for the two that did.
    expect(
      overallVerdict(
        checks({
          store: "unchecked",
          node: "unchecked",
          registration: "healthy",
          drift: "healthy",
        }),
      ),
    ).toBe("healthy");
    // And when nothing ran it says so, rather than inventing health.
    expect(overallVerdict(all("unchecked"))).toBe("unchecked");
    expect(
      overallVerdict(
        checks({
          store: "unchecked",
          node: "unchecked",
          registration: "unchecked",
          drift: "alarm",
        }),
      ),
    ).toBe("alarm");
  });

  test("a sweep that failed outright is unknown in every check, never healthy", () => {
    const v = failedVerification(NOW, "cron", new Error("boom"));
    expect(v.failed).toBe(true);
    expect(v.overall).toBe("unknown");
    expect(Object.values(v.checks).map((c) => c.verdict)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(v.error).toBe("boom");
  });
});

describe("the store verdict", () => {
  test("nothing eligible and nothing stored is healthy, not an alarm: no work, no alarm", () => {
    const r = judgeStore(obs({ eligible: 0, written: 0, index_entries: 0 }), NOW);
    expect(r.verdict).toBe("healthy");
  });

  test("a dataset missing for exactly 48 hours is not yet an alarm; one millisecond more is", () => {
    const edge = new Date(NOW.getTime() - MISSING_GRACE_MS);
    const justOver = new Date(edge.getTime() - 1000);
    // The published time is in SQLite's shape, whole seconds: the boundary is in seconds.
    expect(judgeStore(obs({ missing: [{ published: sqlite(edge) }] }), NOW).verdict).toBe(
      "healthy",
    );
    expect(judgeStore(obs({ missing: [{ published: sqlite(justOver) }] }), NOW).verdict).toBe(
      "alarm",
    );
  });

  test("the clock cannot start before the writer did: an old publication is young against a young origin", () => {
    const oldPublication = sqlite(new Date(NOW.getTime() - 400 * 24 * HOUR));
    const recentOrigin = new Date(NOW.getTime() - 5 * HOUR);
    const r = judgeStore(
      obs({ missing: [{ published: oldPublication }], origin: recentOrigin }),
      NOW,
    );
    expect(r.verdict).toBe("healthy");
    // The same dataset against an origin 3 days old is overdue.
    const old = judgeStore(
      obs({
        missing: [{ published: oldPublication }],
        origin: new Date(NOW.getTime() - 72 * HOUR),
      }),
      NOW,
    );
    expect(old.verdict).toBe("alarm");
    expect(old.counts.missing_overdue).toBe(1);
  });

  test("a publication time that cannot be read is not shown young: it counts against the origin", () => {
    const stale = obs({
      missing: [{ published: "not a time" }],
      origin: new Date(NOW.getTime() - 72 * HOUR),
    });
    expect(judgeStore(stale, NOW).verdict).toBe("alarm");
    const fresh = obs({
      missing: [{ published: null }],
      origin: new Date(NOW.getTime() - 1 * HOUR),
    });
    expect(judgeStore(fresh, NOW).verdict).toBe("healthy");
  });

  test("residue seen for the first time is healthy; seen again a day later it is an alarm", () => {
    const first = judgeStore(obs({ residue: ["aaaa"], previousResidue: null }), NOW);
    expect(first.verdict).toBe("healthy");
    expect(first.counts.residue).toBe(1);
    expect(first.counts.residue_persisting).toBe(0);
    // Remembered, but it is a different dataset: still first seen.
    expect(
      judgeStore(obs({ residue: ["aaaa"], previousResidue: new Set(["bbbb"]) }), NOW).verdict,
    ).toBe("healthy");
    const again = judgeStore(
      obs({ residue: ["aaaa", "cccc"], previousResidue: new Set(["aaaa"]) }),
      NOW,
    );
    expect(again.verdict).toBe("alarm");
    expect(again.counts.residue_persisting).toBe(1);
  });

  test("more residue than the sweep can follow is an alarm on its own", () => {
    const many = Array.from({ length: RESIDUE_MEMORY_CAP + 1 }, (_, i) => `d${i}`);
    expect(judgeStore(obs({ residue: many }), NOW).verdict).toBe("alarm");
    expect(judgeStore(obs({ residue: many.slice(1) }), NOW).verdict).toBe("healthy");
  });

  test("no sentence of a store verdict names a dataset", () => {
    const r = judgeStore(
      obs({
        residue: ["d1", "d2"],
        previousResidue: new Set(["d1"]),
        missing: [{ published: "2020-01-01 00:00:00" }],
      }),
      NOW,
    );
    expect(r.reason).not.toMatch(/\b(nm|on)\d{6}\b/);
    expect(r.reason).not.toContain("d1");
  });

  test("the persistence age is a day, not an hour: an on-demand run does not count as the next day", () => {
    expect(PERSISTENCE_MIN_AGE_MS).toBe(20 * HOUR);
    expect(MISSING_GRACE_MS).toBe(48 * HOUR);
  });
});

describe("a node record", () => {
  test("every record of a real node answer validates", () => {
    expect(NODE_DATASETS.length).toBeGreaterThanOrEqual(20);
    for (const record of NODE_DATASETS) {
      expect(recordProblems(record), String(record.dataset_uuid)).toEqual([]);
    }
  });

  test("each field the federation's model needs is checked, and each omission is named", () => {
    const base = NODE_DATASETS[0] as Record<string, unknown>;
    const without = (k: string) => {
      const { [k]: _gone, ...rest } = base;
      return rest;
    };
    for (const field of [
      "dataset_uuid",
      "dataset_name",
      "dataset_total_subjects",
      "num_matching_subjects",
      "records_protected",
      "image_modals",
    ]) {
      expect(recordProblems(without(field)), field).toContain(field);
    }
    expect(
      recordProblems({ ...base, dataset_uuid: "http://neurobagel.org/vocab/not-a-uuid" }),
    ).toContain("dataset_uuid");
    expect(
      recordProblems({
        ...base,
        dataset_uuid: "http://elsewhere.org/10df5ae9-f7e2-58e3-b8b7-5945f79ef965",
      }),
    ).toContain("dataset_uuid");
    expect(recordProblems({ ...base, dataset_total_subjects: -1 })).toContain(
      "dataset_total_subjects",
    );
    expect(recordProblems({ ...base, dataset_total_subjects: 1.5 })).toContain(
      "dataset_total_subjects",
    );
    expect(recordProblems({ ...base, image_modals: [null] })).toContain("image_modals");
    expect(recordProblems({ ...base, access_email: "someone@example.org" })).toContain(
      "access_email",
    );
    expect(recordProblems("a string")).toEqual(["not an object"]);
    expect(recordProblems(null)).toEqual(["not an object"]);
    expect(recordProblems([])).toEqual(["not an object"]);
  });

  test("an unprotected record is counted apart from an invalid one", () => {
    const iris = new Set(NODE_DATASETS.map((d) => d.dataset_uuid as string));
    const tampered = NODE_DATASETS.map((d, i) =>
      i === 0 ? { ...d, records_protected: false } : d,
    );
    const { result } = judgeNode({ records: tampered, eligible: iris, anonymous: new Set() });
    expect(result.verdict).toBe("alarm");
    expect(result.counts.unprotected).toBe(1);
    expect(result.counts.invalid).toBe(0);
  });
});

describe("the registration verdict", () => {
  const withNemar = [...NODES, { NodeName: NEMAR_NODE_NAME, ApiURL: "https://node.example.org/" }];

  test("the real directory without NEMAR is an alarm, and it asks nothing more", () => {
    expect(nemarListed(NODES)).toBe(false);
    const r = judgeRegistration(NODES, null);
    expect(r.verdict).toBe("alarm");
    expect(r.counts.nemar_listed).toBe(0);
    expect(r.counts.nodes_listed).toBe(NODES.length);
  });

  test("listed, with the real diagnoses naming other nodes only, is healthy", () => {
    expect(DIAGNOSES.errors.length).toBeGreaterThan(0);
    expect(judgeRegistration(withNemar, DIAGNOSES).verdict).toBe("healthy");
  });

  test("listed but named in the diagnoses' errors is an alarm", () => {
    const failing = {
      ...DIAGNOSES,
      errors: [...DIAGNOSES.errors, { node_name: "nemar", error: "x" }],
    };
    const r = judgeRegistration(withNemar, failing);
    expect(r.verdict).toBe("alarm");
    expect(r.counts.nemar_errors).toBe(1);
  });

  test("an answer that is not what the federation sends is unknown, never healthy and never an alarm", () => {
    expect(judgeRegistration({ not: "a list" }, null).verdict).toBe("unknown");
    expect(judgeRegistration(withNemar, { responses: {} }).verdict).toBe("unknown");
    expect(judgeRegistration(withNemar, null).verdict).toBe("unknown");
    expect(nemarListed("x")).toBeNull();
  });

  test("the name is matched without regard to case or padding, and only exactly", () => {
    expect(nemarListed([{ NodeName: " nemar " }])).toBe(true);
    expect(nemarListed([{ NodeName: "NEMAR 2" }])).toBe(false);
    expect(nemarListed([{ NodeName: 5 }, null])).toBe(false);
  });
});

describe("a stored heartbeat", () => {
  const good = {
    at: NOW.toISOString(),
    trigger: "cron",
    failed: false,
    overall: "healthy",
    checks: Object.fromEntries(
      ["store", "node", "registration", "drift"].map((c) => [
        c,
        { verdict: "healthy", reason: "r", counts: {} },
      ]),
    ),
    warnings: [],
    memory: { residue: ["abc"], origin: NOW.toISOString() },
  };

  test("is read back with its memory", () => {
    const parsed = parseHeartbeat(JSON.stringify(good));
    expect(parsed?.verification.overall).toBe("healthy");
    expect(parsed?.memory?.residue).toEqual(["abc"]);
  });

  test("a row that is not a heartbeat is refused, not guessed at", () => {
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat("{")).toBeNull();
    expect(parseHeartbeat(JSON.stringify({ ...good, overall: "fine" }))).toBeNull();
    expect(
      parseHeartbeat(JSON.stringify({ ...good, checks: { store: good.checks.store } })),
    ).toBeNull();
    const badVerdict = {
      ...good,
      checks: { ...good.checks, drift: { verdict: "ok", reason: "r" } },
    };
    expect(parseHeartbeat(JSON.stringify(badVerdict))).toBeNull();
  });

  test("memory that is not a list of strings is dropped, not trusted", () => {
    const parsed = parseHeartbeat(
      JSON.stringify({ ...good, memory: { residue: [1, 2], origin: null } }),
    );
    expect(parsed?.verification.overall).toBe("healthy");
    expect(parsed?.memory).toBeNull();
  });
});
