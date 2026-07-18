/**
 * Exemplar gate tests (epic #923, phase 4 / #927).
 *
 * Phase 4 relaxes every hard xx-prefix block to "block unless exemplar-allowed"
 * and every visibility predicate to admit is_exemplar=1 rows. These tests pin the
 * gate's three-part condition (non-prod env AND xx-prefix AND is_exemplar=1), the
 * shared SQL fragment, the exemplar-aware catalog id gate, the reindex filter
 * base, the parameterized bytes_url origin, and the parameterized landing URLs.
 */

import { describe, expect, test } from "bun:test";
import { datasetLandingUrl, datasetVersionLandingUrl } from "../../shared/datacite-constants";
import { buildBytesUrl, isPublicCatalogId } from "../src/services/data-router";
import { buildReindexFilterQuery } from "../src/services/dataset-reindex";
import { exemplarOrFragment, isExemplarPublishAllowed } from "../src/services/exemplar";
import type { Bindings } from "../src/types/bindings";

const EXEMPLAR_ID = "xx099900"; // dev exemplar band, valid id shape (num 99900 <= 99999)
const envOf = (v: unknown) => ({ ENVIRONMENT: v }) as Pick<Bindings, "ENVIRONMENT">;

describe("isExemplarPublishAllowed", () => {
  test("non-production + xx + is_exemplar=1 -> allowed", () => {
    for (const e of ["development", "staging", "test"]) {
      expect(isExemplarPublishAllowed(envOf(e), { dataset_id: EXEMPLAR_ID, is_exemplar: 1 })).toBe(
        true,
      );
    }
  });

  test("production is blocked even for an exemplar row (defense in depth)", () => {
    expect(
      isExemplarPublishAllowed(envOf("production"), { dataset_id: EXEMPLAR_ID, is_exemplar: 1 }),
    ).toBe(false);
  });

  test("fail-closed on unknown/unset env", () => {
    expect(
      isExemplarPublishAllowed(envOf(undefined), { dataset_id: EXEMPLAR_ID, is_exemplar: 1 }),
    ).toBe(false);
    expect(isExemplarPublishAllowed(envOf(""), { dataset_id: EXEMPLAR_ID, is_exemplar: 1 })).toBe(
      false,
    );
  });

  test("non-exemplar rows stay blocked (0, null, undefined)", () => {
    expect(
      isExemplarPublishAllowed(envOf("test"), { dataset_id: EXEMPLAR_ID, is_exemplar: 0 }),
    ).toBe(false);
    expect(
      isExemplarPublishAllowed(envOf("test"), { dataset_id: EXEMPLAR_ID, is_exemplar: null }),
    ).toBe(false);
    expect(isExemplarPublishAllowed(envOf("test"), { dataset_id: EXEMPLAR_ID })).toBe(false);
  });

  test("non-xx ids are never exemplar-allowed, even if flagged", () => {
    expect(
      isExemplarPublishAllowed(envOf("test"), { dataset_id: "nm000132", is_exemplar: 1 }),
    ).toBe(false);
  });
});

describe("exemplarOrFragment", () => {
  test("default and explicit alias", () => {
    expect(exemplarOrFragment()).toBe("d.is_exemplar = 1");
    expect(exemplarOrFragment("d")).toBe("d.is_exemplar = 1");
  });

  test("empty alias -> unqualified column", () => {
    expect(exemplarOrFragment("")).toBe("is_exemplar = 1");
  });
});

describe("isPublicCatalogId exemplar handling", () => {
  test("xx id blocked without the flag, admitted with it", () => {
    expect(isPublicCatalogId(EXEMPLAR_ID)).toBe(false);
    expect(isPublicCatalogId(EXEMPLAR_ID, { isExemplar: false })).toBe(false);
    expect(isPublicCatalogId(EXEMPLAR_ID, { isExemplar: true })).toBe(true);
  });

  test("nm099999 test dataset stays excluded regardless of flag", () => {
    expect(isPublicCatalogId("nm099999", { isExemplar: true })).toBe(false);
  });

  test("malformed ids rejected even when flagged", () => {
    expect(isPublicCatalogId("not-an-id", { isExemplar: true })).toBe(false);
  });

  test("regular public id unaffected", () => {
    expect(isPublicCatalogId("nm000132")).toBe(true);
  });
});

describe("buildReindexFilterQuery exemplar carve-out", () => {
  test("base SQL admits exemplars alongside the xx exclusion", () => {
    const { sql } = buildReindexFilterQuery("all");
    expect(sql).toContain("(dataset_id NOT LIKE 'xx%' OR is_exemplar = 1)");
  });
});

describe("buildBytesUrl origin parameterization", () => {
  const common = {
    githubOrg: "nemarDatasets",
    datasetId: "nm000132",
    version: "v1.0.0",
    bidsPath: "sub-01/eeg/sub-01_task-rest_eeg.edf",
  };

  test("defaults to the prod data host (byte-identical)", () => {
    expect(buildBytesUrl({ ...common, key: "SHA256E-s1--abc" })).toBe(
      "https://data.nemar.org/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
    );
  });

  test("staging origin override", () => {
    expect(
      buildBytesUrl({ ...common, key: "SHA256E-s1--abc", origin: "https://data-test.nemar.org" }),
    ).toBe("https://data-test.nemar.org/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf");
  });

  test("git-backed files ignore origin (raw.githubusercontent)", () => {
    expect(
      buildBytesUrl({ ...common, key: "git:blobsha", origin: "https://data-test.nemar.org" }),
    ).toBe(
      "https://raw.githubusercontent.com/nemarDatasets/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
    );
  });
});

describe("landing URL base parameterization", () => {
  test("defaults to prod apex", () => {
    expect(datasetLandingUrl(EXEMPLAR_ID)).toBe(`https://nemar.org/dataset/${EXEMPLAR_ID}`);
    expect(datasetVersionLandingUrl(EXEMPLAR_ID, "1.0.0")).toBe(
      `https://nemar.org/dataset/${EXEMPLAR_ID}?v=v1.0.0`,
    );
  });

  test("staging base override", () => {
    expect(datasetLandingUrl(EXEMPLAR_ID, "https://test.nemar.org")).toBe(
      `https://test.nemar.org/dataset/${EXEMPLAR_ID}`,
    );
    expect(datasetVersionLandingUrl(EXEMPLAR_ID, "1.0.0", "https://test.nemar.org")).toBe(
      `https://test.nemar.org/dataset/${EXEMPLAR_ID}?v=v1.0.0`,
    );
  });

  test("trailing slash in base is normalized away", () => {
    expect(datasetLandingUrl(EXEMPLAR_ID, "https://test.nemar.org/")).toBe(
      `https://test.nemar.org/dataset/${EXEMPLAR_ID}`,
    );
  });
});
