/**
 * `planRepull` (ADR 0111, epic #1046 phase 5, #1911), the entry point `nemar admin repull plan`
 * calls, over a real mirror and its real upstream (`test/helpers/repull-fixture.ts`): git and
 * git-annex repositories built by the real import step and the real publish edits, served as bare
 * `file://` origins with blob filters allowed. The catalog facts (the dataset row, the version rows)
 * are the rows the API would answer; the command that reads them over HTTP is driven against the
 * real routers in `repull-plan-cli.test.ts`.
 *
 * What is pinned: the per-path three-way decisions and N.0.0's targets, the copy manifest (pinned,
 * minus what NEMAR holds and what is dead), the privacy ledger's refusal, the bounded blob fetch,
 * the digest's stability, and that a plan changes nothing anywhere.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSnapshotOf } from "../shared/source-snapshot";
import { buildDoiBadge } from "../shared/standard-edits/readme";
import { gitBlobOid } from "../src/lib/repull/edits";
import { listBucketObjects } from "../src/lib/repull/sources";
import { type PlanOptions, planRepull } from "../src/lib/repull/plan";
import { startRenameS3Standin } from "./helpers/s3-rename-standin";
import {
  CHANGES_SENTENCE,
  CONCEPT_DOI,
  NEMAR_ID,
  PATHS,
  README_B,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  refsOf,
} from "./helpers/repull-fixture";

setDefaultTimeout(240_000);

type Body = Record<string, unknown>;
type PathRow = {
  path: string;
  class: string;
  subtype: string | null;
  decision: string;
  target: Record<string, unknown>;
  delta: boolean;
  deleted: boolean;
  explained_by_base: string | null;
  explained_by_theirs: string | null;
};

const ROWS_A = [{ version: "v1.0.0", source_version: TAG_A, source_version_basis: "doi" }];
const DATASET_ROW = { source: "openneuro", source_id: UPSTREAM_ID };

function options(fx: RepullFixture, over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    datasetId: NEMAR_ID,
    catalog: { dataset: DATASET_ROW, versions: ROWS_A },
    github: { token: null, apiBase: "http://127.0.0.1:9" },
    env: fx.env,
    environment: "test",
    workRoot: join(fx.root, "work"),
    ...over,
  };
}

async function plan(fx: RepullFixture, over: Partial<PlanOptions> = {}) {
  mkdirSync(join(fx.root, "work"), { recursive: true });
  const out = await planRepull(options(fx, over));
  if (!out.planned) throw new Error(`not planned: ${out.reason}`);
  return out.file;
}

function rowsOf(body: Body): Map<string, PathRow> {
  return new Map((body.paths as PathRow[]).map((p) => [p.path, p]));
}

function row(body: Body, path: string): PathRow {
  const r = rowsOf(body).get(path);
  if (!r) throw new Error(`no plan row for ${path}`);
  return r;
}

function counts(body: Body): Record<string, unknown> {
  return body.counts as Record<string, unknown>;
}

/** Every file under a directory with its size, for the "nothing changed" check. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${full.slice(dir.length)} ${st.size}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("a plan from tag A to tag B over an imported mirror", () => {
  let fx: RepullFixture;
  let body: Body;
  let file: Awaited<ReturnType<typeof plan>>;
  beforeAll(async () => {
    fx = await buildRepullFixture();
    file = await plan(fx);
    body = file.body as Body;
  });
  afterAll(() => fx?.cleanup());

  test("decides add, modify, delete, rename, an MD5E re-key and a mode change as upstream's", () => {
    const add = row(body, PATHS.addedEdf);
    expect(add).toMatchObject({ class: "take-theirs", decision: "theirs", delta: true });
    expect(add.target).toEqual({ kind: "annex", key: fx.keys.addedEdf });
    expect(row(body, PATHS.channels)).toMatchObject({ class: "take-theirs", delta: true });
    expect(row(body, PATHS.deletedSidecar)).toMatchObject({ deleted: true, delta: false });
    expect(row(body, PATHS.deletedSidecar).target).toEqual({ kind: "absent" });
    expect(body.renames).toEqual([{ from: PATHS.events, to: PATHS.eventsRenamed }]);
    const set = row(body, PATHS.set);
    expect(set.target).toEqual({ kind: "annex", key: fx.keys.setB });
    expect(fx.keys.setB.startsWith("MD5E-")).toBe(true);
    const mode = row(body, PATHS.script);
    expect(mode).toMatchObject({ class: "take-theirs", delta: true });
    expect(mode.target).toMatchObject({ kind: "git", mode: "100755" });
    expect(counts(body)).toMatchObject({ renamed: 1, deleted: 1, added: 2 });
  });

  test("a git-held motion recording becomes annex-from-git and is never copied", () => {
    const motion = row(body, PATHS.motion);
    expect(motion.target).toMatchObject({ kind: "annex-from-git" });
    expect(row(body, PATHS.motionAdded).target).toMatchObject({ kind: "annex-from-git" });
    const copied = (body.copy as { items: Array<{ paths: string[] }> }).items.flatMap(
      (i) => i.paths,
    );
    expect(copied).not.toContain(PATHS.motion);
    expect(copied).not.toContain(PATHS.motionAdded);
    expect((body.local_uploads as Array<{ path: string }>).map((u) => u.path)).toEqual([
      PATHS.motion,
      PATHS.motionAdded,
    ]);
  });

  test("the copy manifest is the pinned new keys, at nemar-s3's prefix", () => {
    const copy = body.copy as {
      items: Array<{
        key: string;
        pin: { bucket: string; object: string; version: string } | null;
      }>;
      unpinned: string[];
      destination_prefix: string;
      presence_basis: string;
    };
    expect(copy.items.map((i) => i.key).sort()).toEqual([fx.keys.addedEdf, fx.keys.setB].sort());
    expect(copy.items.find((i) => i.key === fx.keys.setB)?.pin).toEqual({
      bucket: "openneuro.org",
      object: `${UPSTREAM_ID}/${PATHS.set}`,
      version: "VERSIONSETB",
    });
    expect(copy.unpinned).toEqual([]);
    expect(copy.destination_prefix).toBe(`${NEMAR_ID}/objects/`);
    expect(copy.presence_basis).toBe("location-log");
  });

  test("NEMAR's sidecar edit is a correction, replayed as N.0.1", () => {
    const sidecar = row(body, PATHS.sidecar);
    expect(sidecar).toMatchObject({ class: "correction", subtype: "nemar-modified", delta: true });
    expect(body.corrections).toEqual([
      { path: PATHS.sidecar, group: null, subtype: "nemar-modified" },
    ]);
    expect(body.versions).toEqual({ current: "1.0.0", n0: "2.0.0", n1: "2.0.1" });
    expect(counts(body).doi_count).toBe(2);
  });

  test("a path both sides changed is a conflict, and N.0.0 takes upstream's", () => {
    const p = row(body, PATHS.participants);
    expect(p).toMatchObject({ class: "conflict", subtype: "both-modified", decision: "theirs" });
    expect(body.conflicts).toEqual([
      { path: PATHS.participants, group: null, subtype: "both-modified" },
    ]);
  });

  test("the scrubbed recording is explained by its dead mark and is not copied", () => {
    expect(fx.keys.flaggedNemar).not.toBe(fx.keys.flaggedUpstream);
    const edf = row(body, PATHS.flaggedEdf);
    expect(edf).toMatchObject({
      explained_by_base: "scrubbed-key",
      class: "keep-ours",
      delta: false,
    });
    const keys = (body.copy as { items: Array<{ key: string }> }).items.map((i) => i.key);
    expect(keys).not.toContain(fx.keys.flaggedUpstream);
  });

  test("the motion recording NEMAR annexed is explained because its key hashes upstream's blob", () => {
    expect(row(body, PATHS.motion).explained_by_base).toBe("annexed-from-git");
    expect(row(body, ".gitattributes").explained_by_base).toBe("gitattributes-stripped");
    expect(row(body, ".bidsignore").explained_by_base).toBe("bidsignore-entry");
  });

  test("the description merges key by key, and N.0.0's own SourceDatasets entry names to_tag", () => {
    const d = body.description as {
      status: string;
      merged_json: string;
      keys: Array<{ key: string; class: string }>;
    };
    expect(d.status).toBe("merged");
    const merged = JSON.parse(d.merged_json);
    expect(merged.GeneratedBy).toEqual([{ Name: "fixture-pipeline" }]);
    expect(merged.DatasetDOI).toBe(CONCEPT_DOI);
    expect(merged.Version).toBe("2.0.0");
    expect(merged.Name).toBe("Repull fixture");
    expect(sourceSnapshotOf(merged, UPSTREAM_ID)).toEqual({
      source_version: TAG_B,
      source_version_basis: "doi",
    });
    expect(d.keys).toEqual([expect.objectContaining({ key: "GeneratedBy", class: "take-theirs" })]);
    expect(row(body, PATHS.description).target).toEqual({ kind: "description" });
  });

  test("upstream's changed README becomes README.md under NEMAR's badge", () => {
    const md = row(body, "README.md");
    expect(md).toMatchObject({
      class: "take-theirs",
      delta: true,
      explained_by_base: "readme-badge",
    });
    expect(md.target).toMatchObject({
      kind: "git",
      oid: gitBlobOid(Buffer.from(`${buildDoiBadge(CONCEPT_DOI)}\n\n${README_B}`)),
    });
    // The bare README is renamed again, so N.0.0 holds no README besides README.md.
    expect(rowsOf(body).get("README")?.target ?? { kind: "absent" }).toEqual({ kind: "absent" });
  });

  test("a ledger with only the import's own line does not refuse a plan with unexplained paths", () => {
    expect(body.ledger).toEqual({ status: "ok", lines: 1, recorded_corrections: 0 });
    expect(counts(body).unexplained).toBe(2);
    expect(body.refusals).toEqual([]);
  });

  test("the NEMAR-owned IsIdenticalTo edit is listed, and lineage does not hold", () => {
    expect(body.nemar_owned_edits).toEqual([
      {
        path: ".nemar/metadata.json",
        edit: "is-identical-to",
        from: `10.18112/openneuro.${UPSTREAM_ID}.v${TAG_A}`,
        to: `10.18112/openneuro.${UPSTREAM_ID}.v${TAG_B}`,
      },
    ]);
    expect(body.lineage).toEqual({ holds: false, recordable: false });
  });

  test("a plan changes nothing: refs, files, the remote's store and the bucket stay as they were", async () => {
    const before = {
      origin: await refsOf(fx.originRepo),
      upstream: await refsOf(fx.upstreamRepo),
      originFiles: listing(fx.originRepo),
      upstreamFiles: listing(fx.upstreamRepo),
      store: listing(fx.store),
      bucket: listing(fx.bucketBase),
    };
    await plan(fx, { keepWorkdir: false });
    expect({
      origin: await refsOf(fx.originRepo),
      upstream: await refsOf(fx.upstreamRepo),
      originFiles: listing(fx.originRepo),
      upstreamFiles: listing(fx.upstreamRepo),
      store: listing(fx.store),
      bucket: listing(fx.bucketBase),
    }).toEqual(before);
    // The scratch clones are gone.
    expect(readdirSync(join(fx.root, "work"))).toEqual([]);
  });

  test("the same inputs give the same digest", async () => {
    const again = await plan(fx, {
      now: new Date("2030-01-01T00:00:00Z"),
      environment: "elsewhere",
    });
    expect(again.digest).toBe(file.digest);
    expect(again.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a bucket listing, when asked for, decides what NEMAR holds instead of the location log", async () => {
    const dir = join(fx.bucketBase, NEMAR_ID, "objects");
    const object = join(dir, fx.keys.setB);
    try {
      writeFileSync(object, Buffer.alloc(3000));
      const listed = await plan(fx, { presence: "bucket-listing" });
      const copy = listed.body.copy as { items: Array<{ key: string }>; presence_basis: string };
      expect(copy.presence_basis).toBe("bucket-listing");
      expect(copy.items.map((i) => i.key)).toEqual([fx.keys.addedEdf]);
      expect(counts(listed.body as Body).copy_already_held).toBe(1);
      // An object at the wrong size is not the key's content.
      writeFileSync(object, Buffer.alloc(10));
      const short = await plan(fx, { presence: "bucket-listing" });
      expect((short.body.copy as { items: unknown[] }).items).toHaveLength(2);
      // The location log knows nothing of either object.
      expect((body.copy as { items: unknown[] }).items).toHaveLength(2);
    } finally {
      rmSync(object, { force: true });
    }
  });

  test("from_tag equal to to_tag is nothing to pull", async () => {
    const out = await planRepull(options(fx, { toTag: TAG_A }));
    expect(out.planned).toBe(false);
    if (out.planned) return;
    expect(out.reason).toBe("nothing-to-pull");
  });

  test("without version rows, from_tag comes from the tagged description and the version check is unchecked", async () => {
    const f = await plan(fx, { catalog: { dataset: DATASET_ROW, versions: null } });
    expect((f.body.upstream as Body).from_tag).toBe(TAG_A);
    expect((f.body.upstream as Body).from_tag_source).toBe("tagged-description");
    expect(f.preflight.find((c) => c.name === "version")?.status).toBe("unchecked");
    expect(f.executable).toBe(false);
  });

  test("--from-tag on a mirror recorded unknown gives a dry run only, never recordable as lineage", async () => {
    const f = await plan(fx, {
      fromTag: TAG_A,
      catalog: {
        dataset: DATASET_ROW,
        versions: [{ version: "v1.0.0", source_version: null, source_version_basis: "unknown" }],
      },
    });
    expect(f.preflight.find((c) => c.name === "from-tag")).toMatchObject({
      status: "refused",
      code: "from-tag-not-recorded",
    });
    expect(f.executable).toBe(false);
    expect((f.body.lineage as Body).recordable).toBe(false);
  });
});

describe("the privacy ledger (ADR 0085)", () => {
  test("a recorded correction plus an unexplained path refuses, with no override", async () => {
    const fx = await buildRepullFixture({ recordedCorrection: true });
    try {
      const f = await plan(fx);
      expect(f.body.refusals).toEqual([
        expect.objectContaining({ code: "ledger-correction-unexplained" }),
      ]);
      expect(f.executable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("with nothing unexplained, the ADR 0085 sentence in CHANGES is carried onto upstream's CHANGES", async () => {
    const fx = await buildRepullFixture({
      recordedCorrection: true,
      noContributorEdits: true,
      changesSentence: true,
    });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      expect(body.refusals).toEqual([]);
      const changes = row(body, PATHS.changes);
      expect(changes.explained_by_base).toBe("changes-ledger-sentence");
      const theirs = `${TAG_A} 2026-01-01\n  - Initial snapshot.\n${TAG_B} 2026-06-01\n  - Added sub-03.\n`;
      expect(changes.target).toMatchObject({
        kind: "git",
        oid: gitBlobOid(Buffer.from(`${theirs}${CHANGES_SENTENCE}`)),
        computed: "changes-ledger-sentence",
      });
      expect(counts(body).unexplained).toBe(0);
      expect(body.versions).toEqual({ current: "1.0.0", n0: "2.0.0", n1: null });
    } finally {
      fx.cleanup();
    }
  });
});

describe("pins", () => {
  test("a copy key with no version pin makes the plan not executable", async () => {
    const fx = await buildRepullFixture({ unpinnedSet: true });
    try {
      const f = await plan(fx);
      const copy = f.body.copy as {
        unpinned: string[];
        items: Array<{ key: string; pin: unknown }>;
      };
      expect(copy.unpinned).toEqual([fx.keys.setB]);
      expect(copy.items.find((i) => i.key === fx.keys.setB)?.pin).toBeNull();
      expect(counts(f.body as Body).copy_unpinned).toBe(1);
      expect(f.executable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe("large blobs are fetched under the bound", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({ bigMotion: true, noContributorEdits: true });
  });
  afterAll(() => fx?.cleanup());

  test("within the bound, the 1.1 MiB git blob is fetched and NEMAR's annexed copy is explained", async () => {
    const f = await plan(fx);
    expect(row(f.body as Body, PATHS.motion).explained_by_base).toBe("annexed-from-git");
    expect(counts(f.body as Body).fetched_bytes as number).toBeGreaterThan(1024 * 1024);
  });

  test("past the bound it is not fetched, and the path counts as unexplained", async () => {
    const f = await plan(fx, { maxFetchBytes: 1024 * 1024 });
    const motion = row(f.body as Body, PATHS.motion);
    expect(motion.explained_by_base).toBeNull();
    expect(motion.class).toBe("conflict");
    expect(counts(f.body as Body)).toMatchObject({ fetched_bytes: 0 });
    expect(counts(f.body as Body).fetch_refused as number).toBeGreaterThan(0);
  });
});

describe("the bucket listing runs the real aws CLI against an S3 stand-in", () => {
  const awsTest = Bun.which("aws") !== null ? test : test.skip;
  awsTest("lists the objects under nemar-s3's prefix with their sizes", async () => {
    const s3 = startRenameS3Standin();
    const home = mkdtempSync(join(tmpdir(), "nemar-repull-aws-home-"));
    try {
      const meta = { etag: '"e"', lastModified: "2026-10-01T00:00:00.000Z" };
      s3.putObject("nemar", `${NEMAR_ID}/objects/SHA256E-s5--abc.edf`, { size: 5, ...meta });
      s3.putObject("nemar", `${NEMAR_ID}/objects/annex-uuid`, { size: 36, ...meta });
      s3.putObject("nemar", "on099998/objects/SHA256E-s7--def.edf", { size: 7, ...meta });
      const listing = await listBucketObjects({
        bucket: "nemar",
        region: "us-east-2",
        prefix: `${NEMAR_ID}/objects/`,
        env: {
          HOME: home,
          AWS_ACCESS_KEY_ID: "ASIAIOSFODNN7EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "dummy-secret-key",
          AWS_SESSION_TOKEN: "dummy-session-token",
          AWS_ENDPOINT_URL_S3: s3.s3Url,
          AWS_EC2_METADATA_DISABLED: "true",
        },
      });
      expect([...listing].sort()).toEqual([
        ["SHA256E-s5--abc.edf", 5],
        ["annex-uuid", 36],
      ]);
      expect(s3.log.map((e) => e.op)).toEqual(["ListObjectsV2"]);
    } finally {
      s3.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
