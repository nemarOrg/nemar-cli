/**
 * A re-pull with its pull request open, built once per suite the way production builds it, for the
 * suites of what follows `pr_open` (epic #1046 phase 6, #1912; ADR 0111): `resume`, the merge gate,
 * `pr-reviews` and the release.
 *
 * Everything NEMAR's is real. The mirror and its upstream are `repull-fixture.ts`'s real git and
 * git-annex repositories, served as bare `file://` origins; the NEMAR API is the REAL datasets,
 * admin and users routers over bun:sqlite with every migration applied (`repull-full-app.ts`),
 * reached through TEST_API_URL; S3 is the scrub's stand-in driven by the REAL `aws` CLI for the
 * copy and by the Worker's own signed requests for the lock; GitHub is the suites' `Bun.serve()`
 * stand-in, with live heads read from the bare origin, a merge that squash-commits onto the origin's
 * `main` the way GitHub does with the message it is sent, and the tag and comparison reads the
 * Worker's release route makes. No mocks. The Worker runs as `production` against stand-ins only,
 * because an `on` dataset is re-pulled only there and its identifier screen is bound to the row;
 * nothing it reaches is a real service.
 *
 * The world is made once (`execute` to `pr_open`, about thirty seconds) and every test starts from a
 * snapshot of it: the origin's and upstream's refs, the bucket, the database, GitHub's pull requests.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../../backend/src/services/token";
import { storeRepullScreenResult } from "../../backend/src/services/upstream-repull-screen";
import type { Bindings } from "../../backend/src/types/bindings";
import { freshDb, realD1 } from "../../backend/test/helpers/d1";
import { makeRepullFullApp } from "../../backend/test/helpers/repull-full-app";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { runCommand } from "../../src/lib/git-annex/run-command";
import { defaultPlanPath, writePlanFile } from "../../src/lib/repull/digest";
import { planRepull } from "../../src/lib/repull/plan";
import { type S3Standin, type Snapshot, startS3Standin } from "../scrub/helpers/s3-standin";
import {
  ADMIN_TOKEN,
  type GitHubStandin,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./github-standin";
import {
  CONCEPT_DOI,
  type FixtureOptions,
  type LatestSnapshotStandin,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  gitIn,
  refsOf,
  startLatestSnapshotStandin,
} from "./repull-fixture";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const REGION = "us-east-2";
export const ADMIN_KEY = "repull-world-admin-key-0123456789abcdef0123456789ab";
/** The administrator the API seeds: their linked GitHub login is the stand-in's ADMIN_TOKEN's. */
export const ADMIN_ID = 2;

export interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

export type RepullDbRow = Record<string, unknown> & {
  id: number;
  status: string;
  counts: string;
  last_error: string | null;
  synth_sha: string;
  synth_tree: string;
  base_sha: string;
  head_sha: string | null;
  gates_sha: string | null;
  pr_number: number | null;
  merge_sha: string | null;
  merge_claim_sha: string | null;
  merge_claimed_at: string | null;
  tag_sha: string | null;
};

export interface RepullWorld {
  fx: RepullFixture;
  gh: GitHubStandin;
  s3: S3Standin;
  openNeuro: LatestSnapshotStandin;
  configDir: string;
  db(): Database;
  /** Every request to the API that is not a GET, `METHOD /path`, in order since the last restore. */
  apiWrites: string[];
  /** Runs before the API handles a request: a test's way to move the world at an exact point. */
  setApiHook(hook: ((req: Request) => Promise<void>) | null): void;
  /** Answers a request itself, ahead of the real routes: a NEMAR API that is down, say. */
  setApiOverride(override: ((req: Request) => Response | null) | null): void;
  /** The Worker's bindings, which a test may override for the rest of the test. */
  workerEnv: Partial<Bindings>;
  /**
   * `bun run src/index.ts admin <args>`, with the world's environment and `extra`, and `input` on
   * stdin when given (closed otherwise).
   */
  cli(args: string[], extra?: Record<string, string | undefined>, input?: string): Promise<Run>;
  /** The re-pull row, as the database holds it. */
  row(): RepullDbRow;
  /** The plan file the world was executed from. */
  plan: string;
  /** Put the world back as it was at `pr_open`. */
  restore(): Promise<void>;
  /**
   * Store the identifier screen's report of `sha` as the workflow's callback would, through the
   * Worker's own store (`storeRepullScreenResult`), on the screen that waits for it.
   */
  reportScreen(sha: string, status?: string): Promise<void>;
  /** Commit one file onto a ref of the bare origin, as another writer's push. */
  commitOnto(ref: string, path: string, content: string, message?: string): Promise<string>;
  /** What the dataset workflow does on a merge to `main`: tag `v<version>` at `main`'s head. */
  tagMain(version: string): Promise<string>;
  /** What the version DOI's callback writes: the version row, with a DOI and its upstream tag. */
  insertVersionRow(version: string): void;
  stop(): void;
}

/** The pull request the world opened, as the GitHub stand-in keys it. */
export function prKey(w: RepullWorld): string {
  return `${w.fx.datasetId}#${w.row().pr_number}`;
}

/**
 * workerd's WebCrypto digests MD5, which the s3-lock route needs for PutObjectRetention's
 * `Content-MD5`; Bun's does not ("Unrecognized algorithm name"). The world runs the Worker's routes
 * in this process, so it gives Bun's `crypto.subtle.digest` that one algorithm, through
 * `node:crypto`, for as long as the world runs: the runtime the Worker has, not a stand-in for any
 * NEMAR code. Every other algorithm is Bun's own.
 */
function withWorkerdMd5(): () => void {
  const subtle = crypto.subtle as { digest: SubtleCrypto["digest"] };
  const real = subtle.digest.bind(crypto.subtle);
  subtle.digest = (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name.toUpperCase() !== "MD5") return real(algorithm, data);
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = createHash("md5").update(bytes).digest();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }) as SubtleCrypto["digest"];
  return () => {
    subtle.digest = real;
  };
}

export async function startRepullWorld(
  opts: { datasetId?: string; fixture?: FixtureOptions } = {},
): Promise<RepullWorld> {
  const restoreDigest = withWorkerdMd5();
  const gh = startGitHubStandin();
  const openNeuro = startLatestSnapshotStandin(TAG_B);
  const s3 = startS3Standin({ region: REGION });
  const handle = makeRepullFullApp();
  const origins = new Map<string, string>();
  let db = freshDb();
  const apiWrites: string[] = [];
  let apiHook: ((req: Request) => Promise<void>) | null = null;
  let apiOverride: ((req: Request) => Response | null) | null = null;
  const workerEnv: Partial<Bindings> = {};
  const configDir = mkdtempSync(join(tmpdir(), "nemar-repull-world-"));

  const rev = async (repo: string, spec: string): Promise<string | null> => {
    const r = await runCommand(["git", "rev-parse", "--verify", "--quiet", spec], { cwd: repo });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };
  gh.liveHeads = true;
  gh.resolveHead = async (dataset, ref) => {
    const origin = origins.get(dataset);
    return origin ? rev(origin, `refs/heads/${ref}`) : null;
  };
  gh.resolveTag = async (dataset, tag) => {
    const origin = origins.get(dataset);
    return origin ? rev(origin, `refs/tags/${tag}^{commit}`) : null;
  };
  gh.compareCommits = async (dataset, base, head) => {
    const origin = origins.get(dataset);
    if (!origin) return null;
    if (base === head) return "identical";
    const isAncestor = async (a: string, b: string) =>
      (await runCommand(["git", "merge-base", "--is-ancestor", a, b], { cwd: origin })).exitCode ===
      0;
    if (await isAncestor(base, head)) return "ahead";
    if (await isAncestor(head, base)) return "behind";
    return "diverged";
  };
  // GitHub's squash merge: one commit on `main` holding the head's tree, with the title and the
  // message the merge was sent (GitHub's own default lists the commits as bullets instead).
  gh.onMerge = async (dataset, number, body) => {
    const origin = origins.get(dataset);
    const p = gh.pulls[`${dataset}#${number}`];
    if (!origin || !p) return null;
    const head = await rev(origin, `refs/heads/${p.headRef}`);
    const main = await rev(origin, "refs/heads/main");
    if (!head || !main) return null;
    const title =
      typeof body.commit_title === "string" ? body.commit_title : `${p.title} (#${number})`;
    const message =
      typeof body.commit_message === "string"
        ? body.commit_message
        : `* ${(await gitIn(origin, ["log", "-1", "--format=%B", head])).trim().replace(/\n/g, "\n  ")}`;
    const r = await runCommand(["git", "commit-tree", `${head}^{tree}`, "-p", main, "-F", "-"], {
      cwd: origin,
      stdin: `${title}\n\n${message}\n`,
      env: {
        GIT_AUTHOR_NAME: "GitHub",
        GIT_AUTHOR_EMAIL: "noreply@github.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      },
    });
    if (r.exitCode !== 0) return null;
    const merge = r.stdout.trim();
    await gitIn(origin, ["update-ref", "refs/heads/main", merge, main]);
    return merge;
  };
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;

  const bindings = (): Bindings =>
    ({
      DB: realD1(db),
      ENVIRONMENT: "production",
      GITHUB_ADMIN_PAT: WORKER_TOKEN,
      API_BASE_URL: "https://api.test.nemar.org",
      PRESCREEN_CALLBACK_SECRET: "repull-world-callback-secret",
      S3_BUCKET: "nemar",
      AWS_REGION: REGION,
      AWS_ACCESS_KEY_ID: "AKIAREPULLWORLD00001",
      AWS_SECRET_ACCESS_KEY: "repull-world-worker-secret",
      S3_ENDPOINT_URL: `${s3.url}/nemar`,
      ...workerEnv,
    }) as Bindings;
  const apiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (req.method !== "GET") apiWrites.push(`${req.method} ${url.pathname}`);
      if (apiHook) await apiHook(req.clone());
      return apiOverride?.(req) ?? handle(req, bindings());
    },
  });
  const apiUrl = `http://127.0.0.1:${apiServer.port}`;
  const awsHome = join(configDir, "aws-home");
  mkdirSync(awsHome, { recursive: true });
  writeFileSync(join(awsHome, "config"), `[profile repull-world]\nregion = ${REGION}\n`);
  writeFileSync(join(awsHome, "credentials"), "");

  const fx = await buildRepullFixture({ ...opts.fixture, datasetId: opts.datasetId, s3 });
  origins.set(fx.datasetId, fx.originRepo);

  const seed = async (d: Database) => {
    d.run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
    );
    d.run(
      `INSERT INTO users (id, username, email, password_hash, github_username, status, role,
                          signup_source, email_verified, service_access)
       VALUES (?, 'repulladmin', 'repulladmin@example.org', 'x', 'queueadmin-gh', 'approved',
               'admin', 'cli', 1, 1)`,
      [ADMIN_ID],
    );
    d.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      ADMIN_ID,
      await hashApiKey(ADMIN_KEY),
      ADMIN_KEY.slice(0, 8),
    );
    d.run(
      `INSERT INTO datasets
         (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo,
          first_published_at, source, source_id, concept_doi, anonymous)
       VALUES (?, 'A sufficiently descriptive fixture title', 1, 'active', 'public', 0, ?,
               '2026-01-01 00:00:00', 'openneuro', ?, ?, 0)`,
      [fx.datasetId, `nemarDatasets/${fx.datasetId}`, UPSTREAM_ID, CONCEPT_DOI],
    );
    d.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
       VALUES (?, '1.0.0', ?, 'ezid', '2026-01-01 00:00:00', ?, 'doi')`,
      [fx.datasetId, `10.82901/nemar.${fx.datasetId}.v1.0.0`, TAG_A],
    );
  };
  await seed(db);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "repulladmin",
      accounts: { repulladmin: { apiKey: ADMIN_KEY } },
    }),
  );

  const childEnv = (extra: Record<string, string | undefined> = {}): Record<string, string> => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...fx.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: apiUrl,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      GH_TOKEN: ADMIN_TOKEN,
      NEMAR_GITHUB_API_URL: gh.url,
      NEMAR_REPULL_OPENNEURO_URL: openNeuro.url,
      NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: s3.url,
      NEMAR_REPULL_POLL_MS: "200",
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000002",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRepullWorld",
      AWS_SESSION_TOKEN: "dummy-session-token-for-repull-world",
      AWS_CONFIG_FILE: join(awsHome, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(awsHome, "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_ENDPOINT_URL_S3: s3.url,
      AWS_PROFILE: "repull-world",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
      ...extra,
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    return clean;
  };
  const cli = async (
    args: string[],
    extra: Record<string, string | undefined> = {},
    input?: string,
  ) => {
    const proc = spawn({
      cmd: ["bun", "run", CLI_ENTRY, "admin", ...args],
      cwd: REPO_ROOT,
      env: childEnv(extra),
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
  };

  // The plan, as `nemar admin repull plan` makes it and writes it.
  const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-world-plan-"));
  let plan: string;
  try {
    const out = await planRepull({
      datasetId: fx.datasetId,
      catalog: {
        dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
        versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
      },
      github: { token: ADMIN_TOKEN, apiBase: gh.url },
      env: fx.env,
      environment: apiUrl,
      workRoot: scratch,
      openNeuroGraphqlUrl: openNeuro.url,
    });
    if (!out.planned) throw new Error(`not planned: ${out.reason}`);
    if (!out.file.executable) throw new Error("the world's plan is not executable");
    plan = defaultPlanPath(configDir, fx.datasetId, TAG_B, out.file.digest);
    writePlanFile(plan, out.file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const run = await cli(["repull", "execute", plan, "--yes"]);
  const opened = db.query("SELECT status FROM upstream_repulls").get() as { status: string } | null;
  if (run.exitCode !== 0 || opened?.status !== "pr_open") {
    throw new Error(`the world did not reach pr_open (exit ${run.exitCode}):\n${run.all}`);
  }

  const saved = {
    origin: await refsOf(fx.originRepo),
    upstream: await refsOf(fx.upstreamRepo),
    s3: s3.snapshot() as Snapshot,
    db: db.serialize(),
    pulls: JSON.stringify(gh.pulls),
  };
  const restoreRefs = async (repo: string, refs: string) => {
    const want = new Map(
      refs
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ") as [string, string]),
    );
    for (const line of (await refsOf(repo)).split("\n").filter(Boolean)) {
      const [name] = line.split(" ");
      if (name && !want.has(name)) await gitIn(repo, ["update-ref", "-d", name]);
    }
    for (const [name, oid] of want) await gitIn(repo, ["update-ref", name, oid]);
  };

  const world: RepullWorld = {
    fx,
    gh,
    s3,
    openNeuro,
    configDir,
    db: () => db,
    apiWrites,
    setApiHook: (h) => {
      apiHook = h;
    },
    setApiOverride: (o) => {
      apiOverride = o;
    },
    workerEnv,
    cli,
    plan,
    row: () =>
      db.query("SELECT * FROM upstream_repulls ORDER BY id DESC LIMIT 1").get() as RepullDbRow,
    async restore() {
      await restoreRefs(fx.originRepo, saved.origin);
      await restoreRefs(fx.upstreamRepo, saved.upstream);
      s3.restore(saved.s3);
      db = Database.deserialize(saved.db);
      gh.reset();
      Object.assign(gh.pulls, JSON.parse(saved.pulls));
      apiWrites.length = 0;
      apiHook = null;
      apiOverride = null;
      for (const k of Object.keys(workerEnv)) delete (workerEnv as Record<string, unknown>)[k];
      for (const purpose of ["resume", "merge"]) {
        rmSync(join(configDir, "repull", fx.datasetId, purpose), { recursive: true, force: true });
      }
    },
    async reportScreen(sha, status = "clean") {
      const waiting = db
        .query(
          "SELECT s.id AS id, s.nonce AS nonce FROM upstream_repull_screens s WHERE s.sha = ? AND s.nonce IS NOT NULL",
        )
        .get(sha) as { id: number; nonce: string } | null;
      if (!waiting) throw new Error(`no screen of ${sha} waits for its report`);
      const report = parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: sha,
        scan: {
          id: fx.datasetId,
          version: null,
          scanned_at: "2026-10-25T12:00:00.000Z",
          manifest_source: "clone",
          status,
          incomplete: false,
          incomplete_reasons: [],
          files: { total: 10, edf_bdf: 2, header_read: 2, header_read_failed: 0 },
        },
      });
      const stored = await storeRepullScreenResult(realD1(db), {
        datasetId: fx.datasetId,
        screenId: waiting.id,
        sha,
        nonce: waiting.nonce,
        body: report,
      });
      if (!stored.stored) throw new Error("the screen's report was not stored");
    },
    async commitOnto(ref, path, content, message = "a later commit") {
      const repo = fx.originRepo;
      const before = (await gitIn(repo, ["rev-parse", ref])).trim();
      const blob = (
        await runCommand(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: content })
      ).stdout.trim();
      const index = mkdtempSync(join(tmpdir(), "nemar-repull-world-index-"));
      const env = { GIT_INDEX_FILE: join(index, "index") };
      try {
        await runCommand(["git", "read-tree", ref], { cwd: repo, env });
        await runCommand(
          ["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
          { cwd: repo, env },
        );
        const tree = (await runCommand(["git", "write-tree"], { cwd: repo, env })).stdout.trim();
        const commit = (
          await runCommand(["git", "commit-tree", tree, "-p", before, "-m", message], {
            cwd: repo,
            env: {
              ...env,
              GIT_AUTHOR_NAME: "t",
              GIT_AUTHOR_EMAIL: "t@t",
              GIT_COMMITTER_NAME: "t",
              GIT_COMMITTER_EMAIL: "t@t",
            },
          })
        ).stdout.trim();
        await gitIn(repo, ["update-ref", ref, commit]);
        return commit;
      } finally {
        rmSync(index, { recursive: true, force: true });
      }
    },
    async tagMain(version) {
      const repo = fx.originRepo;
      await gitIn(repo, ["tag", `v${version}`, "refs/heads/main"]);
      return (await gitIn(repo, ["rev-parse", `refs/tags/v${version}^{commit}`])).trim();
    },
    insertVersionRow(version) {
      db.run(
        `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
         VALUES (?, ?, ?, 'ezid', datetime('now'), ?, 'doi')`,
        [fx.datasetId, version, `10.82901/nemar.${fx.datasetId}.v${version}`, TAG_B],
      );
    },
    stop() {
      restoreDigest();
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      apiServer.stop(true);
      gh.stop();
      openNeuro.stop();
      s3.stop();
      fx.cleanup();
      Bun.spawnSync(["chmod", "-R", "u+w", configDir]);
      rmSync(configDir, { recursive: true, force: true });
    },
  };
  return world;
}

/** `.nemar/metadata.json` at `rev` with one key more, as an enrichment run rewrites it. */
export async function enrichedMetadata(repo: string, rev: string, stamp = "2026-10-25T00:00:00Z") {
  const meta = JSON.parse(await gitIn(repo, ["show", `${rev}:.nemar/metadata.json`]));
  return `${JSON.stringify({ ...meta, enriched_at: stamp }, null, 2)}\n`;
}

/** The plan file's digest. */
export function digestOf(plan: string): string {
  return JSON.parse(readFileSync(plan, "utf8")).digest as string;
}
