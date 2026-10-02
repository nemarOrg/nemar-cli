/**
 * The writer's curation adapter (epic #1586, phase 4; ADR 0083 and ADR 0084).
 *
 * Driven against the REAL loader (`lookupCuration`, `parseCuration`) and the REAL
 * committed `shared/neurobagel/curation.json`: the resolver is a thin layer over
 * them, and what it must get right is the contract the lead set:
 *
 *   - an id with an entry resolves to that entry, with a hash that joins the fingerprint;
 *   - an id without one resolves to `none`, but ONLY when the file loads;
 *   - a file that does not load is `failed` for EVERY id, named or not: a broken
 *     file cannot say which datasets it names, and an entry may exist only to
 *     withdraw a claim the mechanical rule would make.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lookupCuration } from "../../shared/neurobagel/curation";
import curationFile from "../../shared/neurobagel/curation.json";
import {
  type CurationSource,
  applyCuration,
  createCurationResolver,
  defaultCurationResolver,
} from "../src/services/neurobagel-curation";

const COMMITTED_TEXT = readFileSync(
  join(import.meta.dir, "../../shared/neurobagel/curation.json"),
  "utf8",
);
const COMMITTED_IDS = Object.keys(curationFile.datasets);
const DAY = new Date("2026-10-02T12:00:00Z");

const committed = (): CurationSource => ({
  file: curationFile as CurationSource["file"],
  lookupCuration,
});

function resolver(file: CurationSource["file"], clock: Date = DAY) {
  return createCurationResolver({
    load: async () => ({ file, lookupCuration }),
    clock: () => clock,
  });
}

describe("the committed file", () => {
  test("loads, and the Worker's re-serialization of the imported object is the file's content", () => {
    // The Worker gets the parsed object (a bundler imports `.json` as an object), so the
    // text handed to the loader is JSON.stringify of it. The committed text must load
    // the same way, or the two routes would disagree about the file.
    expect(COMMITTED_IDS.length).toBeGreaterThan(5);
    expect(lookupCuration(COMMITTED_TEXT, "nm000000", { today: "2026-10-02" }).status).toBe("none");
    expect(
      lookupCuration(JSON.stringify(curationFile), "nm000000", { today: "2026-10-02" }).status,
    ).toBe("none");
    for (const id of COMMITTED_IDS) {
      const fromText = lookupCuration(COMMITTED_TEXT, id, { today: "2026-10-02" });
      const fromObject = lookupCuration(JSON.stringify(curationFile), id, { today: "2026-10-02" });
      expect(fromText.status).toBe("entry");
      expect(fromObject.status).toBe("entry");
    }
  });

  test("every id it names resolves to an entry with a hash; every other id resolves to none", async () => {
    const resolve = createCurationResolver({ load: async () => committed(), clock: () => DAY });
    const hashes = new Set<string>();
    for (const id of COMMITTED_IDS) {
      const r = await resolve(id);
      expect(r.kind).toBe("entry");
      if (r.kind !== "entry") throw new Error("unreachable");
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      hashes.add(r.hash);
      expect(r.entry.datasetId).toBe(id);
    }
    // Each entry has its own hash.
    expect(hashes.size).toBe(COMMITTED_IDS.length);
    for (const id of ["nm000132", "nm000103", "on000117", "xx000042", "nm099998"]) {
      expect(await resolve(id)).toEqual({ kind: "none" });
    }
  });

  test("the default resolver, which imports the file and the loader lazily, answers the same", async () => {
    const first = COMMITTED_IDS[0] as string;
    const r = await defaultCurationResolver(first);
    expect(r.kind).toBe("entry");
    expect(await defaultCurationResolver("nm000132")).toEqual({ kind: "none" });
  });

  test("the hash is of the entry as committed: it moves when the entry does, not otherwise", async () => {
    const id = COMMITTED_IDS[0] as string;
    const base = (await resolver(curationFile as CurationSource["file"])(id)) as {
      kind: "entry";
      hash: string;
    };
    // The same file again: the same hash.
    const again = (await resolver(curationFile as CurationSource["file"])(id)) as typeof base;
    expect(again.hash).toBe(base.hash);
    // A change to the entry's evidence (still a valid file) is a different hash.
    const edited = JSON.parse(JSON.stringify(curationFile));
    edited.datasets[id].evidence.reviewer = "someone else";
    const changed = (await resolver(edited)(id)) as typeof base;
    expect(changed.kind).toBe("entry");
    expect(changed.hash).not.toBe(base.hash);
    // A change to ANOTHER entry leaves this one's hash alone.
    const other = COMMITTED_IDS[1] as string;
    const edited2 = JSON.parse(JSON.stringify(curationFile));
    edited2.datasets[other].evidence.reviewer = "someone else";
    expect(((await resolver(edited2)(id)) as typeof base).hash).toBe(base.hash);
  });
});

describe("a file that does not load stops EVERY dataset", () => {
  const BROKEN: [string, (file: Record<string, unknown>) => void][] = [
    [
      "an unknown key",
      (f) => {
        (
          (f.datasets as Record<string, Record<string, unknown>>)[
            COMMITTED_IDS[0] as string
          ] as Record<string, unknown>
        ).surprise = 1;
      },
    ],
    [
      "a term that is not in the pinned vocabulary",
      (f) => {
        const entry = (
          f.datasets as Record<
            string,
            { columns: Record<string, { Levels?: Record<string, { TermURL: string }> }> }
          >
        )[COMMITTED_IDS[0] as string];
        const column = Object.values(entry?.columns ?? {}).find((c) => c.Levels);
        const level = Object.values(column?.Levels ?? {})[0];
        if (level) level.TermURL = "snomed:0000000";
      },
    ],
    [
      "a dataset id inside the reserved fixture band",
      (f) => {
        (f.datasets as Record<string, unknown>).nm099950 = (f.datasets as Record<string, unknown>)[
          COMMITTED_IDS[0] as string
        ];
      },
    ],
  ];

  for (const [name, break_] of BROKEN) {
    test(`${name}: every id fails, named or not, and the reason is carried`, async () => {
      const file = JSON.parse(JSON.stringify(curationFile)) as Record<string, unknown>;
      break_(file);
      const resolve = resolver(file as CurationSource["file"]);
      for (const id of [...COMMITTED_IDS, "nm000132", "on000117", "nm000001"]) {
        const r = await resolve(id);
        expect(r.kind).toBe("failed");
        if (r.kind === "failed") expect(r.reason).toMatch(/does not load/);
      }
    });
  }

  test("an entry dated after today is a failure for every dataset, until the day comes", async () => {
    const file = JSON.parse(JSON.stringify(curationFile));
    file.datasets[COMMITTED_IDS[0] as string].evidence.date = "2026-10-03";
    const resolve = resolver(file, new Date("2026-10-02T23:00:00Z"));
    expect((await resolve("nm000132")).kind).toBe("failed");
    // The next UTC day, from a resolver that has not seen it yet.
    expect((await resolver(file, new Date("2026-10-03T01:00:00Z"))("nm000132")).kind).toBe("none");
  });

  test("a load that throws is a failure, is not cached, and recovers on the next call", async () => {
    let calls = 0;
    const resolve = createCurationResolver({
      load: async () => {
        calls++;
        if (calls === 1) throw new Error("the chunk did not load");
        return committed();
      },
      clock: () => DAY,
    });
    const first = await resolve("nm000132");
    expect(first).toMatchObject({ kind: "failed" });
    expect((first as { reason: string }).reason).toContain("the chunk did not load");
    expect(await resolve("nm000132")).toEqual({ kind: "none" });
    expect(calls).toBe(2);
  });

  test("the file is loaded once and validated once per day, not once per dataset", async () => {
    let loads = 0;
    const resolve = createCurationResolver({
      load: async () => {
        loads++;
        return committed();
      },
      clock: () => DAY,
    });
    for (let i = 0; i < 50; i++) await resolve(`nm${String(100 + i).padStart(6, "0")}`);
    await resolve(COMMITTED_IDS[0] as string);
    await resolve(COMMITTED_IDS[0] as string);
    expect(loads).toBe(1);
  });
});

describe("applyCuration", () => {
  const input = {
    expectedDatasetId: "nm000001",
    metadata: {},
    participantsTsv: null,
    participantsJson: null,
  };

  test("no entry leaves the input exactly as it was, so output is byte-identical to before curation", () => {
    expect(applyCuration(input, { kind: "none" })).toBe(input);
    expect("curation" in applyCuration(input, { kind: "none" })).toBe(false);
  });

  test("an entry rides on the input's curation field", async () => {
    const id = COMMITTED_IDS[0] as string;
    const r = await resolver(curationFile as CurationSource["file"])(id);
    if (r.kind !== "entry") throw new Error("unreachable");
    const applied = applyCuration({ ...input, expectedDatasetId: id }, r);
    expect(applied.curation).toBe(r.entry);
  });
});
