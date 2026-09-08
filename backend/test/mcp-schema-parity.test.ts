/**
 * Drift test between the zod 3 wire contract (`shared/contract/mcp.ts`) and
 * the zod 4 registration mirrors (`backend/src/mcp/schemas.ts`) -- epic
 * #1065 phase 2, issue #1294, `.context/mcp-server-design.md` section 12's
 * "tool registration under the two-copy zod split".
 *
 * Rather than comparing the two copies' generated JSON Schema documents
 * (two different generators -- `zod-to-json-schema` for zod 3,
 * `z.toJSONSchema()` for zod 4 -- would drift on shape even when the
 * ACCEPT/REJECT behavior agrees), this runs one shared table of valid and
 * invalid inputs through BOTH copies via `.safeParse` and asserts identical
 * accept/reject verdicts and, on a shared success, identical parsed values.
 * A field added to one mirror and not the other, or a cap/default/regex
 * that drifts, fails a case here.
 */

import { describe, expect, test } from "bun:test";
import {
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  searchDatasetsInputSchema,
  searchDatasetsOutputSchema,
} from "../../shared/contract/mcp.js";
import {
  describeDatasetInputSchema4,
  describeDatasetOutputSchema4,
  searchDatasetsInputSchema4,
  searchDatasetsOutputSchema4,
} from "../src/mcp/schemas.js";

/** A minimal Standard-Schema-shaped `.safeParse` caller: both zod 3's
 *  `ZodType` and zod 4's `ZodType` expose this method with an identical
 *  `{ success, data | error }` result shape, so one helper drives both. */
interface SafeParseable {
  safeParse: (input: unknown) => { success: boolean; data?: unknown };
}

function assertParity(zod3: SafeParseable, zod4: SafeParseable, input: unknown, label: string) {
  const r3 = zod3.safeParse(input);
  const r4 = zod4.safeParse(input);
  expect(r3.success, `${label}: zod3.success`).toBe(r4.success);
  if (r3.success && r4.success) {
    expect(r4.data, `${label}: parsed value`).toEqual(r3.data);
  }
}

describe("searchDatasetsInputSchema parity", () => {
  const cases: Array<[string, unknown]> = [
    ["empty object -- defaults apply", {}],
    ["query only", { query: "motor imagery" }],
    [
      "every optional filter",
      { query: "eeg", modality: "eeg", task: "rest", has_hed: true, has_zarr: true },
    ],
    ["limit at the cap (100)", { limit: 100 }],
    ["limit one past the cap (101) -- rejected", { limit: 101 }],
    ["limit zero -- rejected (must be positive)", { limit: 0 }],
    ["limit negative -- rejected", { limit: -1 }],
    ["non-integer limit -- rejected", { limit: 1.5 }],
    ["unknown top-level key -- passthrough keeps it", { query: "eeg", future_field: "x" }],
    ["wrong type for has_hed -- rejected", { has_hed: "yes" }],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(searchDatasetsInputSchema, searchDatasetsInputSchema4, input, label));
  }
});

describe("searchDatasetsOutputSchema parity", () => {
  const validHit = {
    dataset_id: "nm000329",
    name: "A Dataset",
    doi: "10.82901/nemar.nm000329",
    license: "CC-BY-NC-ND-4.0",
    modalities: ["eeg"],
    tasks: ["imagery"],
    subject_count: 16,
    has_hed: true,
    has_zarr: true,
  };
  const cases: Array<[string, unknown]> = [
    ["empty results page", { results: [], count: 0, limit: 20 }],
    ["one valid hit", { results: [validHit], count: 1, limit: 20 }],
    [
      "a hit with a malformed dataset_id -- rejected",
      { results: [{ ...validHit, dataset_id: "not-an-id" }], count: 1, limit: 20 },
    ],
    [
      "a hit missing the required has_zarr -- rejected",
      { results: [{ ...validHit, has_zarr: undefined }], count: 1, limit: 20 },
    ],
    ["negative count -- rejected", { results: [], count: -1, limit: 20 }],
    [
      "unknown top-level key -- passthrough keeps it",
      { results: [], count: 0, limit: 20, future_field: "x" },
    ],
    [
      "unknown key nested inside a results[] hit -- passthrough keeps it",
      { results: [{ ...validHit, future_field: "x" }], count: 1, limit: 20 },
    ],
    ["note populated", { results: [], count: 0, limit: 20, note: "the search index is degraded" }],
    ["note explicitly null", { results: [], count: 0, limit: 20, note: null }],
    ["truncated true", { results: [validHit], count: 500, limit: 20, truncated: true }],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(searchDatasetsOutputSchema, searchDatasetsOutputSchema4, input, label));
  }
});

describe("describeDatasetInputSchema parity", () => {
  const cases: Array<[string, unknown]> = [
    ["a valid dataset id", { dataset_id: "nm000329" }],
    ["a malformed dataset id -- rejected", { dataset_id: "not-an-id" }],
    ["an id with too many digits -- rejected", { dataset_id: "nm0003291" }],
    ["an id with an uppercase prefix -- rejected", { dataset_id: "NM000329" }],
    ["missing dataset_id -- rejected", {}],
    [
      "unknown top-level key -- passthrough keeps it",
      { dataset_id: "nm000329", future_field: "x" },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(describeDatasetInputSchema, describeDatasetInputSchema4, input, label));
  }
});

describe("describeDatasetOutputSchema parity", () => {
  const base = {
    dataset_id: "nm000329",
    name: "A Dataset",
    doi: "10.82901/nemar.nm000329",
    license: "CC-BY-NC-ND-4.0",
    citation: "Someone (2026) A Dataset (v1.0.0). NEMAR. https://doi.org/10.82901/nemar.nm000329",
    cost_hint: {
      next_cheapest_tool: "list_recordings",
      reason: "ready: one cached index parse lists recordings and groups.",
    },
  };
  const cases: Array<[string, unknown]> = [
    ["the minimal required shape (nullable fields as null)", base],
    [
      "every additive field populated",
      {
        ...base,
        modalities: ["eeg"],
        tasks: ["imagery"],
        subject_count: 16,
        has_hed: true,
        hed_version: "8.4.0",
        recording_count: 112,
        total_recording_duration_s: 349602,
        zarr_status: "ready",
        zarr_verify_status: "verified",
        zarr_source_commit: "7172d2d492dad63650f80cdb83352a0e9d4420f7",
        zarr_store_count: 112,
      },
    ],
    ["zarr_status pending", { ...base, zarr_status: "pending" }],
    ["zarr_status an unrecognized value -- rejected", { ...base, zarr_status: "converting" }],
    [
      "cost_hint.next_cheapest_tool an unrecognized tool -- rejected",
      { ...base, cost_hint: { ...base.cost_hint, next_cheapest_tool: "search_datasets" } },
    ],
    [
      "missing citation -- rejected (required, though nullable)",
      (() => {
        const { citation: _citation, ...rest } = base;
        return rest;
      })(),
    ],
    ["malformed dataset_id -- rejected", { ...base, dataset_id: "not-an-id" }],
    ["unknown top-level key -- passthrough keeps it", { ...base, future_field: "x" }],
    [
      "unknown key nested inside cost_hint -- passthrough keeps it",
      { ...base, cost_hint: { ...base.cost_hint, future_field: "x" } },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(describeDatasetOutputSchema, describeDatasetOutputSchema4, input, label));
  }
});
