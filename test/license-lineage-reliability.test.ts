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
  isCutDoiCandidate,
  isDataciteDataContainer,
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
    expect(RESOLVER_VERSION).toBe("license-lineage/5");
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
      // A collection holds data: its rights apply (resolver version 5).
      ["10.6084/m9.figshare.c.3307977", "resolved", "cc-by"],
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
    // nm000812: OSF registers a project as Text / Project.
    ["10.17605/osf.io/f8sq3", "datacite", "Text"],
    // nm000832: a figshare collection version.
    ["10.6084/m9.figshare.c.6979581.v1", "datacite", "Collection"],
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

  test("only an OSF Project is a container among Text records; the parent of a component", () => {
    expect(isDataciteDataContainer("10.17605/osf.io/f8sq3", "Text", "Project")).toBe(true);
    expect(isDataciteDataContainer("10.5281/zenodo.1", "Text", "Project")).toBe(false);
    expect(isDataciteDataContainer("10.17605/osf.io/f8sq3", "Text", "Preprint")).toBe(false);
    expect(isDataciteDataContainer("10.5281/zenodo.1", "Collection", null)).toBe(true);
    expect(isDataciteDataContainer("10.5281/zenodo.1", "JournalArticle", null)).toBe(false);
    expect(componentParentDoi("10.1371/journal.pone.0303144.s001", {})).toBe(
      "10.1371/journal.pone.0303144",
    );
    expect(
      componentParentDoi("10.9999/x.s001", {
        relation: { "is-component-of": [{ "id-type": "doi", id: "10.9999/Parent" }] },
      }),
    ).toBe("10.9999/parent");
    expect(componentParentDoi("10.9999/no-suffix", {})).toBeNull();
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
