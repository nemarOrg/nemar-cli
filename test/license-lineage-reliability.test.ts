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
  componentParentDoi,
  dataciteLicenses,
  declaredLicenseWords,
  extractSources,
  figshareArticleOfUrl,
  isCutDoiCandidate,
  isOsfProject,
  isValidCachedRecord,
  lineageLines,
  mapCache,
  normalizeLicense,
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
  test("is 5, since outcomes change", () => {
    expect(RESOLVER_VERSION).toBe("license-lineage/6");
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

  test("an OSF DOI DataCite holds with rights, not as a project: DataCite's answer, OSF not asked", async () => {
    // wpkrz is registered as a Project (read from OSF since resolver version 5); the same record
    // with another resourceType is DataCite's answer alone.
    const rec = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/25-datacite-osf-cc-by.json`,
      ).text(),
    );
    rec.data.attributes.types.resourceType = "Data";
    standIn.override("datacite /dois/10.17605/osf.io/wpkrz", {
      status: 200,
      body: JSON.stringify(rec),
    });
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
    // Real shapes from DataCite (fixtures 30 to 32): a five-character Dataverse id, a figshare
    // collection, a Dryad file.
    ["10.7910/dvn/29379", true, false],
    ["10.6084/m9.figshare.c.3307977", true, false],
    ["10.5061/dryad.8pm4nv0/1", true, false],
    ["10.7910/dvn/2937", true, true],
    ["10.6084/m9.figshare.c.", true, true],
    ["10.5061/dryad.8pm4nv0/", true, true],
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

  test("README DOIs of these shapes are sources, read from their records", async () => {
    const r = await run(
      inputs(
        "CC0",
        [],
        "Data: https://doi.org/10.7910/DVN/29379, collection 10.6084/m9.figshare.c.3307977 and file 10.5061/dryad.8pm4nv0/1.\n",
      ),
    );
    expect(r.dropped_doi_candidates).toBe(0);
    expect(r.sources.map((s) => [s.id, s.status, s.license])).toEqual([
      ["10.7910/dvn/29379", "resolved", "cc0"],
      // A figshare collection is judged by its members, each CC0 (DataCite says CC BY 3.0 US).
      ["10.6084/m9.figshare.c.3307977", "resolved", "cc0"],
      ["10.5061/dryad.8pm4nv0/1", "publication", "cc0"],
    ]);
    expect(standIn.misses).toEqual([]);
  });

  test("a dropped candidate beside a real source leaves that source's outcome", async () => {
    const r = await run(
      inputs("CC0", [], "Data: https://doi.org/10.7910/DVN/29379; also 10.17605/o\nsf.io/rmafj\n"),
    );
    expect(r.dropped_doi_candidates).toBe(1);
    expect(r.outcome).toBe("compatible");
  });

  test("only dropped candidates: unresolved with the count, never no_upstream_declared", async () => {
    const r = await run(inputs("CC0", [], "Raw data: https://doi.org/10.17605/o\nsf.io/rmafj\n"));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources).toEqual([]);
    expect(r.dropped_doi_candidates).toBe(1);
    expect(lineageLines(r)).toContain(
      "Dropped: 1 DOI candidate(s) cut short in the README or attestation (not sources).",
    );
    expect(standIn.requests).toEqual([]);
  });
});

describe("a README DOI that prefixes a declared DOI is that DOI cut short", () => {
  // nm000746 and nm000843 (2026-11-27): SourceDatasets declares the whole Zenodo DOI, and the
  // README's citation wraps it, so the text yields a cut copy that still has Zenodo's shape.
  const NM000746 = { DOI: "10.5281/zenodo.22314785" };
  const NM000746_README =
    "## Citation\n\nIf you use these data, cite the original deposit: Zenodo.\nhttps://doi.org/10.5281/zenodo.2231\n4785\n";
  const NM000843 = { DOI: "https://doi.org/10.5281/zenodo.23610719" };
  const NM000843_README =
    "Source data: doi:10.5281/zenodo.236\n10719 (CC BY 4.0). Code: https://github.com/example/analysis\n";

  const sourcesOf = (desc: unknown, readme: string, attestation: string | null = null) =>
    extractSources({
      datasetDescription: desc,
      relatedIdentifiers: null,
      attestationUpstreamSource: attestation,
      readme,
    });
  const ids = (found: ReturnType<typeof extractSources>) =>
    found.refs.map((r) => (r.kind === "doi" ? `${r.origin} ${r.doi}` : r.kind));

  test.each([
    [NM000746, NM000746_README, "source_datasets 10.5281/zenodo.22314785"],
    [NM000843, NM000843_README, "source_datasets 10.5281/zenodo.23610719"],
  ])("SourceDatasets %p: the README's cut copy is dropped and counted", (src, readme, kept) => {
    const found = sourcesOf({ SourceDatasets: [src] }, readme);
    expect(ids(found)).toEqual([kept]);
    expect(found.dropped).toBe(1);
  });

  test("a prefix of a related identifier or an attestation DOI is dropped too", () => {
    const related = extractSources({
      datasetDescription: {},
      relatedIdentifiers: [
        { relation_type: "IsDerivedFrom", identifier_type: "DOI", identifier: NM000746.DOI },
      ],
      attestationUpstreamSource: null,
      readme: NM000746_README,
    });
    expect(ids(related)).toEqual(["related_identifiers 10.5281/zenodo.22314785"]);
    expect(related.dropped).toBe(1);
    const attested = sourcesOf({}, NM000843_README, "From Zenodo, 10.5281/zenodo.23610719.");
    expect(ids(attested)).toEqual(["attestation 10.5281/zenodo.23610719"]);
    expect(attested.dropped).toBe(1);
  });

  test("two distinct README records, one a prefix of the other, are both kept", () => {
    // The text does not continue the shorter DOI into the longer one: they are two records.
    const zenodo = sourcesOf({}, "Data: 10.5281/zenodo.1234567 and 10.5281/zenodo.12345678.\n");
    expect(ids(zenodo)).toEqual([
      "readme 10.5281/zenodo.1234567",
      "readme 10.5281/zenodo.12345678",
    ]);
    expect(zenodo.dropped).toBe(0);
    const dataverse = sourcesOf({}, "See doi:10.7910/DVN/ABCDE; also doi:10.7910/DVN/ABCDEF\n");
    expect(ids(dataverse)).toEqual(["readme 10.7910/dvn/abcde", "readme 10.7910/dvn/abcdef"]);
    expect(dataverse.dropped).toBe(0);
    // Nor is a declared DOI enough: the README must itself continue the short one.
    const declared = sourcesOf(
      { SourceDatasets: [NM000746] },
      "Older deposit: 10.5281/zenodo.2231.\n",
    );
    expect(ids(declared)).toEqual([
      "source_datasets 10.5281/zenodo.22314785",
      "readme 10.5281/zenodo.2231",
    ]);
    expect(declared.dropped).toBe(0);
  });

  test("a declared DOI is never dropped, even when the README continues it into another", () => {
    const found = sourcesOf(
      { SourceDatasets: [{ DOI: "10.5281/zenodo.2231" }, NM000746] },
      NM000746_README,
    );
    expect(ids(found)).toEqual([
      "source_datasets 10.5281/zenodo.2231",
      "source_datasets 10.5281/zenodo.22314785",
    ]);
    // The README's own cut copy is dropped and counted; the declared short DOI stays.
    expect(found.dropped).toBe(1);
  });

  test("a wrap with quote markup between the halves is still the same DOI", () => {
    const found = sourcesOf({ SourceDatasets: [NM000843] }, "> doi:10.5281/zenodo.236\n> 10719\n");
    expect(ids(found)).toEqual(["source_datasets 10.5281/zenodo.23610719"]);
    expect(found.dropped).toBe(1);
  });

  test("a README candidate that prefixes another README candidate is dropped", () => {
    const found = sourcesOf(
      {},
      "Data: 10.5281/zenodo.22314785.\n\nCite as https://doi.org/10.5281/zenodo.2231\n4785\n",
    );
    expect(ids(found)).toEqual(["readme 10.5281/zenodo.22314785"]);
    expect(found.dropped).toBe(1);
  });

  test("an equal DOI is one source, not a dropped candidate; a DOI that prefixes nothing stays", () => {
    const same = sourcesOf({ SourceDatasets: [NM000746] }, "Data: 10.5281/zenodo.22314785\n");
    expect(ids(same)).toEqual(["source_datasets 10.5281/zenodo.22314785"]);
    expect(same.dropped).toBe(0);
    // Not a prefix of the declared DOI, so a source of its own.
    const other = sourcesOf({ SourceDatasets: [NM000746] }, "Also 10.5281/zenodo.2232\n");
    expect(ids(other)).toEqual([
      "source_datasets 10.5281/zenodo.22314785",
      "readme 10.5281/zenodo.2232",
    ]);
    expect(other.dropped).toBe(0);
    // A README alone is read as it is: nothing declared it longer.
    expect(ids(sourcesOf({}, NM000746_README))).toEqual(["readme 10.5281/zenodo.2231"]);
    // A declared DOI is never dropped for being a prefix of a README one.
    const declaredShort = sourcesOf(
      { SourceDatasets: [{ DOI: "10.5281/zenodo.2231" }] },
      "10.5281/zenodo.22314785\n",
    );
    expect(ids(declaredShort)).toEqual([
      "source_datasets 10.5281/zenodo.2231",
      "readme 10.5281/zenodo.22314785",
    ]);
  });

  test.each([
    // The second record lists CC BY 4.0 and MIT; the more restrictive reading is kept.
    [NM000746, NM000746_README, "cc-by"],
    [NM000843, NM000843_README, "permissive-attribution"],
  ])(
    "the lineage of %p resolves compatible, and the cut copy is never fetched",
    async (src, readme, license) => {
      const r = await run(inputs("CC-BY-4.0", [src], readme));
      expect(r.outcome).toBe("compatible_attribution");
      expect(r.dropped_doi_candidates).toBe(1);
      expect(r.sources).toHaveLength(1);
      expect(r.sources[0]).toMatchObject({ status: "resolved", license });
      expect(standIn.misses).toEqual([]);
      expect(standIn.requests).toHaveLength(1);
    },
  );
});

describe("a README DOI cut by an ellipsis", () => {
  // The exact shapes of nm000746 and nm000843 (2026-11-27): a truncated README table cell.
  const NM000746_README =
    "| Field | Value |\n| --- | --- |\n| Notes | ...ReferencesAndLinks https://doi.org/10.5281/zenodo.2231 [...]; N: 30 participants |\n";
  const NM000843_README =
    "| Notes | ...ReferencesAndLinks https://doi.org/10.5281/zenodo.236 [...]; N: 30 participants |\n";
  const sourcesOf = (declared: string | null, readme: string) =>
    extractSources({
      datasetDescription: declared === null ? {} : { SourceDatasets: [{ DOI: declared }] },
      relatedIdentifiers: null,
      attestationUpstreamSource: null,
      readme,
    });
  const ids = (found: ReturnType<typeof extractSources>) =>
    found.refs.map((r) => (r.kind === "doi" ? `${r.origin} ${r.doi}` : r.kind));

  test.each([
    ["10.5281/zenodo.22314785", NM000746_README],
    ["10.5281/zenodo.23610719", NM000843_README],
  ])("declared %s: the README's ellipsis-cut copy is dropped and counted", (doi, readme) => {
    const found = sourcesOf(doi, readme);
    expect(ids(found)).toEqual([`source_datasets ${doi}`]);
    expect(found.dropped).toBe(1);
  });

  test.each([
    ["10.5281/zenodo.236 [...]"],
    ["10.5281/zenodo.236[…]"],
    ["10.5281/zenodo.236 ..."],
    ["10.5281/zenodo.236 …"],
  ])("each ellipsis marker: %s", (text) => {
    const found = sourcesOf("10.5281/zenodo.23610719", `Notes: ${text}; N: 30\n`);
    expect(ids(found)).toEqual(["source_datasets 10.5281/zenodo.23610719"]);
    expect(found.dropped).toBe(1);
  });

  test("a short DOI written once on its own as well as cut is a source", () => {
    const readme = `${NM000843_README}\nAn earlier deposit: https://doi.org/10.5281/zenodo.236.\n`;
    const found = sourcesOf("10.5281/zenodo.23610719", readme);
    expect(ids(found)).toEqual([
      "source_datasets 10.5281/zenodo.23610719",
      "readme 10.5281/zenodo.236",
    ]);
    expect(found.dropped).toBe(0);
    // Wrapped once and on its own once: also a source.
    const wrapped = sourcesOf(
      "10.5281/zenodo.22314785",
      "Cite https://doi.org/10.5281/zenodo.2231\n4785. Old: 10.5281/zenodo.2231\n",
    );
    expect(ids(wrapped)).toEqual([
      "source_datasets 10.5281/zenodo.22314785",
      "readme 10.5281/zenodo.2231",
    ]);
    // Every occurrence cut (one wrapped, one ellipsis), beside the whole DOI: dropped.
    const all = sourcesOf(
      "10.5281/zenodo.22314785",
      "Data 10.5281/zenodo.22314785; cite 10.5281/zenodo.2231\n4785; notes 10.5281/zenodo.2231 [...]\n",
    );
    expect(ids(all)).toEqual(["source_datasets 10.5281/zenodo.22314785"]);
    // Each cut candidate is counted, as every dropped candidate is.
    expect(all.dropped).toBe(2);
  });

  test("distinct records are kept: no ellipsis, an ellipsis elsewhere, nothing longer declared", () => {
    const both = sourcesOf(
      null,
      "Data: 10.5281/zenodo.1234567 and 10.5281/zenodo.12345678 [...]; see also ...\n",
    );
    expect(ids(both)).toEqual(["readme 10.5281/zenodo.1234567", "readme 10.5281/zenodo.12345678"]);
    expect(both.dropped).toBe(0);
    // An ellipsis after a DOI that prefixes nothing declared: the README's own source stays.
    const alone = sourcesOf(null, NM000843_README);
    expect(ids(alone)).toEqual(["readme 10.5281/zenodo.236"]);
    // An ellipsis that does not follow the short DOI does not drop it.
    const apart = sourcesOf("10.5281/zenodo.23610719", "Old: 10.5281/zenodo.236, notes [...]\n");
    expect(ids(apart)).toEqual([
      "source_datasets 10.5281/zenodo.23610719",
      "readme 10.5281/zenodo.236",
    ]);
  });

  test.each([
    ["10.5281/zenodo.22314785", NM000746_README],
    ["10.5281/zenodo.23610719", NM000843_README],
  ])("the lineage of %s is compatible, and the cut copy is never fetched", async (doi, readme) => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: doi }], readme));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.dropped_doi_candidates).toBe(1);
    expect(r.sources.map((x) => x.id)).toEqual([doi]);
    expect(standIn.misses).toEqual([]);
  });
});

describe("data containers are data; publications stay publications", () => {
  test.each([
    // nm000812: OSF registers a project as Text / Project; OSF's node says CC BY 4.0, no children.
    ["10.17605/osf.io/f8sq3", "osf", "Text"],
    // nm000808: a PLOS supplementary file, a Crossref component, licensed through its article.
    ["10.1371/journal.pone.0303144.s001", "crossref", "component"],
  ])("%s (%s %s) reads its rights: compatible_attribution", async (doi, resolver, type) => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: doi }]));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources[0]).toMatchObject({
      resolver,
      resource_type: type,
      status: "resolved",
      license: "cc-by",
      license_version: "4.0",
    });
    expect(standIn.misses).toEqual([]);
  });

  test("nm000832's figshare collection is judged by its member (CC0), never by DataCite's CC BY", async () => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.6084/m9.figshare.c.6979581.v1" }]));
    expect(r.outcome).toBe("compatible");
    expect(r.sources[0]).toMatchObject({
      resolver: "figshare",
      resource_type: "Collection",
      status: "resolved",
      license: "cc0",
    });
    expect(r.sources[0].declared_licenses).toEqual([
      { text: "CC0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
    ]);
    expect(standIn.misses).toEqual([]);
  });

  test("the most restrictive member wins; an unreadable member, no member or too many: unresolved", async () => {
    const DOI = { DOI: "10.6084/m9.figshare.c.6979581.v1" };
    const member = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/44-figshare-article-24803499.json`,
      ).text(),
    );
    member.license = {
      value: 4,
      name: "CC BY-NC 4.0",
      url: "https://creativecommons.org/licenses/by-nc/4.0/",
    };
    standIn.override("figshare /v2/articles/24803499", {
      status: 200,
      body: JSON.stringify(member),
    });
    expect((await run(inputs("CC-BY-4.0", [DOI]))).outcome).toBe("needs_permission");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("figshare /v2/articles/24803499", {
      status: 200,
      body: JSON.stringify({ id: 1 }),
    });
    const noLicense = await run(inputs("CC-BY-4.0", [DOI]));
    expect(noLicense.outcome).toBe("unresolved");
    expect(noLicense.sources[0].license).toBeNull();
    standIn.stop();
    standIn = startStandIn();
    standIn.override("figshare /v2/articles/24803499", { status: 503 });
    const failed = await run(inputs("CC-BY-4.0", [DOI]), { retry: NO_RETRY });
    expect(failed.sources[0].status).toBe("fetch_failed");
    expect(failed.outcome).toBe("unresolved");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("figshare /v2/collections/6979581/articles", { status: 200, body: "[]" });
    expect((await run(inputs("CC-BY-4.0", [DOI]))).outcome).toBe("unresolved");
    standIn.stop();
    standIn = startStandIn();
    const many = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: 100 + i })));
    standIn.override("figshare /v2/collections/6979581/articles", { status: 200, body: many });
    expect((await run(inputs("CC-BY-4.0", [DOI]))).outcome).toBe("unresolved");
    expect(standIn.requests.some((k) => k.includes("/v2/articles/100"))).toBe(false);
  });

  test("each member is judged on its own: share-alike beside NonCommercial is never compatible_nc", async () => {
    const DOI = { DOI: "10.6084/m9.figshare.c.3307977" };
    const fixture = (id: number) =>
      Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/${id === 3563031 ? "60" : "61"}-figshare-article-${id}.json`,
      ).json();
    const set = async (id: number, name: string, url: string) => {
      const member = await fixture(id);
      member.license = { value: 9, name, url };
      standIn.override(`figshare /v2/articles/${id}`, {
        status: 200,
        body: JSON.stringify(member),
      });
    };
    // Members CC0, CC BY-SA 4.0 and CC BY-NC 4.0, target CC BY-NC 4.0: the share-alike member
    // cannot be NonCommercial, and the two conflict. One merged rank (NC) would say compatible_nc.
    await set(3563031, "CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/");
    await set(3563028, "CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/");
    const saNc = await run(inputs("CC-BY-NC-4.0", [DOI]));
    expect(saNc.outcome).not.toBe("compatible_nc");
    expect(saNc.outcome).toBe("needs_permission");
    expect(saNc.sources[0].outcome).toBe("needs_permission");
    standIn.stop();
    standIn = startStandIn();
    // ODbL beside NonCommercial keeps the share-alike duty: never compatible_nc.
    await set(3563031, "ODbL", "https://opendatacommons.org/licenses/odbl/1-0/");
    await set(3563028, "CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/");
    const odbl = await run(inputs("CC-BY-NC-4.0", [DOI]));
    expect(odbl.outcome).not.toBe("compatible_nc");
    // ODbL and NonCommercial conflict, as two separate sources would.
    expect(odbl.outcome).toBe("needs_permission");
    standIn.stop();
    standIn = startStandIn();
    // Members CC BY-SA 3.0 and 4.0 under a 3.0 target: the 4.0 member is a mismatch.
    await set(3563031, "CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/");
    await set(3563028, "CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/");
    expect((await run(inputs("CC-BY-SA-3.0", [DOI]))).outcome).toBe("share_alike_mismatch");
  });

  test("among several members the most restrictive wins; a member with an empty license is unresolved", async () => {
    // c.3307977 has three CC0 members; make the second NonCommercial.
    const member = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/60-figshare-article-3563031.json`,
      ).text(),
    );
    member.license = {
      value: 4,
      name: "CC BY-NC 4.0",
      url: "https://creativecommons.org/licenses/by-nc/4.0/",
    };
    standIn.override("figshare /v2/articles/3563031", {
      status: 200,
      body: JSON.stringify(member),
    });
    const DOI = { DOI: "10.6084/m9.figshare.c.3307977" };
    const r = await run(inputs("CC-BY-4.0", [DOI]));
    expect(r.sources[0].license).toBe("cc-by-nc");
    expect(r.outcome).toBe("needs_permission");
    standIn.stop();
    standIn = startStandIn();
    member.license = { value: 0, name: "", url: "" };
    standIn.override("figshare /v2/articles/3563031", {
      status: 200,
      body: JSON.stringify(member),
    });
    const empty = await run(inputs("CC-BY-4.0", [DOI]));
    expect(empty.outcome).toBe("unresolved");
    expect(empty.sources[0].license).toBeNull();
  });

  test("a Collection that is not figshare's is unresolved, whatever DataCite's rights say", async () => {
    const collection = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/37-datacite-figshare-collection-v1.json`,
      ).text(),
    );
    standIn.override("datacite /dois/10.5281/zenodo.24539621", {
      status: 200,
      body: JSON.stringify(collection),
    });
    const r = await run(inputs("CC-BY-4.0", [ZENODO_BY]));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0]).toMatchObject({ resource_type: "Collection", license: null });
    expect(count("figshare")).toBe(0);
  });

  test("an OSF project with no DataCite rights is read from OSF with its children, never a publication", async () => {
    // c5zbq: Text / Project, empty rightsList, no node license, seven children (one CC BY-NC).
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.17605/osf.io/c5zbq" }]));
    expect(r.sources[0]).toMatchObject({
      resolver: "osf",
      resource_type: "Text",
      status: "resolved",
    });
    expect(r.outcome).toBe("needs_permission");
    expect(standIn.misses).toEqual([]);
  });

  /** A synthetic OSF child: a license (name and URL), or none, and how many children it has. */
  const osfChild = (
    id: string,
    license: { name: string; url: string } | null,
    children: number | null = 0,
  ) => ({
    id,
    relationships: {
      license: license === null ? null : { data: { id: "x", type: "licenses" } },
      children: {
        links: { related: { meta: children === null ? {} : { count: children } } },
      },
    },
    ...(license === null ? {} : { embeds: { license: { data: { attributes: license } } } }),
  });
  const childrenOf = (data: unknown[]) => JSON.stringify({ data, links: { next: null } });
  const SA3 = { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" };
  const SA4 = { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" };
  const NC4 = { name: "CC BY-NC 4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/" };
  const ND4 = { name: "CC BY-ND 4.0", url: "https://creativecommons.org/licenses/by-nd/4.0/" };
  const F8 = [{ DOI: "10.17605/osf.io/f8sq3" }];

  test("an OSF child with children of its own leaves no verdict; the tree is not walked", async () => {
    // yb3pq (recorded): three of its nine children have children of their own.
    const r = await run(inputs("CC-BY-NC-SA-4.0", [{ DOI: "10.17605/osf.io/yb3pq" }]));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0]).toMatchObject({ resolver: "osf", license: null });
    expect(standIn.misses).toEqual([]);
    expect(count("/v2/nodes/sp3ck")).toBe(0);
    // A child whose count is not given is not shown to have none.
    standIn.override("osf /v2/nodes/f8sq3/children/", {
      status: 200,
      body: childrenOf([osfChild("abcde", SA4, null)]),
    });
    expect((await run(inputs("CC-BY-SA-4.0", F8))).outcome).toBe("unresolved");
  });

  test("each child is judged on its own: a stricter child decides, and two share-alike versions do not merge", async () => {
    standIn.override("osf /v2/nodes/f8sq3/children/", {
      status: 200,
      body: childrenOf([osfChild("abcde", ND4)]),
    });
    const nd = await run(inputs("CC-BY-4.0", F8));
    expect(nd.sources[0].license).toBe("cc-by-nd");
    expect(nd.outcome).toBe("needs_permission");
    standIn.stop();
    standIn = startStandIn();
    // Node CC BY 4.0, children CC BY-SA 3.0 and 4.0, target CC BY-SA 3.0: the 4.0 child cannot
    // be relicensed under 3.0.
    standIn.override("osf /v2/nodes/f8sq3/children/", {
      status: 200,
      body: childrenOf([osfChild("abcde", SA3), osfChild("fghij", SA4)]),
    });
    const sa = await run(inputs("CC-BY-SA-3.0", F8));
    expect(sa.outcome).toBe("share_alike_mismatch");
    expect(sa.sources[0].parts?.map((p) => `${p.license} ${p.version}`)).toEqual([
      "cc-by 4.0",
      "cc-by-sa 3.0",
      "cc-by-sa 4.0",
    ]);
  });

  test("an OSF children list that fails, cannot be parsed, or has more pages leaves no verdict", async () => {
    standIn.override("osf /v2/nodes/f8sq3/children/", { status: 503 });
    const failed = await run(inputs("CC-BY-4.0", F8), { retry: NO_RETRY });
    expect(failed.sources[0].status).toBe("fetch_failed");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("osf /v2/nodes/f8sq3/children/", {
      status: 200,
      body: JSON.stringify({
        data: [
          {
            id: "abcde",
            relationships: {
              license: { data: {} },
              children: { links: { related: { meta: { count: 0 } } } },
            },
          },
        ],
        links: { next: null },
      }),
    });
    expect((await run(inputs("CC-BY-4.0", F8))).sources[0].status).toBe("unparseable");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("osf /v2/nodes/f8sq3/children/", {
      status: 200,
      body: JSON.stringify({
        data: [],
        links: { next: "https://api.osf.io/v2/nodes/f8sq3/children/?page=2" },
      }),
    });
    const paged = await run(inputs("CC-BY-4.0", F8));
    expect(paged.outcome).toBe("unresolved");
    expect(paged.sources[0].license).toBeNull();
  });

  test("an OSF Dataset with DataCite rights but registered as a Project is read from OSF too", async () => {
    // wpkrz: Dataset / Project with CC BY 4.0 on DataCite; OSF agrees and lists no children.
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.17605/osf.io/wpkrz" }]));
    expect(r.sources[0]).toMatchObject({
      resolver: "osf",
      resource_type: "Dataset",
      license: "cc-by",
    });
    expect(count("/v2/nodes/wpkrz/children/")).toBe(1);
  });

  test("a component of any publisher but PLOS is unresolved, even with a parent or its own license", async () => {
    const comp = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/39-crossref-plos-component.json`,
      ).text(),
    );
    comp.message.license = [
      { "content-version": "vor", URL: "https://creativecommons.org/publicdomain/zero/1.0/" },
    ];
    comp.message.relation = {
      "is-component-of": [
        { "id-type": "doi", id: "10.1038/s41597-019-0027-4", "asserted-by": "object" },
      ],
    };
    standIn.override("datacite /dois/10.1038/s41597-019-0027-4", { status: 404 });
    standIn.override("crossref /works/10.1038/s41597-019-0027-4", {
      status: 200,
      body: JSON.stringify(comp),
    });
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.1038/s41597-019-0027-4" }]));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0]).toMatchObject({ resource_type: "component", license: null });
  });

  test("the component's license is its article's version of record, and the evidence says so", async () => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]));
    expect(r.sources[0].evidence_url).toEndWith("/works/10.1371%2Fjournal.pone.0303144");
    expect(r.sources[0].declared_licenses).toEqual([
      { text: null, url: "http://creativecommons.org/licenses/by/4.0/" },
    ]);
    // A CC0 target is allowed; the attribution duty persists.
    expect((await run(inputs("CC0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]))).outcome).toBe(
      "compatible_attribution",
    );
  });

  test("a component's own license wins over its article's", async () => {
    const own = JSON.parse(
      await Bun.file(
        `${import.meta.dir}/fixtures/license-lineage/39-crossref-plos-component.json`,
      ).text(),
    );
    own.message.license = [
      { "content-version": "vor", URL: "https://creativecommons.org/publicdomain/zero/1.0/" },
    ];
    standIn.override("crossref /works/10.1371/journal.pone.0303144.s001", {
      status: 200,
      body: JSON.stringify(own),
    });
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]));
    expect(r.outcome).toBe("compatible");
    expect(r.sources[0]).toMatchObject({ license: "cc0", resource_type: "component" });
    expect(count("/works/10.1371/journal.pone.0303144?")).toBe(0);
  });

  test("a component with no license of its own or its article's is unresolved, and never cached", async () => {
    standIn.override("crossref /works/10.1371/journal.pone.0303144?", {
      status: 200,
      body: JSON.stringify({ status: "ok", message: { type: "journal-article", license: [] } }),
    });
    const cache = mapCache();
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]), {
      cache,
    });
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0]).toMatchObject({ status: "resolved", license: null });
    const again = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]), {
      cache,
    });
    expect(again.outcome).toBe("unresolved");
    expect(count("/works/10.1371/journal.pone.0303144.s001")).toBe(2);
  });

  test("a component whose article is not in Crossref is unresolved; one that fails is fetch_failed", async () => {
    standIn.override("crossref /works/10.1371/journal.pone.0303144?", { status: 404 });
    const absent = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]));
    expect(absent.outcome).toBe("unresolved");
    expect(absent.sources[0].license).toBeNull();
    standIn.stop();
    standIn = startStandIn();
    standIn.override("crossref /works/10.1371/journal.pone.0303144?", { status: 503 });
    const failed = await run(inputs("CC-BY-4.0", [{ DOI: "10.1371/journal.pone.0303144.s001" }]), {
      retry: NO_RETRY,
    });
    expect(failed.outcome).toBe("unresolved");
    expect(failed.sources[0].status).toBe("fetch_failed");
  });

  test.each([
    // nm000661: a journal article deposited on Zenodo.
    ["10.5281/zenodo.6529724"],
    ["10.6084/m9.figshare.28309157"],
  ])("%s, a JournalArticle, stays source_is_publication", async (doi) => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: doi }]));
    expect(r.outcome).toBe("source_is_publication");
    expect(r.sources[0]).toMatchObject({
      resolver: "datacite",
      resource_type: "JournalArticle",
      status: "publication",
    });
    expect(standIn.misses).toEqual([]);
  });

  test("only an OSF DOI registered as a Project is a project; only PLOS components have a parent", () => {
    expect(isOsfProject("10.17605/osf.io/f8sq3", "Project")).toBe(true);
    expect(isOsfProject("10.5281/zenodo.1", "Project")).toBe(false);
    expect(isOsfProject("10.17605/osf.io/f8sq3", "Preprint")).toBe(false);
    expect(componentParentDoi("10.1371/journal.pone.0303144.s001", {})).toBe(
      "10.1371/journal.pone.0303144",
    );
    expect(
      componentParentDoi("10.1371/x.s001", {
        relation: { "is-component-of": [{ "id-type": "doi", id: "10.1371/Parent" }] },
      }),
    ).toBe("10.1371/parent");
    // Another publisher's component inherits nothing, by stem or by relation.
    expect(componentParentDoi("10.9999/x.s001", {})).toBeNull();
    expect(
      componentParentDoi("10.9999/x.s001", {
        relation: { "is-component-of": [{ "id-type": "doi", id: "10.9999/Parent" }] },
      }),
    ).toBeNull();
    expect(componentParentDoi("10.1371/no-suffix", {})).toBeNull();
    // A PLOS component whose relation names another publisher's work inherits nothing.
    expect(
      componentParentDoi("10.1371/x.s001", {
        relation: { "is-component-of": [{ "id-type": "doi", id: "10.9999/Parent" }] },
      }),
    ).toBeNull();
  });
});

describe("figshare article URLs are read from figshare", () => {
  // nm000830 (2026-11-27): SourceDatasets names the PLOS figshare dataset by URL.
  const NM000830_URL =
    "https://plos.figshare.com/articles/dataset/Frequency-resolved_analysis_of_coherent_oscillations_of_local_cerebral_blood_volume_measured_with_near-infrared_spectroscopy_and_systemic_arterial_pressure_in_healthy_human_subjects/7708514";
  const PAPER = "10.1371/journal.pone.0211710";
  const ARTICLE_FIXTURE = `${import.meta.dir}/fixtures/license-lineage/62-figshare-article-7708514.json`;
  const withType = async (type: string, license?: unknown) => {
    const a = await Bun.file(ARTICLE_FIXTURE).json();
    a.defined_type_name = type;
    if (license !== undefined) a.license = license;
    standIn.override("figshare /v2/articles/7708514?", { status: 200, body: JSON.stringify(a) });
  };

  test.each([
    [NM000830_URL, "7708514", null],
    ["https://figshare.com/articles/7708514/2", "7708514", "2"],
    ["https://figshare.com/articles/dataset/some_slug/7708514/3?file=1", "7708514", "3"],
    ["https://figshare.com/articles/7708514", "7708514", null],
    [
      "https://springernature.figshare.com/articles/journal_contribution/slug/12345/",
      "12345",
      null,
    ],
  ])("%s -> article %s version %p", (url, id, version) => {
    expect(figshareArticleOfUrl(url)).toEqual({ id, version });
  });

  test.each([
    ["https://figshare.com/collections/slug/123"],
    ["https://figshare.com/articles/dataset/no-id"],
    ["https://notfigshare.com/articles/123"],
  ])("%s is not a figshare article", (url) => {
    expect(figshareArticleOfUrl(url)).toBeNull();
  });

  test("nm000830: a figshare dataset under CC BY 4.0, named by its DOI, never read as the article", async () => {
    const r = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({
      id: PAPER,
      resolver: "figshare",
      resource_type: "dataset",
      status: "resolved",
      license: "cc-by",
      license_version: "4.0",
    });
    expect(count("crossref")).toBe(0);
    expect(count("datacite")).toBe(0);
    expect(standIn.misses).toEqual([]);
  });

  test("a versioned URL reads that version", async () => {
    const r = await run(
      inputs("CC-BY-4.0", [{ URL: "https://plos.figshare.com/articles/dataset/x/7708514/1" }]),
    );
    expect(r.outcome).toBe("compatible_attribution");
    expect(count("/v2/articles/7708514/versions/1")).toBe(1);
  });

  test("a paper-like type is a publication; any other type, or a dataset with no license, is unresolved", async () => {
    await withType("journal contribution");
    expect((await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]))).outcome).toBe(
      "source_is_publication",
    );
    for (const [type, license] of [
      ["figure", undefined],
      ["software", undefined],
      ["dataset", null],
    ] as const) {
      standIn.stop();
      standIn = startStandIn();
      await withType(type, license);
      const r = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]));
      expect(r.outcome).toBe("unresolved");
      expect(r.sources[0].license).toBeNull();
    }
  });

  test("a metadata-only figshare record is unresolved whatever its license", async () => {
    const a = await Bun.file(ARTICLE_FIXTURE).json();
    a.is_metadata_record = true;
    a.metadata_reason = "Data available on request from the authors";
    standIn.override("figshare /v2/articles/7708514?", { status: 200, body: JSON.stringify(a) });
    const r = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]));
    expect(r.outcome).toBe("unresolved");
    expect(r.sources[0].license).toBeNull();
  });

  test("a SourceDatasets Version reads that figshare version; the URL's own version wins", async () => {
    const r = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL, Version: "v1" }]));
    expect(r.outcome).toBe("compatible_attribution");
    expect(count("/v2/articles/7708514/versions/1")).toBe(1);
    expect(count("/v2/articles/7708514?")).toBe(0);
    // A Version that is not a figshare version number reads the latest.
    standIn.stop();
    standIn = startStandIn();
    await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL, Version: "1.0.2" }]));
    expect(count("/v2/articles/7708514?")).toBe(1);
    expect(figshareArticleOfUrl("https://figshare.com/articles/x/7708514/1")).toEqual({
      id: "7708514",
      version: "1",
    });
  });

  test("a figshare article that is missing or does not answer is unresolved", async () => {
    standIn.override("figshare /v2/articles/7708514?", { status: 404 });
    const missing = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]));
    expect(missing.sources[0].status).toBe("not_found");
    expect(missing.outcome).toBe("unresolved");
    standIn.stop();
    standIn = startStandIn();
    standIn.override("figshare /v2/articles/7708514?", { status: 503 });
    const down = await run(inputs("CC-BY-4.0", [{ URL: NM000830_URL }]), { retry: NO_RETRY });
    expect(down.sources[0].status).toBe("fetch_failed");
    expect(down.outcome).toBe("unresolved");
  });
});

describe("a stale enrichment relation is not a source", () => {
  const PAPER = "10.1371/journal.pone.0211710";
  const NM000830_URL = "https://plos.figshare.com/articles/dataset/slug/7708514";
  const metadataWith = (identifier: string, relation = "IsDerivedFrom") =>
    JSON.stringify({
      version: "2.0",
      related_identifiers: [
        { identifier, identifier_type: "DOI", relation_type: relation },
        {
          identifier: "https://github.com/nemarDatasets/nm000830",
          identifier_type: "URL",
          relation_type: "IsSupplementTo",
        },
      ],
    });
  const withMetadata = (license: string, sources: unknown[], metadata: string) => ({
    ...inputs(license, sources),
    nemarMetadata: metadata,
  });

  test("nm000830's shape: the stale IsDerivedFrom paper is the figshare source's DOI, so only the source stands", async () => {
    const r = await run(withMetadata("CC-BY-4.0", [{ URL: NM000830_URL }], metadataWith(PAPER)));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources.map((s) => [s.id, s.origin])).toEqual([[PAPER, "source_datasets"]]);
    // The relation is the source itself, not a stale one.
    expect(r.skipped_stale_relations).toBe(0);
  });

  test("a publication relation SourceDatasets does not name is skipped and counted", async () => {
    const r = await run(withMetadata("CC-BY-4.0", [ZENODO_BY], metadataWith(PAPER)));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources.map((s) => s.id)).toEqual(["10.5281/zenodo.24539621"]);
    expect(r.skipped_stale_relations).toBe(1);
    expect(lineageLines(r)).toContain(
      "Skipped: 1 publication(s) listed as IsDerivedFrom or IsIdenticalTo in .nemar/metadata.json that SourceDatasets does not name (stale enrichment, not sources).",
    );
    // Alone, an administrator decides: unresolved, never no_upstream_declared.
    const alone = await run(withMetadata("CC-BY-4.0", [], metadataWith(PAPER)));
    expect(alone.sources).toEqual([]);
    expect(alone.outcome).toBe("unresolved");
    expect(alone.skipped_stale_relations).toBe(1);
  });

  test("a paper SourceDatasets names still is a publication; a dataset relation is still a source", async () => {
    const named = await run(withMetadata("CC-BY-4.0", [{ DOI: PAPER }], metadataWith(PAPER)));
    expect(named.outcome).toBe("source_is_publication");
    expect(named.skipped_stale_relations).toBe(0);
    const dataset = await run(
      withMetadata("CC-BY-4.0", [], metadataWith("10.5281/zenodo.24539621")),
    );
    expect(dataset.sources.map((s) => [s.id, s.origin])).toEqual([
      ["10.5281/zenodo.24539621", "related_identifiers"],
    ]);
    expect(dataset.skipped_stale_relations).toBe(0);
  });

  test("a relation that cannot be read is not skipped: it stays unresolved", async () => {
    standIn.override("crossref /works/10.1371/journal.pone.0211710", { status: 503 });
    const r = await run(withMetadata("CC-BY-4.0", [ZENODO_BY], metadataWith(PAPER)), {
      retry: NO_RETRY,
    });
    expect(r.outcome).toBe("unresolved");
    expect(r.skipped_stale_relations).toBe(0);
  });
});

describe("DANDI's license spellings", () => {
  test.each([
    ["cc_by_40", "cc-by", "4.0"],
    ["cc0_10", "cc0", "1.0"],
    ["CC_BY_40", "cc-by", "4.0"],
    ["cc_by_nc_40", "cc-by-nc", "4.0"],
    ["cc_by_nd_40", "cc-by-nd", "4.0"],
    ["cc_by_sa_40", "cc-by-sa", "4.0"],
    ["cc_by_nc_sa_40", "cc-by-nc-sa", "4.0"],
    ["spdx:CC-BY-4.0", "cc-by", "4.0"],
    ["spdx:CC0-1.0", "cc0", "1.0"],
    ["spdx:CC-BY-NC-ND-4.0", "cc-by-nc-nd", "4.0"],
    ["spdx:ODbL-1.0", "odbl", "1.0"],
    ["spdx:PDDL-1.0", "pddl", "1.0"],
    // Not a license: never guessed toward a permissive one.
    ["spdx:", "other", null],
    ["spdx:LicenseRef-custom", "other", null],
  ])("%s reads as %s %s", (text, license, version) => {
    expect(normalizeLicense(text)).toEqual({
      license: license as ReturnType<typeof normalizeLicense>["license"],
      version,
    });
  });

  test("nm001003's DANDI source is compatible_attribution for a CC-BY-4.0 target (fixture 35)", async () => {
    const r = await run(inputs("CC-BY-4.0", [{ DOI: "10.48324/dandi.001535/0.250714.1218" }]));
    expect(r.outcome).toBe("compatible_attribution");
    expect(r.sources[0]).toMatchObject({
      resolver: "datacite",
      resource_type: "Dataset",
      license: "cc-by",
      license_version: "4.0",
      publisher: "DANDI Archive",
    });
    expect(r.sources[0].declared_licenses).toEqual([{ text: "cc_by_40", url: null }]);
    expect(standIn.misses).toEqual([]);
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
