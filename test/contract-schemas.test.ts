/**
 * Pure unit tests for the shared wire contract (epic #896, #898).
 *
 * No live backend: validates the schemas + version canonicalizer directly, so
 * this is a required unit-pure test that also gates deploys. The live-response
 * drift guard is the separate integration test test/contract-live.test.ts.
 * (Intentionally no live-backend env-var token in this file's text: the CI tier
 * classifier is a content grep, and a mere mention would misroute this pure test
 * out of the required/deploy-gating tier -- see epic #896 cross-phase review.)
 */

import { describe, expect, test } from "bun:test";
import {
  NEUROSCHEMA_VERSION,
  catalogItemSchema,
  datasetDetailSchema,
  datasetListEnvelopeSchema,
  datasetSearchEnvelopeSchema,
  isVersionTag,
  neuroschemaDatasetSchema,
  searchHitSchema,
  toBareVersion,
  toVersionTag,
  userMeResponseSchema,
  versionTagSchema,
} from "../shared/contract/index.js";

describe("version canonicalizer", () => {
  test("toVersionTag is idempotent and coerces bare -> tag", () => {
    expect(toVersionTag("1.0.0")).toBe("v1.0.0");
    expect(toVersionTag("v1.0.0")).toBe("v1.0.0");
    expect(toBareVersion("v2.3.4")).toBe("2.3.4");
    expect(isVersionTag("v1.0.0")).toBe(true);
    expect(isVersionTag("1.0.0")).toBe(false);
  });

  test("versionTagSchema accepts bare or tagged, outputs canonical tag", () => {
    expect(versionTagSchema.parse("1.2.3")).toBe("v1.2.3");
    expect(versionTagSchema.parse("v1.2.3")).toBe("v1.2.3");
    expect(versionTagSchema.parse("1.0.0-rc1")).toBe("v1.0.0-rc1");
    expect(() => versionTagSchema.parse("latest")).toThrow();
    expect(() => versionTagSchema.parse("1.0")).toThrow();
  });
});

describe("catalog item schema", () => {
  const row = {
    dataset_id: "nm000108",
    id: "nm000108",
    name: "Test",
    description: null,
    status: "active",
    visibility: "public",
    concept_doi: null,
    doi: null,
    created_at: "2026-01-01T00:00:00Z",
    owner_username: "someone",
    source: "nemar",
    modalities: "eeg",
    participants: 12,
    tasks: "rest",
    authors: "Doe, J.",
    license: "CC0",
    file_size: 123456,
    file_size_formatted: "120 KB",
    latest_version: "1.0.0", // bare on the wire today; coerced to tag on parse
  };

  test("accepts a current catalog row and canonicalizes latest_version", () => {
    const parsed = catalogItemSchema.parse(row);
    expect(parsed.latest_version).toBe("v1.0.0");
  });

  test("tolerates additive unknown fields (passthrough)", () => {
    const parsed = catalogItemSchema.parse({ ...row, some_future_field: 1 });
    expect((parsed as Record<string, unknown>).some_future_field).toBe(1);
  });

  test("rejects a row missing a required field", () => {
    const { name, ...noName } = row;
    void name;
    expect(() => catalogItemSchema.parse(noName)).toThrow();
  });

  test("list envelope validates", () => {
    expect(() =>
      datasetListEnvelopeSchema.parse({ datasets: [row], count: 1, total_count: 1 }),
    ).not.toThrow();
  });

  test("accepts the #970 honest-size fields (total_files, data_complete, bytes_present)", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      total_files: 400,
      data_complete: 0,
      bytes_present: 36,
    });
    expect(parsed.total_files).toBe(400);
    expect(parsed.data_complete).toBe(0);
    expect(parsed.bytes_present).toBe(36);
  });

  test("#970 fields are optional and nullable (older backends / not-yet-audited rows)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      total_files: null,
      data_complete: null,
      bytes_present: null,
    });
    expect(parsed.data_complete).toBeNull();
  });

  test("rejects an out-of-domain data_complete value", () => {
    expect(() => catalogItemSchema.parse({ ...row, data_complete: 2 })).toThrow();
  });

  test("accepts the #1062 zarr fields, including the derived zarr_index_url", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_status: "ready",
      zarr_store_count: 41,
      zarr_converted_at: "2026-08-01T00:00:00.000Z",
      zarr_source_commit: "abc123",
      zarr_errors: 0,
      zarr_failure_count: 0,
      zarr_deterministic: 0,
      zarr_failed_at: null,
      zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
    });
    expect(parsed.zarr_store_count).toBe(41);
    expect(parsed.zarr_index_url).toBe("https://zarr.nemar.org/on007763/zarr/index.json");
  });

  test("the #1062 zarr fields are optional and nullable (older backends / not-yet-converted rows)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_store_count: null,
      zarr_converted_at: null,
      zarr_source_commit: null,
      zarr_errors: null,
      zarr_failure_count: null,
      zarr_deterministic: null,
      zarr_failed_at: null,
      zarr_index_url: null,
    });
    expect(parsed.zarr_index_url).toBeNull();
  });

  // PR #1201 review, item 3: the cross-field invariant a regressed
  // deriveZarrIndexUrl (or a future write path setting the two fields
  // independently) would violate -- caught at the contract layer, not just
  // trusted from the derivation function's own code.
  test("REJECTS zarr_index_url set when zarr_status is not 'ready'", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: "pending",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  test("REJECTS zarr_index_url set when zarr_status is null (never converted)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: null,
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  test("ACCEPTS zarr_index_url set when zarr_status IS 'ready' (the consistent pair)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: "ready",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).not.toThrow();
  });

  // Issue #1068, epic #1181 phase 8: the fidelity verification sweep's verdict.
  test("accepts the #1068 zarr_verify_status/zarr_verified_at fields", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_status: "ready",
      zarr_verify_status: "verified",
      zarr_verified_at: "2026-09-02 00:00:00",
    });
    expect(parsed.zarr_verify_status).toBe("verified");
    expect(parsed.zarr_verified_at).toBe("2026-09-02 00:00:00");
  });

  test("zarr_verify_status/zarr_verified_at are optional and null (a fresh conversion the sweep hasn't reached yet)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_verify_status: null,
      zarr_verified_at: null,
    });
    expect(parsed.zarr_verify_status).toBeNull();
    expect(parsed.zarr_verified_at).toBeNull();
  });

  test("rejects an out-of-enum zarr_verify_status", () => {
    expect(() => catalogItemSchema.parse({ ...row, zarr_verify_status: "bogus" })).toThrow();
  });

  // The cross-field invariant a regressed sweep write (or a future path that
  // sets the two independently) would violate.
  test("REJECTS zarr_verified_at set when zarr_verify_status is null", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_verify_status: null,
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).toThrow();
  });

  test("ACCEPTS zarr_verified_at set when zarr_verify_status is non-null (the consistent pair)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_verify_status: "failed",
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).not.toThrow();
  });
});

describe("detail schema: zarr_data_failures (#1191, fixes #1188)", () => {
  const detailRow = {
    dataset_id: "on007763",
    id: "on007763",
    name: "Test",
    description: null,
    status: "active",
    visibility: "public",
    concept_doi: null,
    doi: null,
    created_at: "2026-01-01T00:00:00Z",
    owner_username: "someone",
    source: "openneuro",
    modalities: "meg",
    participants: 41,
    tasks: "rest",
    authors: "Doe, J.",
    license: "CC0",
    file_size: 123456,
  };

  test("accepts the bounded {count, detail_ref} summary object", () => {
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: { count: 36, detail_ref: "zarr/index.json" },
    });
    expect(parsed.zarr_data_failures).toEqual({ count: 36, detail_ref: "zarr/index.json" });
  });

  test("accepts the summary object with the optional compacted_by (migration 0074 rows)", () => {
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: {
        count: 877,
        detail_ref: "zarr/index.json",
        compacted_by: "migration_0074",
      },
    });
    expect(parsed.zarr_data_failures?.compacted_by).toBe("migration_0074");
  });

  test("accepts null (no known failures on record)", () => {
    const parsed = datasetDetailSchema.parse({ ...detailRow, zarr_data_failures: null });
    expect(parsed.zarr_data_failures).toBeNull();
  });

  test("KEEPS the coverage counts and the unpublished-sibling flags", () => {
    // Every one of these is written into the same stored object by
    // `zarrFailureColumns` and projected by `parseZarrDataFailures`. Undeclared,
    // the closed object silently STRIPPED them here -- which is how #1197's
    // "2 of 43" reached D1 and never reached a consumer.
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: {
        count: 36,
        detail_ref: "zarr/index.json",
        pending: 5,
        discovered: 43,
        events_upload_failed: true,
        manifest_upload_failed: true,
      },
    });
    expect(parsed.zarr_data_failures).toEqual({
      count: 36,
      detail_ref: "zarr/index.json",
      pending: 5,
      discovered: 43,
      events_upload_failed: true,
      manifest_upload_failed: true,
    });
  });

  test("the sibling flags are true-only: false is not a shape the writer produces", () => {
    // `zarrFailureColumns` omits the key rather than writing false, so absence
    // IS the negative. Accepting false as well would give the same condition two
    // spellings and let a consumer read one of them wrong.
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: {
          count: 0,
          detail_ref: "zarr/index.json",
          manifest_upload_failed: false,
        },
      }),
    ).toThrow();
  });

  test("an undeclared key passes THROUGH rather than being stripped", () => {
    // The module's rule for every other object here: the contract is a lower
    // bound. This nested object was the one exception, and stripping is exactly
    // what made #1197's counts invisible -- a newer backend's next additive key
    // must reach the caller, not vanish on the way out.
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: { count: 1, detail_ref: "zarr/index.json", not_yet_declared: 7 },
    });
    expect((parsed.zarr_data_failures as Record<string, unknown>).not_yet_declared).toBe(7);
  });

  test("zarr_data_failures is optional (older backends omit it entirely)", () => {
    expect(() => datasetDetailSchema.parse(detailRow)).not.toThrow();
  });

  test("REJECTS a raw string -- the pre-#1191 shape must never validate again", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: JSON.stringify({ count: 36, detail_ref: "zarr/index.json" }),
      }),
    ).toThrow();
  });

  test("rejects a bare array (the pre-migration-0074 per-file list shape)", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: [{ path: "a", code: "x" }],
      }),
    ).toThrow();
  });

  // PR #1201 review, item 3: datasetDetailSchema carries the same
  // zarr_index_url/zarr_status invariant as catalogItemSchema -- re-applied
  // via superRefine after `.extend()`, since `.extend()` is not available on
  // a ZodEffects. Proven here so a future refactor that drops the reapply
  // (e.g. reordering the chain) fails this test, not just the list schema's.
  test("also REJECTS zarr_index_url set when zarr_status is not 'ready'", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_status: "pending",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  // Issue #1068, epic #1181 phase 8: same zarr_verified_at/zarr_verify_status
  // invariant as catalogItemSchema, re-applied after `.extend()` -- proven
  // separately for the same reason as the zarr_index_url pair above.
  test("also REJECTS zarr_verified_at set when zarr_verify_status is null", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_verify_status: null,
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).toThrow();
  });

  test("also ACCEPTS the consistent zarr_verify_status/zarr_verified_at pair", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_verify_status: "unverifiable",
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).not.toThrow();
  });
});

describe("search hit schema", () => {
  // The real /datasets/search projection: `d.dataset_id AS id`, no latest_version.
  const hit = {
    id: "nm000108",
    name: "Test",
    modalities: "eeg",
    participants: 12,
    doi: null,
    tasks: "rest",
    authors: "Doe, J.",
    has_hed: 1,
    score: 0.87,
  };

  test("accepts a real search hit (keyed on id, not dataset_id)", () => {
    expect(() => searchHitSchema.parse(hit)).not.toThrow();
  });

  test("rejects a hit missing id (regression guard for the #898 review Critical)", () => {
    const { id, ...noId } = hit;
    void id;
    expect(() => searchHitSchema.parse(noId)).toThrow();
  });

  test("tolerates null raw columns (no COALESCE in the search query)", () => {
    expect(() =>
      searchHitSchema.parse({ id: "nm000108", name: "T", modalities: null, participants: null }),
    ).not.toThrow();
  });

  test("search envelope validates a non-empty results array", () => {
    // "fts" was never a real `method` value the backend emits; #1145 review
    // I6/I7 tightened the schema's `method` to the real 5-member enum, so
    // this now has to use a literal the backend actually returns.
    expect(() =>
      datasetSearchEnvelopeSchema.parse({ results: [hit], count: 1, method: "text", min_score: 0 }),
    ).not.toThrow();
  });

  test("search envelope rejects a method value the backend never emits", () => {
    expect(() =>
      datasetSearchEnvelopeSchema.parse({ results: [hit], count: 1, method: "fts", min_score: 0 }),
    ).toThrow();
  });
});

describe("user /me envelope schema", () => {
  test("accepts the nested {user, token} envelope", () => {
    const env = {
      user: { id: 1, username: "u", email: "e@x.org", github_username: "gh", role: "user" },
      token: { prefix: "abc", created_at: "2026-01-01", last_used_at: null },
    };
    const parsed = userMeResponseSchema.parse(env);
    expect(parsed.user.username).toBe("u");
  });

  test("rejects a flat user (the getCurrentUser bug shape)", () => {
    expect(() =>
      userMeResponseSchema.parse({ id: 1, username: "u", email: "e@x.org", role: "user" }),
    ).toThrow();
  });

  test("status is the column's closed vocabulary, not any string", () => {
    // The four values migration 0001's CHECK constraint admits. The reason it
    // is closed on the wire too: `status === "pending"` is what raises the
    // email_verified gap, and a typo or a stray value there is a comparison
    // that silently never matches rather than a compile or parse error.
    const user = {
      id: 1,
      username: null,
      email: "e@x.org",
      github_username: null,
      role: "user",
    };
    for (const status of ["pending", "verified", "approved", "revoked"]) {
      expect(userMeResponseSchema.parse({ user: { ...user, status }, token: null }).user.status).toBe(
        status,
      );
    }
    // "active" is the DASHBOARD's collapsed value and belongs to /auth/me, not
    // here; mixing the two vocabularies is the confusion the split prevents.
    expect(() =>
      userMeResponseSchema.parse({ user: { ...user, status: "active" }, token: null }),
    ).toThrow();
  });

  test("a profile_gaps entry may carry only its field name", () => {
    // getCurrentUser throws ApiError on ANY mismatch, so a required `set_on`
    // would make one thin entry break every /users/me consumer -- over a key
    // the renderer never reads (resolveWireProfileGaps takes `field` and
    // `blocks`, and falls back to the matrix for a `blocks` it cannot use).
    const parsed = userMeResponseSchema.parse({
      user: {
        id: 1,
        username: null,
        email: "e@x.org",
        github_username: null,
        role: "user",
        profile_gaps: [
          { field: "username", blocks: ["upload_access"] },
          { field: "city" },
        ],
      },
      token: null,
    });
    expect(parsed.user.profile_gaps?.map((g) => g.field)).toEqual(["username", "city"]);
    expect(parsed.user.profile_gaps?.[1].set_on).toBeUndefined();
  });

  test("a profile_gaps entry still needs its field name", () => {
    // The one key the renderers cannot do without: an entry with no `field` is
    // dropped by resolveWireProfileGaps, so accepting it would carry a line
    // nothing can ever print.
    expect(() =>
      userMeResponseSchema.parse({
        user: {
          id: 1,
          username: null,
          email: "e@x.org",
          github_username: null,
          role: "user",
          profile_gaps: [{ blocks: ["upload_access"] }],
        },
        token: null,
      }),
    ).toThrow();
  });
});

describe("neuroschema dataset schema", () => {
  test("pins the v0.4.0 envelope + required identity fields", () => {
    expect(NEUROSCHEMA_VERSION).toBe("0.4.0");
    const ds = {
      schema_version: "0.4.0",
      doc_type: "dataset",
      dataset_id: "nm000108",
      name: "Test",
      source: "nemar",
      recording_modality: ["EEG"],
    };
    expect(() => neuroschemaDatasetSchema.parse(ds)).not.toThrow();
  });

  test("rejects a wrong schema_version or empty modality", () => {
    const base = {
      schema_version: "0.4.0",
      doc_type: "dataset",
      dataset_id: "nm000108",
      name: "T",
      source: "nemar",
      recording_modality: ["EEG"],
    };
    expect(() => neuroschemaDatasetSchema.parse({ ...base, schema_version: "0.2.0" })).toThrow();
    expect(() => neuroschemaDatasetSchema.parse({ ...base, recording_modality: [] })).toThrow();
  });
});
