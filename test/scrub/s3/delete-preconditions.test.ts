/**
 * The delete-old stage's preconditions: what must be true before an old key may go. The rest of
 * the delete-old suite is in `delete.test.ts`; the two share one fixture (`delete-harness.ts`)
 * and are split only so CI can run them on different runners.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanFile, ZarrPlanFile } from "../../../scripts/scrub/contract";
import { StageError } from "../../../scripts/scrub/s3/s3-lib";
import {
  DEFAULT_PUBLIC_BASE,
  type DeletedFile,
  TEST_LOOPBACK_PUBLIC_BASE_ENV,
  checkPublicBase,
  publicObjectUrl,
} from "../../../scripts/scrub/s3/s3-stages";
import {
  a,
  b,
  cleanStore,
  d,
  deleteArgs,
  dir,
  dirtyStore,
  executeArgs,
  expectOldIntact,
  firstNewKey,
  proveZarr,
  pub,
  snap,
  standin,
  useDeleteHarness,
  writeProofs,
} from "./delete-harness";
import { expectStopped, expectUsage } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  centuryFromNow,
  deleteRequests,
  edfFile,
  edfHeader,
  has,
  makeFixture,
  objectPath,
  readJson,
  removeTempDirs,
  runScrub,
  seedManifest,
  startPublicEndpoint,
  writeGitVerified,
  writeJson,
} from "./support";

afterAll(removeTempDirs);
useDeleteHarness();

describe("delete-old: what must be true before an old key may go", () => {
  const body = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const [firstKey, secondKey] = [a.oldKey, b.oldKey].sort() as [string, string];

  /**
   * The stage refuses with `word`, in the dry run and, when `execute` is set, with --execute too,
   * and nothing was deleted either way.
   */
  async function refused(
    word: string,
    opts: { execute?: boolean; base?: string; intact?: boolean; extra?: string[] } = {},
  ) {
    const modes = opts.execute === false ? [[]] : [[], ["--execute"]];
    for (const flag of modes) {
      const r = await runScrub(standin, deleteArgs([...flag, ...(opts.extra ?? [])], opts.base));
      expectStopped(r, 3, word, `${flag.length ? "execute" : "dry run"}: ${word}`);
      expect(deleteRequests(standin), word).toBe(0);
      expect(has(dir, "deleted.json"), word).toBe(false);
    }
    if (opts.intact !== false) expectOldIntact();
  }

  test(
    "--confirm-dataset is required and must equal the plan's dataset, before any S3 call",
    async () => {
      writeProofs();
      const base = ["--dir", dir, "--public-base", pub.url];
      for (const flag of [[], ["--execute"]]) {
        const missing = await runScrub(standin, ["delete-old", ...base, ...flag]);
        expect(missing.exitCode, missing.all).toBe(2);
        expect(missing.stderr).toContain("s3-scrub: missing-confirm-dataset");
        for (const typed of ["xx090999", DATASET.toUpperCase(), `${DATASET} `, "nm099999"]) {
          const wrong = await runScrub(standin, [
            "delete-old",
            ...base,
            "--confirm-dataset",
            typed,
            ...flag,
          ]);
          expectStopped(wrong, 3, "confirm-dataset-mismatch", `typed ${JSON.stringify(typed)}`);
        }
      }
      // Refused before the first request to S3 or to the public endpoint.
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses while a current manifest, of any tag, still names an old key",
    async () => {
      writeProofs();
      // The manifest as it was before runbook step 12 regenerated it: it names the old keys. The
      // regenerated one becomes its history, named here so the manifest is the only refusal.
      seedManifest(standin, "v1.0.0", [a, b, d]);
      await refused("manifest-names-old-key", {
        extra: ["--prune-noncurrent", `${DATASET}/version/`],
      });

      // v1.0.0 is regenerated; a second tag, found by listing, is not.
      standin.restore(snap);
      seedManifest(standin, "v1.0.1", [b]);
      await refused("manifest-names-old-key");
    },
    SLOW,
  );

  test(
    "reads every current manifest, and refuses one it cannot read or cannot account for",
    async () => {
      writeProofs();
      // A second tag that is clean is read as well as the first, and passes.
      seedManifest(standin, "v1.0.1", [a, b, d], {}, DATASET, true);
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      const fetched = standin.calls("GetObject").map((c) => c.key);
      expect(fetched).toContain(`${DATASET}/version/v1.0.0.json`);
      expect(fetched).toContain(`${DATASET}/version/v1.0.1.json`);

      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/version/v1.0.2.json`, body("not json at all"));
      await refused("manifest-malformed", { execute: false });

      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/version/notes.json`, body("{}"));
      await refused("version-dir-unknown-file", { execute: false });
    },
    SLOW,
  );

  test(
    "the dataset must be private: an anonymous HEAD of a new and an old object answers exactly 403",
    async () => {
      writeProofs();
      // 403 passes, in the dry run: two requests, HEADs, anonymous, a new key and an old key.
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      expect(pub.requests.map((q) => [q.method, q.path])).toEqual([
        ["HEAD", `/${DATASET}/objects/${firstNewKey()}`],
        ["HEAD", `/${DATASET}/objects/${firstKey}`],
      ]);
      for (const req of pub.requests) {
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers.cookie).toBeUndefined();
        expect(Object.keys(req.headers).filter((h) => h.startsWith("x-amz"))).toEqual([]);
      }

      // 200 is a public dataset, in either mode.
      pub.status = 200;
      await refused("dataset-is-public");

      // Anything else proves nothing: this bucket denies anonymous listing, so a 404 or a
      // redirect does not say the dataset is private, and an error says nothing at all.
      for (const status of [404, 500, 503, 301, 206, 204]) {
        pub.status = status;
        await refused("privacy-unproven", { execute: false });
      }
      // Nothing listening is no answer either.
      const dead = startPublicEndpoint();
      const deadUrl = dead.url;
      dead.stop();
      await refused("privacy-unproven", { base: deadUrl });
    },
    SLOW,
  );

  test(
    "the probes are objects that exist: a key hidden by a delete marker is skipped",
    async () => {
      writeProofs();
      // A marker on an old key, recorded by the plan (so the delete may remove it).
      const recordMarker = (key: string) => {
        const id = standin.putDeleteMarker(BUCKET, objectPath(key));
        const plan = readJson<PlanFile>(dir, "plan.json");
        (plan.keys.find((k) => k.oldKey === key) as PlanFile["keys"][number]).versionIds.push(id);
        writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
        writeGitVerified(dir); // the git proof names the plan's bytes
      };
      recordMarker(firstKey);
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      expect(pub.requests.map((r) => r.path)).toEqual([
        `/${DATASET}/objects/${firstNewKey()}`,
        `/${DATASET}/objects/${secondKey}`,
      ]);

      // Every old key hidden: the new key alone proves it, as on a re-run after the delete.
      recordMarker(secondKey);
      pub.requests.length = 0;
      const newOnly = await runScrub(standin, deleteArgs());
      expect(newOnly.exitCode, newOnly.all).toBe(0);
      expect(pub.requests.map((r) => r.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);

      // And no new object current either: nothing to ask about, nothing proven, nothing asked.
      for (const f of [a, b]) standin.putDeleteMarker(BUCKET, objectPath(f.newKey as string));
      pub.requests.length = 0;
      await refused("privacy-unproven", { execute: false, intact: false });
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a delete that finished can be run again: the new keys prove privacy, and nothing is left",
    async () => {
      writeProofs();
      const first = await runScrub(standin, executeArgs());
      expect(first.exitCode, first.all).toBe(0);
      rmSync(path.join(dir, "deleted.json"));
      // Reviewer probe T1: the old keys are gone, so a re-run used to stop at privacy-unproven.
      for (const flag of [[], ["--execute"]]) {
        pub.requests.length = 0;
        const again = await runScrub(standin, deleteArgs(flag));
        expect(again.exitCode, again.all).toBe(0);
        expect(again.stdout).toContain("keys=2 versions=0 markers=0");
        expect(pub.requests.map((q) => q.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);
      }
      expect(readJson<DeletedFile>(dir, "deleted.json").counts.versions).toBe(0);
      // And the public answer still decides: a re-run against a public dataset is refused.
      pub.status = 200;
      expectStopped(await runScrub(standin, deleteArgs()), 3, "dataset-is-public");
    },
    SLOW,
  );

  test(
    "the default public base is the production bucket's anonymous URL",
    () => {
      expect(DEFAULT_PUBLIC_BASE).toBe("https://nemar.s3.us-east-2.amazonaws.com");
    },
    SLOW,
  );

  test("the anonymous URL of an object encodes each path segment, and only the segments", () => {
    const base = "https://nemar.s3.us-east-2.amazonaws.com";
    // The plain key: nothing to encode, and a trailing slash on the base makes no difference.
    const plain = "nm000001/objects/SHA256E-s7--0123abcd.edf";
    expect(publicObjectUrl(base, plain)).toBe(`${base}/${plain}`);
    expect(publicObjectUrl(`${base}//`, plain)).toBe(`${base}/${plain}`);
    // An annex key may carry `+` in its extension, which S3 reads as a space in a path; a space,
    // `%`, `&` and non-ASCII are encoded too. The slashes between segments stay slashes.
    expect(publicObjectUrl(base, "nm000001/objects/SHA256E-s7--0123abcd.ed+f")).toBe(
      `${base}/nm000001/objects/SHA256E-s7--0123abcd.ed%2Bf`,
    );
    expect(publicObjectUrl(base, "nm000001/zarr/sub 01/a&b%c/\u00e9.zarr/zarr.json")).toBe(
      `${base}/nm000001/zarr/sub%2001/a%26b%25c/%C3%A9.zarr/zarr.json`,
    );
  });

  test(
    "refuses while the dataset has any archive version or marker, current or not",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      await refused("archives-not-dropped");

      // Reviewer probe T3: an archive hidden by a delete marker is not current, and it is still
      // the original recordings.
      standin.restore(snap);
      const hidden = `${DATASET}/archives/${DATASET}_v1.0.1.zip`;
      standin.putObject(BUCKET, hidden, body("zip"));
      standin.putDeleteMarker(BUCKET, hidden);
      await refused("archives-not-dropped");
      // A marker alone, with nothing under it, is refused too: drop-archives leaves none.
      standin.restore(snap);
      standin.putDeleteMarker(BUCKET, hidden);
      await refused("archives-not-dropped", { execute: false });

      // A sibling prefix that merely starts the same way is not the archive prefix.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/archives-old/x.zip`, body("zip"));
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses a current Zarr object until the zarr stage has proven this plan",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      await refused("zarr-not-scrubbed");

      // The stage's own proof is what the check accepts, and it removed the identifier key first.
      // Its rewrite left the dirty version as history, which this run must be told to prune.
      await proveZarr();
      expect(JSON.parse(dec(standin.current(BUCKET, zarrJson)?.data as Uint8Array))).toEqual(
        JSON.parse(cleanStore),
      );
      const ok = await runScrub(standin, deleteArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(ok.exitCode, ok.all).toBe(0);

      // A proof for another dataset, another plan, another zarr plan, or of another shape. The
      // rewrite's history is named for the prune, so the Zarr proof is the only refusal.
      const only = { execute: false, extra: ["--prune-noncurrent", `${DATASET}/zarr/`] };
      await proveZarr({ dataset: "xx090999" });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ planSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ zarrPlanSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ counts: { stores: 5, docs: 5, rewritten: 1, untouched: 1 } });
      await refused("zarr-not-scrubbed", only);
      // A well-formed proof that the prefix was empty says nothing about the objects there now.
      await proveZarr({
        found: "no-zarr",
        stores: [],
        counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 },
      });
      await refused("zarr-not-scrubbed", only);
      writeJson(dir, "zarr-verified.json", { version: 1 });
      await refused("zarr-not-scrubbed", only);
      // The proof without the zarr-plan.json it names, and a zarr-plan.json that was changed.
      await proveZarr();
      writeJson(dir, "zarr-plan.json", {
        ...readJson<ZarrPlanFile>(dir, "zarr-plan.json"),
        executed: false,
      });
      await refused("zarr-not-scrubbed", only);
      await proveZarr();
      rmSync(path.join(dir, "zarr-plan.json"));
      await refused("zarr-not-scrubbed", only);
      // Without the prune the history is a second refusal, and both are reported.
      await proveZarr({ planSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed+history-remains", { execute: false });
    },
    SLOW,
  );

  test(
    "a Zarr copy that is only history needs no proof, and is pruned",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body("{}"));
      standin.putDeleteMarker(BUCKET, zarrJson);
      expectStopped(await runScrub(standin, deleteArgs()), 3, "history-remains");
      const ok = await runScrub(standin, deleteArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(ok.exitCode, ok.all).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses a recording under objects/ that the plan never read, in any letter case",
    async () => {
      writeProofs();
      // An upload after the plan: an EDF the scrub never saw, so its header was never checked.
      const late = makeFixture(
        "L",
        ".EDF",
        "sub-09/eeg/late.EDF",
        edfFile(edfHeader({ patient: "Quillfeather", recording: "x" }), 4096, 99),
        null,
      );
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      await refused("unplanned-recording");
      // A name that looks like a recording but is not an annex key is not accounted for either.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/objects/not-a-key.bdf`, body("x"));
      await refused("unplanned-recording", { execute: false });
      // A recording whose current entry is a delete marker is still bytes in a locked version:
      // the listing is of versions and markers, so it is seen too (C3).
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      standin.putDeleteMarker(BUCKET, objectPath(late.oldKey));
      expect(standin.current(BUCKET, objectPath(late.oldKey))).toBeUndefined();
      await refused("unplanned-recording");
      // Not a recording: not this check's business.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/objects/SHA256E-s1--${"9".repeat(64)}.json`, body("x"));
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  test(
    "a plan without raw copies ignores annex-uuid and refuses any raw object written since",
    async () => {
      writeProofs();
      // The special remote's marker is in every dataset: never a raw copy, never deleted.
      standin.putObject(
        BUCKET,
        objectPath("annex-uuid"),
        body("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"),
      );
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      // No raw line for a plan that has none.
      expect(ok.stdout).not.toContain("raw copies");
      // A raw text object, and a zero-byte folder key, written after the plan.
      for (const name of ["participants.tsv", "code/"]) {
        standin.restore(snap);
        standin.putObject(BUCKET, objectPath(name), body(name === "code/" ? "" : "x\n"));
        await refused("raw-copy-not-in-plan", { execute: name === "code/" });
      }
      // One that appears while deleting is found by the final listing, and annex-uuid is kept.
      standin.restore(snap);
      standin.putObject(
        BUCKET,
        objectPath("annex-uuid"),
        body("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"),
      );
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, objectPath("late.json"), body("{}"));
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: rawCopies=1 versions=1 markers=0");
      expect(has(dir, "deleted.json")).toBe(false);
      expect(standin.versions(BUCKET, objectPath("annex-uuid")).length).toBe(1);
    },
    SLOW,
  );

  test(
    "refuses a current manifest that names a recording the scrub did not account for",
    async () => {
      writeProofs();
      const late = `SHA256E-s4096--${"7".repeat(64)}.edf`;
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/late.edf": { key: late, size: 4096 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key");
      // A recording kept inline in git, and a recording keyed by another backend.
      standin.restore(snap);
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/inline.edf": { key: `git:${"c".repeat(40)}`, size: 10 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key", { execute: false });
      standin.restore(snap);
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/md5.bdf": { key: "MD5E-s10--abc.bdf", size: 10 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key", { execute: false });
    },
    SLOW,
  );

  test(
    "refuses a plan whose dataset is not a dataset id, before any S3 call",
    async () => {
      writeProofs();
      const plan = readJson<PlanFile>(dir, "plan.json");
      writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ ...plan, dataset: "nm1" }));
      const r = await runScrub(standin, [
        "delete-old",
        "--dir",
        dir,
        "--confirm-dataset",
        "nm1",
        "--public-base",
        pub.url,
      ]);
      expectUsage(r, "bad-dataset-id");
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "the public base must be the plan's bucket on S3 over https, outside a test",
    async () => {
      writeProofs();
      // The variable that admits a loopback server is the tests' alone; unset, it is refused.
      // Through the CLI only hosts no request can reach, so a regression cannot send one to the
      // real bucket; the rest of the rule is checked on the function itself below.
      const outside = { [TEST_LOOPBACK_PUBLIC_BASE_ENV]: "" };
      for (const base of [
        pub.url,
        "https://evil.example",
        "https://nemar.s3.us-east-2.amazonaws.com.evil.example",
      ]) {
        const r = await runScrub(standin, deleteArgs([], base), outside, { anyPublicBase: true });
        expectUsage(r, "bad-public-base", base);
      }
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
      for (const base of [
        "http://nemar.s3.us-east-2.amazonaws.com",
        "https://xnemar.s3.us-east-2.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/other",
        "https://nemar.s3.us-east-2.amazonaws.com:8443",
        "https://nemar.s3.us-east-2.amazonaws.com/?x=1",
        "https://nemar.s3.us-east-2.amazonaws.com/sub",
        "https://user@nemar.s3.us-east-2.amazonaws.com",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).toThrow(StageError);
      }
      // What is accepted, checked without a request to it.
      for (const base of [
        DEFAULT_PUBLIC_BASE,
        `${DEFAULT_PUBLIC_BASE}/`,
        "https://nemar.s3.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/nemar",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).not.toThrow();
      }
      expect(() => checkPublicBase(DEFAULT_PUBLIC_BASE, "other")).toThrow(StageError);
    },
    SLOW,
  );
});
