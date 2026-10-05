/**
 * The zarr stage, run as the real CLI with the real `aws` CLI against the S3 stand-in.
 *
 * Every store, key and value is invented. The stores carry identifier keys with content on
 * purpose, so a test can look for them in whatever the stage printed or wrote and fail if one
 * appears, and can compare what the stage left in S3 with an expectation built independently, by
 * structure, from the same document.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type PlanFile,
  type ZarrPlanFile,
  type ZarrVerifiedFile,
  parseZarrVerified,
} from "../../../scripts/scrub/contract";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  MIB,
  type PublicEndpoint,
  SLOW,
  addUnreadableKey,
  dirText,
  fileSha256,
  fixtureD,
  has,
  leaksAName,
  planArgs,
  readJson,
  runScrub,
  seedManifest,
  seedObject,
  sha256,
  startPublicEndpoint,
  tempDir,
  writeJson,
} from "./support";

let standin: S3Standin;
let pub: PublicEndpoint | undefined;
afterEach(() => {
  standin?.stop();
  pub?.stop();
  pub = undefined;
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const ROOT = `${DATASET}/zarr/sub-01/eeg`;
const storeKey = (name: string) => `${ROOT}/${name}.zarr/zarr.json`;
const A = storeKey("a-pretty");
const B = storeKey("b-compact");
const C = storeKey("c-clean");

/** Values that must appear nowhere the stage prints or writes. */
const VALUES = [
  "P0042",
  "Marigold",
  "Thistlewood",
  "03-JUL-1971",
  "1971-07-03",
  "A-9981",
  "A-7731",
  "Wilhelmina",
  "BioSemi",
];

/**
 * What biosigio's EDF importer writes into `recording_metadata` (every identification field it
 * reads from the header), plus scanner keys elsewhere in the attributes.
 */
const dirtyAttributes = () => ({
  recording_metadata: {
    patientcode: "P0042 Marigold",
    birthdate: "03-JUL-1971",
    startdate: "02.02.20",
    gender: "F",
    equipment: "BioSemi",
    patientname: "Thistlewood",
    patient_additional: "Hieronymus",
    admincode: "A-7731",
    technician: "Wilhelmina Fairweather",
    recording_additional: "Bellweather lab",
  },
  channels: [{ name: "Fz", dob: "1971-07-03" }],
  history: { mrn: "A-9981", note: "kept" },
});

/** The same attributes with the ten identifier members dropped, written out by hand. */
const cleanedAttributes = () => ({
  recording_metadata: { startdate: "02.02.20", gender: "F" },
  channels: [{ name: "Fz" }],
  history: { note: "kept" },
});

const wrap = (attributes: unknown) => ({ zarr_format: 3, node_type: "group", attributes });

const prettyDirty = `${JSON.stringify(wrap(dirtyAttributes()), null, 2)}\n`;
const prettyCleaned = `${JSON.stringify(wrap(cleanedAttributes()), null, 2)}\n`;
const compactDirty = JSON.stringify(
  wrap({
    recording_metadata: { patientcode: "P0043 Marigold", birthdate: "04-AUG-1972", gender: "M" },
  }),
);
const compactCleaned = JSON.stringify(wrap({ recording_metadata: { gender: "M" } }));
const cleanDoc = JSON.stringify(
  wrap({ recording_metadata: { startdate: "02.02.20", gender: "F", email: "a@b.test" } }),
);

interface Seeded {
  dir: string;
  /** The other objects of the Zarr copy, which the stage must never touch. */
  others: Record<string, Uint8Array>;
}

/** A dataset with a plan, and a Zarr copy: two dirty store roots, one clean, and other objects. */
async function seeded(): Promise<Seeded> {
  standin = startS3Standin();
  const d = fixtureD();
  seedObject(standin, d);
  seedManifest(standin, "v1.0.0", [d]);
  const dir = tempDir("zarr");
  const plan = await runScrub(standin, planArgs(dir));
  expect(plan.exitCode, plan.all).toBe(0);

  standin.putObject(BUCKET, A, enc(prettyDirty), {
    contentType: "application/json",
    cacheControl: "max-age=60",
    sse: "AES256",
  });
  standin.putObject(BUCKET, B, enc(compactDirty), { contentType: "application/json" });
  standin.putObject(BUCKET, C, enc(cleanDoc), { contentType: "application/json" });
  const others: Record<string, Uint8Array> = {
    // An array's own metadata, deeper in a store: not a store root, so never read or rewritten.
    [`${ROOT}/a-pretty.zarr/data/zarr.json`]: enc(
      JSON.stringify({ zarr_format: 3, node_type: "array", attributes: { patientcode: "P9999" } }),
    ),
    [`${ROOT}/a-pretty.zarr/data/c/0/0`]: new Uint8Array([1, 2, 3, 4]),
    [`${DATASET}/zarr/index.json`]: enc(JSON.stringify({ stores: 3 })),
  };
  for (const [k, v] of Object.entries(others)) standin.putObject(BUCKET, k, v);
  standin.log.length = 0;
  return { dir, others };
}

const zarrArgs = (dir: string, extra: string[] = []) => [
  "zarr",
  "--dir",
  dir,
  "--concurrency",
  "1",
  ...extra,
];

const text = (key: string) => dec((standin.current(BUCKET, key) as { data: Uint8Array }).data);
const versionsOf = (key: string) => standin.versions(BUCKET, key);
const mode = (dir: string, name: string) => statSync(path.join(dir, name)).mode & 0o777;

function expectNoValue(output: string, dir: string) {
  const everything = `${output}\n${dirText(dir)}`;
  expect(leaksAName(everything)).toBeNull();
  for (const v of VALUES) expect(everything, v).not.toContain(v);
}

describe("zarr: a dry run", () => {
  test(
    "reads, reports what it would remove, writes a private plan, and changes nothing",
    async () => {
      const { dir } = await seeded();
      // A proof from an earlier run is not left standing by a run that did not re-prove.
      writeFileSync(path.join(dir, "zarr-verified.json"), "{}");

      const r = await runScrub(standin, zarrArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zarr dry run (nothing written to S3)");
      expect(r.stdout).toContain("stores=3 clean=1 needScrub=2 unreadable=0 failed=0");

      // Only reads: a listing, a HEAD and a GET per store, never a write.
      expect([...new Set<string>(standin.log.map((x) => x.op))].sort()).toEqual(
        ["GetObject", "HeadObject", "ListObjectsV2"].sort(),
      );
      expect(standin.calls("GetObject").map((c) => c.key)).toEqual([A, B, C]);
      for (const k of [A, B, C]) expect(versionsOf(k).length).toBe(1);

      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.executed).toBe(false);
      expect(plan.dataset).toBe(DATASET);
      expect(plan.planSha256).toBe(fileSha256(dir, "plan.json"));
      expect(plan.found).toBe("stores");
      expect(plan.outcomes).toEqual({ "needs-scrub": 2, clean: 1 });
      expect(plan.removedMembers).toBe(12);
      // The set of keys examined is named by a digest computed here; no key is stored.
      expect(plan.keysSha256).toBe(sha256(enc([A, B, C].sort().join("\n"))));
      const planText = readFileSync(path.join(dir, "zarr-plan.json"), "utf8");
      for (const k of [A, B, C]) expect(planText).not.toContain(k);
      expect(planText).not.toContain("zarr.json");
      expect(planText).not.toContain("sub-01");
      expect(plan.totals).toEqual({
        stores: 3,
        clean: 1,
        needScrub: 2,
        scrubbed: 0,
        unreadable: 0,
        failed: 0,
      });
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(mode(dir, "zarr-plan.json")).toBe(0o600);
      expectNoValue(r.all, dir);
    },
    SLOW,
  );
});

describe("zarr: --execute", () => {
  test(
    "removes exactly the identifier keys, conditionally, and leaves every other object alone",
    async () => {
      const { dir, others } = await seeded();
      const before = {
        a: versionsOf(A)[0]?.etag as string,
        b: versionsOf(B)[0]?.etag as string,
        c: versionsOf(C)[0]?.etag as string,
      };

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("stores=3 clean=1 scrubbed=2 unreadable=0 failed=0");
      expect(r.stdout).toContain("zarr: ok");

      // The rewritten roots are the original minus the identifier members, in the original layout.
      expect(text(A)).toBe(prettyCleaned);
      expect(text(B)).toBe(compactCleaned);
      for (const v of VALUES) {
        expect(text(A), v).not.toContain(v);
        expect(text(B), v).not.toContain(v);
      }
      // The fields that stay are the ones that were not identifiers.
      expect(JSON.parse(text(A)).attributes.recording_metadata).toEqual({
        startdate: "02.02.20",
        gender: "F",
      });

      // A new version each; the original is still there, noncurrent, for the prune to remove.
      for (const k of [A, B]) {
        expect(versionsOf(k).length, k).toBe(2);
        expect(versionsOf(k)[1]?.deleteMarker).toBe(false);
      }
      expect(dec((versionsOf(A)[0] as { data: Uint8Array }).data)).toBe(prettyDirty);

      // Each write named the ETag it read, so a writer in between would have been refused.
      const puts = standin.calls("PutObject");
      expect(puts.map((p) => [p.key, p.status, p.ifMatch])).toEqual([
        [A, 200, before.a],
        [B, 200, before.b],
      ]);
      // The metadata the object had is the metadata it keeps.
      const rewritten = standin.current(BUCKET, A);
      expect(rewritten?.contentType).toBe("application/json");
      expect(rewritten?.cacheControl).toBe("max-age=60");
      expect(rewritten?.sse).toBe("AES256");

      // The clean root and every other object of the Zarr copy: no new version, same bytes.
      expect(versionsOf(C).length).toBe(1);
      expect(versionsOf(C)[0]?.etag).toBe(before.c);
      for (const [k, v] of Object.entries(others)) {
        expect(versionsOf(k).length, k).toBe(1);
        expect(Buffer.compare(standin.current(BUCKET, k)?.data as Uint8Array, v), k).toBe(0);
      }
      expect(standin.calls("DeleteObject").length).toBe(0);

      // The record of the run, and the proof bound to it.
      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.executed).toBe(true);
      expect(plan.outcomes).toEqual({ scrubbed: 2, clean: 1 });
      const proof = parseZarrVerified(readFileSync(path.join(dir, "zarr-verified.json"), "utf8"));
      expect(proof.dataset).toBe(DATASET);
      expect(proof.planSha256).toBe(fileSha256(dir, "plan.json"));
      expect(proof.zarrPlanSha256).toBe(fileSha256(dir, "zarr-plan.json"));
      expect(proof.counts).toEqual({ stores: 3, rewritten: 2, untouched: 1 });
      expect(mode(dir, "zarr-plan.json")).toBe(0o600);
      expect(mode(dir, "zarr-verified.json")).toBe(0o600);
      expectNoValue(r.all, dir);

      // Run again: nothing is left to remove, so nothing is written, and the proof is renewed.
      standin.log.length = 0;
      const again = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      expect(standin.calls("PutObject").length).toBe(0);
      for (const k of [A, B, C]) expect(versionsOf(k).length).toBe(k === C ? 1 : 2);
      const renewed = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(renewed.counts).toEqual({ stores: 3, rewritten: 0, untouched: 3 });
    },
    SLOW,
  );

  test(
    "a store root changed since it was read is never overwritten, and a re-run finishes the job",
    async () => {
      const { dir } = await seeded();
      // Just as the first write begins, another writer replaces A with a newer version that still
      // has identifiers (and a key of its own).
      const newer = JSON.stringify(
        wrap({ ...dirtyAttributes(), later: { added: "by another writer" } }),
      );
      standin.beforeOp("PutObject", () => {
        standin.putObject(BUCKET, A, enc(newer), { contentType: "application/json" });
      });

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("changed-concurrently=1");
      expect(r.stdout).toContain("zarr-verified.json NOT written");
      expect(has(dir, "zarr-verified.json")).toBe(false);

      // The other writer's version stands: our stale write was refused, not applied on top.
      expect(text(A)).toBe(newer);
      expect(versionsOf(A).length).toBe(2);
      expect(standin.calls("PutObject").find((p) => p.key === A)?.status).toBe(412);
      // The other store was independent of it and was scrubbed.
      expect(text(B)).toBe(compactCleaned);

      // Nothing blocks a second run: it reads what is there now, removes the keys, keeps theirs.
      const again = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      const finalA = JSON.parse(text(A));
      expect(finalA.attributes.later).toEqual({ added: "by another writer" });
      expect(finalA.attributes.recording_metadata).toEqual({
        startdate: "02.02.20",
        gender: "F",
      });
      expect(versionsOf(A).length).toBe(3);
      expect(has(dir, "zarr-verified.json")).toBe(true);
    },
    SLOW,
  );

  test(
    "a store that is dirty again when read back is not clean, and nothing is proven",
    async () => {
      const { dir } = await seeded();
      // Reads, in order with one worker: A, then A again after its write. Just before that second
      // read, a writer puts a dirty version back.
      // The stand-in counts every GET since it started (the plan's too), so the hook is armed
      // for each of the next few and fires on the second of the ones the stage makes.
      let reads = 0;
      for (let nth = 1; nth <= 40; nth++) {
        standin.beforeOp(
          "GetObject",
          () => {
            reads += 1;
            if (reads === 2) standin.putObject(BUCKET, A, enc(prettyDirty));
          },
          nth,
        );
      }
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("verify-failed=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(text(A)).toBe(prettyDirty);
      expect(readJson<ZarrPlanFile>(dir, "zarr-plan.json").outcomes).toEqual({
        "verify-failed": 1,
        scrubbed: 1,
        clean: 1,
      });
    },
    SLOW,
  );

  test(
    "a store that cannot be read or cleaned is counted, the plan is incomplete, and nothing is proven",
    async () => {
      const { dir } = await seeded();
      const D = storeKey("d-malformed");
      const E = storeKey("e-not-utf8");
      const F = storeKey("f-too-large");
      const G = storeKey("g-outside");
      const V2 = `${DATASET}/zarr/sub-02/old.zarr/.zattrs`;
      standin.putObject(BUCKET, D, enc("Marigold Thistlewood is not json"));
      standin.putObject(BUCKET, E, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
      // A zarr.json is a few KiB; this one is not metadata and is never read.
      const huge = new Uint8Array(17 * MIB).fill(0x20);
      huge.set(enc('{"attributes":{}}'), 0);
      standin.putObject(BUCKET, F, huge);
      // An identifier key outside `attributes`, which the stage does not reach, beside one inside.
      const outside = JSON.stringify({
        zarr_format: 3,
        patientcode: "P0044",
        attributes: { mrn: "A-9981" },
      });
      standin.putObject(BUCKET, G, enc(outside));
      standin.putObject(BUCKET, V2, enc("{}"));
      standin.log.length = 0;

      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, zarrArgs(dir, flag));
        expect(r.exitCode, r.all).toBe(4);
        expect(r.stdout).toContain("incomplete");
        expect(r.stdout).toContain("zarr-json-malformed=2");
        expect(r.stdout).toContain("zarr-json-too-large=1");
        expect(r.stdout).toContain("identifier-outside-attributes=1");
        expect(r.stdout).toContain("zarr-v2-metadata=1");
        // The v2 store has no zarr.json at its root, so it is also a store without a root.
        expect(r.stdout).toContain("store-root-missing=1");
        expect(has(dir, "zarr-verified.json")).toBe(false);
        expect(leaksAName(r.all)).toBeNull();
        expect(r.all).not.toContain("P0044");
      }
      // The ones it could not clean are exactly as they were; the one it could was cleaned.
      for (const k of [D, E, F, G, V2]) expect(versionsOf(k).length, k).toBe(1);
      expect(text(G)).toBe(outside);
      expect(text(A)).toBe(prettyCleaned);
      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.totals.unreadable).toBe(6);
      expect(plan.totals.failed).toBe(0);
    },
    SLOW,
  );

  test(
    "a store that cannot be read at all is a failure, not a clean store",
    async () => {
      const { dir } = await seeded();
      standin.inject("GetObject", { code: "InternalError", status: 500, key: B });
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("GetObject:failed=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(versionsOf(B).length).toBe(1);
    },
    SLOW,
  );
});

describe("zarr: the EDF identification fields the converter mirrors", () => {
  test(
    "a store whose only identifier is a mirrored field the scanner does not know is not clean",
    async () => {
      const { dir } = await seeded();
      // Reviewer probe T6: a technician's name and free text from the patient field, and nothing
      // the scanner calls an identifier. Before the mirror list this store was "clean".
      const T = storeKey("t-technician");
      const doc = JSON.stringify(
        wrap({
          recording_metadata: {
            gender: "F",
            startdate: "02.02.20",
            technician: "Wilhelmina Fairweather",
            patient_additional: "Hieronymus",
            admincode: "A-7731",
            recording_additional: "Bellweather lab",
            equipment: "BioSemi",
          },
        }),
      );
      standin.putObject(BUCKET, T, enc(doc), { contentType: "application/json" });

      const dry = await runScrub(standin, zarrArgs(dir));
      expect(dry.exitCode, dry.all).toBe(0);
      expect(dry.stdout).toContain("stores=4 clean=1 needScrub=3");

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(JSON.parse(text(T))).toEqual(
        wrap({ recording_metadata: { gender: "F", startdate: "02.02.20" } }),
      );
      for (const v of ["Wilhelmina", "Fairweather", "Hieronymus", "A-7731", "Bellweather"]) {
        expect(text(T), v).not.toContain(v);
      }
      expect(readJson<ZarrVerifiedFile>(dir, "zarr-verified.json").counts.rewritten).toBe(3);
      expectNoValue(r.all, dir);
    },
    SLOW,
  );
});

describe("zarr-public: the check from outside after publication", () => {
  const index = (stores: string[]) =>
    enc(JSON.stringify({ dataset_id: DATASET, stores: stores.map((zarr) => ({ zarr })) }));
  const rel = (key: string) => key.slice(`${DATASET}/zarr/`.length, -"/zarr.json".length);

  /** A public reader of the stand-in's current objects, and the dataset's index naming A, B, C. */
  async function published(): Promise<Seeded> {
    const s = await seeded();
    standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index([A, B, C].map(rel)));
    pub = startPublicEndpoint();
    pub.serve = (key) => standin.current(BUCKET, key)?.data;
    return s;
  }
  const publicArgs = () => ["zarr-public", "--dataset", DATASET, "--public-base", pub?.url ?? ""];

  test(
    "asks the zarr stage's own question of every store the index names, anonymously",
    async () => {
      const { dir } = await published();
      const before = await runScrub(standin, publicArgs());
      expect(before.exitCode, before.all).toBe(1);
      expect(before.stdout).toContain("stores=3 clean=1 identifier=2 unreadable=0");
      expectNoValue(before.all, dir);
      // Anonymous GETs only: the index, then each store root.
      for (const req of pub?.requests ?? []) {
        expect(req.method).toBe("GET");
        expect(req.headers.authorization).toBeUndefined();
      }
      expect((pub?.requests ?? []).map((q) => q.path).sort()).toEqual(
        [`/${DATASET}/zarr/index.json`, ...[A, B, C].map((k) => `/${k}`)].sort(),
      );

      expect((await runScrub(standin, zarrArgs(dir, ["--execute"]))).exitCode).toBe(0);
      const after = await runScrub(standin, publicArgs());
      expect(after.exitCode, after.all).toBe(0);
      expect(after.stdout).toContain("stores=3 clean=3 identifier=0 unreadable=0");
    },
    SLOW,
  );

  test(
    "a mirrored field the scanner does not know fails the public check too",
    async () => {
      await published();
      standin.putObject(
        BUCKET,
        A,
        enc(
          JSON.stringify(wrap({ recording_metadata: { technician: "Wilhelmina", gender: "F" } })),
        ),
      );
      standin.putObject(BUCKET, B, enc(compactCleaned));
      const r = await runScrub(standin, publicArgs());
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("stores=3 clean=2 identifier=1 unreadable=0");
      expect(r.all).not.toContain("Wilhelmina");
    },
    SLOW,
  );

  test(
    "a store or an index it cannot read proves nothing",
    async () => {
      await published();
      standin.putObject(BUCKET, A, enc(prettyCleaned));
      standin.putObject(BUCKET, B, enc(compactCleaned));
      // C is named by the index and not served: 403, as for a missing key.
      standin.putDeleteMarker(BUCKET, C);
      const r = await runScrub(standin, publicArgs());
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("http-403=1");

      standin.putDeleteMarker(BUCKET, `${DATASET}/zarr/index.json`);
      expectStopped(await runScrub(standin, publicArgs()), 4, "index-unreadable");

      standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index(["../../objects/x.zarr"]));
      expectStopped(await runScrub(standin, publicArgs()), 4, "index-malformed");
    },
    SLOW,
  );
});

describe("zarr: a proof is never vacuous", () => {
  test(
    "objects under the prefix and no store root: unreadable, and no proof is written",
    async () => {
      const { dir, others } = await seeded();
      // Reviewer probe T7: only a dirty zarr.json under a directory without the .zarr suffix, and
      // an index. Before, that was "every one of 0 store roots is clean" and a proof.
      for (const k of [A, B, C]) standin.putDeleteMarker(BUCKET, k);
      const stray = `${DATASET}/zarr/sub-01/eeg/store-without-suffix/zarr.json`;
      standin.putObject(BUCKET, stray, enc(prettyDirty));
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, zarrArgs(dir, flag));
        expect(r.exitCode, r.all).toBe(4);
        expect(r.stdout).toContain("stores=0");
        expect(r.stdout).toContain("no-store-root=1");
        expect(r.stdout).toContain("zarr-json-outside-store=1");
        expect(has(dir, "zarr-verified.json")).toBe(false);
      }
      expect(text(stray)).toBe(prettyDirty);

      // Nothing but the index: no zarr.json anywhere, and still not a prefix with nothing in it.
      standin.putDeleteMarker(BUCKET, stray);
      for (const k of Object.keys(others)) {
        if (!k.endsWith("index.json")) standin.putDeleteMarker(BUCKET, k);
      }
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("not clean, by reason: no-store-root=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a zarr.json outside any store, or a store with no root, fails a run that has good stores",
    async () => {
      const { dir } = await seeded();
      standin.putObject(BUCKET, `${DATASET}/zarr/zarr.json`, enc(compactDirty));
      let r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("zarr-json-outside-store=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);

      standin.putDeleteMarker(BUCKET, `${DATASET}/zarr/zarr.json`);
      // Chunks of a store whose root metadata is gone: nothing says what its attributes were.
      standin.putObject(BUCKET, `${ROOT}/rootless.zarr/data/c/0/0`, new Uint8Array([1]));
      r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("store-root-missing=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a store root that starts with a byte order mark is refused, not rewritten without it",
    async () => {
      const { dir } = await seeded();
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(compactDirty)]);
      standin.putObject(BUCKET, B, bom);
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("zarr-json-bom=1");
      expect(versionsOf(B).length).toBe(2);
      expect(Buffer.compare(standin.current(BUCKET, B)?.data as Uint8Array, bom)).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );
});

describe("zarr: preconditions", () => {
  test(
    "needs a plan to name the dataset and the bucket",
    async () => {
      standin = startS3Standin();
      const empty = mkdtempSync(path.join(tmpdir(), "s3-scrub-zarr-empty-"));
      expectStopped(await runScrub(standin, zarrArgs(empty)), 3, "plan.json-missing");

      const bad = tempDir("zarr-badplan");
      writeJson(bad, "plan.json", {
        version: 1,
        dataset: "nm1",
        keys: [],
        totals: { keys: 0, needScrub: 0, bytesToHash: 0, unreadable: 0 },
      });
      const r = await runScrub(standin, zarrArgs(bad));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("bad-dataset-id");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, before any S3 call",
    async () => {
      const { dir } = await seeded();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, zarrArgs(dir, flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a dataset with no Zarr copy is recorded as no-zarr, and the plan it made is the one named",
    async () => {
      standin = startS3Standin();
      const d = fixtureD();
      seedObject(standin, d);
      seedManifest(standin, "v1.0.0", [d]);
      const dir = tempDir("zarr-none");
      expect((await runScrub(standin, planArgs(dir))).exitCode).toBe(0);
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(proof.found).toBe("no-zarr");
      expect(proof.counts).toEqual({ stores: 0, rewritten: 0, untouched: 0 });
      expect(r.stdout).toContain("no Zarr copy");
      expect(proof.planSha256).toBe(fileSha256(dir, "plan.json"));
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.dataset).toBe(DATASET);
      expect(sha256(readFileSync(path.join(dir, "zarr-plan.json")))).toBe(proof.zarrPlanSha256);
    },
    SLOW,
  );
});
