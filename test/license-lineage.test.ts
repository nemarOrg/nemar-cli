/**
 * The upstream license lineage resolver and rule (epic #2182 card D1, ADR 0139 decision 7).
 *
 * Real code paths only: the resolver runs its real fetches against a local stand-in that serves
 * registry responses recorded on 2026-11-25 (test/fixtures/license-lineage/README.md). Error paths
 * (a timeout, a 5xx, a DOI one registry lacks) are HTTP conditions set on the stand-in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPATIBLE_OUTCOMES,
  LINEAGE_ANCHORS,
  LINEAGE_COPY,
  LINEAGE_DOCS_URL,
  LINEAGE_OUTCOMES,
  type LineageInputs,
  type LineageOutcome,
  MAX_CREATORS,
  MAX_SOURCES,
  type NormalizedLicense,
  OUTCOME_RANK,
  RESOLVER_READ,
  RESOLVER_VERSION,
  SOURCE_STATUSES,
  SOURCE_STATUS_COPY,
  type SourceInputs,
  combineOutcomes,
  crossrefDescribed,
  crossrefLicenses,
  dataciteDescribed,
  dataciteLicenses,
  extractSourceRefs,
  isValidCachedRecord,
  lineageExitCode,
  lineageLines,
  mapCache,
  normalizeLicense,
  openalexDescribed,
  physionetLicense,
  resolveLicenseLineage,
  sourceOutcome,
} from "../shared/license-lineage";
import { type StandIn, startStandIn } from "./fixtures/license-lineage/stand-in";

const FIXTURES = join(import.meta.dir, "fixtures", "license-lineage");
const fixture = (file: string): unknown => JSON.parse(readFileSync(join(FIXTURES, file), "utf-8"));

let standIn: StandIn;
beforeEach(() => {
  standIn = startStandIn();
});
afterEach(() => {
  standIn.stop();
});

function inputs(
  over: Partial<LineageInputs> & { license?: string; sources?: unknown[]; datasetDoi?: string },
): LineageInputs {
  const desc: Record<string, unknown> = { Name: "fixture" };
  if (over.license !== undefined) desc.License = over.license;
  if (over.sources) desc.SourceDatasets = over.sources;
  if (over.datasetDoi) desc.DatasetDOI = over.datasetDoi;
  return {
    datasetDescription:
      over.datasetDescription === undefined ? JSON.stringify(desc) : over.datasetDescription,
    nemarMetadata: over.nemarMetadata ?? null,
    attestationUpstreamSource: over.attestationUpstreamSource ?? null,
    readme: over.readme ?? null,
  };
}

const NO_SOURCES: SourceInputs = {
  datasetDescription: {},
  relatedIdentifiers: null,
  attestationUpstreamSource: null,
  readme: null,
};

function run(i: LineageInputs, timeoutMs = 2_000) {
  return resolveLicenseLineage(i, { bases: standIn.bases, timeoutMs });
}

const ON_CC0 = { DOI: "doi:10.18112/openneuro.ds003645.v2.0.2" };
const ZENODO_NC = { URL: "https://zenodo.org/records/22967622" };
const ZENODO_NC_ND = { DOI: "10.5281/zenodo.21156617" };
const ZENODO_SA = { DOI: "https://doi.org/10.5281/zenodo.24015383" };
const ZENODO_BY = { DOI: "10.5281/zenodo.24539621" };
const PN_ODC_BY = { URL: "https://physionet.org/content/eegmmidb/1.0.0/" };
const PN_CRED = { DOI: "10.13026/5ntk-km72" };
const ARTICLE = { DOI: "10.1038/s41597-019-0027-4" };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("copy tables", () => {
  test("every outcome and every source status has a statement, read, remedy and anchor", () => {
    for (const o of LINEAGE_OUTCOMES) {
      const c = LINEAGE_COPY[o];
      for (const field of [c.statement, c.read, c.remedy, c.anchor])
        expect(field.length).toBeGreaterThan(0);
      expect(c.anchor.startsWith("https://docs.nemar.org/")).toBe(true);
    }
    for (const s of SOURCE_STATUSES) expect(SOURCE_STATUS_COPY[s].remedy.length).toBeGreaterThan(0);
  });

  test("exit codes: 0 only for the three compatible outcomes", () => {
    const zero = LINEAGE_OUTCOMES.filter((o) => lineageExitCode(o) === 0).sort();
    expect(zero).toEqual(["compatible", "compatible_attribution", "compatible_nc"]);
    expect(lineageExitCode("unresolved")).toBe(2);
  });

  test("unresolved is never compatible, and outranks every target-only fix", () => {
    expect(COMPATIBLE_OUTCOMES.has("unresolved")).toBe(false);
    expect(OUTCOME_RANK.unresolved).toBeGreaterThan(OUTCOME_RANK.share_alike_mismatch);
    expect(OUTCOME_RANK.unresolved).toBeLessThan(OUTCOME_RANK.needs_permission);
    expect(OUTCOME_RANK.redistribution_prohibited).toBeGreaterThan(OUTCOME_RANK.needs_permission);
  });
});

// ---------------------------------------------------------------------------
// Normalization and filters
// ---------------------------------------------------------------------------

describe("normalizeLicense", () => {
  const cases: Array<[string | null, NormalizedLicense, string | null]> = [
    ["CC0", "cc0", "1.0"],
    ["CC0-1.0", "cc0", "1.0"],
    ["https://creativecommons.org/publicdomain/zero/1.0/", "cc0", "1.0"],
    ["PDDL-1.0", "pddl", "1.0"],
    ["CC-BY-4.0", "cc-by", "4.0"],
    ["cc-by-nc-4.0", "cc-by-nc", "4.0"],
    ["https://creativecommons.org/licenses/by-nc-sa/3.0/", "cc-by-nc-sa", "3.0"],
    ["https://creativecommons.org/licenses/by-sa/4.0/legalcode", "cc-by-sa", "4.0"],
    ["http://creativecommons.org/licenses/by-nd/2.5", "cc-by-nd", "2.5"],
    [
      "Creative Commons Attribution Non Commercial No Derivatives 4.0 International",
      "cc-by-nc-nd",
      "4.0",
    ],
    ["CC BY-NC-SA 4.0", "cc-by-nc-sa", "4.0"],
    ["ODC-By-1.0", "odc-by", "1.0"],
    ["Open Data Commons Attribution License v1.0", "odc-by", "1.0"],
    ["ODbL-1.0", "odbl", "1.0"],
    ["https://opendatacommons.org/licenses/odbl/1-0/", "odbl", null],
    ["PhysioNet Credentialed Health Data License 1.5.0", "physionet-credentialed", "1.5"],
    ["PhysioNet Restricted Health Data License 1.5.0", "physionet-restricted", "1.5"],
    ["All rights reserved", "restricted", null],
    // Software licenses applied to data (lead ruling 2026-11-25): one family per line.
    ["MIT", "permissive-attribution", null],
    ["https://opensource.org/licenses/MIT", "permissive-attribution", null],
    ["BSD-2-Clause", "permissive-attribution", null],
    ["BSD-3-Clause", "permissive-attribution", null],
    ['BSD 3-Clause "New" or "Revised" License', "permissive-attribution", null],
    ["Apache-2.0", "permissive-attribution", "2.0"],
    ["Apache License, Version 2.0", "permissive-attribution", "2.0"],
    ["https://www.apache.org/licenses/LICENSE-2.0", "permissive-attribution", "2.0"],
    // Versions and clauses outside the ruling stay unrecognized.
    ["BSD-4-Clause", "other", null],
    ["Apache-1.1", "other", null],
    ["GPL-3.0", "other", null],
    ["https://creativecommons.org/publicdomain/mark/1.0/", "cc0", "1.0"],
    ["Public Domain Mark 1.0", "cc0", "1.0"],
    ["public-domain", "cc0", null],
    ["", "none", null],
    [null, "none", null],
  ];
  for (const [text, license, version] of cases) {
    test(`${JSON.stringify(text)} -> ${license}`, () => {
      expect(normalizeLicense(text)).toEqual({ license, version });
    });
  }
});

describe("physionetLicense", () => {
  test("a non-open access policy decides, whatever the license name says", () => {
    const odcBy = "Open Data Commons Attribution License v1.0";
    expect(physionetLicense(odcBy, "Open").license).toBe("odc-by");
    expect(physionetLicense(odcBy, "Credentialed").license).toBe("physionet-credentialed");
    expect(physionetLicense(odcBy, "Restricted").license).toBe("physionet-restricted");
    expect(physionetLicense(odcBy, "Contributor Review").license).toBe("physionet-restricted");
    expect(physionetLicense(null, null).license).toBe("none");
  });
});

describe("filters", () => {
  test("DataCite access-rights URIs are not licenses", () => {
    const { values } = dataciteLicenses([
      { rights: "Open Access", rightsUri: "info:eu-repo/semantics/openAccess" },
      { rights: "Creative Commons Attribution 4.0 International", rightsIdentifier: "cc-by-4.0" },
    ]);
    expect(values.map((v) => v.license)).toEqual(["cc-by"]);
    // And alone, an access-rights statement leaves no license at all.
    expect(
      dataciteLicenses([{ rightsUri: "info:eu-repo/semantics/restrictedAccess" }]).values,
    ).toEqual([]);
  });

  test("Crossref keeps only vor or unspecified, never TDM or STM-ASF terms (real record)", () => {
    const rec = fixture("18-crossref-article.json") as { message: { license: unknown } };
    const { raws } = crossrefLicenses(rec.message.license);
    // The recorded article lists the same URL twice: once as tdm, once as vor.
    expect(raws).toEqual(["https://creativecommons.org/licenses/by/4.0"]);
    const { values } = crossrefLicenses([
      { URL: "https://www.elsevier.com/tdm/userlicense/1.0/", "content-version": "unspecified" },
      { URL: "https://creativecommons.org/licenses/by-nc/4.0/", "content-version": "am" },
      { URL: "https://example.org/stm-asf/terms", "content-version": "stm-asf" },
      { URL: "https://creativecommons.org/licenses/by-nd/4.0/", "content-version": "vor" },
    ]);
    expect(values.map((v) => v.license)).toEqual(["cc-by-nd"]);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe("extractSourceRefs", () => {
  test("decided order, URL forms mapped to DOIs, de-duplicated", () => {
    const refs = extractSourceRefs({
      datasetDescription: {
        SourceDatasets: [
          { URL: "https://openneuro.org/datasets/ds003645/versions/2.0.2" },
          { URL: "https://openneuro.org/datasets/ds000117", Version: "1.0.5" },
          { URL: "https://openneuro.org/datasets/ds004362" },
          { URL: "https://zenodo.org/records/123" },
          { URL: "https://physionet.org/content/eegmmidb/1.0.0/" },
          { URL: "https://example.org/somewhere" },
        ],
      },
      relatedIdentifiers: [
        {
          identifier: "10.18112/openneuro.ds003645.v2.0.2",
          identifier_type: "DOI",
          relation_type: "IsDerivedFrom",
        },
        { identifier: "10.5281/zenodo.9", identifier_type: "DOI", relation_type: "IsIdenticalTo" },
        { identifier: "10.1038/paper", identifier_type: "DOI", relation_type: "IsReferencedBy" },
      ],
      attestationUpstreamSource: "Converted from https://doi.org/10.1234/any.publisher.doi",
      readme:
        "Cite 10.1038/s41597-019-0027-4 and 10.6084/m9.figshare.6427334.v5, raw at https://zenodo.org/records/123.",
    });
    expect(refs.map((r) => [r.origin, r.kind === "doi" ? r.doi : r.kind])).toEqual([
      ["source_datasets", "10.18112/openneuro.ds003645.v2.0.2"],
      ["source_datasets", "10.18112/openneuro.ds000117.v1.0.5"],
      ["source_datasets", "openneuro_latest"],
      ["source_datasets", "10.5281/zenodo.123"],
      ["source_datasets", "physionet"],
      ["source_datasets", "url"],
      ["related_identifiers", "10.5281/zenodo.9"],
      ["attestation", "10.1234/any.publisher.doi"],
      // The README's article DOI is not a source; its data-repository DOI is.
      ["readme", "10.6084/m9.figshare.6427334.v5"],
    ]);
  });

  test("the attestation takes any DOI, the README only data-repository DOIs", () => {
    const text = "Data: 10.1016/j.neuroimage.2020.116000";
    expect(extractSourceRefs({ ...NO_SOURCES, attestationUpstreamSource: text })).toHaveLength(1);
    expect(extractSourceRefs({ ...NO_SOURCES, readme: text })).toHaveLength(0);
  });

  test("the dataset's own DOIs are not its sources", () => {
    const own = "10.5281/zenodo.24539621";
    const readme = `Cite this dataset: https://doi.org/${own} and 10.82901/nemar.nm000480.v1.0.0. Raw: 10.5281/zenodo.22967622`;
    const refs = extractSourceRefs({
      datasetDescription: { DatasetDOI: `doi:${own}`, SourceDatasets: [{ DOI: own }] },
      relatedIdentifiers: null,
      attestationUpstreamSource: null,
      readme,
    });
    expect(refs.map((r) => (r.kind === "doi" ? r.doi : r.kind))).toEqual([
      "10.5281/zenodo.22967622",
    ]);
    // A NEMAR DOI is still a source where a depositor declares one (a NEMAR dataset derived from another).
    const declared = extractSourceRefs({
      ...NO_SOURCES,
      datasetDescription: { SourceDatasets: [{ DOI: "10.82901/nemar.nm000103" }] },
    });
    expect(declared).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Every outcome, from recorded responses
// ---------------------------------------------------------------------------

describe("resolveLicenseLineage, one source", () => {
  test("OpenNeuro: DataCite has no rights, the snapshot's License is CC0 -> compatible", async () => {
    const r = await run(inputs({ license: "CC0", sources: [ON_CC0] }));
    expect(r.outcome).toBe("compatible");
    expect(r.sources[0]).toMatchObject({
      id: "10.18112/openneuro.ds003645.v2.0.2",
      resolver: "openneuro",
      resource_type: "Dataset",
      license: "cc0",
      status: "resolved",
      evidence_url: "https://openneuro.org/datasets/ds003645/versions/2.0.2",
    });
    expect(standIn.misses).toEqual([]);
  });

  test("OpenNeuro without a version: the latest version record from DataCite", async () => {
    const r = await run(
      inputs({ license: "CC0", sources: [{ URL: "https://openneuro.org/datasets/ds003645" }] }),
    );
    expect(r.sources[0].id).toBe("10.18112/openneuro.ds003645.v2.1.0");
    expect(r.outcome).toBe("compatible");
    expect(standIn.misses).toEqual([]);
  });

  test("PhysioNet open ODC-By (by URL) -> compatible_attribution, with its DOI", async () => {
    const r = await run(inputs({ license: "CC0", sources: [PN_ODC_BY] }));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources[0]).toMatchObject({
      id: "10.13026/c28g6p",
      resolver: "physionet",
      license: "odc-by",
    });
    expect(r.sources[0].evidence_url).toEndWith("/api/v1/project/published/eegmmidb/1.0.0/");
  });

  test("PhysioNet by DOI with an unversioned landing page reads the latest version", async () => {
    const r = await run(inputs({ license: "CC0", sources: [{ DOI: "10.13026/C28G6P" }] }));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources[0].resolver).toBe("physionet");
    expect(standIn.misses).toEqual([]);
  });

  test("PhysioNet credentialed -> redistribution_prohibited", async () => {
    const r = await run(inputs({ license: "CC0", sources: [PN_CRED] }));
    expect(r.outcome).toBe("redistribution_prohibited");
    expect(r.sources[0].license).toBe("physionet-credentialed");
  });

  test("Zenodo CC-BY-NC: NC target -> compatible_nc; NC dropped -> needs_permission", async () => {
    expect((await run(inputs({ license: "CC-BY-NC-4.0", sources: [ZENODO_NC] }))).outcome).toBe(
      "compatible_nc",
    );
    const dropped = await run(inputs({ license: "CC0", sources: [ZENODO_NC] }));
    expect(dropped.outcome).toBe("needs_permission");
    expect(dropped.sources[0]).toMatchObject({
      id: "10.5281/zenodo.22967622",
      resolver: "datacite",
      license: "cc-by-nc",
    });
  });

  test("an ND record -> needs_permission", async () => {
    const r = await run(inputs({ license: "CC-BY-NC-ND-4.0", sources: [ZENODO_NC_ND] }));
    expect(r.outcome).toBe("needs_permission");
    expect(r.sources[0].license).toBe("cc-by-nc-nd");
  });

  test("share-alike: same SA -> attribution; earlier version or other target -> mismatch", async () => {
    expect((await run(inputs({ license: "CC-BY-SA-4.0", sources: [ZENODO_SA] }))).outcome).toBe(
      "compatible_attribution",
    );
    expect((await run(inputs({ license: "CC-BY-SA-3.0", sources: [ZENODO_SA] }))).outcome).toBe(
      "share_alike_mismatch",
    );
    // The source names 4.0 and the target names no version: not shown to match.
    expect((await run(inputs({ license: "CC BY-SA", sources: [ZENODO_SA] }))).outcome).toBe(
      "share_alike_mismatch",
    );
    expect((await run(inputs({ license: "CC0", sources: [ZENODO_SA] }))).outcome).toBe(
      "share_alike_mismatch",
    );
  });

  test("an article DOI: DataCite lacks it, Crossref says journal-article -> source_is_publication", async () => {
    const r = await run(inputs({ license: "CC0", sources: [ARTICLE] }));
    expect(r.outcome).toBe("source_is_publication");
    expect(r.sources[0]).toMatchObject({
      resolver: "crossref",
      resource_type: "journal-article",
      status: "publication",
    });
    expect(standIn.misses).toEqual([]);
  });

  test("a DOI neither DataCite nor Crossref has falls to OpenAlex", async () => {
    standIn.override("crossref /works/10.1038/s41597", { status: 404 });
    const r = await run(inputs({ license: "CC0", sources: [ARTICLE] }));
    expect(r.sources[0]).toMatchObject({
      resolver: "openalex",
      resource_type: "data-paper",
      license: "cc-by",
    });
    expect(r.outcome).toBe("source_is_publication");
  });

  test("an OpenAlex dataset with no license -> needs_permission", async () => {
    standIn.override("datacite /dois/10.18112/openneuro.ds003645.v2.0.2", { status: 404 });
    standIn.override("crossref /works/10.18112", { status: 404 });
    const r = await run(inputs({ license: "CC0", sources: [ON_CC0] }));
    expect(r.sources[0]).toMatchObject({
      resolver: "openalex",
      resource_type: "dataset",
      license: "none",
    });
    expect(r.outcome).toBe("needs_permission");
  });

  test("no source -> no_upstream_declared; a URL with no DOI -> unresolved", async () => {
    expect((await run(inputs({ license: "CC0" }))).outcome).toBe("no_upstream_declared");
    const r = await run(inputs({ license: "CC0", sources: [{ URL: "https://example.org/data" }] }));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0].status).toBe("no_doi");
    expect(standIn.requests).toEqual([]);
  });
});

describe("unresolved: a fetch error is never compatible", () => {
  test("a timeout -> unresolved, and it does not fall through to another registry", async () => {
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { delayMs: 600 });
    const r = await run(inputs({ license: "CC0", sources: [ZENODO_BY] }), 150);
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0].status).toBe("fetch_failed");
    expect(standIn.requests.some((k) => k.includes("crossref"))).toBe(false);
  });

  test("a 503 -> unresolved", async () => {
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 503 });
    expect((await run(inputs({ license: "CC0", sources: [ZENODO_BY] }))).outcome).toBe(
      "unresolved",
    );
  });

  test("a repository API failing after DataCite answered -> unresolved, not none", async () => {
    standIn.override("openneuro /crn/graphql", { status: 502 });
    const r = await run(inputs({ license: "CC0", sources: [ON_CC0] }));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0].license).toBeNull();
  });

  test("answers are cached per DOI, failures are not", async () => {
    const cache = mapCache();
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 503 });
    await resolveLicenseLineage(inputs({ license: "CC0", sources: [ZENODO_BY] }), {
      bases: standIn.bases,
      cache,
    });
    standIn.stop();
    standIn = startStandIn();
    const first = await resolveLicenseLineage(inputs({ license: "CC0", sources: [ZENODO_BY] }), {
      bases: standIn.bases,
      cache,
    });
    expect(first.outcome).toBe("compatible_attribution");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("datacite", { status: 503 });
    const second = await resolveLicenseLineage(inputs({ license: "CC0", sources: [ZENODO_BY] }), {
      bases: standIn.bases,
      cache,
    });
    expect(second.outcome).toBe("compatible_attribution");
  });

  test(`more than ${MAX_SOURCES} sources: the rest are not_checked and the outcome is unresolved`, async () => {
    const many = Array.from({ length: MAX_SOURCES + 1 }, () => ZENODO_BY).map((s, i) =>
      i === 0 ? s : { URL: `https://zenodo.org/records/24539621${i}` },
    );
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 404 });
    const r = await resolveLicenseLineage(inputs({ license: "CC0", sources: many }), {
      bases: standIn.bases,
      timeoutMs: 2_000,
    });
    expect(r.sources).toHaveLength(MAX_SOURCES + 1);
    expect(r.sources[MAX_SOURCES].status).toBe("not_checked");
    expect(r.sources.slice(0, MAX_SOURCES).every((s) => s.status !== "not_checked")).toBe(true);
    expect(r.outcome).not.toBe("compatible");
  });
});

// ---------------------------------------------------------------------------
// Two sources, and the lattice
// ---------------------------------------------------------------------------

describe("input files", () => {
  test("a missing description is unresolved, never no_upstream_declared, and nothing is fetched", async () => {
    const r = await run(inputs({ datasetDescription: null }));
    expect(r.inputs.dataset_description).toBe("missing");
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0]).toMatchObject({
      id: "dataset_description.json",
      status: "description_unreadable",
    });
    expect(standIn.requests).toEqual([]);
  });

  test("a description that is not JSON, or not an object, is unparseable and unresolved", async () => {
    for (const text of ["{ not json", "[]", "null"]) {
      const r = await run(inputs({ datasetDescription: text }));
      expect(r.inputs.dataset_description).toBe("unparseable");
      expect(r.outcome).toBe("unresolved");
      expect(r.sources[0].status).toBe("description_unreadable");
    }
    expect(SOURCE_STATUS_COPY.description_unreadable.statement).toContain(
      "dataset_description.json",
    );
  });

  test("an unparseable .nemar/metadata.json is reported, and makes a compatible result unresolved", async () => {
    const r = await run(inputs({ license: "CC0", sources: [ON_CC0], nemarMetadata: "{oops" }));
    expect(r.inputs.nemar_metadata).toBe("unparseable");
    expect(r.sources.map((s) => s.status)).toEqual(["resolved", "metadata_unreadable"]);
    expect(r.outcome).toBe("unresolved");
    const missing = await run(inputs({ license: "CC0", sources: [ON_CC0] }));
    expect(missing.inputs.nemar_metadata).toBe("missing");
    expect(missing.outcome).toBe("compatible");
  });

  test("enrichment related identifiers are read from .nemar/metadata.json", async () => {
    const meta = JSON.stringify({
      related_identifiers: [
        {
          identifier: "10.5281/zenodo.24539621",
          identifier_type: "DOI",
          relation_type: "IsDerivedFrom",
        },
      ],
    });
    const r = await run(inputs({ license: "CC0", nemarMetadata: meta }));
    expect(r.inputs.nemar_metadata).toBe("read");
    expect(r.sources[0]).toMatchObject({ origin: "related_identifiers", license: "cc-by" });
  });
});

describe("a 200 that is not a record: unparseable, unresolved", () => {
  const cases: Array<[string, string, string]> = [
    [
      "HTML",
      "datacite /dois/10.5281/zenodo.24539621",
      "<!doctype html><html><body>Service page</body></html>",
    ],
    ["{}", "datacite /dois/10.5281/zenodo.24539621", "{}"],
    ["an array", "datacite /dois/10.5281/zenodo.24539621", "[]"],
  ];
  for (const [name, route, body] of cases) {
    test(`DataCite answering ${name}`, async () => {
      standIn.override(route, { status: 200, body });
      const r = await run(inputs({ license: "CC0", sources: [ZENODO_BY] }));
      expect(r.sources[0].status).toBe("unparseable");
      expect(r.outcome).toBe("unresolved");
    });
  }

  test("OpenNeuro GraphQL answering {errors, data: null}", async () => {
    standIn.override("openneuro /crn/graphql", {
      status: 200,
      body: JSON.stringify({ errors: [{ message: "Internal error" }], data: null }),
    });
    const r = await run(inputs({ license: "CC0", sources: [ON_CC0] }));
    expect(r.sources[0].status).toBe("unparseable");
    expect(r.outcome).toBe("unresolved");
  });

  test("a PhysioNet record with no access policy, or a non-string one", async () => {
    const rec = fixture("10-physionet-physionet-credentialed.json") as Record<string, unknown>;
    for (const policy of [undefined, 3]) {
      standIn.stop();
      standIn = startStandIn();
      const { access_policy: _dropped, ...rest } = rec;
      const body = policy === undefined ? rest : { ...rest, access_policy: policy };
      standIn.override("physionet /api/v1/project/published/mimic-iv-ed/2.2/", {
        status: 200,
        body: JSON.stringify(body),
      });
      const r = await run(inputs({ license: "CC0", sources: [PN_CRED] }));
      expect(r.sources[0].status).toBe("unparseable");
      expect(r.outcome).toBe("unresolved");
    }
  });
});

describe("cached hits", () => {
  test("a hit with a status outside the vocabulary, or a failure, is a miss", async () => {
    const good = (await run(inputs({ license: "CC0", sources: [ZENODO_BY] }))).sources[0];
    const { origin: _o, outcome: _x, ...record } = good;
    expect(isValidCachedRecord(record)).toBe(true);
    expect(isValidCachedRecord({ ...record, status: "fine" })).toBe(false);
    expect(isValidCachedRecord({ ...record, status: "fetch_failed" })).toBe(false);
    expect(isValidCachedRecord({ ...record, license: "beerware" })).toBe(false);
    expect(isValidCachedRecord(null)).toBe(false);
    // A record written before the descriptive fields existed is a miss, never served.
    const { creators: _c, ...older } = record;
    expect(isValidCachedRecord(older)).toBe(false);
  });

  test("a bad hit is fetched again", async () => {
    const cache = mapCache();
    await cache.put(`${RESOLVER_VERSION}:doi:10.5281/zenodo.24539621`, {
      id: "10.5281/zenodo.24539621",
      status: "bogus",
    } as never);
    const r = await resolveLicenseLineage(inputs({ license: "CC0", sources: [ZENODO_BY] }), {
      bases: standIn.bases,
      cache,
    });
    expect(r.outcome).toBe("compatible_attribution");
    expect(standIn.requests.some((k) => k.includes("zenodo.24539621"))).toBe(true);
  });
});

describe("two sources", () => {
  test("CC0 + CC BY -> compatible_attribution", async () => {
    expect((await run(inputs({ license: "CC0", sources: [ON_CC0, ZENODO_BY] }))).outcome).toBe(
      "compatible_attribution",
    );
  });

  test("CC0 + credentialed -> redistribution_prohibited", async () => {
    expect((await run(inputs({ license: "CC0", sources: [ON_CC0, PN_CRED] }))).outcome).toBe(
      "redistribution_prohibited",
    );
  });

  test("NC + a non-NC SA source conflict -> needs_permission even with an NC-SA target", async () => {
    const r = await run(inputs({ license: "CC-BY-NC-SA-4.0", sources: [ZENODO_NC, ZENODO_SA] }));
    expect(r.sources.map((s) => s.outcome)).toEqual(["compatible_nc", "share_alike_mismatch"]);
    expect(r.outcome).toBe("needs_permission");
  });

  test("a fetch failure beside a compatible source -> unresolved", async () => {
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 500 });
    expect((await run(inputs({ license: "CC0", sources: [ON_CC0, ZENODO_BY] }))).outcome).toBe(
      "unresolved",
    );
  });

  test("a known blocker outranks a fetch failure", async () => {
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 500 });
    expect(
      (await run(inputs({ license: "CC0", sources: [ZENODO_NC_ND, ZENODO_BY] }))).outcome,
    ).toBe("needs_permission");
  });

  test("an article beside a dataset -> source_is_publication", async () => {
    expect((await run(inputs({ license: "CC0", sources: [ON_CC0, ARTICLE] }))).outcome).toBe(
      "source_is_publication",
    );
  });
});

describe("the rule, per license", () => {
  const resolved = (license: NormalizedLicense, version: string | null = null) => ({
    status: "resolved" as const,
    license,
    license_version: version,
  });
  const t = (text: string) => normalizeLicense(text);
  const table: Array<[NormalizedLicense, string, LineageOutcome]> = [
    ["cc0", "CC-BY-4.0", "compatible"],
    ["pddl", "CC0", "compatible"],
    ["odc-by", "CC0", "compatible_attribution"],
    ["permissive-attribution", "CC0", "compatible_attribution"],
    ["permissive-attribution", "CC-BY-NC-4.0", "compatible_attribution"],
    ["cc-by-nc", "CC-BY-NC-SA-4.0", "compatible_nc"],
    ["cc-by-nc-sa", "CC-BY-NC-SA-4.0", "compatible_nc"],
    ["cc-by-nc-sa", "CC-BY-NC-4.0", "share_alike_mismatch"],
    ["cc-by-nc-sa", "CC-BY-SA-4.0", "needs_permission"],
    ["odbl", "ODbL-1.0", "compatible_attribution"],
    ["odbl", "CC-BY-4.0", "share_alike_mismatch"],
    ["cc-by-nd", "CC-BY-ND-4.0", "needs_permission"],
    ["restricted", "CC0", "needs_permission"],
    ["other", "CC0", "needs_permission"],
    ["none", "CC0", "needs_permission"],
    ["physionet-restricted", "CC-BY-NC-ND-4.0", "redistribution_prohibited"],
  ];
  for (const [source, target, outcome] of table) {
    test(`${source} -> ${target}: ${outcome}`, () => {
      expect(sourceOutcome(resolved(source), t(target))).toBe(outcome);
    });
  }

  test("ODbL with CC-BY-SA conflicts even when each alone matches the target", () => {
    expect(
      combineOutcomes([
        { outcome: "compatible_attribution", license: "odbl" },
        { outcome: "share_alike_mismatch", license: "cc-by-sa" },
      ]),
    ).toBe("needs_permission");
  });

  test("the most restrictive outcome wins, in both orders", () => {
    const a = { outcome: "compatible" as const, license: "cc0" as const };
    const b = {
      outcome: "redistribution_prohibited" as const,
      license: "physionet-credentialed" as const,
    };
    expect(combineOutcomes([a, b])).toBe("redistribution_prohibited");
    expect(combineOutcomes([b, a])).toBe("redistribution_prohibited");
    expect(combineOutcomes([])).toBe("no_upstream_declared");
  });

  test("every outcome is reached by this file", () => {
    // A guard that the list above and the recorded cases cover the closed union.
    const reached: LineageOutcome[] = [
      "compatible",
      "compatible_attribution",
      "compatible_nc",
      "share_alike_mismatch",
      "needs_permission",
      "redistribution_prohibited",
      "source_is_publication",
      "no_upstream_declared",
      "unresolved",
    ];
    expect([...reached].sort()).toEqual([...LINEAGE_OUTCOMES].sort());
  });
});

describe("lineageLines", () => {
  test("prints the outcome, each source with its evidence, the remedy and the docs link", async () => {
    const r = await run(inputs({ license: "CC0", sources: [ZENODO_NC] }));
    const text = lineageLines(r).join("\n");
    expect(text).toContain("License lineage: needs_permission");
    expect(text).toContain("10.5281/zenodo.22967622");
    expect(text).toContain(`evidence: ${standIn.bases.datacite}/dois/10.5281%2Fzenodo.22967622`);
    expect(text).toContain(LINEAGE_COPY.needs_permission.remedy);
    expect(text).toContain(LINEAGE_COPY.needs_permission.anchor);
    expect(text).toContain(`Resolver: ${RESOLVER_VERSION}`);
    expect(text).toContain(`read: ${RESOLVER_READ.datacite}`);
    expect(text).toContain(`Read: ${LINEAGE_COPY.needs_permission.read}`);
  });

  test("every anchor used is one A10 creates", () => {
    const used = [
      ...Object.values(LINEAGE_COPY).map((c) => c.anchor),
      ...Object.values(SOURCE_STATUS_COPY).map((c) => c.anchor),
    ];
    for (const a of used) {
      expect(a.startsWith(`${LINEAGE_DOCS_URL}#`)).toBe(true);
      expect(LINEAGE_ANCHORS).toContain(a.slice(a.indexOf("#") + 1));
    }
  });
});

describe("each record's title, creators and publisher, from the recorded responses (card B4)", () => {
  const fixture = (file: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures/license-lineage", file), "utf-8"));

  test("DataCite: an OpenNeuro snapshot is described by its DataCite record", async () => {
    const [src] = (await run(inputs({ license: "CC0", sources: [ON_CC0] }))).sources;
    expect(src).toMatchObject({
      resolver: "openneuro",
      title: "Face processing MEEG dataset with HED annotation",
      publisher: "OpenNeuro",
    });
    expect(src?.creators.slice(0, 2)).toEqual(["Daniel G. Wakeman", "Richard N Henson"]);
  });

  test("DataCite: a Zenodo record", async () => {
    const [src] = (await run(inputs({ license: "CC0", sources: [ZENODO_BY] }))).sources;
    expect(src).toMatchObject({
      resolver: "datacite",
      title:
        "Dataset S1: B98 rat 40 Hz click-train EEG exports (filtered and unfiltered) and stimulus channel",
      creators: ["Digavalli, Sivarao V.", "Gautam, Deepshila", "Oprisan, Sorinel A."],
      publisher: "Zenodo",
    });
  });

  test("PhysioNet: the project's title, and PhysioNet as the publisher", async () => {
    const [src] = (await run(inputs({ license: "CC0", sources: [PN_ODC_BY] }))).sources;
    expect(src).toMatchObject({
      resolver: "physionet",
      title: "EEG Motor Movement/Imagery Dataset",
      creators: [],
      publisher: "PhysioNet",
    });
  });

  test("Crossref: an article DataCite does not hold", async () => {
    const [src] = (await run(inputs({ license: "CC0", sources: [ARTICLE] }))).sources;
    expect(src).toMatchObject({
      resolver: "crossref",
      title: "Multi-channel EEG recordings during a sustained-attention driving task",
      publisher: "Springer Science and Business Media LLC",
    });
    expect(src?.creators.slice(0, 2)).toEqual(["Zehong Cao", "Chun-Hsiang Chuang"]);
  });

  test("OpenAlex: the title, the authorships' names and the location's host", () => {
    expect(openalexDescribed(fixture("20-openalex-openalex-dataset.json"))).toEqual({
      title: "Face processing MEEG dataset with HED annotation",
      creators: expect.arrayContaining(["Daniel G. Wakeman", "Richard N. Henson"]),
      publisher: "OpenNeuro",
    });
    const article = openalexDescribed(fixture("19-openalex-article.json"));
    expect(article.title).toBe(
      "Multi-channel EEG recordings during a sustained-attention driving task",
    );
    expect(article.publisher).toBe("Nature Portfolio");
  });

  test("at most ten creators, and a record with none of the fields is described by nulls", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `Person ${i}` }));
    expect(dataciteDescribed({ creators: many }).creators).toHaveLength(MAX_CREATORS);
    expect(crossrefDescribed({ author: many }).creators).toHaveLength(MAX_CREATORS);
    expect(dataciteDescribed({})).toEqual({ title: null, creators: [], publisher: null });
    expect(dataciteDescribed({ publisher: { name: "Zenodo" } }).publisher).toBe("Zenodo");
    expect(crossrefDescribed(fixture("18-crossref-article.json").message).creators.length).toBe(4);
  });
});
