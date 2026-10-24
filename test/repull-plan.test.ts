/**
 * `planRepull` (ADR 0111, epic #1046 phase 5, #1911), the entry point `nemar admin repull plan`
 * calls, over a real mirror and its real upstream (`test/helpers/repull-fixture.ts`): git and
 * git-annex repositories built by the real import step and the real publish edits, served as bare
 * `file://` origins with blob filters allowed. The catalog facts (the dataset row, the version rows)
 * are the rows the API would answer; the command that reads them over HTTP is driven against the
 * real routers in `repull-plan-cli.test.ts`.
 *
 * What is pinned: the per-path three-way decisions and N.0.0's targets, each standard edit the
 * planner recognizes and the near misses it must not, the copy manifest (pinned, minus what NEMAR
 * holds and what is dead), the privacy ledger's refusals, the bounded blob fetch, the preflight
 * codes a repository's own state produces, the digest's stability, and that a plan changes nothing
 * anywhere.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSnapshotOf } from "../shared/source-snapshot";
import { buildDoiBadge } from "../shared/standard-edits/readme";
import { PLANNER_VERSION } from "../src/lib/repull/digest";
import { gitBlobOid } from "../src/lib/repull/edits";
import { type PlanOptions, RepullCannotPlan, planRepull } from "../src/lib/repull/plan";
import { listBucketObjects } from "../src/lib/repull/sources";
import { ADMIN_TOKEN, startGitHubStandin } from "./helpers/github-standin";
import {
  CHANGES_SENTENCE,
  CONCEPT_DOI,
  type LatestSnapshotStandin,
  NEMAR_ID,
  PATHS,
  README_B,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  gitIn,
  refsOf,
  startLatestSnapshotStandin,
  writeAnnexBranchFile,
} from "./helpers/repull-fixture";
import { startRenameS3Standin } from "./helpers/s3-rename-standin";
import { toolOrFail } from "./scrub/helpers/require-tools";

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
const DATASET_ROW = { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI };
const CHANGES_B = `${TAG_A} 2026-01-01\n  - Initial snapshot.\n${TAG_B} 2026-06-01\n  - Added sub-03.\n`;

/** OpenNeuro's latest-snapshot answer for every plan in this file: tag B unless a test says otherwise. */
let openNeuro: LatestSnapshotStandin;
beforeAll(() => {
  openNeuro = startLatestSnapshotStandin(TAG_B);
});
afterAll(() => openNeuro?.stop());

function options(fx: RepullFixture, over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    openNeuroGraphqlUrl: openNeuro.url,
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

function refusalCodes(body: Body): string[] {
  return (body.refusals as Array<{ code: string }>).map((r) => r.code).sort();
}

type CopyItem = { key: string; purpose: string; pin: unknown; paths: string[] };

function copyOf(body: Body): {
  items: CopyItem[];
  unpinned: string[];
  dead_recordings: string[];
  destination_prefix: string;
  presence_basis: string;
} {
  return body.copy as ReturnType<typeof copyOf>;
}

/** Every file under a directory with the sha256 of its content, for the "nothing changed" check. */
function contents(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.push(`${full.slice(dir.length)} ${hash}`);
      }
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
    const copied = copyOf(body).items.flatMap((i) => i.paths);
    expect(copied).not.toContain(PATHS.motion);
    expect(copied).not.toContain(PATHS.motionAdded);
    expect((body.local_uploads as Array<{ path: string }>).map((u) => u.path)).toEqual([
      PATHS.motion,
      PATHS.motionAdded,
    ]);
  });

  test("the copy manifest is the pinned new keys, at nemar-s3's prefix", () => {
    const copy = copyOf(body);
    expect(copy.items.map((i) => i.key).sort()).toEqual([fx.keys.addedEdf, fx.keys.setB].sort());
    expect(copy.items.every((i) => i.purpose === "copy")).toBe(true);
    expect(copy.items.find((i) => i.key === fx.keys.setB)?.pin).toEqual({
      bucket: "openneuro.org",
      object: `${UPSTREAM_ID}/${PATHS.set}`,
      version: "VERSIONSETB",
    });
    expect(copy.unpinned).toEqual([]);
    expect(copy.destination_prefix).toBe(`${NEMAR_ID}/objects/`);
    expect(copy.presence_basis).toBe("location-log");
  });

  test("the counts that drive the digest", () => {
    expect(counts(body)).toMatchObject({
      copy_items: 2,
      copy_bytes: 3000 + 4256,
      copy_bytes_unknown: 0,
      local_uploads: 2,
      local_bytes: 36,
      // copy + local uploads + the recordings the scrub may re-key (the added EDF).
      orphan_bytes_max: 3000 + 4256 + 36 + 4256,
      orphan_bytes_unknown: 0,
      data_changing: true,
      metadata_only: false,
      doi_count: 2,
      unchecked: 0,
      fetch_refused: 0,
    });
    expect(body.scrub_forecast).toEqual({
      recordings_to_read: 1,
      json_files_to_read: 2,
      scans_tables_to_read: 0,
      non_sha256e_recordings: 0,
    });
    // The redirect to local remotes is recorded, outside the digest.
    expect(file.sources).toBe("test-bases");
  });

  test("NEMAR's sidecar edit is a correction, replayed as N.0.1", () => {
    const sidecar = row(body, PATHS.sidecar);
    expect(sidecar).toMatchObject({ class: "correction", subtype: "nemar-modified", delta: true });
    expect(body.corrections).toEqual([
      { path: PATHS.description, group: "description", subtype: "per-key" },
      { path: PATHS.sidecar, group: null, subtype: "nemar-modified" },
    ]);
    expect(body.versions).toEqual({ current: "1.0.0", n0: "2.0.0", n1: "2.0.1" });
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
    expect(copyOf(body).items.map((i) => i.key)).not.toContain(fx.keys.flaggedUpstream);
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
    // A key upstream added is taken; a key NEMAR added is a correction for N.0.1, so N.0.0 lacks it.
    expect(d.keys).toEqual([
      expect.objectContaining({ key: "GeneratedBy", class: "take-theirs", take: "theirs" }),
      expect.objectContaining({
        key: "HowToAcknowledge",
        class: "correction",
        subtype: "nemar-added",
      }),
    ]);
    expect(merged.HowToAcknowledge).toBeUndefined();
    expect(counts(body).description_corrections).toBe(1);
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
    expect(counts(body).unexplained).toBe(3);
    expect(body.refusals).toEqual([]);
  });

  test("the NEMAR-owned IsIdenticalTo edit is listed, and lineage does not hold", () => {
    expect(body.nemar_owned_edits).toEqual([
      {
        path: ".nemar/metadata.json",
        edit: "is-identical-to",
        status: "ok",
        from: `10.18112/openneuro.${UPSTREAM_ID}.v${TAG_A}`,
        to: `10.18112/openneuro.${UPSTREAM_ID}.v${TAG_B}`,
        error: null,
      },
    ]);
    expect(body.lineage).toEqual({ holds: false, recordable: false });
  });

  test("a plan changes nothing: refs, file contents, the remote's store and the bucket", async () => {
    const snapshot = async () => ({
      origin: await refsOf(fx.originRepo),
      upstream: await refsOf(fx.upstreamRepo),
      originFiles: contents(fx.originRepo),
      upstreamFiles: contents(fx.upstreamRepo),
      store: contents(fx.store),
      bucket: contents(fx.bucketBase),
    });
    const before = await snapshot();
    await plan(fx, { keepWorkdir: false });
    expect(await snapshot()).toEqual(before);
    // The scratch clones are gone.
    expect(readdirSync(join(fx.root, "work"))).toEqual([]);
  });

  test("the same remotes and the same options give the same digest", async () => {
    const again = await plan(fx, {
      now: new Date("2030-01-01T00:00:00Z"),
      environment: "elsewhere",
    });
    expect(again.digest).toBe(file.digest);
    expect(again.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a bucket listing, when asked for, decides what NEMAR holds instead of the location log", async () => {
    const object = join(fx.bucketBase, NEMAR_ID, "objects", fx.keys.setB);
    try {
      writeFileSync(object, Buffer.alloc(3000));
      const listed = await plan(fx, { presence: "bucket-listing" });
      expect(copyOf(listed.body as Body).presence_basis).toBe("bucket-listing");
      expect(copyOf(listed.body as Body).items.map((i) => i.key)).toEqual([fx.keys.addedEdf]);
      expect(counts(listed.body as Body).copy_already_held).toBe(1);
      // The location log knows nothing of the object, so the same remotes plan the copy.
      const logged = await plan(fx);
      expect(copyOf(logged.body as Body).items).toHaveLength(2);
      // An object at the wrong size is not the key's content.
      writeFileSync(object, Buffer.alloc(10));
      const short = await plan(fx, { presence: "bucket-listing" });
      expect(copyOf(short.body as Body).items).toHaveLength(2);
    } finally {
      rmSync(object, { force: true });
    }
  });

  test("a bucket listing without the prefix's annex-uuid object cannot be told from an empty one", async () => {
    const marker = join(fx.bucketBase, NEMAR_ID, "objects", "annex-uuid");
    const aside = `${marker}.aside`;
    renameSync(marker, aside);
    try {
      const err = await planRepull(options(fx, { presence: "bucket-listing" })).catch((e) => e);
      expect(err).toBeInstanceOf(RepullCannotPlan);
      expect(String(err.message)).toContain("annex-uuid");
    } finally {
      renameSync(aside, marker);
    }
  });

  test("to_tag defaults to OpenNeuro's latest snapshot, and a tag it does not name latest is not proved newer", async () => {
    expect(file.preflight.find((c) => c.name === "to-tag")).toMatchObject({
      status: "ok",
      detail: `${TAG_B} (OpenNeuro's latest)`,
    });
    // The legacy 00001 is on the mirror, and its creation order against 1.0.0 is not OpenNeuro's
    // answer, so the plan is made and is not executable (Phase 4a: order is creation, not number).
    const legacy = await plan(fx, { toTag: "00001" });
    expect(legacy.preflight.find((c) => c.name === "to-tag")).toMatchObject({
      status: "unchecked",
      code: "order-unverified",
    });
    expect(legacy.executable).toBe(false);
  });

  test("with OpenNeuro not answering, nothing is planned without --to-tag, and a flag is unverified", async () => {
    openNeuro.status = 503;
    try {
      const none = await planRepull(options(fx));
      expect(none.planned ? null : none.reason).toBe("latest-unknown");
      const flagged = await plan(fx, { toTag: TAG_B });
      expect(flagged.preflight.find((c) => c.name === "to-tag")).toMatchObject({
        status: "unchecked",
        code: "order-unverified",
      });
    } finally {
      openNeuro.status = null;
    }
  });

  test("OpenNeuro's latest that is not numerically after from_tag is unverified, not ok", async () => {
    // 00001 is on the mirror and numerically equal to the mirrored 1.0.0 without being that tag.
    openNeuro.latest = "00001";
    try {
      const f = await plan(fx);
      expect((f.body.upstream as Body).to_tag).toBe("00001");
      expect(f.preflight.find((c) => c.name === "to-tag")).toMatchObject({
        status: "unchecked",
        code: "order-unverified",
      });
      expect(f.executable).toBe(false);
    } finally {
      openNeuro.latest = TAG_B;
    }
  });

  test("a tag the version rows could not record is refused (Phase 4a's isSourceTag)", async () => {
    const out = await planRepull(options(fx, { toTag: "1.1.0-rc1" }));
    expect(out.planned ? null : out.reason).toBe("to-tag-unrecordable");
  });

  test("from_tag equal to to_tag is nothing to pull", async () => {
    const out = await planRepull(options(fx, { toTag: TAG_A }));
    expect(out.planned).toBe(false);
    if (out.planned) return;
    expect(out.reason).toBe("nothing-to-pull");
  });

  test("a tag that is not an OpenNeuro snapshot tag is malformed, not mirror lag; a v prefix is the same tag", async () => {
    const to = await planRepull(options(fx, { toTag: "1..2" }));
    expect(to.planned ? null : to.reason).toBe("to-tag-malformed");
    const from = await planRepull(options(fx, { fromTag: "a/b" }));
    expect(from.planned ? null : from.reason).toBe("from-tag-malformed");
    // Phase 3's tag rule: `v1.1.0` names the snapshot `1.1.0`, for both flags.
    const v = await plan(fx, { toTag: `v${TAG_B}`, fromTag: `v${TAG_A}` });
    expect(v.body.upstream).toMatchObject({ from_tag: TAG_A, to_tag: TAG_B });
    // Where no tag is recorded, the flag itself is the tag planned from, without its v.
    const unrecorded = await plan(fx, {
      fromTag: `v${TAG_A}`,
      catalog: {
        dataset: DATASET_ROW,
        versions: [{ version: "v1.0.0", source_version: null, source_version_basis: "unknown" }],
      },
    });
    expect(unrecorded.body.upstream).toMatchObject({ from_tag: TAG_A, from_tag_source: "flag" });
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

  test("with no concept DOI in the catalog, no badge is explained and README.md cannot be computed", async () => {
    const f = await plan(fx, {
      catalog: { dataset: { ...DATASET_ROW, concept_doi: null }, versions: ROWS_A },
    });
    const md = row(f.body as Body, "README.md");
    expect(md.explained_by_base).toBeNull();
    expect(md.target).toEqual({ kind: "unknown", reason: "no-concept-doi" });
    expect(refusalCodes(f.body as Body)).toContain("target-unknown");
    // A missing DOI is not a disagreeing one.
    expect(refusalCodes(f.body as Body)).not.toContain("concept-doi-disagrees");
  });

  test("a catalog concept DOI that main's DatasetDOI does not carry refuses", async () => {
    const f = await plan(fx, {
      catalog: {
        dataset: { ...DATASET_ROW, concept_doi: "10.82901/nemar.other" },
        versions: ROWS_A,
      },
    });
    expect(refusalCodes(f.body as Body)).toContain("concept-doi-disagrees");
    // The badge names the description's DOI, not the catalog's, so it is not explained either.
    expect(row(f.body as Body, "README.md").explained_by_base).toBeNull();
  });

  describe("preflight codes the remotes' own state produces", () => {
    test("GitHub not answering leaves release-pr unchecked", async () => {
      const f = await plan(fx, { github: { token: "a-token", apiBase: "http://127.0.0.1:9" } });
      expect(f.preflight.find((c) => c.name === "release-pr")).toMatchObject({
        status: "unchecked",
        code: "github-unreachable",
      });
    });

    test("100 or more open pull requests are too many to say none is a release", async () => {
      const gh = startGitHubStandin();
      try {
        for (let n = 1; n <= 100; n++) gh.pulls[`${NEMAR_ID}#${n}`] = { sha: "a".repeat(40) };
        const f = await plan(fx, { github: { token: ADMIN_TOKEN, apiBase: gh.url } });
        expect(f.preflight.find((c) => c.name === "release-pr")).toMatchObject({
          status: "unchecked",
          code: "too-many-open",
        });
      } finally {
        gh.stop();
      }
    });

    test("a release/vN.0.0 branch on the mirror refuses, before any REST call", async () => {
      const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
      await gitIn(fx.originRepo, ["update-ref", "refs/heads/release/v2.0.0", main]);
      try {
        const f = await plan(fx);
        expect(f.preflight.find((c) => c.name === "release-pr")).toMatchObject({
          status: "refused",
          code: "release-branch-exists",
        });
      } finally {
        await gitIn(fx.originRepo, ["update-ref", "-d", "refs/heads/release/v2.0.0"]);
      }
    });

    test("remote.log naming nemar-s3 twice, or not at all, refuses annex-uuid", async () => {
      const annex = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
      const line = (uuid: string) =>
        `${uuid} bucket=nemar datacenter=us-east-2 fileprefix=${NEMAR_ID}/objects/ name=nemar-s3 type=S3 timestamp=1790000002s\n`;
      try {
        await writeAnnexBranchFile(
          fx.originRepo,
          "remote.log",
          `${line(fx.nemarUuid)}${line("11111111-2222-4333-8444-555555555555")}`,
        );
        const twice = await plan(fx);
        expect(twice.preflight.find((c) => c.name === "annex-uuid")).toMatchObject({
          status: "refused",
          code: "nemar-s3-ambiguous",
        });
        await gitIn(fx.originRepo, ["update-ref", "refs/heads/git-annex", annex]);
        await writeAnnexBranchFile(
          fx.originRepo,
          "remote.log",
          `${fx.nemarUuid} directory=/x name=other-remote type=directory timestamp=1790000002s\n`,
        );
        const none = await plan(fx);
        expect(none.preflight.find((c) => c.name === "annex-uuid")).toMatchObject({
          status: "refused",
          code: "no-nemar-s3-remote",
        });
      } finally {
        await gitIn(fx.originRepo, ["update-ref", "refs/heads/git-annex", annex]);
      }
    });

    test("a marker the bucket refuses to read is unchecked, never a match", async () => {
      const marker = join(fx.bucketBase, NEMAR_ID, "objects", "annex-uuid");
      chmodSync(marker, 0o000);
      try {
        const f = await plan(fx);
        expect(f.preflight.find((c) => c.name === "annex-uuid")).toMatchObject({
          status: "unchecked",
          code: "marker-forbidden",
        });
      } finally {
        chmodSync(marker, 0o644);
      }
    });
  });
});

describe("the privacy ledger (ADR 0085)", () => {
  test("a recorded correction plus a conflicting path refuses, with no override", async () => {
    const fx = await buildRepullFixture({ recordedCorrection: true });
    try {
      const f = await plan(fx);
      expect(refusalCodes(f.body as Body)).toEqual(["ledger-correction-unexplained"]);
      expect(f.executable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("a recorded correction plus one correction and no conflict refuses too; CHANGES keeps its sentence when upstream annexes it", async () => {
    const fx = await buildRepullFixture({
      recordedCorrection: true,
      sidecarEditOnly: true,
      noContributorEdits: true,
      annexedRootMetadata: true,
      changes: "sentence",
    });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      expect(counts(body)).toMatchObject({ conflicts: 0, corrections: 1 });
      expect(refusalCodes(body)).toEqual(["ledger-correction-unexplained"]);
      const changes = row(body, PATHS.changes);
      expect(changes.explained_by_base).toBe("changes-ledger-sentence");
      expect(changes.target).toEqual({
        kind: "unannex",
        key: fx.keys.changesB,
        append: [CHANGES_SENTENCE],
      });
      const item = copyOf(body).items.find((i) => i.key === fx.keys.changesB);
      expect(item).toMatchObject({
        purpose: "unannex",
        pin: { bucket: "openneuro.org", version: "VERSIONCHANGESB" },
      });
      expect(counts(body).unannex_items).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("with nothing unexplained, the ADR 0085 sentence in CHANGES is carried onto upstream's CHANGES", async () => {
    const fx = await buildRepullFixture({
      recordedCorrection: true,
      noContributorEdits: true,
      changes: "sentence",
    });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      expect(body.refusals).toEqual([]);
      const changes = row(body, PATHS.changes);
      expect(changes.explained_by_base).toBe("changes-ledger-sentence");
      expect(changes.target).toMatchObject({
        kind: "git",
        oid: gitBlobOid(Buffer.from(`${CHANGES_B}${CHANGES_SENTENCE}`)),
        computed: "changes-ledger-sentence",
      });
      expect(counts(body).unexplained).toBe(0);
      expect(body.versions).toEqual({ current: "1.0.0", n0: "2.0.0", n1: null });
    } finally {
      fx.cleanup();
    }
  });

  test("a ledger that does not parse, a gitlink, a stale badge and an unparseable .nemar/metadata.json", async () => {
    const fx = await buildRepullFixture({
      corruptLedger: true,
      brokenNemarMetadata: true,
      gitlink: true,
      staleBadge: true,
      noContributorEdits: true,
    });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      expect(refusalCodes(body)).toEqual(["gitlink", "ledger-unreadable"]);
      const ledger = (body.refusals as Array<{ code: string; detail: string }>).find(
        (r) => r.code === "ledger-unreadable",
      );
      // The parser's class, and nothing it quoted from the file.
      expect(ledger?.detail).toContain("SyntaxError");
      expect(JSON.stringify(body)).not.toContain("Jane");
      // A badge naming another DOI than the concept DOI is not NEMAR's edit.
      expect(row(body, "README.md").explained_by_base).toBeNull();
      // A NEMAR-owned file that does not parse is said, with the parser's words, not left null.
      expect(body.nemar_owned_edits).toEqual([
        expect.objectContaining({ status: "unparseable", from: null, error: "SyntaxError" }),
      ]);
      expect(f.executable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe("the enrichment's generated participants.tsv is a standard edit", () => {
  const placeholder = (...subjects: string[]) =>
    `participant_id\tage\tsex\n${subjects.map((s) => `${s}\tn/a\tn/a\n`).join("")}`;

  test("explained from upstream's tree, re-made from tag B's subjects, and no correction for the ledger rule", async () => {
    // A recorded correction makes any unexplained path refuse the plan, so this also shows the
    // generated file is not counted as one.
    const fx = await buildRepullFixture({
      generatedParticipants: true,
      noContributorEdits: true,
      recordedCorrection: true,
    });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      expect(body.planner).toBe(PLANNER_VERSION);
      expect(PLANNER_VERSION).toBe(2);
      const p = row(body, PATHS.participants);
      expect(p).toMatchObject({
        class: "take-theirs",
        explained_by_base: "participants-generated",
        explained_by_theirs: null,
        decision: "theirs",
        delta: true,
      });
      expect(p.target).toEqual({
        kind: "git",
        mode: "100644",
        oid: gitBlobOid(Buffer.from(placeholder("sub-01", "sub-02", "sub-03"))),
        computed: "participants-generated",
      });
      expect(counts(body).unexplained).toBe(0);
      expect(body.refusals).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("with the same subjects at both tags, NEMAR's file is kept as it is", async () => {
    const fx = await buildRepullFixture({
      generatedParticipants: true,
      noContributorEdits: true,
      metadataOnlyB: true,
    });
    try {
      const p = row((await plan(fx)).body as Body, PATHS.participants);
      expect(p).toMatchObject({
        class: "keep-ours",
        explained_by_base: "participants-generated",
        explained_by_theirs: "participants-generated",
        decision: "ours",
        delta: false,
        deleted: false,
      });
    } finally {
      fx.cleanup();
    }
  });

  test("a placeholder edited afterwards is NEMAR's own addition, a correction", async () => {
    const fx = await buildRepullFixture({
      generatedParticipants: "edited",
      noContributorEdits: true,
    });
    try {
      const p = row((await plan(fx)).body as Body, PATHS.participants);
      expect(p).toMatchObject({
        class: "correction",
        subtype: "nemar-added",
        explained_by_base: null,
        explained_by_theirs: null,
        deleted: true,
      });
      expect(p.target).toEqual({ kind: "absent" });
    } finally {
      fx.cleanup();
    }
  });
});

describe("the import's in-place edits are explained, and their near misses are not", () => {
  test("a scrubbed git-held recording, a blanked sidecar, a scans table, the provenance pair and .bidsignore", async () => {
    const fx = await buildRepullFixture({
      privacyEdits: true,
      noContributorEdits: true,
      changes: "not-at-end",
    });
    try {
      const body = (await plan(fx)).body as Body;
      expect(row(body, PATHS.gitHeldEdf).explained_by_base).toBe("scrubbed-git-held");
      expect(row(body, PATHS.blankedJson).explained_by_base).toBe("json-blanked");
      expect(row(body, PATHS.scans).explained_by_base).toBe("scans-dates");
      expect(row(body, PATHS.provenance).explained_by_base).toBe("provenance-note");
      expect(row(body, PATHS.provenanceReadme).explained_by_base).toBe("provenance-readme-note");
      expect(row(body, ".bidsignore").explained_by_base).toBe("bidsignore-entry");
      for (const p of [PATHS.gitHeldEdf, PATHS.blankedJson, PATHS.scans, PATHS.provenance]) {
        expect(row(body, p).class).toBe("keep-ours");
      }
      // The ADR 0085 sentence with text after it is not the rewrite's append.
      expect(row(body, PATHS.changes)).toMatchObject({
        explained_by_base: null,
        class: "conflict",
      });
    } finally {
      fx.cleanup();
    }
  });

  test("a forged sentence and a re-keyed recording of another size are unexplained; a key the location log holds is not copied", async () => {
    const fx = await buildRepullFixture({
      changes: "forged",
      wrongSizeScrubbedKey: true,
      heldSetB: true,
      noContributorEdits: true,
    });
    try {
      const body = (await plan(fx)).body as Body;
      expect(row(body, PATHS.changes)).toMatchObject({
        explained_by_base: null,
        class: "conflict",
      });
      // The upstream key is dead, but NEMAR's key is not the same size, so it is not a scrub.
      expect(row(body, PATHS.flaggedEdf)).toMatchObject({
        explained_by_base: null,
        class: "correction",
        subtype: "nemar-modified",
      });
      // NEMAR's location log records tag B's .set at nemar-s3, so nothing copies it.
      expect(copyOf(body).items.map((i) => i.key)).toEqual([fx.keys.addedEdf]);
      expect(counts(body).copy_already_held).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("root metadata upstream annexed is explained when NEMAR holds its bytes in git", async () => {
    const fx = await buildRepullFixture({ annexedRootMetadata: true, noContributorEdits: true });
    try {
      const body = (await plan(fx)).body as Body;
      expect(row(body, PATHS.changes).explained_by_base).toBe("root-metadata-unannexed");
      expect(row(body, PATHS.changes).target).toEqual({ kind: "unannex", key: fx.keys.changesB });
      // The README family: upstream's annexed README, un-annexed, renamed and badged.
      expect(row(body, "README.md")).toMatchObject({
        explained_by_base: "readme-badge",
        class: "keep-ours",
      });
      expect(copyOf(body).items.find((i) => i.key === fx.keys.changesB)?.purpose).toBe("unannex");
    } finally {
      fx.cleanup();
    }
  });
});

describe("the README family and the conflict and correction subtypes", () => {
  test("every subtype, and a README NEMAR edited that upstream changed", async () => {
    const fx = await buildRepullFixture({
      subtypes: true,
      readmeEdit: true,
      noContributorEdits: true,
    });
    try {
      const body = (await plan(fx)).body as Body;
      expect(row(body, PATHS.deletedSidecar)).toMatchObject({
        class: "conflict",
        subtype: "upstream-deleted/nemar-changed",
      });
      expect(row(body, PATHS.channels)).toMatchObject({
        class: "conflict",
        subtype: "nemar-deleted/upstream-changed",
      });
      expect(row(body, PATHS.bothAdded)).toMatchObject({
        class: "conflict",
        subtype: "both-added",
      });
      expect(row(body, PATHS.nemarAdded)).toMatchObject({
        class: "correction",
        subtype: "nemar-added",
        deleted: true,
      });
      expect(row(body, PATHS.sidecar)).toMatchObject({
        class: "correction",
        subtype: "nemar-deleted",
        delta: true,
      });
      expect(row(body, "README.md")).toMatchObject({
        group: "readme",
        class: "conflict",
        subtype: "both-modified",
      });
    } finally {
      fx.cleanup();
    }
  });

  test("an upstream README.md under the legacy Zenodo badge is explained, and N.0.0 gets today's badge", async () => {
    const fx = await buildRepullFixture({
      readme: "md",
      legacyBadge: true,
      noContributorEdits: true,
    });
    try {
      const md = row((await plan(fx)).body as Body, "README.md");
      expect(md).toMatchObject({ explained_by_base: "readme-badge", class: "take-theirs" });
      expect(md.target).toMatchObject({
        kind: "git",
        oid: gitBlobOid(Buffer.from(`${buildDoiBadge(CONCEPT_DOI)}\n\n${README_B}`)),
      });
    } finally {
      fx.cleanup();
    }
  });

  test("no README upstream: the import's stub under a badge is explained, and a metadata-only pull says so", async () => {
    const fx = await buildRepullFixture({
      readme: "none",
      metadataOnlyB: true,
      noContributorEdits: true,
    });
    try {
      const body = (await plan(fx)).body as Body;
      const md = row(body, "README.md");
      expect(md).toMatchObject({ explained_by_base: "readme-badge", class: "keep-ours" });
      expect(counts(body)).toMatchObject({
        copy_items: 0,
        local_uploads: 0,
        data_changing: false,
        metadata_only: true,
        doi_count: 1,
        orphan_bytes_max: 0,
      });
    } finally {
      fx.cleanup();
    }
  });
});

describe("dead keys", () => {
  test("N.0.0 never copies a dead key: a recording is left for the scrub to re-key, anything else refuses", async () => {
    const fx = await buildRepullFixture({ deadKeys: true, noContributorEdits: true });
    try {
      const f = await plan(fx);
      const body = f.body as Body;
      const copy = copyOf(body);
      expect(row(body, PATHS.movedEdf).target).toEqual({
        kind: "annex",
        key: fx.keys.flaggedUpstream,
      });
      expect(copy.dead_recordings).toEqual([fx.keys.flaggedUpstream]);
      expect(row(body, PATHS.copiedSet).target).toEqual({ kind: "annex", key: fx.keys.setA });
      expect(copy.items.map((i) => i.key)).not.toContain(fx.keys.setA);
      expect(copy.items.map((i) => i.key)).not.toContain(fx.keys.flaggedUpstream);
      expect(refusalCodes(body)).toEqual(["target-names-dead-key"]);
      // The scrubbed recording's old path: upstream moved it, and NEMAR's re-keyed copy goes.
      expect(row(body, PATHS.flaggedEdf)).toMatchObject({
        explained_by_base: "scrubbed-key",
        class: "take-theirs",
        deleted: true,
      });
      expect(f.executable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe("pins", () => {
  test("a copy key pinned only on another bucket is unpinned, and makes the plan not executable", async () => {
    const fx = await buildRepullFixture({ unpinnedSet: true });
    // Every preflight check answers ok (the open pull requests come from the stand-in), so the
    // unpinned key is the only thing that keeps this plan from being executable.
    const gh = startGitHubStandin();
    try {
      const f = await plan(fx, { github: { token: ADMIN_TOKEN, apiBase: gh.url } });
      expect(f.preflight.every((c) => c.status === "ok")).toBe(true);
      expect(f.body.refusals).toEqual([]);
      const copy = copyOf(f.body as Body);
      expect(copy.unpinned).toEqual([fx.keys.setB]);
      expect(copy.items.find((i) => i.key === fx.keys.setB)?.pin).toBeNull();
      expect(counts(f.body as Body).copy_unpinned).toBe(1);
      expect(f.executable).toBe(false);
    } finally {
      gh.stop();
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

  test("lineage holds when every path is explained from base, and is never recordable from --from-tag", async () => {
    const recorded = await plan(fx);
    expect(recorded.body.lineage).toEqual({ holds: true, recordable: true });
    const flagged = await plan(fx, {
      fromTag: TAG_A,
      catalog: {
        dataset: DATASET_ROW,
        versions: [{ version: "v1.0.0", source_version: null, source_version_basis: "unknown" }],
      },
    });
    expect(flagged.body.lineage).toEqual({ holds: true, recordable: false });
  });

  test("within the bound, the 1.1 MiB git blob is fetched and NEMAR's annexed copy is explained", async () => {
    const f = await plan(fx);
    expect(row(f.body as Body, PATHS.motion).explained_by_base).toBe("annexed-from-git");
    expect(counts(f.body as Body).fetched_bytes as number).toBeGreaterThan(1024 * 1024);
    // Upstream's changed blob was fetched for the check, so its size is known.
    expect(counts(f.body as Body)).toMatchObject({
      local_bytes_unknown: 0,
      orphan_bytes_unknown: 0,
    });
  });

  test("past the bound the path is unchecked, never a conflict, and the plan refuses", async () => {
    const f = await plan(fx, { maxFetchBytes: 1024 * 1024 });
    const body = f.body as Body;
    expect(row(body, PATHS.motion)).toMatchObject({
      explained_by_base: null,
      class: "unchecked",
      subtype: "fetch-bound",
    });
    // Neither 1.1 MiB blob was read, so the local upload's size is unknown, and never zero.
    expect(counts(body)).toMatchObject({
      fetched_bytes: 0,
      conflicts: 0,
      unchecked: 1,
      // An unchecked path could hide a reverted correction as well as a conflict could.
      unexplained: 1,
      local_bytes_unknown: 1,
      orphan_bytes_unknown: 1,
    });
    expect(counts(body).fetch_refused as number).toBeGreaterThan(0);
    expect(refusalCodes(body)).toEqual(["fetch-bound"]);
    expect(f.executable).toBe(false);
  });
});

describe("the bucket listing runs the real aws CLI against an S3 stand-in", () => {
  const awsTest = toolOrFail("aws", Bun.which("aws") !== null) ? test : test.skip;

  async function listWith(objects: Array<[string, number]>) {
    const s3 = startRenameS3Standin();
    const home = mkdtempSync(join(tmpdir(), "nemar-repull-aws-home-"));
    try {
      const meta = { etag: '"e"', lastModified: "2026-10-01T00:00:00.000Z" };
      for (const [key, size] of objects) s3.putObject("nemar", key, { size, ...meta });
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
      }).catch((e: Error) => e);
      return { listing, ops: s3.log.map((e) => e.op) };
    } finally {
      s3.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }

  awsTest("lists the objects under nemar-s3's prefix with their sizes", async () => {
    const { listing, ops } = await listWith([
      [`${NEMAR_ID}/objects/SHA256E-s5--abc.edf`, 5],
      [`${NEMAR_ID}/objects/annex-uuid`, 36],
      ["on099998/objects/SHA256E-s7--def.edf", 7],
    ]);
    expect(listing instanceof Map ? [...listing].sort() : listing).toEqual([
      ["SHA256E-s5--abc.edf", 5],
      ["annex-uuid", 36],
    ]);
    expect(ops).toEqual(["ListObjectsV2"]);
  });

  awsTest("a listing without the prefix's annex-uuid object throws", async () => {
    const { listing } = await listWith([[`${NEMAR_ID}/objects/SHA256E-s5--abc.edf`, 5]]);
    expect(listing).toBeInstanceOf(Error);
    expect(String((listing as Error).message)).toContain("annex-uuid");
  });
});
