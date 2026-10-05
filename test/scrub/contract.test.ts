/** The scrub stage contract: keys, and the guards that refuse a file that does not match. */

import { describe, expect, test } from "bun:test";
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
  parseZarrVerified,
} from "../../scripts/scrub/contract";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const OLD = `SHA256E-s1000--${H1}.bdf`;
const NEW = `SHA256E-s1000--${H2}.bdf`;

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
      entries: { [OLD]: { newKey: NEW, size: 1000, sourceSha256Verified: true } },
    });
    expect(parseHashes(ok).entries[OLD]?.newKey).toBe(NEW);
    const sameKey = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: { [OLD]: { newKey: OLD, size: 1000, sourceSha256Verified: true } },
    });
    expect(() => parseHashes(sameKey)).toThrow("must not equal");
    const otherSize = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: { newKey: `SHA256E-s999--${H2}.bdf`, size: 999, sourceSha256Verified: true },
      },
    });
    expect(() => parseHashes(otherSize)).toThrow("size and extension");
    const otherExt = JSON.stringify({
      version: 1,
      dataset: "nm1",
      entries: {
        [OLD]: { newKey: `SHA256E-s1000--${H2}.edf`, size: 1000, sourceSha256Verified: true },
      },
    });
    expect(() => parseHashes(otherExt)).toThrow("size and extension");
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
    const plan = { version: 1, dataset: "d", keys: [{ oldKey: OLD }] };
    expect(parsePlan(JSON.stringify(plan)).keys.length).toBe(1);
  });

  test("zarr-verified.json: bound to two files by sha256, counts that add up", () => {
    const ok = {
      version: 1,
      dataset: "nm1",
      verifiedAt: "2026-10-04T00:00:00Z",
      planSha256: H1,
      zarrPlanSha256: H2,
      counts: { stores: 3, rewritten: 2, untouched: 1 },
    };
    expect(parseZarrVerified(JSON.stringify(ok)).counts.stores).toBe(3);
    const bad = (over: Record<string, unknown>) => JSON.stringify({ ...ok, ...over });
    for (const over of [
      { version: 2 },
      { dataset: 7 },
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
});
