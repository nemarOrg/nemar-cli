/**
 * What moves a Neurobagel dataset's fingerprint and signature (epic #1586, phase 4; ADR 0084).
 *
 * The fingerprint decides whether anything is rewritten, so an input it does not hash is a
 * change the store silently never picks up. Every input the artifacts depend on is proven
 * here to move it, by itself, with the others held still: the row's fields, the whole
 * enrichment document (and its length, which is all the cheap signature can afford to read),
 * the curation entry, the manifest's ETag, the transform's version, the pinned vocabulary and
 * the writer's own revision. Then the behaviour that follows: a store written under another
 * revision, or from another version of a row, is rewritten by the next run.
 *
 * Where an input is deliberately NOT in a layer, a test says so.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  FINGERPRINT_INPUTS,
  NEUROBAGEL_WRITER_REVISION,
  type RowFingerprintFields,
  type TransformIdentity,
  cheapSignature,
  inputFingerprint,
  inputFingerprintDocument,
  rowFingerprint,
  rowFingerprintDocument,
  sha256Hex,
  signatureDocument,
  transformIdentity,
} from "../src/services/neurobagel-fingerprint";
import { META, listStore } from "../src/services/neurobagel-store";
import { runNeurobagelWriter } from "../src/services/neurobagel-writer";
import {
  type Harness,
  recordWrites,
  seedSynthetic,
  startHarness,
} from "./helpers/neurobagel-harness";

const BASE: RowFingerprintFields = {
  dataset_id: "nm000900",
  name: "A dataset",
  subject_count: 12,
  license: "CC0-1.0",
  concept_doi: "10.82901/nemar.nm000900",
  latest_version: "1.0.0",
};
const ENRICHMENT_SHA = "a".repeat(64);
const CURATION = "b".repeat(64);

/** Each input, changed alone. */
const ROW_CHANGES: [string, Partial<RowFingerprintFields>][] = [
  ["the dataset id", { dataset_id: "nm000901" }],
  ["the name", { name: "Another name" }],
  ["the subject count", { subject_count: 13 }],
  ["the subject count going unknown", { subject_count: null }],
  ["the license", { license: "CC-BY-4.0" }],
  ["the license going unknown", { license: null }],
  ["the concept DOI", { concept_doi: "10.82901/nemar.other" }],
  ["the concept DOI going unknown", { concept_doi: null }],
  ["the latest version", { latest_version: "1.1.0" }],
];

const IDENTITY_CHANGES: [string, Partial<TransformIdentity>][] = [
  ["the writer's revision", { writer: NEUROBAGEL_WRITER_REVISION + 1 }],
  ["the transform's version", { transform: transformIdentity().transform + 1 }],
  ["the pinned community vocabulary", { vocab_communities: "0".repeat(40) }],
  ["the pinned bagel vocabulary", { vocab_bagel: "0.0.0-other" }],
];

describe("the row fingerprint", () => {
  const base = () => rowFingerprint(BASE, ENRICHMENT_SHA, CURATION);

  test("is deterministic, and shaped sha256:<hex>", async () => {
    expect(await base()).toBe(await base());
    expect(await base()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  for (const [what, change] of ROW_CHANGES) {
    test(`moves with ${what}`, async () => {
      expect(await rowFingerprint({ ...BASE, ...change }, ENRICHMENT_SHA, CURATION)).not.toBe(
        await base(),
      );
    });
  }

  test("moves with the whole enrichment document (its hash), and with the curation entry", async () => {
    expect(await rowFingerprint(BASE, "c".repeat(64), CURATION)).not.toBe(await base());
    expect(await rowFingerprint(BASE, ENRICHMENT_SHA, "c".repeat(64))).not.toBe(await base());
    expect(await rowFingerprint(BASE, ENRICHMENT_SHA, null)).not.toBe(await base());
  });

  for (const [what, change] of IDENTITY_CHANGES) {
    test(`moves with ${what}`, async () => {
      expect(
        await rowFingerprint(BASE, ENRICHMENT_SHA, CURATION, { ...transformIdentity(), ...change }),
      ).not.toBe(await base());
    });
  }

  test("the default identity is the current one", async () => {
    expect(await rowFingerprint(BASE, ENRICHMENT_SHA, CURATION, transformIdentity())).toBe(
      await base(),
    );
    expect(transformIdentity().writer).toBe(NEUROBAGEL_WRITER_REVISION);
    expect(transformIdentity().vocab_communities).toMatch(/^[0-9a-f]{40}$/);
    expect(transformIdentity().vocab_bagel.length).toBeGreaterThan(0);
  });
});

describe("the input fingerprint", () => {
  test("is the row fingerprint and the manifest's ETag, and moves with either", async () => {
    const row = await rowFingerprint(BASE, ENRICHMENT_SHA, CURATION);
    const fp = await inputFingerprint(row, '"etag-1"');
    expect(fp).toBe(await inputFingerprint(row, '"etag-1"'));
    expect(await inputFingerprint(row, '"etag-2"')).not.toBe(fp);
    const other = await rowFingerprint({ ...BASE, name: "Another" }, ENRICHMENT_SHA, CURATION);
    expect(await inputFingerprint(other, '"etag-1"')).not.toBe(fp);
  });
});

describe("the cheap signature", () => {
  const base = () => cheapSignature(BASE, 500, CURATION);

  test("is deterministic, and shaped sha256:<hex>", async () => {
    expect(await base()).toBe(await base());
    expect(await base()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  for (const [what, change] of ROW_CHANGES) {
    test(`moves with ${what}`, async () => {
      expect(await cheapSignature({ ...BASE, ...change }, 500, CURATION)).not.toBe(await base());
    });
  }

  test("moves with the enrichment document's LENGTH, which is all it reads of it, and with the curation entry", async () => {
    expect(await cheapSignature(BASE, 501, CURATION)).not.toBe(await base());
    expect(await cheapSignature(BASE, 0, CURATION)).not.toBe(await base());
    expect(await cheapSignature(BASE, 500, "c".repeat(64))).not.toBe(await base());
    expect(await cheapSignature(BASE, 500, null)).not.toBe(await base());
  });

  for (const [what, change] of IDENTITY_CHANGES) {
    test(`moves with ${what}`, async () => {
      expect(
        await cheapSignature(BASE, 500, CURATION, { ...transformIdentity(), ...change }),
      ).not.toBe(await base());
    });
  }

  test("does NOT depend on the manifest's ETag or the enrichment's hash: those are the row fingerprint's and the input fingerprint's", async () => {
    // A same-length edit of the enrichment document is invisible to the signature by
    // design; the row fingerprint catches it when the dataset is examined.
    expect(cheapSignature.length).toBeLessThanOrEqual(4);
    const a = await rowFingerprint(BASE, "d".repeat(64), CURATION);
    const b = await rowFingerprint(BASE, "e".repeat(64), CURATION);
    expect(a).not.toBe(b);
  });
});

describe("the inputs are pinned next to the writer revision", () => {
  /** Every leaf path of a document, `a.b` for nested objects. */
  function paths(value: unknown, prefix = ""): string[] {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
    }
    return [prefix];
  }

  const identity = transformIdentity();

  test("what the code hashes is what the pin lists, so changing an input fails here until the pin and the revision move", () => {
    expect(paths(signatureDocument(BASE, 500, CURATION, identity))).toEqual([
      ...FINGERPRINT_INPUTS.signature,
    ]);
    expect(paths(rowFingerprintDocument(BASE, ENRICHMENT_SHA, CURATION, identity))).toEqual([
      ...FINGERPRINT_INPUTS.rowFingerprint,
    ]);
    expect(paths(inputFingerprintDocument("sha256:x", '"etag"'))).toEqual([
      ...FINGERPRINT_INPUTS.inputFingerprint,
    ]);
  });

  test("the pin is for THIS revision: a pin updated without a bump (or a bump without the pin) fails", () => {
    expect(FINGERPRINT_INPUTS.revision).toBe(NEUROBAGEL_WRITER_REVISION);
  });

  test("the signature and the row fingerprint share every input but the enrichment's form (its length, its hash)", () => {
    const shared = (list: readonly string[]) => list.filter((p) => !p.startsWith("enrichment_"));
    expect(shared(FINGERPRINT_INPUTS.signature)).toEqual(shared(FINGERPRINT_INPUTS.rowFingerprint));
    // So a change to one of the shared inputs moves both layers together, which is the point.
    expect(FINGERPRINT_INPUTS.signature).toContain("enrichment_length");
    expect(FINGERPRINT_INPUTS.rowFingerprint).toContain("enrichment_sha256");
  });
});

describe("what a run does when a fingerprint input changes", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.dispose();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const run = (over: Partial<Parameters<typeof runNeurobagelWriter>[1]> = {}) =>
    runNeurobagelWriter(h.env(), { trigger: "admin", execute: true, ...over });
  const outcomes = (r: Awaited<ReturnType<typeof run>>) =>
    r.results.map((x) => `${x.id}:${x.outcome}`);

  const COLUMN_CHANGES: [string, string][] = [
    ["the license", "license = 'CC-BY-4.0'"],
    ["the subject count", "subject_count = 99"],
    ["the concept DOI", "concept_doi = '10.82901/nemar.moved'"],
    ["the name", "name = 'Renamed'"],
  ];

  for (const [what, assignment] of COLUMN_CHANGES) {
    test(`${what} changed in the row: examined first, and rewritten`, async () => {
      for (const id of ["nm000910", "nm000911", "nm000912"]) seedSynthetic(h, id);
      await run();
      h.db.run(`UPDATE datasets SET ${assignment} WHERE dataset_id = 'nm000912'`);
      // One slot, on a day whose rotation would start at the first id: only a STALE
      // signature puts the last dataset ahead of it.
      const dry = await run({ execute: false, limit: 1, now: new Date(Date.UTC(2026, 9, 3)) });
      expect(outcomes(dry)).toEqual(["nm000912:would_write"]);
      const result = await run({ limit: 1, now: new Date(Date.UTC(2026, 9, 3)) });
      expect(outcomes(result)).toEqual(["nm000912:written"]);
      // And once rewritten it is settled: nothing is stale, nothing is written.
      const rec = recordWrites(h.bucket);
      const again = await runNeurobagelWriter(h.env({ NEUROBAGEL: rec.bucket }), {
        trigger: "admin",
        execute: true,
        limit: 50,
      });
      expect(again.results.every((r) => r.outcome === "unchanged")).toBe(true);
      expect(rec.log).toEqual([]);
    });
  }

  test("the enrichment document edited to a DIFFERENT text of the SAME length: invisible to the signature, caught by the fingerprint when examined", async () => {
    seedSynthetic(h, "nm000913");
    await run();
    const before = String(
      h.db.query("SELECT enrichment_json AS e FROM datasets WHERE dataset_id = 'nm000913'").get()
        ?.e,
    );
    const after = before.replace("Ada Lovelace", "Ada Lovelacf");
    expect(after.length).toBe(before.length);
    expect(after).not.toBe(before);
    h.db.query("UPDATE datasets SET enrichment_json = ? WHERE dataset_id = 'nm000913'").run(after);
    // The signature still matches (no stale class), yet the dataset's fingerprint does not.
    const status = await run({ execute: false, only: ["nm000913"] });
    expect(outcomes(status)).toEqual(["nm000913:would_write"]);
    const result = await run({ only: ["nm000913"] });
    expect(outcomes(result)).toEqual(["nm000913:written"]);
  });

  test("the enrichment document changing LENGTH is stale at once: examined ahead of the rotation", async () => {
    for (const id of ["nm000914", "nm000915", "nm000916"]) seedSynthetic(h, id);
    await run();
    h.db.run(
      "UPDATE datasets SET enrichment_json = enrichment_json || ' ' WHERE dataset_id = 'nm000916'",
    );
    const dry = await run({ execute: false, limit: 1, now: new Date(Date.UTC(2026, 9, 3)) });
    expect(dry.results[0]?.id).toBe("nm000916");
  });

  test("a store written under the previous WRITER REVISION is rewritten by this one", async () => {
    seedSynthetic(h, "nm000917");
    await run();
    // Make the store look as if revision N-1 had written it: the same inputs, the previous
    // revision in the hash, which is what a deploy that bumps NEUROBAGEL_WRITER_REVISION meets.
    const listing = await listStore(h.bucket);
    const stored = listing.datasets.get("nm000917")?.jsonld;
    expect(stored).toBeTruthy();
    const meta = { ...(stored?.meta ?? {}) };
    const previous = { ...transformIdentity(), writer: NEUROBAGEL_WRITER_REVISION - 1 };
    const row = h.db
      .query(
        `SELECT name, subject_count, license, concept_doi, enrichment_json FROM datasets WHERE dataset_id = 'nm000917'`,
      )
      .get() as Record<string, string | number | null>;
    const fields: RowFingerprintFields = {
      dataset_id: "nm000917",
      name: row.name as string,
      subject_count: row.subject_count as number,
      license: row.license as string,
      concept_doi: row.concept_doi as string,
      latest_version: "1.0.0",
    };
    const oldRowFp = await rowFingerprint(
      { ...fields, latest_version: "v1.0.0" },
      await sha256Hex(String(row.enrichment_json ?? "")),
      null,
      previous,
    );
    meta[META.rowFingerprint] = oldRowFp;
    meta[META.fingerprint] = await inputFingerprint(oldRowFp, meta[META.manifestEtag] as string);
    meta[META.signature] = await cheapSignature(
      fields,
      String(row.enrichment_json ?? "").length,
      null,
      previous,
    );
    const object = await h.bucket.get("nm000917.jsonld");
    await h.bucket.put("nm000917.jsonld", await (object as R2ObjectBody).arrayBuffer(), {
      customMetadata: meta,
    });

    // Every dataset is stale under the new revision: it is examined first and rewritten.
    const result = await run({ limit: 1 });
    expect(outcomes(result)).toEqual(["nm000917:written"]);
    const after = (await listStore(h.bucket)).datasets.get("nm000917")?.jsonld?.meta;
    expect(after?.[META.fingerprint]).not.toBe(meta[META.fingerprint]);
    expect(after?.[META.signature]).not.toBe(meta[META.signature]);
  });
});
