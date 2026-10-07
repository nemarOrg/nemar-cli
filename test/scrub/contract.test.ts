/** The scrub stage contract: keys, and the guards that refuse a file that does not match. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ContractError,
  buildKey,
  parseAssembled,
  parseDeleted,
  parseGitPlan,
  parseGitVerified,
  parseHashes,
  parseKey,
  parseKeymap,
  parsePatches,
  parsePlan,
  parseRawHashes,
  parseRawVerified,
  parseVerified,
  parseZarrVerified,
  patchDigest,
} from "../../scripts/scrub/contract";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const OLD = `SHA256E-s1000--${H1}.bdf`;
const NEW = `SHA256E-s1000--${H2}.bdf`;
const BOUND = "c".repeat(64);

interface KeyOver {
  [k: string]: unknown;
}

/** A plan key as the plan stage writes it: read, nothing to scrub, one version. */
const planKey = (over: KeyOver = {}) => ({
  oldKey: OLD,
  size: 1000,
  needsScrub: false,
  versionIds: ["v1"],
  reasons: [],
  status: "read",
  ...over,
});

/** A whole plan with totals added up here, by hand, from the keys given. */
function planText(keys: KeyOver[], over: KeyOver = {}, totals: KeyOver = {}): string {
  return JSON.stringify({
    version: 1,
    dataset: "d",
    bucket: "nemar",
    tags: ["v1.0.0"],
    createdAt: "2026-10-04T00:00:00Z",
    keys,
    totals: {
      keys: keys.length,
      needScrub: keys.filter((k) => k.needsScrub === true).length,
      bytesToHash: keys
        .filter((k) => k.needsScrub === true)
        .reduce((n, k) => n + Number(k.size), 0),
      unreadable: keys.filter((k) => k.status === "unreadable").length,
      ...totals,
    },
    ...over,
  });
}

describe("annex keys", () => {
  test("parse and build round-trip, keeping size and extension", () => {
    expect(parseKey(OLD)).toEqual({ size: 1000, sha256: H1, ext: ".bdf" });
    expect(buildKey(1000, H2, ".bdf")).toBe(NEW);
    expect(parseKey(`SHA256E-s5--${H1}`).ext).toBe("");
    expect(parseKey(`SHA256E-s5--${H1}.fif.gz`).ext).toBe(".fif.gz");
  });

  test("anything that is not a SHA256E key is refused", () => {
    for (const bad of [
      "MD5E-s1--abc.bdf",
      `SHA256E-s1--${H1.slice(1)}.bdf`,
      `SHA256E--${H1}.bdf`,
      "x",
    ]) {
      expect(() => parseKey(bad), bad).toThrow(ContractError);
    }
    expect(() => buildKey(1, "Z".repeat(64), ".bdf")).toThrow(ContractError);
  });
});

describe("stage files", () => {
  test("hashes.json: a scrubbed key keeps size and extension and must differ from the original", () => {
    const ok = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: { newKey: NEW, size: 1000, sourceSha256Verified: true, patchSha256: BOUND },
      },
    });
    expect(parseHashes(ok).entries[OLD]?.newKey).toBe(NEW);
    const sameKey = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: { newKey: OLD, size: 1000, sourceSha256Verified: true, patchSha256: BOUND },
      },
    });
    expect(() => parseHashes(sameKey)).toThrow("must not equal");
    const otherSize = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: {
          newKey: `SHA256E-s999--${H2}.bdf`,
          size: 999,
          sourceSha256Verified: true,
          patchSha256: BOUND,
        },
      },
    });
    expect(() => parseHashes(otherSize)).toThrow("size and extension");
    const otherExt = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: {
          newKey: `SHA256E-s1000--${H2}.edf`,
          size: 1000,
          sourceSha256Verified: true,
          patchSha256: BOUND,
        },
      },
    });
    expect(() => parseHashes(otherExt)).toThrow("size and extension");
  });

  test("hashes.json: every entry names the patch it was computed for, as a sha256", () => {
    const withEntry = (e: Record<string, unknown>) =>
      JSON.stringify({ version: 1, dataset: "nm1", entries: { [OLD]: e } });
    const entry = { newKey: NEW, size: 1000, sourceSha256Verified: true };
    expect(parseHashes(withEntry({ ...entry, patchSha256: BOUND })).entries[OLD]?.patchSha256).toBe(
      BOUND,
    );
    for (const patchSha256 of [undefined, "", "abc", BOUND.toUpperCase(), `${BOUND}0`, 7]) {
      expect(() => parseHashes(withEntry({ ...entry, patchSha256 })), String(patchSha256)).toThrow(
        ContractError,
      );
    }
  });

  test("a patch is bound by the sha256 of its hex text, not of the bytes it decodes to", () => {
    const hex = "ab".repeat(256);
    const asText = createHash("sha256").update(Buffer.from(hex, "utf8")).digest("hex");
    const asBytes = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
    expect(patchDigest(hex)).toBe(asText);
    expect(patchDigest(hex)).not.toBe(asBytes);
  });

  test("patches.json: exactly 256 bytes of lowercase hex per key", () => {
    expect(Object.keys(parsePatches(JSON.stringify({ [OLD]: "ab".repeat(256) })))).toEqual([OLD]);
    expect(() => parsePatches(JSON.stringify({ [OLD]: "ab".repeat(255) }))).toThrow(ContractError);
    expect(() => parsePatches(JSON.stringify({ [OLD]: "AB".repeat(256) }))).toThrow(ContractError);
    expect(() => parsePatches(JSON.stringify({ nope: "ab".repeat(256) }))).toThrow(ContractError);
  });

  test("keymap.json: only SHA256E pairs, never identity", () => {
    expect(parseKeymap(JSON.stringify({ [OLD]: NEW }))[OLD]).toBe(NEW);
    expect(() => parseKeymap(JSON.stringify({ [OLD]: OLD }))).toThrow(ContractError);
    expect(() => parseKeymap(JSON.stringify({ [OLD]: "x" }))).toThrow(ContractError);
  });

  test("plan.json, assembled.json and git-plan.json refuse another shape", () => {
    expect(() => parsePlan("{}")).toThrow(ContractError);
    expect(() =>
      parsePlan(JSON.stringify({ version: 1, dataset: "d", keys: [{ oldKey: "x" }] })),
    ).toThrow(ContractError);
    expect(() =>
      parseAssembled(
        JSON.stringify({ version: 1, entries: { [OLD]: { newKey: NEW, mode: "COMPLIANCE" } } }),
      ),
    ).toThrow(ContractError);
    expect(() => parseGitPlan(JSON.stringify({ version: 1, dropPaths: [] }))).toThrow(
      ContractError,
    );
    const gp = { version: 1, dropPaths: [], blankJsonKeys: {}, appendText: {} };
    expect(parseGitPlan(JSON.stringify({ ...gp, dataset: "d" })).dropPaths).toEqual([]);
    const withOps = {
      ...gp,
      dataset: "d",
      jsonOps: { "p.json": [{ op: "set", key: "k", value: "v" }] },
    };
    expect(parseGitPlan(JSON.stringify(withOps)).jsonOps?.["p.json"]?.length).toBe(1);
    expect(() =>
      parseGitPlan(JSON.stringify({ ...gp, dataset: "d", jsonOps: { "p.json": [{ op: "rm" }] } })),
    ).toThrow(ContractError);
    expect(() =>
      parseGitPlan(JSON.stringify({ ...gp, dataset: "d", jsonOps: { "p.json": "x" } })),
    ).toThrow(ContractError);
    expect(parsePlan(planText([planKey()])).keys.length).toBe(1);
  });

  test("zarr-verified.json: bound to two files by sha256, counts that add up", () => {
    const ok = {
      version: 1,
      dataset: "nm1",
      verifiedAt: "2026-10-04T00:00:00Z",
      planSha256: H1,
      zarrPlanSha256: H2,
      found: "stores",
      stores: ["sub-01/a.zarr", "sub-01/b.zarr", "sub-02/c.zarr"],
      allowedMembers: ["recordingnote"],
      counts: { stores: 3, docs: 7, rewritten: 2, untouched: 5 },
    };
    // The whole shape, read back: not merely "it parsed".
    expect(parseZarrVerified(JSON.stringify(ok))).toEqual(ok as never);
    const none = {
      ...ok,
      found: "no-zarr",
      stores: [],
      allowedMembers: [],
      counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 },
    };
    expect(parseZarrVerified(JSON.stringify(none))).toEqual(none as never);
    const bad = (over: Record<string, unknown>) => JSON.stringify({ ...ok, ...over });
    for (const over of [
      { version: 2 },
      { dataset: 7 },
      { dataset: "" },
      { verifiedAt: "yesterday" },
      { verifiedAt: undefined },
      // Never vacuous: no store under `stores`, stores under `no-zarr`, or neither word.
      { stores: [], counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 } },
      { found: "no-zarr" },
      { found: undefined },
      { found: "none" },
      { planSha256: "abc" },
      { planSha256: H1.toUpperCase() },
      { zarrPlanSha256: undefined },
      { counts: { stores: 3, docs: 7, rewritten: 1, untouched: 1 } },
      { counts: { stores: 3, rewritten: 2, untouched: 1 } },
      // Fewer documents than store roots, and a stores list that is not `stores` long.
      { counts: { stores: 3, docs: 2, rewritten: 1, untouched: 1 } },
      { stores: ["sub-01/a.zarr"] },
      { stores: ["sub-01/a.zarr", "sub-01/a.zarr", "sub-02/c.zarr"] },
      { stores: ["sub-01/a", "sub-01/b.zarr", "sub-02/c.zarr"] },
      { stores: ["../a.zarr", "sub-01/b.zarr", "sub-02/c.zarr"] },
      { stores: undefined },
      { allowedMembers: ["Not Canonical"] },
      { allowedMembers: undefined },
      { counts: { stores: -1, docs: -1, rewritten: -1, untouched: 0 } },
      { counts: { stores: 1.5, docs: 1.5, rewritten: 1.5, untouched: 0 } },
      { counts: null },
    ]) {
      expect(() => parseZarrVerified(bad(over)), JSON.stringify(over)).toThrow(ContractError);
    }
  });

  test("plan.json: partial is a boolean, and a git: key is carried only by an unreadable entry", () => {
    expect(parsePlan(planText([planKey()], { partial: true })).partial).toBe(true);
    expect(() => parsePlan(planText([planKey()], { partial: "yes" }))).toThrow(ContractError);
    const git = `git:${"b".repeat(40)}`;
    const inline = planKey({ oldKey: git, status: "unreadable", size: 0 });
    expect(parsePlan(planText([inline])).keys.length).toBe(1);
    expect(() => parsePlan(planText([planKey({ oldKey: git, size: 0 })]))).toThrow(ContractError);
    expect(() => parsePlan(planText([{ ...inline, oldKey: "git:zz" }]))).toThrow(ContractError);
  });

  test("plan.json: every field a stage trusts is checked, and totals must match the keys", () => {
    const other = `SHA256E-s2000--${H2}.edf`;
    const scrub = planKey({ needsScrub: true, reasons: ["edf-patient-name"] });
    const good = [scrub, planKey({ oldKey: other, size: 2000 })];
    const parsed = parsePlan(planText(good));
    expect(parsed.totals).toEqual({ keys: 2, needScrub: 1, bytesToHash: 1000, unreadable: 0 });

    const mutations: Array<[string, string]> = [
      // Totals that hide or invent something.
      ["unreadable hidden", planText([planKey({ status: "unreadable" })], {}, { unreadable: 0 })],
      ["unreadable invented", planText([planKey()], {}, { unreadable: 1 })],
      ["bytes shrunk", planText(good, {}, { bytesToHash: 1 })],
      ["bytes counted for a clean key", planText(good, {}, { bytesToHash: 3000 })],
      ["needScrub wrong", planText(good, {}, { needScrub: 2 })],
      ["keys wrong", planText(good, {}, { keys: 3 })],
      ["a total negative", planText(good, {}, { keys: -2 })],
      ["a total fractional", planText(good, {}, { keys: 2.5 })],
      ["a total a string", planText(good, {}, { keys: "2" })],
      ["totals absent", JSON.stringify({ ...JSON.parse(planText(good)), totals: undefined })],
      ["totals not an object", planText(good, { totals: [] })],
      // Fields of a key.
      ["status unknown", planText([planKey({ status: "ok" })])],
      ["status absent", planText([planKey({ status: undefined })])],
      ["size absent", planText([planKey({ size: undefined })])],
      ["size negative", planText([planKey({ size: -1 })])],
      ["size fractional", planText([planKey({ size: 1000.5 })])],
      ["size disagrees with the key", planText([planKey({ size: 999 })])],
      ["size a string", planText([planKey({ size: "1000" })])],
      ["versionIds absent", planText([planKey({ versionIds: undefined })])],
      ["versionIds not strings", planText([planKey({ versionIds: [1] })])],
      ["versionIds a string", planText([planKey({ versionIds: "v1" })])],
      ["reasons not strings", planText([planKey({ reasons: [null] })])],
      ["needsScrub absent", planText([planKey({ needsScrub: undefined })])],
      [
        "needsScrub on an unread key",
        planText([planKey({ needsScrub: true, status: "unreadable" })]),
      ],
      ["the same key twice", planText([planKey(), planKey()])],
      // The header.
      ["bucket a number", planText(good, { bucket: 1 })],
      ["bucket absent", planText(good, { bucket: undefined })],
      ["bucket empty", planText(good, { bucket: "" })],
      ["dataset empty", planText(good, { dataset: "" })],
      ["tags not strings", planText(good, { tags: [1] })],
      ["keys not a list", planText(good, { keys: {} })],
    ];
    for (const [label, text] of mutations) {
      expect(() => parsePlan(text), label).toThrow(ContractError);
    }
  });

  test("assembled.json: every field verify and delete-old act on is checked", () => {
    const entry = {
      newKey: NEW,
      newVersionId: "v-new",
      retainUntil: "2126-10-04T00:00:00Z",
      mode: "GOVERNANCE",
    };
    const doc = (over: KeyOver = {}, e: KeyOver = {}) =>
      JSON.stringify({
        version: 1,
        dataset: "nm000186",
        bucket: "nemar",
        entries: { [OLD]: { ...entry, ...e } },
        ...over,
      });
    expect(parseAssembled(doc()).entries[OLD]?.newVersionId).toBe("v-new");
    // Milliseconds are allowed, and the value comes back exactly as written.
    expect(
      parseAssembled(doc({}, { retainUntil: "2126-10-04T00:00:00.000Z" })).entries[OLD]
        ?.retainUntil,
    ).toBe("2126-10-04T00:00:00.000Z");
    const mutations: Array<[string, string]> = [
      // Reviewer probe T4: without it, a HEAD would check the current version instead.
      ["newVersionId absent", doc({}, { newVersionId: undefined })],
      ["newVersionId empty", doc({}, { newVersionId: "" })],
      ["newVersionId a number", doc({}, { newVersionId: 7 })],
      ["retainUntil absent", doc({}, { retainUntil: undefined })],
      ["retainUntil not a date", doc({}, { retainUntil: "forever" })],
      ["retainUntil a bare day", doc({}, { retainUntil: "2126-10-04" })],
      ["mode COMPLIANCE", doc({}, { mode: "COMPLIANCE" })],
      ["newKey another size", doc({}, { newKey: `SHA256E-s999--${H2}.bdf` })],
      ["newKey another extension", doc({}, { newKey: `SHA256E-s1000--${H2}.edf` })],
      ["newKey the old key", doc({}, { newKey: OLD })],
      ["newKey not a key", doc({}, { newKey: "x" })],
      ["dataset absent", doc({ dataset: undefined })],
      ["dataset empty", doc({ dataset: "" })],
      ["bucket absent", doc({ bucket: undefined })],
      ["bucket empty", doc({ bucket: "" })],
      ["entries a list", doc({ entries: [] })],
      ["version 2", doc({ version: 2 })],
    ];
    for (const [label, text] of mutations) {
      expect(() => parseAssembled(text), label).toThrow(ContractError);
    }
  });

  test("verified.json: the proof's counts are counts, and its digest is a sha256", () => {
    const ok = {
      version: 1,
      dataset: "d",
      verifiedAt: "2026-10-04T00:00:00Z",
      assembledSha256: H1,
      counts: { keys: 3, headersChecked: 3, rangesCompared: 27 },
    };
    expect(parseVerified(JSON.stringify(ok)).counts.rangesCompared).toBe(27);
    for (const over of [
      { dataset: 1 },
      { dataset: "" },
      { verifiedAt: undefined },
      { verifiedAt: "not a date" },
      { verifiedAt: "2026-13-45T00:00:00Z" },
      { assembledSha256: "abc" },
      { assembledSha256: H1.toUpperCase() },
      { counts: undefined },
      { counts: { keys: 3, headersChecked: 3 } },
      { counts: { keys: -1, headersChecked: 3, rangesCompared: 0 } },
      { counts: { keys: 3, headersChecked: 3.5, rangesCompared: 0 } },
      { counts: { keys: "3", headersChecked: 3, rangesCompared: 0 } },
      { counts: { keys: 3, headersChecked: 3, rangesCompared: null } },
    ]) {
      expect(() => parseVerified(JSON.stringify({ ...ok, ...over })), JSON.stringify(over)).toThrow(
        ContractError,
      );
    }
  });

  test("git-verified.json: the provenance counts are counts, and a proof from before them still parses", () => {
    const proof = {
      version: 1,
      dataset: "nm000186",
      mode: "fresh-clone",
      verifiedAt: "2026-10-06T00:00:00.000Z",
      keymapSha256: H1,
      gitPlanSha256: H2,
      s3PlanSha256: BOUND,
      counts: { refs: 5, commits: 9, provenanceHashesKept: 88, provenanceBlobsKept: 2 },
    };
    expect(parseGitVerified(JSON.stringify(proof)).counts.provenanceHashesKept).toBe(88);
    // Written before the provenance exception: that verify kept no old hash at all, a stricter
    // check, so its proof is still a proof.
    const older = { ...proof, counts: { refs: 5, commits: 9 } };
    expect(parseGitVerified(JSON.stringify(older)).counts.provenanceHashesKept).toBeUndefined();
    for (const counts of [
      { ...proof.counts, provenanceHashesKept: -1 },
      { ...proof.counts, provenanceHashesKept: 1.5 },
      { ...proof.counts, provenanceBlobsKept: "2" },
    ]) {
      expect(
        () => parseGitVerified(JSON.stringify({ ...proof, counts })),
        JSON.stringify(counts),
      ).toThrow(ContractError);
    }
    // The kept count is a count, not a field of its own: one beside `counts` is still refused.
    expect(() => parseGitVerified(JSON.stringify({ ...proof, provenanceHashesKept: 88 }))).toThrow(
      ContractError,
    );
  });

  test("git-verified.json: allowedTags is optional, and when there it is a sorted list of version tags", () => {
    const proof = {
      version: 1,
      dataset: "nm000112",
      mode: "fresh-clone",
      verifiedAt: "2026-10-07T00:00:00.000Z",
      keymapSha256: H1,
      gitPlanSha256: H2,
      s3PlanSha256: BOUND,
      counts: { refs: 6, commits: 9 },
    };
    // Without the field, or with the tags the operator named, it is a proof.
    expect(parseGitVerified(JSON.stringify(proof)).allowedTags).toBeUndefined();
    expect(
      parseGitVerified(JSON.stringify({ ...proof, allowedTags: ["v1.1.1"] })).allowedTags,
    ).toEqual(["v1.1.1"]);
    expect(
      parseGitVerified(JSON.stringify({ ...proof, allowedTags: ["v1.1.1", "v2.0.0-rc1"] }))
        .allowedTags,
    ).toEqual(["v1.1.1", "v2.0.0-rc1"]);
    // Present only when there is a tag, and a tag the git plan would refuse is no tag here.
    for (const allowedTags of [
      [],
      null,
      "v1.1.1",
      { 0: "v1.1.1" },
      [1],
      [null],
      [""],
      ["1.1.1"],
      ["v1.1"],
      ["v1.1.1 "],
      ["v1.1.1-"],
      ["v1.1.1/../x"],
      ["main"],
      ["v1.1.1", "v1.1.1"],
      ["v2.0.0", "v1.1.1"],
    ]) {
      expect(
        () => parseGitVerified(JSON.stringify({ ...proof, allowedTags })),
        JSON.stringify(allowedTags),
      ).toThrow(ContractError);
    }
    // The flag exists in a fresh-clone verify only, so no other proof carries a list.
    expect(() =>
      parseGitVerified(JSON.stringify({ ...proof, mode: "local", allowedTags: ["v1.1.1"] })),
    ).toThrow(ContractError);
    expect(parseGitVerified(JSON.stringify({ ...proof, mode: "local" })).mode).toBe("local");
    // Still no field the contract does not name.
    expect(() =>
      parseGitVerified(JSON.stringify({ ...proof, allowedTags: ["v1.1.1"], extra: 1 })),
    ).toThrow(ContractError);
    expect(() => parseGitVerified(JSON.stringify({ ...proof, extra: 1 }))).toThrow(ContractError);
  });
});

describe("raw copies (ADR 0085, amendment of 2026-10-06)", () => {
  const rec = {
    name: "sub-01/eeg/sub-01_eeg.BDF",
    kind: "recording",
    versions: [{ id: "v1", size: 1000 }],
    markers: ["m1"],
  };
  const tsv = {
    name: "participants.tsv",
    kind: "other",
    versions: [{ id: "v2", size: 9 }],
    markers: [],
  };
  const folder = { name: "code/", kind: "other", versions: [{ id: "v3", size: 0 }], markers: [] };
  const onlyMarker = { name: "CHANGES", kind: "other", versions: [], markers: ["m2"] };
  /** A plan with these raw copies and totals counted here, by hand. */
  const rawPlan = (raw: KeyOver[], totals: KeyOver = {}) => {
    const count = (f: (r: KeyOver) => unknown[] | undefined) =>
      raw.reduce((n, r) => n + (Array.isArray(f(r)) ? (f(r) as unknown[]).length : 0), 0);
    return planText(
      [planKey()],
      { rawCopies: raw },
      {
        rawCopyNames: raw.length,
        rawCopyVersions: count((r) => r.versions as unknown[]),
        rawCopyMarkers: count((r) => r.markers as unknown[]),
        ...totals,
      },
    );
  };
  const sorted = [onlyMarker, folder, tsv, rec];

  test("plan.json: raw copies are carried exactly, and a plan without them is unchanged", () => {
    const plan = parsePlan(rawPlan(sorted));
    expect(plan.rawCopies?.map((r) => r.name)).toEqual([
      "CHANGES",
      "code/",
      "participants.tsv",
      rec.name,
    ]);
    expect(plan.totals).toMatchObject({ rawCopyNames: 4, rawCopyVersions: 3, rawCopyMarkers: 2 });
    // None at all: neither the list nor its counts.
    expect(parsePlan(planText([planKey()])).rawCopies).toBeUndefined();
    // An empty list with zero counts is a plan with none.
    expect(parsePlan(rawPlan([])).rawCopies).toEqual([]);
    const mutations: Array<[string, string]> = [
      ["an unknown member", rawPlan([{ ...tsv, more: 1 }])],
      ["a member missing", rawPlan([{ name: tsv.name, kind: "other", versions: tsv.versions }])],
      ["a recording called other", rawPlan([{ ...rec, kind: "other" }])],
      ["a text file called a recording", rawPlan([{ ...tsv, kind: "recording" }])],
      ["annex-uuid", rawPlan([{ ...tsv, name: "annex-uuid" }])],
      ["an annex key's name", rawPlan([{ ...rec, name: `SHA256E-s1000--${H1}.bdf` }])],
      ["a bad annex key's name", rawPlan([{ ...tsv, name: "SHA256E-x" }])],
      ["an empty name", rawPlan([{ ...tsv, name: "" }])],
      ["a NUL", rawPlan([{ ...tsv, name: "a\u0000b" }])],
      ["a lone surrogate", rawPlan([{ ...tsv, name: "a\ud800b" }])],
      ["a carriage return", rawPlan([{ ...tsv, name: "a\rb.tsv" }])],
      ["a tab", rawPlan([{ ...tsv, name: "a\tb.tsv" }])],
      ["a line feed", rawPlan([{ ...tsv, name: "a\nb.tsv" }])],
      ["U+001F", rawPlan([{ ...tsv, name: "a\u001fb.tsv" }])],
      ["DEL", rawPlan([{ ...tsv, name: "a\u007fb.tsv" }])],
      ["a C1 control", rawPlan([{ ...tsv, name: "a\u0085b.tsv" }])],
      ["U+FFFE", rawPlan([{ ...tsv, name: "a\ufffeb.tsv" }])],
      ["U+FFFF", rawPlan([{ ...tsv, name: "a\uffffb.tsv" }])],
      ["out of order", rawPlan([tsv, folder])],
      ["a name twice", rawPlan([tsv, tsv])],
      ["nothing under the name", rawPlan([{ ...tsv, versions: [] }])],
      ["an id twice", rawPlan([{ ...rec, markers: ["v1"] }])],
      ["a version id empty", rawPlan([{ ...tsv, versions: [{ id: "", size: 9 }] }])],
      ["a size negative", rawPlan([{ ...tsv, versions: [{ id: "v2", size: -1 }] }])],
      ["a size a string", rawPlan([{ ...tsv, versions: [{ id: "v2", size: "9" }] }])],
      ["a version with more", rawPlan([{ ...tsv, versions: [{ id: "v2", size: 9, x: 1 }] }])],
      ["a marker a number", rawPlan([{ ...tsv, markers: [7] }])],
      ["rawCopies an object", planText([planKey()], { rawCopies: {} })],
      ["names counted wrong", rawPlan(sorted, { rawCopyNames: 3 })],
      ["versions counted wrong", rawPlan(sorted, { rawCopyVersions: 4 })],
      ["markers counted wrong", rawPlan(sorted, { rawCopyMarkers: 1 })],
      ["a count absent", rawPlan(sorted, { rawCopyMarkers: undefined })],
      ["raw counts without raw copies", planText([planKey()], {}, { rawCopyNames: 0 })],
    ];
    for (const [label, text] of mutations) {
      expect(() => parsePlan(text), label).toThrow(ContractError);
    }
  });

  test("raw-hashes.json: a digest or the one failure word per version, never twice", () => {
    const digest = {
      name: tsv.name,
      versionId: "v2",
      size: 9,
      sha256: H1,
      gitBlobSha1: "c".repeat(40),
    };
    const failure = { name: rec.name, versionId: "v1", failure: "size-differs" };
    const doc = (entries: unknown[], over: KeyOver = {}) =>
      JSON.stringify({ version: 1, dataset: "nm000112", planSha256: H2, entries, ...over });
    expect(parseRawHashes(doc([failure, digest])).entries.length).toBe(2);
    // The writer's order is not checked: Python and JavaScript sort strings differently.
    expect(parseRawHashes(doc([digest, failure])).entries.length).toBe(2);
    const mutations: Array<[string, string]> = [
      ["an extra field", doc([digest], { more: 1 })],
      ["planSha256 not a sha256", doc([digest], { planSha256: "x" })],
      ["entries an object", doc([digest], { entries: {} })],
      ["a digest with more", doc([{ ...digest, more: 1 }])],
      ["a digest missing its blob id", doc([{ ...digest, gitBlobSha1: undefined }])],
      ["a blob id of SHA-256 length", doc([{ ...digest, gitBlobSha1: H1 }])],
      ["a sha256 in upper case", doc([{ ...digest, sha256: H1.toUpperCase() }])],
      ["a size negative", doc([{ ...digest, size: -1 }])],
      ["another failure word", doc([{ ...failure, failure: "read-failed" }])],
      ["a failure with a digest", doc([{ ...failure, sha256: H1 }])],
      ["a version twice", doc([digest, { ...digest }])],
      ["annex-uuid", doc([{ ...digest, name: "annex-uuid" }])],
      ["an empty version id", doc([{ ...digest, versionId: "" }])],
    ];
    for (const [label, text] of mutations) {
      expect(() => parseRawHashes(text), label).toThrow(ContractError);
    }
  });

  test("raw-verified.json: three bindings, counts that add up, and never vacuous", () => {
    const ok = {
      version: 1,
      dataset: "nm000112",
      verifiedAt: "2026-10-06T00:00:00.000Z",
      planSha256: H1,
      rawHashesSha256: H2,
      gitBlobsSha256: BOUND,
      matchedKeys: [`SHA256E-s1000--${H1}.bdf`, `SHA256E-s9--${H2}.edf`],
      counts: { names: 3, versions: 4, markers: 2, matchedRecordings: 1, matchedOther: 3 },
    };
    expect(parseRawVerified(JSON.stringify(ok)).counts.matchedOther).toBe(3);
    // Only markers left under the names: no version to match, still a proof about names.
    const markersOnly = {
      ...ok,
      matchedKeys: [],
      counts: { ...ok.counts, versions: 0, matchedRecordings: 0, matchedOther: 0 },
    };
    expect(parseRawVerified(JSON.stringify(markersOnly)).counts.versions).toBe(0);
    for (const over of [
      { more: 1 },
      { planSha256: "x" },
      { gitBlobsSha256: undefined },
      { verifiedAt: "today" },
      { counts: { ...ok.counts, matchedOther: 2 } },
      { counts: { ...ok.counts, names: 0 } },
      { counts: { ...ok.counts, extra: 1 } },
      { counts: { ...ok.counts, markers: -1 } },
      // The matched keys: annex keys, strictly sorted, there exactly when a recording matched.
      { matchedKeys: undefined },
      { matchedKeys: "SHA256E-s9" },
      { matchedKeys: [...ok.matchedKeys].reverse() },
      { matchedKeys: [ok.matchedKeys[0], ok.matchedKeys[0]] },
      { matchedKeys: ["participants.tsv"] },
      { matchedKeys: [`git:${"a".repeat(40)}`] },
      { matchedKeys: [] },
      { ...markersOnly, matchedKeys: [ok.matchedKeys[0]] },
    ]) {
      expect(
        () => parseRawVerified(JSON.stringify({ ...ok, ...over })),
        JSON.stringify(over),
      ).toThrow(ContractError);
    }
  });

  test("deleted.json: the raw counts come as a pair or not at all", () => {
    const base = {
      version: 1,
      dataset: "nm000112",
      deletedAt: "2026-10-06T00:00:00.000Z",
      assembledSha256: H1,
      counts: { keys: 2, versions: 2, markers: 0, prunedVersions: 0, prunedMarkers: 0 },
    };
    expect(parseDeleted(JSON.stringify(base)).counts.rawVersions).toBeUndefined();
    const raw = { ...base, counts: { ...base.counts, rawVersions: 747, rawMarkers: 127 } };
    expect(parseDeleted(JSON.stringify(raw)).counts).toMatchObject({
      rawVersions: 747,
      rawMarkers: 127,
    });
    for (const counts of [
      { ...base.counts, rawVersions: 747 },
      { ...base.counts, rawMarkers: 127 },
      { ...base.counts, rawVersions: 1, rawMarkers: -1 },
      { ...base.counts, rawVersions: 1, rawMarkers: 1, rawNames: 1 },
    ]) {
      expect(
        () => parseDeleted(JSON.stringify({ ...base, counts })),
        JSON.stringify(counts),
      ).toThrow(ContractError);
    }
  });
});
