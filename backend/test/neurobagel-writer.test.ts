/**
 * The Neurobagel writer, end to end (epic #1586, phase 4; ADR 0084).
 *
 * REAL ENGINES, no stand-ins for logic: a D1 carrying every production migration, the
 * R2 simulator `wrangler dev` runs, the real `dataRoutes` data plane, the real pure
 * transform. Only S3 and GitHub raw are a local HTTP server (`helpers/neurobagel-harness`).
 *
 * The anchor is nm000132: its REAL published manifest and the participants files
 * captured from data.nemar.org in phase 1. The writer reads them through the data
 * plane and must produce, byte for byte, the phase 1 goldens.
 *
 * Writes are counted by a transparent wrapper around the real bucket (`recordWrites`):
 * every call still reaches R2, the wrapper only records it, which is how "a second run
 * writes nothing" and the ordering of writes against deletes are proven.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Ajv from "ajv";
import schema from "../../deploy/neurobagel/index.schema.json";
import { type CurationResolver, createCurationResolver } from "../src/services/neurobagel-curation";
import { syncNeurobagelDataset } from "../src/services/neurobagel-hooks";
import { neurobagelStatus } from "../src/services/neurobagel-status";
import {
  ARTIFACT_KINDS,
  ARTIFACT_SUFFIX,
  type IndexDocument,
  META,
  NEUROBAGEL_INDEX_KEY,
  NEUROBAGEL_INDEX_SCHEMA,
  indexProblems,
  listStore,
  parseStoredIndex,
} from "../src/services/neurobagel-store";
import {
  type RunResult,
  neurobagelWriterMode,
  reconcileLimit,
  runNeurobagelWriter,
} from "../src/services/neurobagel-writer";
import type { Bindings } from "../src/types/bindings";
import { realD1, wrapD1 } from "./helpers/d1";
import {
  type Harness,
  gitBlobSha,
  golden,
  recordOps,
  recordWrites,
  seedDatasetRow,
  seedFromFixture,
  seedSynthetic,
  startHarness,
  storeKeys,
} from "./helpers/neurobagel-harness";

let h: Harness;
const quiet = { error: console.error, warn: console.warn, log: console.log };

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

async function text(key: string): Promise<string> {
  const object = await h.bucket.get(key);
  if (!object) throw new Error(`no object ${key}`);
  return object.text();
}

async function storedIndex(): Promise<IndexDocument> {
  const parsed = parseStoredIndex(await text(NEUROBAGEL_INDEX_KEY));
  if (!parsed) throw new Error("stored index is not an index");
  return parsed;
}

function run(over: Partial<Parameters<typeof runNeurobagelWriter>[1]> = {}, env?: Bindings) {
  return runNeurobagelWriter(env ?? h.env(), { trigger: "admin", execute: true, ...over });
}

const outcomes = (r: RunResult) => r.results.map((x) => `${x.id}:${x.outcome}`);

/**
 * A dataset whose table has a `group` column and a REAL curation entry for it, written
 * in the file's format and loaded by the real `lookupCuration` (the vocabulary is the
 * pinned one: `snomed:230690007` is "Cerebrovascular accident"). The pins are the git
 * blob hashes of the very bytes served, so the entry is current, unless `stalePin`.
 */
function curatedDataset(
  id: string,
  groupValue: string,
  options: { stalePin?: boolean } = {},
): { tsv: string; pjson: string; resolver: CurationResolver } {
  const tsv = `participant_id\tage\tgroup\nsub-01\t30\t${groupValue}\nsub-02\t31\t${groupValue}\nsub-03\t32\tpatient\n`;
  const pjson = JSON.stringify({ age: { Units: "years" } });
  const bytes = (t: string) => new TextEncoder().encode(t);
  const file = {
    format: 1,
    datasets: {
      [id]: {
        columns: {
          group: {
            IsAbout: { TermURL: "nb:Diagnosis", Label: "Diagnosis" },
            Levels: { patient: { TermURL: "snomed:230690007", Label: "Cerebrovascular accident" } },
            MissingValues: groupValue === "patient" ? [] : [groupValue],
            VariableType: "Categorical",
          },
        },
        evidence: { source: "a test", reviewer: "a test", review: "author", date: "2026-10-02" },
        pins: {
          participants_tsv: options.stalePin ? "0".repeat(40) : gitBlobSha(bytes(tsv)),
          participants_json: gitBlobSha(bytes(pjson)),
        },
      },
    },
  };
  const resolver = createCurationResolver({
    load: async () => ({
      file,
      lookupCuration: (await import("../../shared/neurobagel/curation")).lookupCuration,
    }),
    clock: () => new Date("2026-10-02T12:00:00Z"),
  });
  return { tsv, pjson, resolver };
}

// ----------------------------------------------------------------------------
// The anchor: real data through the real data plane
// ----------------------------------------------------------------------------

describe("nm000132, real manifest and real participants files", () => {
  test("the writer reproduces the phase 1 goldens byte for byte", async () => {
    seedFromFixture(h);
    const result = await run();

    expect(result.status).toBe("ok");
    expect(outcomes(result)).toEqual(["nm000132:written"]);
    expect(await storeKeys(h.bucket)).toEqual([
      "index.json",
      "nm000132.jsonld",
      "nm000132_annotated.json",
      "nm000132_dataset_description.json",
    ]);
    for (const name of [
      "nm000132.jsonld",
      "nm000132_annotated.json",
      "nm000132_dataset_description.json",
    ]) {
      expect(await text(name)).toBe(golden("nm000132", name));
    }
  });

  test("every artifact carries its sha256, verified by R2, and the JSON-LD carries the fingerprint", async () => {
    seedFromFixture(h);
    await run();
    const listing = await listStore(h.bucket);
    const stored = listing.datasets.get("nm000132");
    expect(stored?.jsonld && stored.dictionary && stored.description).toBeTruthy();
    for (const kind of ARTIFACT_KINDS) {
      const artifact = stored?.[kind];
      const head = await h.bucket.head(artifact?.key as string);
      // R2 was handed the hash and checked it against the bytes it stored.
      expect(head?.checksums.toJSON().sha256).toBe(artifact?.sha256);
      expect(head?.httpMetadata?.contentType).toBe(
        kind === "jsonld" ? "application/ld+json" : "application/json",
      );
    }
    const meta = stored?.jsonld?.meta ?? {};
    expect(meta[META.fingerprint]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.rowFingerprint]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.signature]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta[META.manifestEtag]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(meta[META.version]).toBe("v1.1.1");
    // The companions carry only the two facts the index needs.
    expect(Object.keys(stored?.dictionary?.meta ?? {}).sort()).toEqual(["kind", "sha256"]);
  });

  test("the transform ran with expectedDatasetId, so another dataset's metadata is refused", async () => {
    // Direct evidence the id is passed: a dataset whose data plane serves another
    // dataset's metadata is the case the transform's check exists for, and the writer
    // would have no way to notice. Here the gather itself checks it first.
    seedFromFixture(h);
    const result = await run({ only: ["nm000132"] });
    expect(outcomes(result)).toEqual(["nm000132:written"]);
  });
});

// ----------------------------------------------------------------------------
// The index, against the schema the node's tooling uses
// ----------------------------------------------------------------------------

const ajv = new Ajv({ strict: false, allErrors: true });
const validateIndex = ajv.compile(schema);

/** The schema's x-rules, which a JSON Schema cannot state, read FROM the schema file. */
function xRuleProblems(index: IndexDocument): string[] {
  const rules = (schema as unknown as { "x-rules": Record<string, unknown> })["x-rules"];
  const suffix = rules.artifactSuffix as Record<string, string>;
  const problems: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of index.datasets) {
    if (ids.has(d.id)) problems.push(`duplicate id ${d.id}`);
    ids.add(d.id);
    const jsonlds = d.artifacts.filter((a) => a.kind === "jsonld");
    if (rules.oneJsonldPerDataset && jsonlds.length !== 1) problems.push(`${d.id}: jsonld count`);
    for (const a of d.artifacts) {
      if (rules.nameIsIdPlusSuffix && a.name !== `${d.id}${suffix[a.kind]}`) {
        problems.push(`${a.name}: not id + suffix`);
      }
      if (names.has(a.name)) problems.push(`duplicate name ${a.name}`);
      names.add(a.name);
    }
  }
  return problems;
}

describe("index.json conforms to deploy/neurobagel/index.schema.json", () => {
  test("the writer's index validates, with the schema's own x-rules", async () => {
    seedFromFixture(h);
    seedSynthetic(h, "nm000600");
    seedSynthetic(h, "on000600");
    await run();
    const index = await storedIndex();
    expect(validateIndex(index), JSON.stringify(validateIndex.errors)).toBe(true);
    expect(xRuleProblems(index)).toEqual([]);
    expect(index.schema).toBe(NEUROBAGEL_INDEX_SCHEMA);
    expect(index.datasets.map((d) => d.id)).toEqual(["nm000132", "nm000600", "on000600"]);
    expect(indexProblems(index)).toEqual([]);
  });

  test("the producer-side constants cannot drift from the schema file", () => {
    const props = schema.properties as unknown as { schema: { const: string } };
    expect(NEUROBAGEL_INDEX_SCHEMA).toBe(props.schema.const);
    const rules = (schema as unknown as { "x-rules": { artifactSuffix: Record<string, string> } })[
      "x-rules"
    ];
    expect(ARTIFACT_SUFFIX).toEqual(rules.artifactSuffix);
    const kinds = (
      schema.definitions as unknown as { artifact: { properties: { kind: { enum: string[] } } } }
    ).artifact.properties.kind.enum;
    expect([...ARTIFACT_KINDS]).toEqual(kinds);
  });

  test("the artifact entry is the three-file shape the loader reads, with sizes and hashes of the real bytes", async () => {
    seedFromFixture(h);
    await run();
    const entry = (await storedIndex()).datasets[0];
    expect(entry?.artifacts.map((a) => [a.name, a.kind])).toEqual([
      ["nm000132.jsonld", "jsonld"],
      ["nm000132_annotated.json", "dictionary"],
      ["nm000132_dataset_description.json", "description"],
    ]);
    // The README's worked example is these very files.
    expect(entry?.artifacts.map((a) => a.bytes)).toEqual([41928, 1305, 811]);
    expect(entry?.artifacts.map((a) => a.sha256)).toEqual([
      "9008cd4477758e7da24339fe4dd43ee380025a600527d7b5540e5369d59824e2",
      "447f64adedea5463732607800fe4dfd0ad94296ea36ee04af0e0ace0166a886a",
      "465ce163d97fb10dbd61dfd8d12592fed07a931346f42c000cd88d62729dba9f",
    ]);
    // The reference fingerprint of the schema: sha256 of the artifact hashes, joined.
    expect(entry?.fingerprint).toBe(
      "sha256:acd7b00c07840016c67ae625fc3de2a01e1f247694db1e2b28dabe24af7b9f95",
    );
    expect(entry?.input_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a document the loader would refuse is never written", () => {
    const good: IndexDocument = {
      schema: NEUROBAGEL_INDEX_SCHEMA,
      generated_at: "2026-10-02T00:00:00Z",
      datasets: [],
    };
    expect(indexProblems(good)).toEqual([]);
    expect(indexProblems({ ...good, generated_at: "yesterday" })).not.toEqual([]);
    const entry = {
      id: "nm000001",
      fingerprint: `sha256:${"a".repeat(64)}`,
      input_fingerprint: `sha256:${"b".repeat(64)}`,
      artifacts: [
        { name: "nm000001.jsonld", kind: "jsonld" as const, sha256: "c".repeat(64), bytes: 10 },
      ],
    };
    expect(indexProblems({ ...good, datasets: [entry] })).toEqual([]);
    // No JSON-LD, a name that is not id + suffix, a duplicate id: each is a refusal.
    expect(indexProblems({ ...good, datasets: [{ ...entry, artifacts: [] }] })).not.toEqual([]);
    expect(
      indexProblems({
        ...good,
        datasets: [
          { ...entry, artifacts: [{ ...entry.artifacts[0], name: "nm000002.jsonld" }] },
        ] as never,
      }),
    ).not.toEqual([]);
    expect(indexProblems({ ...good, datasets: [entry, entry] })).not.toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Idempotency: nothing changed, nothing written
// ----------------------------------------------------------------------------

describe("a second run with nothing changed writes nothing", () => {
  test("zero puts and zero deletes, to artifacts and index alike", async () => {
    seedFromFixture(h);
    seedSynthetic(h, "nm000601");
    const first = recordWrites(h.bucket);
    const r1 = await run({}, h.env({ NEUROBAGEL: first.bucket }));
    expect(outcomes(r1).sort()).toEqual(["nm000132:written", "nm000601:written"]);
    // Three artifacts a dataset, plus the index, once.
    expect(first.log.filter((e) => e.op === "put")).toHaveLength(7);

    const second = recordWrites(h.bucket);
    const r2 = await run({}, h.env({ NEUROBAGEL: second.bucket }));
    expect(outcomes(r2).sort()).toEqual(["nm000132:unchanged", "nm000601:unchanged"]);
    expect(second.log).toEqual([]);
    expect(r2.index).toMatchObject({ changed: false, written: false, entries: 2 });
  });

  test("and the index keeps its timestamp, so it is byte-identical", async () => {
    seedFromFixture(h);
    await run({ now: new Date("2026-10-02T10:00:00Z") });
    const before = await text(NEUROBAGEL_INDEX_KEY);
    await run({ now: new Date("2026-10-03T10:00:00Z") });
    expect(await text(NEUROBAGEL_INDEX_KEY)).toBe(before);
    expect(parseStoredIndex(before)?.generated_at).toBe("2026-10-02T10:00:00.000Z");
  });

  test("a change to one input rewrites exactly that dataset and the index", async () => {
    seedSynthetic(h, "nm000602");
    seedSynthetic(h, "nm000603");
    await run();
    h.db.query("UPDATE datasets SET name = 'Renamed' WHERE dataset_id = 'nm000602'").run();

    const rec = recordWrites(h.bucket);
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(result).sort()).toEqual(["nm000602:written", "nm000603:unchanged"]);
    const puts = rec.log.map((e) => e.key).sort();
    expect(puts).toEqual(
      [
        "index.json",
        "nm000602.jsonld",
        "nm000602_annotated.json",
        "nm000602_dataset_description.json",
      ]
        .sort()
        .filter((k) => puts.includes(k)),
    );
    // Only the JSON-LD is certain to change with a name; every key written is this dataset's or the index.
    expect(puts.every((k) => k === "index.json" || k.startsWith("nm000602"))).toBe(true);
    expect(puts).toContain("nm000602.jsonld");
    expect(puts).toContain("index.json");
  });

  test("a row edited between the plan and the processing is stamped with what it was built from, so it is not stale for ever", async () => {
    seedSynthetic(h, "nm000607");
    // The edit lands on the first statement the writer issues AFTER it planned: the
    // re-check of the one row. The plan saw the old name; the fingerprint and the artifacts
    // are built from the new one, and the signature must be too.
    let edited = false;
    const d1 = wrapD1(realD1(h.db), (sql) => {
      if (!edited && sql.includes("WHERE d.dataset_id = ?") && !sql.includes("enrichment_length")) {
        edited = true;
        h.db
          .query("UPDATE datasets SET name = 'Edited mid-run' WHERE dataset_id = 'nm000607'")
          .run();
      }
    });
    const first = await run({}, h.env({ DB: d1 }));
    expect(edited).toBe(true);
    expect(outcomes(first)).toEqual(["nm000607:written"]);
    expect(await text("nm000607.jsonld")).toContain("Edited mid-run");

    const status = await neurobagelStatus(h.env());
    expect(status.counts.stale).toBe(0);
    expect(status.counts.written).toBe(1);
    // And the next run finds nothing to do at all, rather than examining it as stale each time.
    const rec = recordWrites(h.bucket);
    const second = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(second)).toEqual(["nm000607:unchanged"]);
    expect(rec.log).toEqual([]);
  });

  test("two readers that disagree on the latest version (a timestamp tie) refuse the dataset, not stamp one version's ETag on another's content", async () => {
    // Two versions created in the same second. The writer breaks the tie by id (the newer
    // row); the data plane's own query does not, and answers the first. Both manifests exist.
    const tie = "2026-01-02 03:04:05";
    seedSynthetic(h, "nm000608", {
      version: "1.0.0",
      versions: [
        ["1.0.0", tie],
        ["1.1.0", tie],
      ],
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(h.standin.objects.get("/nm000608/version/v1.0.0.json")?.body),
    );
    h.standin.put(
      "/nm000608/version/v1.1.0.json",
      JSON.stringify({ ...manifest, version: "1.1.0", doi: "10.82901/nemar.nm000608.v1.1.0" }),
    );
    const rec = recordWrites(h.bucket);
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(result.results).toEqual([
      {
        id: "nm000608",
        outcome: "refused",
        code: "latest_version_disagreement",
        detail: expect.stringContaining("1.1.0"),
      },
    ]);
    expect(rec.log).toEqual([]);
    // A standing disagreement is a finding a person can read, until it is resolved.
    const status = await neurobagelStatus(h.env());
    expect(status.needs_review).toEqual([
      { id: "nm000608", source: "refusal", code: "latest_version_disagreement" },
    ]);
  });

  test("a rewritten manifest (a new ETag, same name) is a change the row cannot see", async () => {
    seedSynthetic(h, "nm000604");
    await run();
    // Same dataset row, same version; the manifest is rewritten in place, as the pipeline does.
    const key = "/nm000604/version/v1.0.0.json";
    const manifest = JSON.parse(new TextDecoder().decode(h.standin.objects.get(key)?.body));
    manifest.files["sub-04/eeg/sub-04_task-rest_eeg.edf"] = {
      key: "MD5E-s5--abc.edf",
      size: 5,
      checksum: "md5:abc",
    };
    h.standin.put(key, JSON.stringify(manifest));

    const result = await run({ only: ["nm000604"] });
    expect(outcomes(result)).toEqual(["nm000604:written"]);
    // The new subject is in the graph, which only the manifest could have told it.
    expect(await text("nm000604.jsonld")).toContain("sub-04");
  });

  test("force rewrites although the fingerprint matches", async () => {
    seedSynthetic(h, "nm000605");
    await run();
    const rec = recordWrites(h.bucket);
    const result = await run({ force: true }, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(result)).toEqual(["nm000605:written"]);
    // Identical bytes are not rewritten (companions skipped); the JSON-LD records what it was built from.
    expect(rec.log.map((e) => e.key)).toEqual(["nm000605.jsonld"]);
  });

  test("the transform version moves the signature, so a version bump marks every dataset stale", async () => {
    seedSynthetic(h, "nm000606");
    await run();
    const listing = await listStore(h.bucket);
    const stamped = listing.datasets.get("nm000606")?.jsonld?.meta[META.signature];
    expect(stamped).toBeTruthy();
    // Corrupt the stored signature as a bumped transform version would leave it stale.
    const object = await h.bucket.get("nm000606.jsonld");
    const body = await (object as R2ObjectBody).arrayBuffer();
    await h.bucket.put("nm000606.jsonld", body, {
      customMetadata: { ...(object?.customMetadata ?? {}), [META.signature]: "sha256:stale" },
    });
    const dry = await run({ execute: false });
    expect(dry.results.find((r) => r.id === "nm000606")?.outcome).toBe("unchanged");
    // Stale rows are examined first; here the row fingerprint still matches, so nothing is written.
    const rec = recordWrites(h.bucket);
    const after = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(outcomes(after)).toEqual(["nm000606:unchanged"]);
    expect(rec.log).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Removal
// ----------------------------------------------------------------------------

describe("a dataset that stops being eligible leaves the store", () => {
  const CAUSES: [string, string][] = [
    ["goes private", "UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000610'"],
    [
      "is withdrawn",
      "UPDATE datasets SET visibility = 'private', withdrawn_at = datetime('now') WHERE dataset_id = 'nm000610'",
    ],
    ["is archived", "UPDATE datasets SET status = 'archived' WHERE dataset_id = 'nm000610'"],
    ["is marked deleted", "UPDATE datasets SET status = 'deleted' WHERE dataset_id = 'nm000610'"],
    ["is deleted outright", "DELETE FROM datasets WHERE dataset_id = 'nm000610'"],
    [
      "becomes anonymous",
      "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000610'",
    ],
    [
      "loses its first publication",
      "UPDATE datasets SET first_published_at = NULL WHERE dataset_id = 'nm000610'",
    ],
    ["loses its versions", "DELETE FROM dataset_versions WHERE dataset_id = 'nm000610'"],
    ["becomes a sandbox row", "UPDATE datasets SET is_sandbox = 1 WHERE dataset_id = 'nm000610'"],
  ];

  for (const [cause, sql] of CAUSES) {
    test(`it ${cause}: artifacts deleted and the index drops it, in one run`, async () => {
      seedSynthetic(h, "nm000610");
      seedSynthetic(h, "nm000611");
      await run();
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000610", "nm000611"]);

      h.db.run(sql);
      const result = await run();

      expect(result.removed).toEqual(["nm000610"]);
      expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000611"]);
      expect(await storeKeys(h.bucket)).toEqual([
        "index.json",
        "nm000611.jsonld",
        "nm000611_annotated.json",
        "nm000611_dataset_description.json",
      ]);
    });
  }

  test("removal does not depend on ingestion: the data plane can be down entirely", async () => {
    seedSynthetic(h, "nm000612");
    seedSynthetic(h, "nm000613");
    await run();
    h.db.query("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000612'").run();
    // S3 and GitHub answer nothing at all.
    h.standin.objects.clear();

    const result = await run();

    expect(result.removed).toEqual(["nm000612"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000613"]);
    expect(await storeKeys(h.bucket)).not.toContain("nm000612.jsonld");
    // The survivor could not be re-examined (its manifest is gone) and was left exactly as it was.
    expect(await storeKeys(h.bucket)).toContain("nm000613.jsonld");
  });

  test("a dataset gone from D1 is removed from a store that holds it", async () => {
    seedSynthetic(h, "nm000614");
    await run();
    h.db.run("DELETE FROM dataset_versions WHERE dataset_id = 'nm000614'");
    h.db.run("DELETE FROM datasets WHERE dataset_id = 'nm000614'");
    const result = await run();
    expect(result.removed).toEqual(["nm000614"]);
    expect((await storedIndex()).datasets).toEqual([]);
  });

  test("a restored dataset comes back on the next run", async () => {
    seedSynthetic(h, "nm000615");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000615'");
    await run();
    expect(await storeKeys(h.bucket)).toEqual(["index.json"]);
    h.db.run("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'nm000615'");
    const back = await run();
    expect(outcomes(back)).toEqual(["nm000615:written"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000615"]);
  });

  test("only the requested ids are removed when a list is given, though the index drops every ineligible one", async () => {
    seedSynthetic(h, "nm000616");
    seedSynthetic(h, "nm000617");
    await run();
    h.db.run(
      "UPDATE datasets SET visibility = 'private' WHERE dataset_id IN ('nm000616','nm000617')",
    );
    const result = await run({ only: ["nm000616"] });
    expect(result.removed).toEqual(["nm000616"]);
    // 617 is out of the index (removal is by omission, always) but its objects wait for their run.
    expect((await storedIndex()).datasets).toEqual([]);
    expect(await storeKeys(h.bucket)).toContain("nm000617.jsonld");
  });
});

// ----------------------------------------------------------------------------
// Ordering, for a consumer that may read at any moment
// ----------------------------------------------------------------------------

describe("write order", () => {
  test("an addition writes every artifact before the index", async () => {
    seedSynthetic(h, "nm000620");
    seedSynthetic(h, "nm000621");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    const keys = rec.log.map((e) => e.key);
    const indexAt = keys.indexOf("index.json");
    expect(indexAt).toBe(keys.length - 1);
    expect(rec.log.every((e) => e.op === "put")).toBe(true);
  });

  test("within a dataset the JSON-LD, the commit marker, is written last", async () => {
    seedSynthetic(h, "nm000622");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log.map((e) => e.key)).toEqual([
      "nm000622_annotated.json",
      "nm000622_dataset_description.json",
      "nm000622.jsonld",
      "index.json",
    ]);
  });

  test("a removal writes the index before it deletes the artifacts", async () => {
    seedSynthetic(h, "nm000623");
    seedSynthetic(h, "nm000624");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000623'");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(rec.log.map((e) => `${e.op}:${e.key}`)).toEqual([
      "put:index.json",
      "delete:nm000623.jsonld",
      "delete:nm000623_annotated.json",
      "delete:nm000623_dataset_description.json",
    ]);
  });

  test("a run that both adds and removes writes artifacts, then the index, then deletes", async () => {
    seedSynthetic(h, "nm000625");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000625'");
    seedSynthetic(h, "nm000626");
    const rec = recordWrites(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    const ops = rec.log.map((e) => `${e.op}:${e.key}`);
    const indexAt = ops.indexOf("put:index.json");
    const lastPut = ops
      .map((o, i) => (o.startsWith("put:nm") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    const firstDelete = ops.findIndex((o) => o.startsWith("delete:"));
    expect(lastPut).toBeLessThan(indexAt);
    expect(indexAt).toBeLessThan(firstDelete);
  });

  test("a stale index that cannot be replaced keeps the artifacts of what is leaving", async () => {
    seedSynthetic(h, "nm000627");
    seedSynthetic(h, "nm000628");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000627'");
    // Every attempt to replace the index loses: another writer changes it first.
    let bumps = 0;
    const real = h.bucket;
    const contended = new Proxy(real, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY) {
              bumps++;
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ schema: NEUROBAGEL_INDEX_SCHEMA, generated_at: "2026-01-01T00:00:00Z", datasets: [], bump: bumps })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    console.warn = () => {};
    const result = await run({}, h.env({ NEUROBAGEL: contended }));
    console.warn = quiet.warn;
    expect(result.index.contended).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.removals_pending).toBe(1);
    // Nothing was deleted, because the index could not be brought up to date first.
    expect(await storeKeys(h.bucket)).toContain("nm000627.jsonld");
  });

  test("a writer that loses the index race rebuilds from a fresh listing and wins", async () => {
    seedSynthetic(h, "nm000629");
    let injected = false;
    const real = h.bucket;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === NEUROBAGEL_INDEX_KEY && !injected) {
              injected = true;
              // Another run replaced the index after this one read it.
              await (target.put as (...a: unknown[]) => unknown)(
                key,
                `${JSON.stringify({ schema: NEUROBAGEL_INDEX_SCHEMA, generated_at: "2026-01-01T00:00:00Z", datasets: [] })}\n`,
              );
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    // Start with an index present, so the write is conditional.
    await run();
    seedSynthetic(h, "nm000630");
    const result = await run({}, h.env({ NEUROBAGEL: racing }));
    expect(result.index.written).toBe(true);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000629", "nm000630"]);
  });

  test("the previous index is read BEFORE the listing it is rebuilt from", async () => {
    seedSynthetic(h, "nm000633");
    await run();
    const rec = recordOps(h.bucket);
    await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    // The first listing is the run's own, at the start. The sync that follows reads the
    // index and only then lists: a write conditional on the index it read cannot be
    // clobbered by a listing taken before another run's writes.
    const firstList = rec.log.indexOf("list");
    const indexRead = rec.log.indexOf("get:index.json");
    const secondList = rec.log.indexOf("list", firstList + 1);
    expect(indexRead).toBeGreaterThan(firstList);
    expect(secondList).toBeGreaterThan(indexRead);
  });

  test("a dataset another run publishes while this one works is kept: eligibility is decided after the listing", async () => {
    seedSynthetic(h, "nm000634");
    await run();
    // Another writer (a hook) publishes nm000635 at the moment this run lists the bucket for
    // its index. The catalog this run read at its start has never heard of it.
    let published = false;
    const rec = recordOps(h.bucket, async (op, count) => {
      if (op === "list" && count === 2 && !published) {
        published = true;
        seedSynthetic(h, "nm000635");
        await syncNeurobagelDataset(h.env(), "nm000635", "hook:version");
      }
    });
    const result = await run({}, h.env({ NEUROBAGEL: rec.bucket }));
    expect(published).toBe(true);
    expect(result.removed).toEqual([]);
    expect(await storeKeys(h.bucket)).toContain("nm000635.jsonld");
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000634", "nm000635"]);
  });

  test("two hooks for two datasets at once leave an index naming both", async () => {
    seedSynthetic(h, "nm000631");
    seedSynthetic(h, "nm000632");
    const env = h.env();
    await Promise.all([
      syncNeurobagelDataset(env, "nm000631", "hook:version"),
      syncNeurobagelDataset(env, "nm000632", "hook:version"),
    ]);
    // Whatever the interleaving, a final reconcile settles the index to the listing.
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000631", "nm000632"]);
    expect(validateIndex(await storedIndex())).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// The anonymity double guard
// ----------------------------------------------------------------------------

describe("anonymity: two independent guards", () => {
  test("a dataset anonymous in D1 is never written, and no file of it is read", async () => {
    seedSynthetic(h, "nm000640", { anonymous: 1, firstPublishedAt: null });
    seedSynthetic(h, "nm000641");
    const result = await run();
    expect(outcomes(result)).toEqual(["nm000641:written"]);
    expect(await storeKeys(h.bucket)).not.toContain("nm000640.jsonld");
    // Not even its manifest or participants file was requested.
    expect(h.standin.log.filter((r) => r.path.includes("nm000640"))).toEqual([]);
    expect(result.eligible).toBe(1);
  });

  test("the standing anonymous deposit's id, in the reserved band, is never written", async () => {
    seedSynthetic(h, "nm099998", { anonymous: 1, firstPublishedAt: null, isSandbox: 1 });
    const result = await run();
    expect(result.eligible).toBe(0);
    expect(await storeKeys(h.bucket)).toEqual(
      ["index.json"].filter(() => (result.index.entries ?? 0) > 0),
    );
    expect(h.standin.log.filter((r) => r.path.includes("nm099998"))).toEqual([]);
  });

  test("the row says eligible, the data plane says anonymous: refused, audited, and nothing GitHub or mail", async () => {
    seedSynthetic(h, "nm000642");
    seedSynthetic(h, "nm000643");
    // The race the second guard exists for: the row is eligible when the plan is made and
    // is anonymous by the time the data plane builds its metadata. (The schema's triggers
    // forbid the state in one statement, so the stamp goes in the same UPDATE.)
    let flipped = false;
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
        flipped = true;
        h.db.run(
          "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000642'",
        );
      }
    });
    const result = await run({ only: ["nm000642", "nm000643"] }, h.env({ DB: d1 }));

    expect(result.results.find((r) => r.id === "nm000642")).toMatchObject({
      outcome: "refused",
      code: "anonymity_disagreement",
    });
    expect(result.anonymity_findings).toBe(1);
    expect(await storeKeys(h.bucket)).not.toContain("nm000642.jsonld");
    // No depositor file of it was requested after the guard.
    expect(
      h.standin.log.filter((r) => r.path.includes("nm000642") && r.path.includes("participants")),
    ).toEqual([]);
    // Audit log, and only the audit log.
    const rows = h.db
      .query<{ action: string; resource_id: string; details: string }, []>(
        "SELECT action, resource_id, details FROM audit_log WHERE action LIKE 'neurobagel_%anonymity%'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe("nm000642");
    expect(rows[0]?.details).not.toMatch(/Ada|Lovelace|Dataset nm/);
  });

  test("a disagreement removes what the store already held for that dataset (fail closed)", async () => {
    seedSynthetic(h, "nm000644");
    seedSynthetic(h, "nm000645");
    await run();
    let flipped = false;
    h.db.run("UPDATE datasets SET name = 'Touched' WHERE dataset_id = 'nm000644'");
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
        flipped = true;
        h.db.run(
          "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000644'",
        );
      }
    });
    const result = await run({ only: ["nm000644"] }, h.env({ DB: d1 }));
    expect(result.results.find((r) => r.id === "nm000644")?.outcome).toBe("refused");
    expect(result.removed).toEqual(["nm000644"]);
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000645"]);
  });

  test("a metadata document with a missing or null anonymous is refused too: unknown is not false", async () => {
    // The data plane always writes the field, so this is the guard's own contract, driven
    // through the real gather by serving a document without it from a real route.
    const { gatherNeurobagelInput } = await import("../src/services/neurobagel-gather");
    seedSynthetic(h, "nm000646");
    const env = h.env();
    const ok = await gatherNeurobagelInput(env, "nm000646");
    expect((ok.input.metadata as { anonymous: unknown }).anonymous).toBe(false);
    h.db.run(
      "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000646'",
    );
    await expect(gatherNeurobagelInput(env, "nm000646")).rejects.toMatchObject({
      code: "anonymity_disagreement",
    });
  });
});

// ----------------------------------------------------------------------------
// Curation: the lead's contract
// ----------------------------------------------------------------------------

describe("a dataset with a curation entry is never converted without it", () => {
  test("a failed lookup stops the dataset: nothing written, the existing artifact left, a finding recorded", async () => {
    seedSynthetic(h, "nm000650");
    await run();
    const before = await text("nm000650.jsonld");
    h.db.run(
      "UPDATE datasets SET name = 'Changed after curation broke' WHERE dataset_id = 'nm000650'",
    );

    const rec = recordWrites(h.bucket);
    const result = await run(
      {
        deps: { curation: async () => ({ kind: "failed", reason: "curation.json is not valid" }) },
      },
      h.env({ NEUROBAGEL: rec.bucket }),
    );

    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "curation_unavailable" });
    expect(rec.log).toEqual([]);
    expect(await text("nm000650.jsonld")).toBe(before);
    const ledger = h.db
      .query<{ action: string; details: string }, []>(
        "SELECT action, details FROM audit_log WHERE resource_id = 'nm000650' AND action = 'neurobagel_refused'",
      )
      .all();
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]?.details ?? "{}").code).toBe("curation_unavailable");
  });

  test("a lookup that THROWS is the same stop, never a conversion with no curation", async () => {
    seedSynthetic(h, "nm000651");
    const result = await run({
      deps: {
        curation: async () => {
          throw new Error("CurationError: an entry is stale");
        },
      },
    });
    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "curation_unavailable" });
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a real entry is applied through the real loader and the real transform", async () => {
    const { tsv, pjson, resolver } = curatedDataset("nm000652", "patient");
    seedSynthetic(h, "nm000652", { tsv, participantsJson: pjson });
    const result = await run({ deps: { curation: resolver } });
    expect(result.results[0]?.outcome).toBe("written");
    // The entry's diagnosis is in the graph, and the mechanical healthy control is too
    // (the entry maps `patient` and declares `Control` missing: it is the entry's call).
    const jsonld = await text("nm000652.jsonld");
    expect(jsonld).toContain("snomed:230690007");
    expect(result.needs_review).toEqual([]);
    const meta = (await listStore(h.bucket)).datasets.get("nm000652")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toBe("");
  });

  test("a stale entry federates the dataset WITHOUT a false healthy control, and says so", async () => {
    // The table says `Control` and the entry, reviewed against other bytes, withdraws the
    // mechanical healthy control mapping. The entry is stale (its pin is not this file),
    // so it is skipped whole and the variable it names is WITHHELD, never fallen back to.
    const { tsv, pjson, resolver } = curatedDataset("nm000653", "Control", { stalePin: true });
    seedSynthetic(h, "nm000653", { tsv, participantsJson: pjson });
    const result = await run({ deps: { curation: resolver } });
    const written = result.results[0];
    expect(written?.outcome).toBe("written");
    if (written?.outcome !== "written") throw new Error("unreachable");
    expect(written.flags).toEqual(expect.arrayContaining(["curation_stale", "curation_withheld"]));
    expect(await text("nm000653.jsonld")).not.toContain("ncit:C94342");
    expect(result.needs_review).toEqual([{ id: "nm000653", flags: written.flags }]);
    // The flags ride on the stored artifact, so status can list them without re-running.
    const meta = (await listStore(h.bucket)).datasets.get("nm000653")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toContain("curation_stale");
  });

  test("with no entry at all the same table DOES carry the mechanical healthy control", async () => {
    // The control for the test above: the withheld claim is real, and the entry's
    // absence is what would have published it.
    const { tsv, pjson } = curatedDataset("nm000654", "Control");
    seedSynthetic(h, "nm000654", { tsv, participantsJson: pjson });
    await run();
    expect(await text("nm000654.jsonld")).toContain("ncit:C94342");
  });

  test("a failed dataset does not stop the others, and the finding clears when it recovers", async () => {
    seedSynthetic(h, "nm000653");
    seedSynthetic(h, "nm000654");
    const failing = async (id: string) =>
      id === "nm000653"
        ? ({ kind: "failed", reason: "broken" } as const)
        : ({ kind: "none" } as const);
    const r1 = await run({ deps: { curation: failing } });
    expect(outcomes(r1).sort()).toEqual(["nm000653:refused", "nm000654:written"]);
    // The standing finding is recorded once, not once per run.
    await run({ deps: { curation: failing } });
    const refusals = () =>
      h.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused' AND resource_id = 'nm000653'",
        )
        .get()?.n;
    expect(refusals()).toBe(1);
    // Fixed: it is written, and a clearing row follows.
    const r3 = await run({});
    expect(outcomes(r3)).toContain("nm000653:written");
    const last = h.db
      .query<{ action: string }, []>(
        "SELECT action FROM audit_log WHERE resource_id = 'nm000653' AND action LIKE 'neurobagel_%' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(last?.action).toBe("neurobagel_cleared");
  });

  test("a curation hash joins the fingerprint, so a changed entry is a rewrite", async () => {
    seedSynthetic(h, "nm000655");
    await run({ deps: { curation: async () => ({ kind: "none" }) } });
    const rec = recordWrites(h.bucket);
    const result = await run(
      {
        execute: false,
        deps: { curation: async () => ({ kind: "entry", hash: "sha256:new", entry: {} }) },
      },
      h.env({ NEUROBAGEL: rec.bucket }),
    );
    expect(result.results[0]).toMatchObject({ outcome: "would_write", reason: "inputs changed" });
    expect(rec.log).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Needs-review flags
// ----------------------------------------------------------------------------

describe("needs-review flags are surfaced, never silent", () => {
  test("a partial join rides on the stored artifact and in the run", async () => {
    // Table ids meet the index in part: sub-01 and sub-02 join, sub-09 has no data.
    seedSynthetic(h, "nm000660", {
      subjects: ["sub-01", "sub-02", "sub-03"],
      tsv: "participant_id\tage\nsub-01\t21\nsub-02\t22\nsub-09\t23\n",
    });
    const result = await run();
    const written = result.results[0];
    expect(written?.outcome).toBe("written");
    if (written?.outcome !== "written") throw new Error("unreachable");
    expect(written.flags).toEqual(["partial_join"]);
    expect(result.needs_review).toEqual([{ id: "nm000660", flags: ["partial_join"] }]);
    const meta = (await listStore(h.bucket)).datasets.get("nm000660")?.jsonld?.meta ?? {};
    expect(meta[META.flags]).toBe("partial_join");
  });

  test("informational flags do not ask for review", async () => {
    seedSynthetic(h, "nm000661", { tsv: null, participantsJson: null });
    const result = await run();
    expect(result.results[0]?.outcome).toBe("written");
    expect(result.needs_review).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// What a dataset the data plane cannot answer does to the store
// ----------------------------------------------------------------------------

describe("failures never replace a good artifact with a worse one", () => {
  test("a manifest read that breaks mid-stream leaves metadata degraded: refused, existing set kept", async () => {
    seedSynthetic(h, "nm000670");
    await run();
    const before = await text("nm000670.jsonld");
    h.db.run(
      "UPDATE datasets SET name = 'Renamed while S3 was failing' WHERE dataset_id = 'nm000670'",
    );
    const key = "/nm000670/version/v1.0.0.json";
    const manifest = JSON.parse(new TextDecoder().decode(h.standin.objects.get(key)?.body));
    // The manifest is rewritten (a new ETag), and HEAD still answers with it; but the
    // body breaks off partway, as a dropped S3 connection does.
    manifest.created = "2026-02-02T00:00:00.000Z";
    h.standin.put(key, JSON.stringify(manifest), { breakAfter: 40 });
    console.error = () => {};

    const rec = recordWrites(h.bucket);
    const result = await run({ only: ["nm000670"] }, h.env({ NEUROBAGEL: rec.bucket }));
    console.error = quiet.error;

    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "metadata_degraded" });
    expect(rec.log).toEqual([]);
    expect(await text("nm000670.jsonld")).toBe(before);
  });

  test("a transient S3 failure on the HEAD is an error of the run, written nowhere and ledgered nowhere", async () => {
    seedSynthetic(h, "nm000671");
    // Point the writer's S3 at a port nothing listens on.
    const result = await run({}, h.env({ S3_ENDPOINT_URL: "http://127.0.0.1:1" }));
    expect(result.results[0]?.outcome).toBe("error");
    expect(await storeKeys(h.bucket)).toEqual([]);
    const ledger = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'neurobagel_refused'",
      )
      .get();
    expect(ledger?.n).toBe(0);
  });

  test("a manifest the bucket does not have is refused (manifest_absent)", async () => {
    seedSynthetic(h, "nm000672");
    h.standin.remove("/nm000672/version/v1.0.0.json");
    const result = await run();
    expect(result.results[0]).toMatchObject({ outcome: "refused", code: "manifest_absent" });
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("an absent participants file is null to the transform, and a failed one is NOT", async () => {
    seedSynthetic(h, "nm000673", { tsv: null });
    const ok = await run({ only: ["nm000673"] });
    expect(ok.results[0]?.outcome).toBe("written");

    seedSynthetic(h, "nm000674");
    // The manifest names participants.tsv, but the raw host cannot serve it.
    h.standin.remove("/nemarDatasets/nm000674/v1.0.0/participants.tsv");
    console.error = () => {};
    console.warn = () => {};
    const bad = await run({ only: ["nm000674"] });
    console.error = quiet.error;
    console.warn = quiet.warn;
    expect(bad.results[0]?.outcome).toBe("refused");
    expect(await storeKeys(h.bucket)).not.toContain("nm000674.jsonld");
  });

  test("an annexed participants file is reached through its redirect, once, and the URL is not reported", async () => {
    seedSynthetic(h, "nm000675", { annexTsv: true });
    const followed: string[] = [];
    const tsv = "participant_id\tage\tsex\nsub-01\t20\tM\nsub-02\t21\tF\nsub-03\t22\tM\n";
    const result = await run({
      deps: {
        followRedirect: (async (url: string) => {
          followed.push(url);
          return new Response(tsv, { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    expect(result.results[0]?.outcome).toBe("written");
    expect(followed).toHaveLength(1);
    expect(followed[0]).toMatch(/^https:\/\//);
    // The URL (a presigned credential) is in no part of the result.
    expect(JSON.stringify(result)).not.toContain(followed[0] as string);
    expect(await text("nm000675.jsonld")).toContain("sub-01");
  });
});

// ----------------------------------------------------------------------------
// Modes
// ----------------------------------------------------------------------------

describe("off by default, and a reported no-op without a bucket", () => {
  test("the switch is exactly the string 1", () => {
    expect(
      neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: undefined, NEUROBAGEL: undefined }),
    ).toBe("disabled");
    for (const value of ["0", "", "true", "yes", "1 ", " 1", "on"]) {
      expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: value, NEUROBAGEL: h.bucket })).toBe(
        "disabled",
      );
    }
    expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: "1", NEUROBAGEL: undefined })).toBe(
      "store_unconfigured",
    );
    expect(neurobagelWriterMode({ NEUROBAGEL_WRITER_ENABLED: "1", NEUROBAGEL: h.bucket })).toBe(
      "enabled",
    );
  });

  test("disabled: a real run does nothing and says so; no bucket call is made", async () => {
    seedSynthetic(h, "nm000680");
    const rec = recordWrites(h.bucket);
    const result = await run(
      {},
      h.env({ NEUROBAGEL: rec.bucket, NEUROBAGEL_WRITER_ENABLED: undefined }),
    );
    expect(result.status).toBe("disabled");
    expect(rec.log).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual([]);
    expect(h.standin.log).toEqual([]);
  });

  test("store_unconfigured: a reported no-op, not an error", async () => {
    seedSynthetic(h, "nm000681");
    const result = await run({}, h.env({ NEUROBAGEL: undefined }));
    expect(result.status).toBe("store_unconfigured");
    expect(result.error).toBeUndefined();
    expect(h.standin.log).toEqual([]);
  });

  test("a dry run needs the bucket but not the switch, and writes nothing", async () => {
    seedSynthetic(h, "nm000682");
    const rec = recordWrites(h.bucket);
    const result = await run(
      { execute: false },
      h.env({ NEUROBAGEL: rec.bucket, NEUROBAGEL_WRITER_ENABLED: undefined }),
    );
    expect(result.status).toBe("ok");
    expect(result.dry_run).toBe(true);
    expect(result.writer_enabled).toBe(false);
    expect(result.results).toEqual([
      { id: "nm000682", outcome: "would_write", reason: "not in the store" },
    ]);
    expect(rec.log).toEqual([]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'neurobagel_%'").get(),
    ).toEqual({
      n: 0,
    });
  });

  test("a dry run reports what a real run would remove", async () => {
    seedSynthetic(h, "nm000683");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000683'");
    const dry = await run({ execute: false });
    expect(dry.results).toContainEqual({ id: "nm000683", outcome: "would_remove" });
    expect(await storeKeys(h.bucket)).toContain("nm000683.jsonld");
    expect(dry.index.changed).toBe(true);
    expect(dry.index.written).toBe(false);
  });

  test("the per-tick bound reads its variable, defaults to 25 and never exceeds the hard limit", () => {
    expect(reconcileLimit({})).toBe(25);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "7" })).toBe(7);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "0" })).toBe(25);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "-3" })).toBe(25);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "lots" })).toBe(25);
    expect(reconcileLimit({ NEUROBAGEL_RECONCILE_MAX: "99999" })).toBe(200);
  });
});

// ----------------------------------------------------------------------------
// The store's own hygiene
// ----------------------------------------------------------------------------

describe("the index is rebuilt from the listing", () => {
  test("a missing, corrupt or truncated index is replaced from the objects in the bucket", async () => {
    seedSynthetic(h, "nm000690");
    seedSynthetic(h, "nm000691");
    await run();
    const good = await text(NEUROBAGEL_INDEX_KEY);

    await h.bucket.delete(NEUROBAGEL_INDEX_KEY);
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);

    await h.bucket.put(NEUROBAGEL_INDEX_KEY, "{ not json");
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);

    await h.bucket.put(NEUROBAGEL_INDEX_KEY, good.slice(0, good.length / 2));
    await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000690", "nm000691"]);
  });

  test("a stored artifact the index lacks is added, and one for an ineligible id is dropped, from the listing alone", async () => {
    seedSynthetic(h, "nm000692");
    await run();
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000692'");
    // The previous run died after changing D1's view but before the index changed: simulate by
    // restoring an index that still lists the dataset.
    const stale = await text(NEUROBAGEL_INDEX_KEY);
    await run();
    await h.bucket.put(NEUROBAGEL_INDEX_KEY, stale);
    await h.bucket.put("nm000692.jsonld", "{}", {
      customMetadata: { [META.sha256]: "0".repeat(64), [META.kind]: "jsonld" },
    });
    await run();
    expect((await storedIndex()).datasets).toEqual([]);
  });

  test("objects that are not the writer's are ignored: never indexed, never deleted", async () => {
    seedSynthetic(h, "nm000693");
    await h.bucket.put("README.txt", "hello");
    await h.bucket.put("nm000999.jsonld", "{}"); // artifact-shaped, no writer stamp
    await h.bucket.put("xx000042.jsonld", "{}", {
      customMetadata: { [META.sha256]: "1".repeat(64), [META.kind]: "jsonld" },
    });
    const result = await run();
    expect((await storedIndex()).datasets.map((d) => d.id)).toEqual(["nm000693"]);
    expect(await storeKeys(h.bucket)).toEqual(
      expect.arrayContaining(["README.txt", "nm000999.jsonld", "xx000042.jsonld"]),
    );
    expect(result.removed).toEqual([]);
  });

  test("a JSON-LD the writer did not stamp as a whole set is never indexed, whatever else it carries", async () => {
    seedSynthetic(h, "nm000695");
    await run();
    // The commit marker is the fingerprint on the JSON-LD. An object with the right
    // hash and kind but no fingerprint is a set that was never completed.
    const object = await h.bucket.get("nm000695.jsonld");
    const body = await (object as R2ObjectBody).arrayBuffer();
    await h.bucket.put("nm000695.jsonld", body, {
      customMetadata: {
        [META.sha256]: object?.customMetadata?.[META.sha256] as string,
        [META.kind]: "jsonld",
      },
    });
    const result = await run({ execute: false });
    expect(result.index.skipped_incomplete).toEqual(["nm000695"]);
    expect(result.index.changed).toBe(true);
  });

  test("a set missing its companions is incomplete: rewritten, and not indexed until complete", async () => {
    seedSynthetic(h, "nm000694");
    await run();
    await h.bucket.delete("nm000694_annotated.json");
    const dry = await run({ execute: false });
    expect(dry.results[0]).toMatchObject({ outcome: "would_write", reason: "incomplete set" });
    const result = await run();
    expect(outcomes(result)).toEqual(["nm000694:written"]);
    expect(await storeKeys(h.bucket)).toContain("nm000694_annotated.json");
  });
});

// ----------------------------------------------------------------------------
// The bound and the order of work
// ----------------------------------------------------------------------------

describe("a tick examines at most N datasets, in a deterministic order", () => {
  const IDS = ["nm000700", "nm000701", "nm000702", "nm000703", "nm000704", "nm000705", "nm000706"];

  test("missing datasets come first, by id, and progress is made across ticks", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const t1 = await run({ limit: 3 });
    expect(outcomes(t1)).toEqual(["nm000700:written", "nm000701:written", "nm000702:written"]);
    expect(t1.unexamined).toBe(4);
    const t2 = await run({ limit: 3 });
    expect(outcomes(t2)).toEqual(["nm000703:written", "nm000704:written", "nm000705:written"]);
    const t3 = await run({ limit: 3 });
    expect(outcomes(t3).filter((o) => o.endsWith(":written"))).toEqual(["nm000706:written"]);
    // Once all are written, the tick is the rotation: nothing is rewritten.
    const t4 = await run({ limit: 3 });
    expect(t4.results.every((r) => r.outcome === "unchanged")).toBe(true);
    expect((await storedIndex()).datasets).toHaveLength(7);
  });

  test("a dataset with nothing in the store is examined before one that merely changed", async () => {
    for (const id of ["nm000700", "nm000701", "nm000702"]) seedSynthetic(h, id);
    await run({ limit: 2 });
    // 700 and 701 are written; 702 is missing; 700 then goes stale. Missing outranks stale
    // even though 700 sorts first.
    h.db.run("UPDATE datasets SET name = 'Late edit' WHERE dataset_id = 'nm000700'");
    const dry = await run({ execute: false, limit: 2 });
    expect(outcomes(dry)).toEqual(["nm000702:would_write", "nm000700:would_write"]);
  });

  test("the same inputs plan the same work (a pure function of inputs and date)", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const a = await run({ execute: false, limit: 4 });
    const b = await run({ execute: false, limit: 4 });
    expect(outcomes(a)).toEqual(outcomes(b));
    expect(outcomes(a)).toEqual(IDS.slice(0, 4).map((id) => `${id}:would_write`));
  });

  test("stale datasets come before the rotation, and the rotation window moves each UTC day", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    await run({ limit: 7 });
    // A change in one row makes it stale; it goes first however late its id.
    h.db.run("UPDATE datasets SET name = 'Late edit' WHERE dataset_id = 'nm000706'");
    const dry = await run({ execute: false, limit: 2, now: new Date("2026-10-01T12:00:00Z") });
    expect(dry.results[0]).toMatchObject({ id: "nm000706", outcome: "would_write" });

    // With nothing stale, the examined window differs day to day and covers everything.
    await run({ limit: 7 });
    const seen = new Set<string>();
    for (let day = 0; day < 4; day++) {
      const d = await run({
        execute: false,
        limit: 2,
        now: new Date(Date.UTC(2026, 9, 1 + day, 12)),
      });
      for (const r of d.results) seen.add(r.id);
    }
    expect([...seen].sort()).toEqual(IDS);
  });

  test("a set missing a companion is MISSING to the plan: it is examined first, on any day, however late its id", async () => {
    for (const id of ["nm000700", "nm000701", "nm000702"]) seedSynthetic(h, id);
    await run({ limit: 3 });
    await h.bucket.delete("nm000702_annotated.json");
    // With one slot a day, a rotation member would be examined on one day in three; a
    // set that is not whole must lead on every one of them.
    for (let day = 0; day < 3; day++) {
      const dry = await run({
        execute: false,
        limit: 1,
        now: new Date(Date.UTC(2026, 9, 1 + day, 12)),
      });
      expect(outcomes(dry)).toEqual(["nm000702:would_write"]);
    }
  });

  test("an explicit list is examined as asked and bounded by its own length", async () => {
    for (const id of IDS) seedSynthetic(h, id);
    const result = await run({ only: ["nm000705", "nm000701", "nm000999"], limit: 2 });
    // Two named, both eligible; the unknown id is not eligible and is not examined.
    expect(outcomes(result)).toEqual(["nm000701:written", "nm000705:written"]);
  });
});
