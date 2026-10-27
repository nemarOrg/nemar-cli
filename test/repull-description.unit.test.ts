/**
 * Supplements to `repull-plan.test.ts` for two rules the fixture's one description and one README
 * cannot vary enough to falsify (ADR 0111, decision 1, and its Phase 5 amendment):
 *
 * - `SourceDatasets` merges three-way as a set: what either side added is kept, what upstream
 *   removed is not brought back, what NEMAR removed stays removed, and a `null` entry (on which
 *   `applyConceptDoiToDescription` throws) is merged as a value;
 * - a README badge is stripped only in a spelling NEMAR has written, and only when its image and
 *   its link name the same DOI;
 * - a scrubbed key is explained only when both keys declare the same size, and a key that declares
 *   none (a URL key) proves nothing, which no git-annex repository the fixture builds can hold;
 * - a byte count with unknown parts is never rendered as complete.
 *
 * The entry point drives the description and the README family in `repull-plan.test.ts`; these
 * call `mergeDescription` and `badgeStrips` directly because no real mirror in the fixture holds a
 * second source entry or a mismatched badge.
 */

import { describe, expect, test } from "bun:test";
import { buildDoiBadge } from "../shared/standard-edits/readme";
import { mergeDescription } from "../src/lib/repull/description";
import { type Side, bareDoi, explainEdit } from "../src/lib/repull/edits";
import { badgeStrips } from "../src/lib/repull/overlay";
import { toTagCheck } from "../src/lib/repull/preflight";
import { bytesPhrase, orphanPhrase } from "../src/lib/repull/render";
import { planSources } from "../src/lib/repull/sources";

const DS = "ds099999";
const own = (tag: string) => ({ DOI: `10.18112/openneuro.${DS}.v${tag}` });
const OTHER = { DOI: "10.18112/openneuro.ds000001.v1.0.0" };
const KEPT = { URL: "https://example.org/kept" };
const ADDED_UP = { URL: "https://example.org/upstream-added" };
const ADDED_NEMAR = { URL: "https://example.org/nemar-added" };

function side(desc: unknown) {
  return { present: true, bytes: Buffer.from(JSON.stringify(desc)) };
}

describe("SourceDatasets merges three-way", () => {
  const merged = mergeDescription({
    base: side({ Name: "x", SourceDatasets: [OTHER, KEPT, own("1.0.0")] }),
    theirs: side({ Name: "x", SourceDatasets: [KEPT, ADDED_UP, own("1.1.0"), null] }),
    ours: side({
      Name: "x",
      DatasetDOI: "10.82901/nemar.on099999",
      SourceDatasets: [OTHER, own("1.0.0"), ADDED_NEMAR],
    }),
    ds: DS,
    toTag: "1.1.0",
    nextVersion: "2.0.0",
  });
  const out = JSON.parse(merged.mergedJson as string);

  test("keeps what either side added and drops what either side removed", () => {
    // OTHER: upstream removed it, so it is not brought back.
    // KEPT: NEMAR removed it while upstream kept it, so it stays removed.
    expect(out.SourceDatasets).toEqual([
      ADDED_UP,
      null,
      ADDED_NEMAR,
      {
        DOI: `doi:10.18112/openneuro.${DS}.v1.1.0`,
        URL: `https://openneuro.org/datasets/${DS}/versions/1.1.0`,
        Version: "1.1.0",
      },
    ]);
    expect(merged.sourceDatasets).toEqual({ kept: 2, addedByNemar: 1, removedByUpstream: 1 });
  });

  test("NEMAR's own fields are ours and N.0.0", () => {
    expect(out.DatasetDOI).toBe("10.82901/nemar.on099999");
    expect(out.Version).toBe("2.0.0");
    expect(merged.status).toBe("merged");
  });

  test("a side that does not parse is unmergeable as a whole", () => {
    const bad = mergeDescription({
      base: side({ Name: "x" }),
      theirs: { present: true, bytes: Buffer.from("{ not json") },
      ours: side({ Name: "x" }),
      ds: DS,
      toTag: "1.1.0",
      nextVersion: "2.0.0",
    });
    expect(bad.status).toBe("unparseable");
    expect(bad.mergedJson).toBeNull();
    expect(bad.explained).toBe(false);
  });
});

describe("badgeStrips", () => {
  const doi = "10.82901/nemar.on099999";
  const zenodo = `[![DOI](https://zenodo.org/badge/DOI/${doi}.svg)](https://doi.org/${doi})`;

  test("strips the current spelling, the legacy Zenodo one, and a stack of them, for the concept DOI", () => {
    const text = `${buildDoiBadge(doi)}\n\n${zenodo}\n\nBody.\n`;
    expect(badgeStrips(text, doi)).toEqual([text, `${zenodo}\n\nBody.\n`, "Body.\n"]);
    expect(badgeStrips(text, `doi:${doi}`)).toHaveLength(3);
  });

  test("leaves a badge whose image names another DOI than its link", () => {
    const forged = `[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.1.svg)](https://doi.org/${doi})\n\nBody.\n`;
    expect(badgeStrips(forged, doi)).toEqual([forged]);
  });

  test("leaves a badge for any DOI but the concept DOI, and every badge when there is none", () => {
    const stale = `${buildDoiBadge("10.82901/nemar.stale")}\n\nBody.\n`;
    expect(badgeStrips(stale, doi)).toEqual([stale]);
    expect(badgeStrips(`${buildDoiBadge(doi)}\n\nBody.\n`, null)).toHaveLength(1);
  });
});

describe("a scrubbed key needs the same declared size", () => {
  const annex = (key: string): Side => ({
    kind: "annex",
    key,
    mode: "120000",
    oid: "0".repeat(40),
  });
  const dead = { isDeadAtNemar: () => true };
  const SIZED = `SHA256E-s4256--${"a".repeat(64)}.edf`;
  const OTHER = `SHA256E-s4256--${"b".repeat(64)}.edf`;
  const UNSIZED = "URL--https&c%%example.org%x.edf";

  test("a dead upstream key and a same-size NEMAR key is the scrub", () => {
    expect(explainEdit("sub-01/eeg/x.edf", annex(SIZED), annex(OTHER), dead)).toBe("scrubbed-key");
  });

  test("an unknown size on either side is not the same size", () => {
    expect(explainEdit("sub-01/eeg/x.edf", annex(UNSIZED), annex(OTHER), dead)).toBeNull();
    expect(explainEdit("sub-01/eeg/x.edf", annex(SIZED), annex(UNSIZED), dead)).toBeNull();
  });
});

describe("bytesPhrase and orphanPhrase", () => {
  test("say how many sizes are unknown whenever one is, and drop the upper bound then", () => {
    expect(bytesPhrase(100, 0)).toBe("100 bytes");
    expect(bytesPhrase(100, 2)).toBe("100 bytes known, plus 2 of unknown size");
    expect(orphanPhrase(100, 0)).toBe("at most 100 bytes");
    expect(orphanPhrase(100, 2)).toBe("100 bytes known, plus 2 of unknown size, no upper bound");
  });
});

describe("toTagCheck orders OpenNeuro's latest against from_tag by creation, never by number", () => {
  /** OpenNeuro's answer: `order` lists the tags oldest first, a month apart, the last one latest. */
  const answer = (order: string[]) => {
    const snapshots = order.map((tag, i) => ({
      tag,
      created: `2026-${String(i + 1).padStart(2, "0")}-01T00:00:00.000Z`,
    }));
    return {
      kind: "snapshot" as const,
      latest: snapshots[snapshots.length - 1] ?? null,
      snapshots,
    };
  };
  const check = (fromTag: string | null, order: string[], mirror: string[]) =>
    toTagCheck({ flag: undefined, mirrorTags: mirror, fromTag, upstream: answer(order) }).check;

  test("a latest created after from_tag is ok", () => {
    expect(check("1.0.0", ["1.0.0", "2.0.0"], ["1.0.0", "2.0.0"])).toMatchObject({ status: "ok" });
  });

  test("a latest its own list shows older than from_tag (a withdrawn snapshot, a mirror ahead) is unverified, never ok", () => {
    // OpenNeuro names 1.0.0 latest while its list has 2.0.0 created later.
    const upstream = answer(["1.0.0", "2.0.0"]);
    const c = toTagCheck({
      flag: undefined,
      mirrorTags: ["1.0.0", "2.0.0"],
      fromTag: "2.0.0",
      upstream: { ...upstream, latest: upstream.snapshots[0] ?? null },
    }).check;
    expect(c).toMatchObject({ status: "unchecked", code: "order-unverified" });
  });

  test("a latest numerically equal to from_tag is ordered like any other tag; the same tag is nothing to pull", () => {
    // `1` and `1.0.0` are two snapshots, and OpenNeuro made `1` later.
    expect(check("1.0.0", ["1.0.0", "1"], ["1", "1.0.0"])).toMatchObject({ status: "ok" });
    expect(check("1.0.0", ["1", "1.0.0"], ["1", "1.0.0"])).toMatchObject({
      status: "refused",
      code: "nothing-to-pull",
    });
    expect(check("1.0.0", ["0.9.0", "v1.0.0"], ["1.0.0"])).toMatchObject({
      status: "refused",
      code: "nothing-to-pull",
    });
  });

  test("00006 then 1.0.0 is creation order, so 1.0.0 is newer and ok", () => {
    expect(check("00006", ["00006", "1.0.0"], ["00006", "1.0.0"])).toMatchObject({
      status: "ok",
    });
  });

  test("a from_tag OpenNeuro's list does not name is unverified, and so is no from_tag at all", () => {
    expect(check("draft", ["1.0.0"], ["1.0.0"])).toMatchObject({
      status: "unchecked",
      code: "order-unverified",
    });
    expect(check(null, ["1.0.0"], ["1.0.0"])).toMatchObject({
      status: "unchecked",
      code: "order-unverified",
    });
  });
});

describe("planSources", () => {
  test("a stand-in OpenNeuro endpoint a library caller passes is a test base too", () => {
    expect(planSources({}, undefined)).toBe("remotes");
    expect(planSources({}, "http://127.0.0.1:9/crn/graphql")).toBe("test-bases");
    expect(planSources({ NEMAR_REPULL_ORIGIN_BASE: "/tmp/o" }, undefined)).toBe("test-bases");
  });
});

describe("bareDoi", () => {
  test("drops doi: and a resolver, and a missing DOI is null so it never matches another", () => {
    expect(bareDoi(" doi:10.82901/nemar.nm000001 ")).toBe("10.82901/nemar.nm000001");
    expect(bareDoi("DOI:10.82901/nemar.nm000001")).toBe("10.82901/nemar.nm000001");
    expect(bareDoi("https://doi.org/10.82901/nemar.nm000001")).toBe("10.82901/nemar.nm000001");
    expect(bareDoi("https://dx.doi.org/10.82901/nemar.nm000001")).toBe("10.82901/nemar.nm000001");
    expect(bareDoi(null)).toBeNull();
    expect(bareDoi(undefined)).toBeNull();
    expect(bareDoi("   ")).toBeNull();
  });
});
