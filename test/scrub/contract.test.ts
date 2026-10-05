/** The scrub stage contract: keys, and the guards that refuse a file that does not match. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ContractError,
  buildKey,
  parseAssembled,
  parseGitPlan,
  parseHashes,
  parseKey,
  parseKeymap,
  parsePatches,
  parsePlan,
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
      counts: { stores: 3, rewritten: 2, untouched: 1 },
    };
    expect(parseZarrVerified(JSON.stringify(ok)).counts.stores).toBe(3);
    const none = { ...ok, found: "no-zarr", counts: { stores: 0, rewritten: 0, untouched: 0 } };
    expect(parseZarrVerified(JSON.stringify(none)).found).toBe("no-zarr");
    const bad = (over: Record<string, unknown>) => JSON.stringify({ ...ok, ...over });
    for (const over of [
      { version: 2 },
      { dataset: 7 },
      { dataset: "" },
      { verifiedAt: "yesterday" },
      { verifiedAt: undefined },
      // Never vacuous: no store under `stores`, stores under `no-zarr`, or neither word.
      { counts: { stores: 0, rewritten: 0, untouched: 0 } },
      { found: "no-zarr" },
      { found: undefined },
      { found: "none" },
      { planSha256: "abc" },
      { planSha256: H1.toUpperCase() },
      { zarrPlanSha256: undefined },
      { counts: { stores: 3, rewritten: 1, untouched: 1 } },
      { counts: { stores: -1, rewritten: -1, untouched: 0 } },
      { counts: { stores: 1.5, rewritten: 1.5, untouched: 0 } },
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
    expect(parseAssembled(doc({}, { retainUntil: "2126-10-04T00:00:00.000Z" }))).toBeTruthy();
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
});
