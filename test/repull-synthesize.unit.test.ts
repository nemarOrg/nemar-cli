/**
 * What the re-pull synthesis checks before it accepts its commit (ADR 0111, decisions 1, 2 and 8;
 * epic #1046 phase 6): `assertSynthesized` and the copy manifest it checks.
 *
 * The integration suite (`repull-execute-prepare.test.ts`) drives a real preparation, which by
 * construction never produces most of what this refuses: an upload that is not a local one, a copy
 * key outside the plan, a replaced key still named. So each rule is pinned here on its own, over
 * entries shaped as the index and the plan give them, one change at a time from a tree that
 * passes.
 */

import { describe, expect, test } from "bun:test";
import type { ImportScrubResult } from "../src/lib/import-scrub";
import type { PlanBody } from "../src/lib/repull/digest";
import {
  type CopyManifest,
  type Entry,
  assertSynthesized,
  buildCopyManifest,
  manifestDigest,
} from "../src/lib/repull/execute/synthesize";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";
import type { ImportManifestItem } from "../src/lib/s3-server-copy";

const K = {
  copied: "SHA256E-s10--1111111111111111111111111111111111111111111111111111111111111111.edf",
  upstreamFlagged:
    "SHA256E-s20--2222222222222222222222222222222222222222222222222222222222222222.edf",
  rekeyed: "SHA256E-s20--3333333333333333333333333333333333333333333333333333333333333333.edf",
  motion: "SHA256E-s5--4444444444444444444444444444444444444444444444444444444444444444.tsv",
  held: "SHA256E-s7--5555555555555555555555555555555555555555555555555555555555555555.edf",
  stray: "SHA256E-s9--6666666666666666666666666666666666666666666666666666666666666666.edf",
};
const OID = (n: number) => String(n).repeat(40).slice(0, 40);

function body(): PlanBody {
  return {
    planner: 2,
    dataset: "xx099999",
    upstream: { ds: "ds099999", from_tag: "1.0.0", to_tag: "1.1.0", to_commit: OID(1) },
    nemar: { main_commit: OID(2) },
    versions: { current: "1.0.0", n0: "2.0.0", n1: null },
    paths: [],
    copy: {
      destination_prefix: "xx099999/objects/",
      dead_recordings: [],
      items: [
        {
          key: K.copied,
          purpose: "copy",
          size: 10,
          pin: { bucket: "openneuro.org", object: "ds099999/sub-03/a.edf", version: "v1" },
        },
        {
          key: K.upstreamFlagged,
          purpose: "copy",
          size: 20,
          pin: { bucket: "openneuro.org", object: "ds099999/sub-04/b.edf", version: "v2" },
        },
      ],
    },
  };
}

const annex = (key: string): Entry => ({ mode: "120000", oid: OID(9), key });
const blob = (oid: string, mode = "100644"): Entry => ({ mode, oid, key: null });

function scrubResult(over: Partial<ImportScrubResult> = {}): ImportScrubResult {
  return {
    counts: {} as ImportScrubResult["counts"],
    items: [local(K.rekeyed)],
    replacedKeys: new Set([K.upstreamFlagged]),
    handledPaths: new Set(),
    historyHoldsOriginals: false,
    headerReadKeys: new Set([K.copied, K.upstreamFlagged]),
    committed: true,
    ...over,
  };
}

function local(key: string): ImportManifestItem {
  return {
    key,
    sourceUrl: null,
    source: null,
    destUri: `s3://nemar/xx099999/objects/${key}`,
    origin: "local",
  };
}

/** A preparation that passes: two delta recordings (one copied, one re-keyed by the scrub), git-held
 * motion data annexed, a JSON blanked, a deletion, a held recording the plan does not touch. */
function passing() {
  const base = new Map<string, Entry>([
    ["sub-01/eeg/kept.edf", annex(K.held)],
    ["sub-01/eeg/kept.json", blob(OID(3))],
    ["sub-02/eeg/gone.json", blob(OID(4))],
    ["sourcedata/sourcedata_provenance.json", blob(OID(5))],
    [".nemar/corrections.jsonl", blob(OID(6))],
  ]);
  const expected = new Map<string, string>([
    ["sub-03/a.edf", `A:${K.copied}`],
    ["sub-04/b.edf", `A:${K.upstreamFlagged}`],
    ["sub-02/motion/m_motion.tsv", `L:${OID(7)}`],
    ["sub-03/a.json", `G:100644:${OID(8)}`],
    ["sub-02/eeg/gone.json", "absent"],
  ]);
  const tree = new Map<string, Entry>([
    ["sub-01/eeg/kept.edf", annex(K.held)],
    ["sub-01/eeg/kept.json", blob(OID(3))],
    // Annotated by the scrub, which reads the provenance files whenever a header changes.
    ["sourcedata/sourcedata_provenance.json", blob("a".repeat(40))],
    [".nemar/corrections.jsonl", blob("b".repeat(40))],
    ["sub-03/a.edf", annex(K.copied)],
    ["sub-04/b.edf", annex(K.rekeyed)],
    ["sub-02/motion/m_motion.tsv", annex(K.motion)],
    // Blanked by the scrub: what was staged before it is the plan's target.
    ["sub-03/a.json", blob("c".repeat(40))],
  ]);
  const preScrub = new Map<string, Entry>([
    ["sub-03/a.edf", annex(K.copied)],
    ["sub-04/b.edf", annex(K.upstreamFlagged)],
    ["sub-02/motion/m_motion.tsv", blob(OID(7))],
    ["sub-03/a.json", blob(OID(8))],
    ["sourcedata/sourcedata_provenance.json", blob(OID(5))],
  ]);
  const scope = new Set([...expected.keys(), "sourcedata/sourcedata_provenance.json"]);
  const scrub = scrubResult();
  const uploaded: ImportManifestItem[] = [...scrub.items, local(K.motion)];
  const held = new Set([K.held]);
  const b = body();
  const named = new Set(
    [...tree].filter(([p, e]) => e.key && !p.startsWith(".nemar/")).map(([, e]) => e.key as string),
  );
  const manifest = buildCopyManifest({ named, body: b, digest: `sha256:${"0".repeat(64)}`, held });
  return { tree, base, expected, preScrub, scope, body: b, scrub, uploaded, held, manifest };
}

function refusalOf(fn: () => void): ExecuteRefused | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ExecuteRefused) return err;
    throw err;
  }
}

describe("assertSynthesized", () => {
  test("a tree with the plan's targets and the scrub's changes passes, and the manifest is what is copied and uploaded", () => {
    const args = passing();
    expect(refusalOf(() => assertSynthesized(args))).toBeNull();
    expect(args.manifest.items.map((i) => i.key)).toEqual([K.copied]);
    expect(args.manifest.local.map((i) => i.key).sort()).toEqual([K.motion, K.rekeyed].sort());
    expect(manifestDigest(args.manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The digest is of canonical JSON: the same manifest, built again, has the same digest.
    expect(manifestDigest(passing().manifest)).toBe(manifestDigest(args.manifest));
  });

  test("an extra key planted in the scrub's result, not a local upload, refuses", () => {
    const args = passing();
    const planted: ImportManifestItem = { ...local(K.stray), origin: undefined };
    const err = refusalOf(() =>
      assertSynthesized({ ...args, uploaded: [...args.uploaded, planted] }),
    );
    expect(err?.code).toBe("synthesis-mismatch");
  });

  test("a named copy key passed off as an upload, not a local one, refuses", () => {
    const args = passing();
    const planted: ImportManifestItem = { ...local(K.copied), origin: undefined };
    const err = refusalOf(() =>
      assertSynthesized({ ...args, uploaded: [...args.uploaded, planted] }),
    );
    expect(err?.code).toBe("synthesis-mismatch");
    expect(err?.message).toContain("not a local upload");
  });

  test("an upload the tree does not name refuses", () => {
    const args = passing();
    const err = refusalOf(() =>
      assertSynthesized({ ...args, uploaded: [...args.uploaded, local(K.stray)] }),
    );
    expect(err?.code).toBe("synthesis-mismatch");
  });

  test("a copy key outside the plan refuses (the manifest is a subset of the plan's copy keys)", () => {
    const args = passing();
    const manifest: CopyManifest = {
      ...args.manifest,
      items: [
        ...args.manifest.items,
        { key: K.stray, bucket: "openneuro.org", object: "ds099999/x.edf", version: "v9", size: 9 },
      ],
    };
    const err = refusalOf(() => assertSynthesized({ ...args, manifest }));
    expect(err?.code).toBe("synthesis-mismatch");
    expect(err?.message).toContain("outside the plan");
  });

  test("a local manifest key this run did not upload refuses", () => {
    const args = passing();
    const manifest: CopyManifest = {
      ...args.manifest,
      local: [...args.manifest.local, { key: K.stray, size: 9 }],
    };
    expect(refusalOf(() => assertSynthesized({ ...args, manifest }))?.code).toBe(
      "synthesis-mismatch",
    );
  });

  test("a key the scrub replaced, still named anywhere, refuses", () => {
    const args = passing();
    const tree = new Map(args.tree);
    tree.set("sub-05/copy.edf", annex(K.upstreamFlagged));
    const expected = new Map(args.expected);
    expected.set("sub-05/copy.edf", `A:${K.upstreamFlagged}`);
    const err = refusalOf(() => assertSynthesized({ ...args, tree, expected }));
    expect(err?.message).toContain("replaced");
  });

  test("a named key that is neither held, copied nor uploaded refuses", () => {
    const args = passing();
    const tree = new Map(args.tree);
    tree.set("sub-01/eeg/kept.edf", annex(K.stray));
    const base = new Map(args.base);
    base.set("sub-01/eeg/kept.edf", annex(K.stray));
    const err = refusalOf(() => assertSynthesized({ ...args, tree, base }));
    expect(err?.message).toContain("neither held");
  });

  test("a delta path that is not its target refuses, unless the scrub rewrote it in scope", () => {
    const args = passing();
    const tree = new Map(args.tree);
    tree.set("sub-03/a.json", blob("d".repeat(40)));
    const notScrubbed = new Map(args.preScrub);
    notScrubbed.set("sub-03/a.json", blob("e".repeat(40)));
    expect(refusalOf(() => assertSynthesized({ ...args, preScrub: notScrubbed }))?.code).toBe(
      "synthesis-mismatch",
    );
    const scope = new Set(args.scope);
    scope.delete("sub-03/a.json");
    expect(refusalOf(() => assertSynthesized({ ...args, scope }))?.code).toBe("synthesis-mismatch");
    // A blob the scrub could not have rewritten (not a JSON, a scans table or a provenance file).
    const expected = new Map(args.expected);
    expected.set("sub-03/a.tsv", `G:100644:${OID(8)}`);
    const t2 = new Map(args.tree);
    t2.set("sub-03/a.tsv", blob("c".repeat(40)));
    const p2 = new Map(args.preScrub);
    p2.set("sub-03/a.tsv", blob(OID(8)));
    const s2 = new Set([...args.scope, "sub-03/a.tsv"]);
    expect(
      refusalOf(() => assertSynthesized({ ...args, expected, tree: t2, preScrub: p2, scope: s2 }))
        ?.code,
    ).toBe("synthesis-mismatch");
  });

  test("a path the plan does not list must be NEMAR's side as it was; only a provenance file the scrub annotated differs", () => {
    const args = passing();
    const tree = new Map(args.tree);
    tree.set("sub-01/eeg/kept.json", blob("f".repeat(40)));
    expect(refusalOf(() => assertSynthesized({ ...args, tree }))?.code).toBe("synthesis-mismatch");
    // The annotated provenance file outside the scope: not the scrub's to change.
    const scope = new Set(args.scope);
    scope.delete("sourcedata/sourcedata_provenance.json");
    expect(refusalOf(() => assertSynthesized({ ...args, scope }))?.code).toBe("synthesis-mismatch");
    // NEMAR-owned paths are not compared (the ledger gained the scrub's line).
    expect(args.tree.get(".nemar/corrections.jsonl")).not.toEqual(
      args.base.get(".nemar/corrections.jsonl"),
    );
  });

  test("a re-keyed recording must carry a key this run uploaded; annexed git-held data likewise", () => {
    const args = passing();
    const uploaded = args.uploaded.filter((i) => i.key !== K.rekeyed);
    expect(refusalOf(() => assertSynthesized({ ...args, uploaded }))?.code).toBe(
      "synthesis-mismatch",
    );
    const tree = new Map(args.tree);
    tree.set("sub-02/motion/m_motion.tsv", blob(OID(7)));
    expect(refusalOf(() => assertSynthesized({ ...args, tree }))?.code).toBe("synthesis-mismatch");
  });

  test("a deleted path still present refuses", () => {
    const args = passing();
    const tree = new Map(args.tree);
    tree.set("sub-02/eeg/gone.json", blob(OID(4)));
    expect(refusalOf(() => assertSynthesized({ ...args, tree }))?.code).toBe("synthesis-mismatch");
  });
});
