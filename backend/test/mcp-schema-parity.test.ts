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
  getEventsInputSchema,
  getEventsOutputSchema,
  listRecordingsInputSchema,
  listRecordingsOutputSchema,
  provenanceEnvelopeSchema,
  renderOverviewInputSchema,
  renderOverviewOutputSchema,
  searchDatasetsInputSchema,
  searchDatasetsOutputSchema,
} from "../../shared/contract/mcp.js";
import {
  describeDatasetInputSchema4,
  describeDatasetOutputSchema4,
  getEventsInputSchema4,
  getEventsOutputSchema4,
  listRecordingsInputSchema4,
  listRecordingsOutputSchema4,
  provenanceEnvelopeSchema4,
  renderOverviewInputSchema4,
  renderOverviewOutputSchema4,
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

// ---------------------------------------------------------------------------
// list_recordings (epic #1065 phase 3, issue #1295)
// ---------------------------------------------------------------------------

describe("listRecordingsInputSchema parity", () => {
  const cases: Array<[string, unknown]> = [
    ["dataset_id only -- defaults apply", { dataset_id: "nm000329" }],
    ["malformed dataset id -- rejected", { dataset_id: "not-an-id" }],
    [
      "every optional filter",
      { dataset_id: "nm000329", modality: "eeg", min_duration_s: 10, include_derived: true },
    ],
    ["limit at the cap (500)", { dataset_id: "nm000329", limit: 500 }],
    ["limit one past the cap (501) -- rejected", { dataset_id: "nm000329", limit: 501 }],
    ["negative offset -- rejected", { dataset_id: "nm000329", offset: -1 }],
    [
      "unknown top-level key -- passthrough keeps it",
      { dataset_id: "nm000329", future_field: "x" },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(listRecordingsInputSchema, listRecordingsInputSchema4, input, label));
  }
});

describe("listRecordingsOutputSchema parity", () => {
  const base = {
    dataset_id: "nm000329",
    source_commit: "7172d2d492dad63650f80cdb83352a0e9d4420f7",
    recordings: [],
    total_count: 0,
    excluded_derived_count: 0,
    limit: 50,
    offset: 0,
    index_format_version: 3,
    discovered_count: 3,
    failure_count: 0,
    pending_count: 0,
    excluded_legacy_non_raw_count: 0,
  };
  const oneRecording = {
    path: "sub-1/eeg/sub-1_task-x_eeg.bdf",
    zarr: "sub-1/eeg/sub-1_task-x_eeg.zarr",
    source_tree: "raw",
    derived: false,
    groups: [{ name: "eeg_250hz", rate: 250, n_channels: 63, n_view_levels: 5 }],
  };
  const cases: Array<[string, unknown]> = [
    ["the minimal required shape", base],
    ["source_commit null -- no usable commit", { ...base, source_commit: null }],
    ["one recording with groups", { ...base, recordings: [oneRecording], total_count: 1 }],
    [
      "a malformed source_commit (not 40-hex) -- rejected",
      { ...base, source_commit: "not-a-commit" },
    ],
    ["note populated", { ...base, note: "legacy index v1: re-conversion pending" }],
    ["unknown top-level key -- passthrough keeps it", { ...base, future_field: "x" }],
    [
      "unknown key nested inside a recording -- passthrough keeps it",
      { ...base, recordings: [{ ...oneRecording, future_field: "x" }] },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(listRecordingsOutputSchema, listRecordingsOutputSchema4, input, label));
  }
});

// ---------------------------------------------------------------------------
// get_events (epic #1065 phase 3, issue #1295)
// ---------------------------------------------------------------------------

describe("getEventsInputSchema parity", () => {
  const cases: Array<[string, unknown]> = [
    [
      "dataset_id + recording only -- defaults apply",
      { dataset_id: "nm000329", recording: "sub-1/eeg/sub-1_task-x_eeg.zarr" },
    ],
    ["with group filter", { dataset_id: "nm000329", recording: "x.zarr", group: "eeg_250hz" }],
    ["limit at the cap (5000)", { dataset_id: "nm000329", recording: "x.zarr", limit: 5000 }],
    [
      "limit one past the cap (5001) -- rejected",
      { dataset_id: "nm000329", recording: "x.zarr", limit: 5001 },
    ],
    ["negative offset -- rejected", { dataset_id: "nm000329", recording: "x.zarr", offset: -1 }],
    ["malformed dataset id -- rejected", { dataset_id: "not-an-id", recording: "x.zarr" }],
    [
      "unknown top-level key -- passthrough keeps it",
      { dataset_id: "nm000329", recording: "x.zarr", future_field: "x" },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () => assertParity(getEventsInputSchema, getEventsInputSchema4, input, label));
  }
});

describe("getEventsOutputSchema parity", () => {
  const base = {
    dataset_id: "nm000329",
    recording: "sub-1/eeg/sub-1_task-x_eeg.zarr",
    events: [],
    source: "events_parquet",
    estimated: false,
    total_count: 0,
    limit: 1000,
    offset: 0,
    truncated: false,
  };
  const oneEvent = {
    store_path: "sub-1/eeg/sub-1_task-x_eeg.zarr",
    group_name: "eeg_250hz",
    onset_s: 1.5,
    sample_index: 375,
  };
  const cases: Array<[string, unknown]> = [
    ["the minimal required shape", base],
    ["one event row", { ...base, events: [oneEvent], total_count: 1 }],
    [
      "source_tsv_fallback with estimated true",
      { ...base, source: "events_tsv_fallback", estimated: true },
    ],
    ["an unrecognized source -- rejected", { ...base, source: "made_up" }],
    [
      "a negative sample_index -- rejected",
      { ...base, events: [{ ...oneEvent, sample_index: -1 }] },
    ],
    ["note populated", { ...base, note: "no events file was found" }],
    ["unknown top-level key -- passthrough keeps it", { ...base, future_field: "x" }],
    [
      "unknown key nested inside an event row -- passthrough keeps it (subject/session/etc.)",
      { ...base, events: [{ ...oneEvent, subject: "1", session: "0" }] },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () => assertParity(getEventsOutputSchema, getEventsOutputSchema4, input, label));
  }
});

// ---------------------------------------------------------------------------
// render_overview (epic #1065 phase 3, issue #1295)
// ---------------------------------------------------------------------------

describe("renderOverviewInputSchema parity", () => {
  const cases: Array<[string, unknown]> = [
    [
      "dataset_id + recording only -- defaults apply",
      { dataset_id: "nm000329", recording: "x.zarr" },
    ],
    ["width_px at the cap (4000)", { dataset_id: "nm000329", recording: "x.zarr", width_px: 4000 }],
    [
      "width_px one past the cap (4001) -- rejected",
      { dataset_id: "nm000329", recording: "x.zarr", width_px: 4001 },
    ],
    [
      "width_px zero -- rejected (must be positive)",
      { dataset_id: "nm000329", recording: "x.zarr", width_px: 0 },
    ],
    ["malformed dataset id -- rejected", { dataset_id: "not-an-id", recording: "x.zarr" }],
    [
      "unknown top-level key -- passthrough keeps it",
      { dataset_id: "nm000329", recording: "x.zarr", future_field: "x" },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(renderOverviewInputSchema, renderOverviewInputSchema4, input, label));
  }
});

describe("renderOverviewOutputSchema parity", () => {
  const base = {
    dataset_id: "nm000329",
    recording: "sub-1/eeg/sub-1_task-x_eeg.zarr",
    group: "eeg_250hz",
    level: 5,
    width_px: 100,
    height_px: 1197,
    mime_type: "image/png",
    columns_read: 135,
    chunks_read: 1,
    bytes_read: 33379,
  };
  const cases: Array<[string, unknown]> = [
    ["the minimal required shape", base],
    ["a cache hit (zero reads)", { ...base, columns_read: 0, chunks_read: 0, bytes_read: 0 }],
    ["an unrecognized mime_type -- rejected", { ...base, mime_type: "image/jpeg" }],
    ["a non-positive level -- rejected", { ...base, level: 0 }],
    ["unknown top-level key -- passthrough keeps it", { ...base, future_field: "x" }],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(renderOverviewOutputSchema, renderOverviewOutputSchema4, input, label));
  }
});

// ---------------------------------------------------------------------------
// provenanceEnvelopeSchema (PR review item 24): the sss-iff-derived
// refinement (ADR 0028) is the exact invariant whose absence on
// recordingSummarySchema caused the item-1 bug (every derived store's
// envelope threw) -- covered here directly, plus embedded in each of the
// three recording-level tools' own output parity below.
// ---------------------------------------------------------------------------

describe("provenanceEnvelopeSchema parity", () => {
  const base = {
    dataset_id: "on003392",
    doi: "10.82901/nemar.on003392",
    license: "CC0",
    citation: "Someone (2026) A Dataset (v1.0.0). NEMAR. https://doi.org/10.82901/nemar.on003392",
    source_commit: "1035360c2cbb5a349cc43a46a58543c5f02a4e38",
    index_etag: null,
    engine_version: "3",
    source_tree: "raw",
    lossy: true,
    dtype: "int16",
    effective_rate_hz: 250,
    source_rate_hz: 2000,
    zarr_verify_status: null,
  };
  const sss = {
    applied: true,
    method: "maxwell_filter",
    calibration: "sub-01_acq-calibration_meg.dat",
    cross_talk: "sub-01_acq-crosstalk_meg.fif",
    mne_version: "1.12.1",
  };
  const cases: Array<[string, unknown]> = [
    ["derived: false, no sss -- accepted", { ...base, derived: false }],
    ["derived: true WITH sss -- accepted", { ...base, derived: true, sss }],
    ["derived: true WITHOUT sss -- rejected by both copies (ADR 0028)", { ...base, derived: true }],
    [
      "derived: false WITH sss -- rejected by both copies (ADR 0028)",
      { ...base, derived: false, sss },
    ],
    [
      "a malformed (non-40-hex) source_commit -- rejected",
      { ...base, derived: false, source_commit: "abc" },
    ],
  ];
  for (const [label, input] of cases) {
    test(label, () =>
      assertParity(provenanceEnvelopeSchema, provenanceEnvelopeSchema4, input, label));
  }
});

describe("envelope embedded in the three recording-level tools' outputs (item 24)", () => {
  const derivedEnvelope = {
    dataset_id: "on003392",
    doi: "10.82901/nemar.on003392",
    license: "CC0",
    citation: null,
    source_commit: "1035360c2cbb5a349cc43a46a58543c5f02a4e38",
    index_etag: null,
    engine_version: "3",
    source_tree: "raw",
    derived: true,
    sss: {
      applied: true,
      method: "maxwell_filter",
      calibration: "sub-01_acq-calibration_meg.dat",
      cross_talk: "sub-01_acq-crosstalk_meg.fif",
      mne_version: "1.12.1",
    },
    lossy: true,
    dtype: "int16",
    effective_rate_hz: 250,
    source_rate_hz: 2000,
    zarr_verify_status: null,
  };

  test("listRecordingsOutputSchema accepts a derived-store envelope with sss", () => {
    assertParity(
      listRecordingsOutputSchema,
      listRecordingsOutputSchema4,
      {
        dataset_id: "on003392",
        source_commit: "1035360c2cbb5a349cc43a46a58543c5f02a4e38",
        recordings: [],
        total_count: 0,
        excluded_derived_count: 1,
        limit: 50,
        offset: 0,
        index_format_version: 3,
        discovered_count: 1,
        failure_count: 0,
        pending_count: 0,
        excluded_legacy_non_raw_count: 0,
        envelope: derivedEnvelope,
      },
      "listRecordingsOutputSchema with a derived envelope",
    );
  });

  test("getEventsOutputSchema accepts a derived-store envelope with sss", () => {
    assertParity(
      getEventsOutputSchema,
      getEventsOutputSchema4,
      {
        dataset_id: "on003392",
        recording: "sub-01/meg/sub-01_task-localizer_meg.zarr",
        events: [],
        source: "events_tsv_fallback",
        estimated: true,
        total_count: 0,
        limit: 1000,
        offset: 0,
        truncated: false,
        envelope: derivedEnvelope,
      },
      "getEventsOutputSchema with a derived envelope",
    );
  });

  test("renderOverviewOutputSchema accepts a derived-store envelope with sss", () => {
    assertParity(
      renderOverviewOutputSchema,
      renderOverviewOutputSchema4,
      {
        dataset_id: "on003392",
        recording: "sub-01/meg/sub-01_task-localizer_meg.zarr",
        group: "meg_250hz",
        level: 3,
        width_px: 50,
        height_px: 100,
        mime_type: "image/png",
        columns_read: 132,
        chunks_read: 1,
        bytes_read: 1079,
        envelope: derivedEnvelope,
      },
      "renderOverviewOutputSchema with a derived envelope",
    );
  });
});
