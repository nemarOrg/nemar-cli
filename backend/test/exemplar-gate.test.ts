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

/**
 * The anonymity term, and the intent that narrows it (#1423).
 *
 * The term exists so the fleet's standing anonymous deposit cannot be
 * published for real: the approve path would stamp `first_published_at`, and
 * migration 0085's triggers then refuse `anonymous = 1` on that row forever,
 * destroying the fixture rather than dirtying it.
 *
 * It was refusing an ANONYMOUS RELEASE too, which cannot do any of that --
 * `FIRST_PUBLICATION_STAMP_SQL` leaves an anonymous row unstamped on purpose.
 * Since the anonymous release is the only path that runs `repo_public` and
 * `create_tag`, refusing it meant the fixture could never have a public row, a
 * version or a manifest, so every public-facing anonymity surface was
 * unreachable by the fixture built to exercise them.
 */
describe("isExemplarPublishAllowed: the anonymous deposit", () => {
  const anonRow = { dataset_id: EXEMPLAR_ID, is_exemplar: 1, anonymous: 1 };
  const plainRow = { dataset_id: EXEMPLAR_ID, is_exemplar: 1, anonymous: 0 };

  test("an anonymous exemplar is refused every direction, with no way to ask", () => {
    // Withdrawn in #1433. The gate briefly took an `anonymousRelease` intent so
    // the fleet's anonymous deposit could take the one publish path it needed
    // (#1423). That fixture was in the wrong band: `xx` publishes only through
    // the exemplar exception, so widening the exception was the only way to let
    // it live there. It now lives at a reserved `nm` id where an anonymous
    // release is an ordinary publication, and the parameter went with it.
    expect(isExemplarPublishAllowed(envOf("test"), anonRow)).toBe(false);
  });

  test("the term is a LIVE guard: the admin route can still create such a row", () => {
    // Not unreachable, though the fleet no longer declares an anonymous entry.
    // POST /admin/datasets/exemplar still accepts `anonymous: true` and writes
    // it with is_exemplar = 1 on an xx0999NN id (routes/admin/exemplar.ts), so
    // an admin can create exactly this row today. #1434 retires that field.
    // Publishing such a row destroys it rather than dirtying it: the approve
    // path stamps first_published_at, after which migration 0085's triggers
    // refuse anonymous = 1 on it forever.
    expect(isExemplarPublishAllowed(envOf("test"), anonRow)).toBe(false);
    expect(isExemplarPublishAllowed(envOf("test"), plainRow)).toBe(true);
  });

  test("an ordinary exemplar is allowed off production", () => {
    expect(isExemplarPublishAllowed(envOf("test"), plainRow)).toBe(true);
  });

  test("the production fence holds, and fails closed on an unknown env", () => {
    // The env term is the one that keeps `is_exemplar = 1` out of production
    // entirely. It uses isNonProductionEnv, so an unset value refuses.
    expect(isExemplarPublishAllowed(envOf("production"), plainRow)).toBe(false);
    expect(isExemplarPublishAllowed(envOf(undefined), plainRow)).toBe(false);
    expect(isExemplarPublishAllowed(envOf("production"), anonRow)).toBe(false);
  });

  test("a non-exemplar xx row is still refused", () => {
    // The exemption is for the staging fleet, not for the xx band.
    expect(
      isExemplarPublishAllowed(
        envOf("test"),
        { dataset_id: EXEMPLAR_ID, is_exemplar: 0, anonymous: 1 },
      ),
    ).toBe(false);
  });
});

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
    datasetId: "nm000132",
    version: "v1.0.0",
    bidsPath: "sub-01/eeg/sub-01_task-rest_eeg.edf",
  };

  test("defaults to the prod data host (byte-identical)", () => {
    expect(buildBytesUrl({ ...common })).toBe(
      "https://data.nemar.org/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
    );
  });

  test("staging origin override", () => {
    expect(buildBytesUrl({ ...common, origin: "https://data-test.nemar.org" })).toBe(
      "https://data-test.nemar.org/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
    );
  });

  test("git-backed files follow the same origin as annexed ones (#1403)", () => {
    // They used to return a raw.githubusercontent.com URL regardless of
    // origin, which meant the staging manifest pointed at production's repo
    // content and a private repo had no readable metadata at all.
    expect(buildBytesUrl({ ...common, origin: "https://data-test.nemar.org" })).toBe(
      "https://data-test.nemar.org/nm000132/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
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
