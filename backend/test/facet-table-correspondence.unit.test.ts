/**
 * Cross-checks between the two halves of the declared facet table (epic
 * #1144 phase 3, #1147, D2/ADR 0031): `shared/facets.ts` (the CLI/wire
 * vocabulary) and `backend/src/services/dataset-facets.ts` (the SQL
 * binding). These are the three properties that make twenty facets
 * maintainable instead of twenty chances to half-wire one (plan
 * verification case 8):
 *
 *  1. The two tables declare the exact same set of facet keys, in both
 *     directions -- a facet added to one and not the other is either a
 *     dead CLI flag or an unreachable SQL binding.
 *  2. `hasActiveFilters` (dataset-search.ts) returns true for EACH facet
 *     key individually, not just "some" facet -- an OR-gate term deleted
 *     for one specific key is exactly the class of bug that left 22 of 154
 *     tests green in Phase 2b (only tested in aggregate, never per-term).
 *  3. Every facet's bound column(s) appear in the actual projected SQL of
 *     both `GET /datasets` branches (driven through the real route, not a
 *     hand-copied column list) -- a facet a caller can filter by but never
 *     see the value of is a result set with no way to check (D7).
 *
 * No mocks: table correspondence is pure data, and the projection check
 * drives the real Hono route against a real bun:sqlite-backed D1.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FACETS, type FacetKey } from "../../shared/facets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { FACET_DEFINITIONS } from "../src/services/dataset-facets";
import type { DatasetFilterOptions } from "../src/services/dataset-filters";
import { hasActiveFilters } from "../src/services/dataset-search";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

describe("shared/facets.ts <-> dataset-facets.ts correspondence", () => {
  const vocabKeys = new Set(FACETS.map((f) => f.key));
  const sqlKeys = new Set(FACET_DEFINITIONS.map((d) => d.key));

  test("there are facets to check (guards a vacuous pass)", () => {
    expect(vocabKeys.size).toBeGreaterThan(0);
  });

  test("every shared/facets.ts key has a dataset-facets.ts SQL binding", () => {
    const missing = [...vocabKeys].filter((k) => !sqlKeys.has(k));
    expect(missing).toEqual([]);
  });

  test("every dataset-facets.ts SQL binding has a shared/facets.ts entry", () => {
    const missing = [...sqlKeys].filter((k) => !vocabKeys.has(k));
    expect(missing).toEqual([]);
  });

  test("no duplicate keys in either table", () => {
    expect(FACETS.length).toBe(vocabKeys.size);
    expect(FACET_DEFINITIONS.length).toBe(sqlKeys.size);
  });
});

describe("hasActiveFilters: every facet key is its own OR-gate term", () => {
  // Each of the twenty facets, driven through a MINIMAL valid FacetValue for
  // its own kind -- not a shared fixture -- so a deleted term for ONE key
  // fails only that key's test, not all twenty at once (mirrors the epic's
  // own post-mortem: an aggregate assertion let 22/154 tests stay green
  // when one OR-gate term was deleted).
  for (const facet of FACETS) {
    test(`facets.${facet.key} alone makes hasActiveFilters true`, () => {
      const filters: DatasetFilterOptions = {
        facets: { [facet.key]: valueFor(facet.key) } as DatasetFilterOptions["facets"],
      };
      expect(hasActiveFilters(filters)).toBe(true);
    });
  }

  test("no facets and no legacy filter makes hasActiveFilters false", () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  test("an empty facets object (no keys) makes hasActiveFilters false", () => {
    expect(hasActiveFilters({ facets: {} })).toBe(false);
  });
});

/** One minimal, valid FacetValue per facet, keyed by its shared/facets.ts
 *  valueKind -- just enough shape for `isAnyFacetActive`'s
 *  `Object.keys(facets).length > 0` check, which is kind-agnostic. */
function valueFor(key: FacetKey): unknown {
  const def = FACETS.find((f) => f.key === key);
  if (!def) throw new Error(`no shared/facets.ts entry for ${key}`);
  switch (def.valueKind) {
    case "number":
    case "bytes":
    case "duration":
      return { kind: "range", min: 1, max: null };
    case "enum":
      return { kind: "enum", values: [def.enumValues?.[0] ?? "x"] };
    case "text":
      return { kind: "text", value: "x" };
    case "version":
      return { kind: "version", prefix: "1" };
  }
}

describe("D7: every facet's column is projected on both GET /datasets branches", () => {
  let db: Database;
  let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

  function env(): Bindings {
    return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
  }

  beforeEach(() => {
    db = freshDb();
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    registerCatalogRoutes(app);
    db.run(
      `INSERT INTO datasets (
         dataset_id, name, owner_user_id, github_repo, visibility, status, is_sandbox
       ) VALUES ('nm100001', 'projection fixture', -1, 'nemarDatasets/nm100001', 'public', 'active', 0)`,
    );
  });

  // The column a facet reads, per its dataset-facets.ts SQL binding, mapped
  // to the JSON KEY it must appear under in an unaliased `d.<col>`
  // projection (the wire key is the raw column name unless the route
  // aliases it -- `channels`/`age` are pairs, so both min/max columns are
  // checked; `citations` reads `num_citations`, which the public branch has
  // aliased since #804 and the ?mine branch gained here for parity).
  const expectedColumns: Record<FacetKey, string[]> = {
    subjects: ["participants"], // subject_count is COALESCEd + aliased already
    channels: ["channel_count_min", "channel_count_max", "n_channels"],
    sessions: ["sessions_count"],
    size: ["file_size"],
    files: ["total_files"],
    citations: ["num_citations"],
    duration: ["total_recording_duration"],
    "recording-length": ["recording_duration_min", "recording_duration_max"],
    recordings: ["recording_count"],
    unavailable: ["recordings_unavailable"],
    age: ["age_min", "age_max"],
    rate: ["sampling_frequency"],
    powerline: ["power_line_frequency"],
    reference: ["eeg_reference"],
    placement: ["placement_scheme"],
    "electrode-system": ["electrode_system"],
    source: ["source"],
    zarr: ["zarr_status"],
    "bids-version": ["bids_version"],
    "hed-version": ["hed_version"],
  };

  test("every facet's column is a key on the public GET /datasets row", async () => {
    const res = await app.request("/", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: Record<string, unknown>[] };
    expect(body.datasets.length).toBe(1);
    const row = body.datasets[0];
    const missing: string[] = [];
    for (const facet of FACETS) {
      for (const col of expectedColumns[facet.key]) {
        if (!(col in row)) missing.push(`${facet.key} -> ${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every facet's column is a key on the ?mine=true GET /datasets row", async () => {
    const API_KEY = "projection-fixture-key-0123456789abcdef01234567";
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (7, 'proj', 'proj@example.org', 'x', 'approved', 'member', 1)",
    );
    db.run("UPDATE datasets SET owner_user_id = 7 WHERE dataset_id = 'nm100001'");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (7, ?, ?)").run(
      await hashApiKey(API_KEY),
      API_KEY.slice(0, 8),
    );

    const res = await app.request(
      "/?mine=true",
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: Record<string, unknown>[] };
    expect(body.datasets.length).toBe(1);
    const row = body.datasets[0];
    const missing: string[] = [];
    for (const facet of FACETS) {
      for (const col of expectedColumns[facet.key]) {
        if (!(col in row)) missing.push(`${facet.key} -> ${col}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
