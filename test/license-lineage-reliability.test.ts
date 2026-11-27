/**
 * License lineage reliability (epic #2449 phase 3, ADR 0142 decision 3): failed fetches asked again
 * within a budget, no `unresolved` source served from the cache, `resolved_at`, osf.io sources,
 * README DOI candidates cut short, and the source's declared license beside the normalized word.
 *
 * Real code paths only: the resolver runs its real fetches against the local stand-in serving the
 * responses recorded from the public registries (test/fixtures/license-lineage/README.md, files 21
 * to 29 recorded on 2026-11-27). Transient failures are HTTP conditions set on the stand-in for the
 * first N requests, the HTTP-fixture pattern `.rules/testing.md` allows for retry logic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LINEAGE_RETRY,
  LINEAGE_RETRY_WINDOW_MS,
  type LineageInputs,
  type LineageResult,
  MAX_DECLARED_LICENSE_LENGTH,
  MAX_RETRY_AFTER_MS,
  NO_RETRY,
  RESOLVER_VERSION,
  type ResolveOptions,
  dataciteLicenses,
  declaredLicenseWords,
  extractSources,
  isCutDoiCandidate,
  isValidCachedRecord,
  lineageLines,
  mapCache,
  osfDoiOfUrl,
  resolveLicenseLineage,
} from "../shared/license-lineage";
import { type StandIn, startStandIn } from "./fixtures/license-lineage/stand-in";

let standIn: StandIn;
let waits: number[];
beforeEach(() => {
  standIn = startStandIn();
  waits = [];
});
afterEach(() => {
  standIn.stop();
});

/** Waits are recorded, not slept: the policy is what is under test, not the timer. */
const recordSleep = async (ms: number) => {
  waits.push(ms);
};

function inputs(license: string, sources: unknown[] = [], readme: string | null = null) {
  return {
    datasetDescription: JSON.stringify({
      Name: "fixture",
      License: license,
      SourceDatasets: sources,
    }),
    nemarMetadata: null,
    attestationUpstreamSource: null,
    readme,
  } satisfies LineageInputs;
}

function run(i: LineageInputs, over: ResolveOptions = {}) {
  return resolveLicenseLineage(i, { bases: standIn.bases, sleep: recordSleep, ...over });
}

const ZENODO_BY = { DOI: "10.5281/zenodo.24539621" };
const ZENODO_BY_KEY = "datacite /dois/10.5281/zenodo.24539621";
const count = (part: string) => standIn.requests.filter((k) => k.includes(part)).length;

describe("resolver version", () => {
  test("is 3, since outcomes change", () => {
    expect(RESOLVER_VERSION).toBe("license-lineage/3");
  });
});

// ---------------------------------------------------------------------------
// (1) Re-resolve: retries, budget, cache, resolved_at
// ---------------------------------------------------------------------------

describe("a failed fetch is asked again", () => {
  test("one 503, then the record: resolved, after one 250 ms wait", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 503, times: 1 });
    const r = await run(inputs("CC0", [ZENODO_BY]));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources[0].status).toBe("resolved");
    expect(count(ZENODO_BY_KEY)).toBe(2);
    expect(waits).toEqual([250]);
  });

  test("a timeout, then the record: resolved", async () => {
    standIn.override(ZENODO_BY_KEY, { delayMs: 400, times: 1 });
    const r = await run(inputs("CC0", [ZENODO_BY]), { timeoutMs: 100 });
    expect(r.outcome).toBe("compatible_attribution");
    expect(count(ZENODO_BY_KEY)).toBe(2);
  });

  test("a body that is not JSON, then the record: resolved", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 200, body: "<html>", times: 1 });
    expect((await run(inputs("CC0", [ZENODO_BY]))).outcome).toBe("compatible_attribution");
  });

  test("a failure that persists: three attempts, then unresolved, never a verdict", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 503 });
    const r = await run(inputs("CC0", [ZENODO_BY]));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0].status).toBe("fetch_failed");
    expect(count(ZENODO_BY_KEY)).toBe(LINEAGE_RETRY.attempts);
    expect(waits).toEqual([250, 1_000]);
    // Still DataCite's failure: it never falls through to another registry.
    expect(count("crossref")).toBe(0);
  });

  test("a 429's Retry-After is honored, and capped", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 429, headers: { "Retry-After": "1" }, times: 1 });
    await run(inputs("CC0", [ZENODO_BY]));
    expect(waits).toEqual([1_000]);
    waits = [];
    standIn.override(ZENODO_BY_KEY, { status: 429, headers: { "Retry-After": "60" }, times: 1 });
    await run(inputs("CC0", [ZENODO_BY]));
    expect(waits).toEqual([MAX_RETRY_AFTER_MS]);
  });

  test("a refusal that will not change (401) is asked once", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 401 });
    const r = await run(inputs("CC0", [ZENODO_BY]));
    expect(r.outcome).toBe("unresolved");
    expect(count(ZENODO_BY_KEY)).toBe(1);
    expect(waits).toEqual([]);
  });

  test("NO_RETRY asks once", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 503, times: 1 });
    const r = await run(inputs("CC0", [ZENODO_BY]), { retry: NO_RETRY });
    expect(r.outcome).toBe("unresolved");
    expect(count(ZENODO_BY_KEY)).toBe(1);
  });

  test("the fetch budget bounds every request, retries included", async () => {
    standIn.override("datacite", { status: 503 });
    const r = await run(
      inputs("CC0", [
        ZENODO_BY,
        { DOI: "10.5281/zenodo.22967622" },
        { DOI: "10.5281/zenodo.21156617" },
      ]),
      { fetchBudget: 4 },
    );
    expect(standIn.requests).toHaveLength(4);
    expect(r.sources.every((s) => s.status === "fetch_failed")).toBe(true);
    expect(r.outcome).toBe("unresolved");
  });

  test("a spent budget refuses a first attempt too: that source is a failed fetch", async () => {
    const r = await run(inputs("CC0", [ZENODO_BY, { DOI: "10.5281/zenodo.22967622" }]), {
      fetchBudget: 1,
    });
    expect(standIn.requests).toHaveLength(1);
    expect(r.sources.map((s) => s.status).sort()).toEqual(["fetch_failed", "resolved"]);
    expect(r.outcome).toBe("unresolved");
  });

  test("no retry starts that could end past the retry window", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 503 });
    // A timeout as long as the window leaves no room for a retry.
    const r = await run(inputs("CC0", [ZENODO_BY]), { timeoutMs: LINEAGE_RETRY_WINDOW_MS });
    expect(r.outcome).toBe("unresolved");
    expect(count(ZENODO_BY_KEY)).toBe(1);
  });
});

describe("the cache never serves an unresolved source", () => {
  test("a not_found is not cached: the next lineage asks again", async () => {
    const cache = mapCache();
    const missing = { DOI: "10.5281/zenodo.24539621" };
    standIn.override("datacite /dois/10.5281/zenodo.24539621", { status: 404, times: 1 });
    standIn.override("crossref /works/10.5281/zenodo.24539621", { status: 404, times: 1 });
    standIn.override("openalex /works/doi:10.5281/zenodo.24539621", { status: 404, times: 1 });
    const first = await run(inputs("CC0", [missing]), { cache });
    expect(first.sources[0].status).toBe("not_found");
    expect(first.outcome).toBe("unresolved");
    // The DOI is registered now: the next lineage reads it, not a stored not_found.
    const second = await run(inputs("CC0", [missing]), { cache });
    expect(second.outcome).toBe("compatible_attribution");
  });

  test("a failure is not cached; an answer is", async () => {
    const cache = mapCache();
    standIn.override(ZENODO_BY_KEY, { status: 503, times: LINEAGE_RETRY.attempts });
    expect((await run(inputs("CC0", [ZENODO_BY]), { cache })).outcome).toBe("unresolved");
    expect((await run(inputs("CC0", [ZENODO_BY]), { cache })).outcome).toBe(
      "compatible_attribution",
    );
    const before = standIn.requests.length;
    expect((await run(inputs("CC0", [ZENODO_BY]), { cache })).outcome).toBe(
      "compatible_attribution",
    );
    expect(standIn.requests.length).toBe(before);
  });

  test("a stored not_found, or a record with no declared licenses, is a miss", async () => {
    const good = (await run(inputs("CC0", [ZENODO_BY]))).sources[0];
    const { origin: _o, outcome: _x, ...record } = good;
    expect(isValidCachedRecord(record)).toBe(true);
    expect(isValidCachedRecord({ ...record, status: "not_found" })).toBe(false);
    const { declared_licenses: _d, ...older } = record;
    expect(isValidCachedRecord(older)).toBe(false);
  });
});

describe("resolved_at", () => {
  test("each lineage records when it was resolved", async () => {
    const at = new Date("2026-11-27T12:00:00.000Z");
    const r = await run(inputs("CC0", [ZENODO_BY]), { now: () => at });
    expect(r.resolved_at).toBe(at.toISOString());
    expect(r.fetched_at).toBe(r.resolved_at);
    expect(lineageLines(r)).toContain(
      `Resolver: ${RESOLVER_VERSION}, resolved ${at.toISOString()}`,
    );
    const unreadable = await run({ ...inputs("CC0"), datasetDescription: null }, { now: () => at });
    expect(unreadable.resolved_at).toBe(at.toISOString());
  });
});

// ---------------------------------------------------------------------------
// (2) osf.io sources
// ---------------------------------------------------------------------------

describe("osf.io URLs map to their DataCite DOI", () => {
  test.each([
    ["https://osf.io/rmafj", "10.17605/osf.io/rmafj"],
    ["https://osf.io/rmafj/", "10.17605/osf.io/rmafj"],
    ["http://www.osf.io/J3S7G/", "10.17605/osf.io/j3s7g"],
    ["https://osf.io/j3s7g/files/osfstorage", "10.17605/osf.io/j3s7g"],
    ["https://osf.io/j3s7g/?view_only=abc", "10.17605/osf.io/j3s7g"],
    ["https://osf.io/j3s7g#wiki", "10.17605/osf.io/j3s7g"],
  ])("%s -> %s", (url, doi) => {
    expect(osfDoiOfUrl(url)).toBe(doi);
  });

  test.each([
    "https://osf.io/rmafjx",
    "https://osf.io/rmaf",
    "https://osf.io/preprints/psyarxiv/abcde",
    "https://osf.io/about/",
    "https://osf.io/files",
    "https://example.org/osf.io/rmafj",
    "osf.io/rmafj",
  ])("%s maps to no DOI", (url) => {
    expect(osfDoiOfUrl(url)).toBeNull();
  });

  test("nm000712's source: no DataCite DOI, OSF declares CC BY-SA 4.0", async () => {
    const r = await run(inputs("CC0", [{ URL: "https://osf.io/rmafj" }]));
    expect(r.sources[0]).toMatchObject({
      id: "10.17605/osf.io/rmafj",
      resolver: "osf",
      resource_type: "Dataset",
      license: "cc-by-sa",
      license_version: "4.0",
      status: "resolved",
      publisher: "OSF",
      declared_licenses: [
        {
          text: "CC-By Attribution-ShareAlike 4.0 International",
          url: "https://creativecommons.org/licenses/by-sa/4.0/legalcode",
        },
      ],
    });
    expect(r.sources[0].title).toContain("self-touch");
    expect(r.outcome).toBe("share_alike_mismatch");
    expect((await run(inputs("CC-BY-SA-4.0", [{ URL: "https://osf.io/rmafj/" }]))).outcome).toBe(
      "compatible_attribution",
    );
    // An OSF DOI DataCite lacks goes to OSF, never to Crossref or OpenAlex.
    expect(count("crossref") + count("openalex")).toBe(0);
    expect(standIn.misses).toEqual([]);
  });

  test("nm001031's source: OSF declares CC BY 4.0 -> compatible_attribution", async () => {
    const r = await run(inputs("CC0", [{ URL: "https://osf.io/j3s7g/" }]));
    expect(r.sources[0]).toMatchObject({
      resolver: "osf",
      license: "cc-by",
      license_version: "4.0",
    });
    expect(r.outcome).toBe("compatible_attribution");
    expect(standIn.misses).toEqual([]);
  });

  test("an OSF DOI DataCite holds with rights: DataCite's answer, OSF not asked", async () => {
    const r = await run(inputs("CC0", [{ DOI: "10.17605/OSF.IO/WPKRZ" }]));
    expect(r.sources[0]).toMatchObject({ resolver: "datacite", license: "cc-by" });
    expect(count("osf /v2")).toBe(0);
  });

  test("DataCite with no rights and a node with no license: none -> needs_permission", async () => {
    const r = await run(inputs("CC0", [{ URL: "https://osf.io/j7as8/" }]));
    expect(r.sources[0]).toMatchObject({
      resolver: "osf",
      license: "none",
      status: "resolved",
      declared_licenses: [],
    });
    // The DataCite record's title, since DataCite holds the DOI.
    expect(r.sources[0].title).not.toBeNull();
    expect(r.outcome).toBe("needs_permission");
    expect(lineageLines(r)).toContain("      declared license: none (the record lists no license)");
    expect(standIn.misses).toEqual([]);
  });

  test("a private node (401) is unresolved, and asked once", async () => {
    standIn.override("osf /v2/nodes/rmafj", { status: 401 });
    const r = await run(inputs("CC0", [{ URL: "https://osf.io/rmafj" }]));
    expect(r.sources[0].status).toBe("fetch_failed");
    expect(r.outcome).toBe("unresolved");
    expect(count("osf /v2/nodes/rmafj")).toBe(1);
  });

  test("a node whose license relationship is there but not embedded is unparseable", async () => {
    standIn.override("osf /v2/nodes/rmafj", {
      status: 200,
      body: JSON.stringify({
        data: { attributes: { title: "x" }, relationships: { license: { data: { id: "1" } } } },
      }),
    });
    const r = await run(inputs("CC0", [{ URL: "https://osf.io/rmafj" }]));
    expect(r.sources[0].status).toBe("unparseable");
  });

  test("an osf.io URL in a README or the attestation is a source; an OSF site page is not", () => {
    const found = extractSources({
      datasetDescription: {},
      relatedIdentifiers: null,
      attestationUpstreamSource: "Converted from https://osf.io/rmafj/",
      readme: "Raw data: https://osf.io/j3s7g/files. See https://osf.io/about for OSF.",
    });
    expect(
      found.refs.map((r) => (r.kind === "doi" ? [r.origin, r.doi] : [r.origin, r.kind])),
    ).toEqual([
      ["attestation", "10.17605/osf.io/rmafj"],
      ["readme", "10.17605/osf.io/j3s7g"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// (3) README DOI candidates cut short
// ---------------------------------------------------------------------------

describe("a DOI cut out of a README is not a source", () => {
  test.each([
    ["10.17605/o", true, true],
    ["10.17605/o", false, true],
    ["10.5281/abc", false, true],
    ["10.5281/zenodo", true, true],
    ["10.17605/osf.io/rmaf", true, true],
    ["10.18112/openneuro.ds00364", true, true],
    ["10.6084/m9.figshare.", true, true],
    ["10.17605/osf.io/rmafj", true, false],
    ["10.5281/zenodo.22967622", true, false],
    ["10.18112/openneuro.ds003645.v2.0.2", true, false],
    ["10.6084/m9.figshare.6427334.v5", true, false],
    ["10.13026/c28g6p", true, false],
    ["10.7910/dvn/abcdef", true, false],
    ["10.5061/dryad.x3ffbg7k8", true, false],
    // An attestation takes any DOI and checks only the length.
    ["10.1234/any.publisher.doi", false, false],
  ])("%s (README shapes: %p) cut: %p", (doi, shaped, cut) => {
    expect(isCutDoiCandidate(doi, shaped)).toBe(cut);
  });

  const readmeOf = (readme: string) =>
    extractSources({
      datasetDescription: {},
      relatedIdentifiers: null,
      attestationUpstreamSource: null,
      readme,
    });

  test("a DOI wrapped at a line break is dropped and counted", () => {
    const found = readmeOf("The raw data are on OSF (https://doi.org/10.17605/O\nSF.IO/RMAFJ).\n");
    expect(found.refs).toEqual([]);
    expect(found.dropped).toBe(1);
  });

  test("a DOI cut where the text stops is dropped and counted", () => {
    const found = readmeOf("## Source\n\nZenodo: 10.5281/zenodo.");
    expect(found.refs).toEqual([]);
    expect(found.dropped).toBe(1);
  });

  test("markup around a whole DOI is not part of it", () => {
    const found = readmeOf(
      "Data: `10.5281/zenodo.22967622`, **10.6084/m9.figshare.6427334.v5**, *10.13026/c28g6p*.\n",
    );
    expect(found.refs.map((r) => (r.kind === "doi" ? r.doi : r.kind))).toEqual([
      "10.5281/zenodo.22967622",
      "10.6084/m9.figshare.6427334.v5",
      "10.13026/c28g6p",
    ]);
    expect(found.dropped).toBe(0);
  });

  test("an attestation that is only a DOI is a source", () => {
    const found = extractSources({
      datasetDescription: {},
      relatedIdentifiers: null,
      attestationUpstreamSource: "10.5281/zenodo.24539621",
      readme: null,
    });
    expect(found.refs).toHaveLength(1);
  });

  test("a dropped candidate never makes the lineage unresolved, and is shown", async () => {
    const r = await run(inputs("CC0", [], "Raw data: https://doi.org/10.17605/o\nsf.io/rmafj\n"));
    expect(r.outcome).toBe("no_upstream_declared");
    expect(r.sources).toEqual([]);
    expect(r.dropped_doi_candidates).toBe(1);
    expect(lineageLines(r)).toContain(
      "Dropped: 1 DOI candidate(s) cut short in the README or attestation (not sources).",
    );
    expect(standIn.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (4) The source's declared license
// ---------------------------------------------------------------------------

describe("the source's declared license", () => {
  test("PsychArchives' Scientific Use License: needs_permission, shown as declared", async () => {
    const r = await run(inputs("CC0", [{ DOI: "10.23668/psycharchives.22842" }]));
    expect(r.outcome).toBe("needs_permission");
    expect(r.sources[0]).toMatchObject({ license: "other", resolver: "datacite" });
    expect(r.sources[0].declared_licenses).toEqual([
      { text: "Scientific Use License v1", url: null },
      { text: null, url: "https://doi.org/10.23668/psycharchives.4988" },
    ]);
    expect(lineageLines(r)).toContain(
      '      declared license: "Scientific Use License v1"; <https://doi.org/10.23668/psycharchives.4988>',
    );
  });

  test("an access-rights word beside CC BY is not a license (PsychArchives openAccess)", async () => {
    const r = await run(inputs("CC0", [{ DOI: "10.23668/psycharchives.22830" }]));
    expect(r.sources[0].license).toBe("cc-by");
    expect(r.outcome).toBe("compatible_attribution");
    // A compatible source prints no declared-license line.
    expect(lineageLines(r).some((l) => l.includes("declared license"))).toBe(false);
  });

  test("Crossref's license URL is the declared license of an article", async () => {
    const r = await run(inputs("CC0", [{ DOI: "10.1038/s41597-019-0027-4" }]));
    expect(r.outcome).toBe("source_is_publication");
    expect(r.sources[0].declared_licenses).toEqual([
      { text: null, url: "https://creativecommons.org/licenses/by/4.0" },
    ]);
  });

  test("an unresolved source says no record was read", async () => {
    standIn.override(ZENODO_BY_KEY, { status: 503 });
    const r = await run(inputs("CC0", [ZENODO_BY]), { retry: NO_RETRY });
    expect(lineageLines(r)).toContain("      declared license: not read (no record was read)");
  });

  test("control characters are removed and a long value is capped", () => {
    const { declared } = dataciteLicenses([
      { rights: "Custom\u001b[31m terms\nfor reuse", rightsUri: "x".repeat(1000) },
    ]);
    expect(declared[0].text).toBe("Custom [31m terms for reuse");
    expect(declared[0].url?.length).toBe(MAX_DECLARED_LICENSE_LENGTH);
  });

  test("a result from a Worker of resolver version 2 still prints", () => {
    const old = {
      outcome: "needs_permission",
      inputs: { dataset_description: "read", nemar_metadata: "missing", readme: "missing" },
      target_license: "cc0",
      target_license_raw: "CC0",
      sources: [
        {
          id: "10.5281/zenodo.22967622",
          resolver: "datacite",
          resource_type: "Dataset",
          title: null,
          creators: [],
          publisher: null,
          license: "cc-by-nc",
          license_version: "4.0",
          raw: null,
          evidence_url: null,
          status: "resolved",
          origin: "source_datasets",
          outcome: "needs_permission",
        },
      ],
      resolver_version: "license-lineage/2",
      fetched_at: "2026-11-25T00:00:00.000Z",
    } as unknown as LineageResult;
    const lines = lineageLines(old);
    expect(lines).toContain("Resolver: license-lineage/2, resolved 2026-11-25T00:00:00.000Z");
    expect(lines).toContain("      declared license: not recorded (an older resolver version)");
    expect(declaredLicenseWords({ status: "fetch_failed", declared_licenses: [] })).toBe(
      "not read (no record was read)",
    );
  });
});
