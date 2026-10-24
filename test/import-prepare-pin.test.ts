/**
 * `prepareImport` itself, end to end, pinned to a tag and guarded against a moved upstream (epic
 * #1046 Phase 3, ADR 0111 decision 10): the wiring the unit tests of its pieces cannot see, the
 * tag, the release state and the source id handed to the guard, and when the entry is recorded.
 *
 * Each run is a child process, because prepare ends a refusal with `process.exit`. Nothing it
 * touches is remote:
 *   - the OpenNeuro mirror and the dataset's origin are local repositories, reached by git's own
 *     `url.<base>.insteadOf` rewrite of the two GitHub URLs prepare builds, so no production code
 *     path is replaced and nothing can reach GitHub (the dataset id, ds999990, names no real
 *     dataset, and the token is not one);
 *   - the backend is a local server answering the two routes prepare calls (the import create,
 *     409 for a dataset that exists, and the version list), through the CLI's own API client and a
 *     scratch config;
 *   - OpenNeuro's GraphQL is a local server that names a newer latest tag than the one imported,
 *     the condition the warning is for.
 * `skipData` keeps S3 out: the guard, the clone and the entry are all before or beside the data.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceSnapshotOf } from "../shared/source-snapshot";
import { pushToGitHub } from "../src/lib/git-annex/clone-push";
import {
  cloneOpenNeuroAtTag,
  hasSourceEntryFor,
  shouldRecordSourceEntry,
  sourceDatasetEntry,
} from "../src/lib/import-openneuro";
import { makeScratch, run } from "./helpers/annex-repo";
import { buildTaggedUpstream } from "./helpers/tagged-upstream";

const DS = "ds999990";
const NEMAR_ID = "on999990";
const scratch = makeScratch("import-prepare-pin");

let backend: ReturnType<typeof Bun.serve>;
let graphql: ReturnType<typeof Bun.serve>;
/** What the version list answers for the dataset: released when it holds a version. */
let versions: unknown[] = [];

beforeAll(() => {
  backend = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/admin/datasets/import") {
        return Response.json({ error: `Dataset ${NEMAR_ID} already exists` }, { status: 409 });
      }
      if (req.method === "GET" && path === `/datasets/${NEMAR_ID}/versions`) {
        return Response.json({ dataset_id: NEMAR_ID, current_version: "1.0.0", versions });
      }
      return Response.json({ error: "Dataset not found" }, { status: 404 });
    },
  });
  graphql = Bun.serve({
    port: 0,
    fetch: () => Response.json({ data: { dataset: { latestSnapshot: { tag: "1.0.2" } } } }),
  });
}, 30_000);

afterAll(() => {
  backend.stop(true);
  graphql.stop(true);
  scratch.cleanup();
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run(["git", ...args], dir);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let n = 0;

/**
 * One world per scenario: OpenNeuro's mirror of DS (tags 1.0.0 and 1.0.1, HEAD past both) and the
 * dataset's bare origin after a first import at 1.0.0, whose description carries `sourceDatasets`.
 */
async function world(sourceDatasets: unknown[] | undefined): Promise<{
  root: string;
  bare: string;
  tip: string;
}> {
  n += 1;
  const root = join(scratch.root, `world-${n}`);
  mkdirSync(join(root, "openneuro"), { recursive: true });
  mkdirSync(join(root, "datasets"), { recursive: true });
  const upstream = join(root, "openneuro", `${DS}.git`);
  await buildTaggedUpstream(root, { id: DS, dir: upstream });

  const unavailable = {
    graphqlUrl: "http://127.0.0.1:9/crn/graphql",
    attempts: 1,
    retryDelayMs: 1,
  };
  const first = join(root, "first");
  await cloneOpenNeuroAtTag(DS, first, { tag: "1.0.0", repoUrl: upstream, lookup: unavailable });
  await git(first, "config", "user.email", "test@test.com");
  await git(first, "config", "user.name", "Test");
  const descPath = join(first, "dataset_description.json");
  const desc = JSON.parse(readFileSync(descPath, "utf8"));
  desc.Version = "1.0.0";
  if (sourceDatasets !== undefined) desc.SourceDatasets = sourceDatasets;
  writeFileSync(descPath, `${JSON.stringify(desc, null, 2)}\n`);
  mkdirSync(join(first, ".nemar"), { recursive: true });
  writeFileSync(join(first, ".nemar", "metadata.json"), '{"version":"2.0"}\n');
  await git(first, "add", "dataset_description.json", ".nemar/metadata.json");
  await git(first, "commit", "-q", "-m", `Add NEMAR metadata (imported from OpenNeuro ${DS})`);
  const bare = join(root, "datasets", `${NEMAR_ID}.git`);
  mkdirSync(bare, { recursive: true });
  await git(bare, "init", "-q", "--bare", "-b", "main");
  await git(first, "remote", "remove", "origin");
  await git(first, "remote", "add", "origin", bare);
  const pushed = await pushToGitHub(first, "origin");
  if (!pushed.success) throw new Error(`first push: ${pushed.error}`);
  return { root, bare, tip: await git(bare, "rev-parse", "main") };
}

/** Run `prepareImport(DS, { tag, ... })` in a child against `root`'s world; its exit and output. */
async function prepare(
  root: string,
  tag: string,
  options: { workDir?: boolean } = {},
): Promise<{ code: number; log: string; lastFailure: string }> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      activeAccount: "prepare-pin",
      accounts: {
        "prepare-pin": { apiKey: "unused-key", apiUrl: `http://127.0.0.1:${backend.port}` },
      },
    }),
  );
  const workDir = options.workDir === false ? undefined : join(root, "work");
  const script = join(root, "prepare.ts");
  writeFileSync(
    script,
    [
      `import { prepareImport } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-openneuro.ts"))};`,
      `await prepareImport(${JSON.stringify(DS)}, ${JSON.stringify({
        tag,
        ...(workDir ? { workDir } : {}),
        skipData: true,
        persistStaging: false,
        openNeuroLookup: {
          graphqlUrl: `http://127.0.0.1:${graphql.port}/crn/graphql`,
          attempts: 1,
          retryDelayMs: 1,
        },
      })});`,
    ].join("\n"),
  );
  const child = Bun.spawn(["bun", script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      NEMAR_CONFIG_DIR: home,
      // configureGitHubRemote takes the HTTPS form with a token; this one is not a token, and
      // the rewrite below means it is never sent anywhere.
      GH_TOKEN: "not-a-real-token",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${join(root, "openneuro")}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/OpenNeuroDatasets/",
      GIT_CONFIG_KEY_1: `url.${join(root, "datasets")}/.insteadOf`,
      GIT_CONFIG_VALUE_1: "https://github.com/nemarDatasets/",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const log = out + err;
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const failures = log.split("\n").filter((l) => l.includes("✖"));
  const lastFailure = (failures.at(-1) ?? "").replace(ansi, "").replace("✖", "").trim();
  return { code: await child.exited, log, lastFailure };
}

const RECORDED_1_0_0 = [sourceDatasetEntry(DS, "1.0.0")];

describe("shouldRecordSourceEntry", () => {
  test("the entry is recorded when the tree is the pinned tag's, never after a hard reset", () => {
    expect(shouldRecordSourceEntry({ kind: "none" })).toBe(true);
    expect(shouldRecordSourceEntry({ kind: "retarget" })).toBe(true);
    expect(shouldRecordSourceEntry({ kind: "hard-reset" })).toBe(false);
  });
});

describe("prepareImport at a tag against a dataset that already exists", () => {
  test("released, recorded at 1.0.0, imported at 1.0.1: refused, nothing pushed, its work dir removed", async () => {
    versions = [{ version: "v1.0.0", doi: "10.5072/FK2X", provider: "ezid", created_at: "x" }];
    const { root, bare, tip } = await world(RECORDED_1_0_0);
    const r = await prepare(root, "1.0.1", { workDir: false });
    expect(r.code).toBe(1);
    expect(
      r.lastFailure.startsWith(`[openneuro-upstream-moved] ${DS}: ${NEMAR_ID} has released`),
    ).toBe(true);
    expect(r.lastFailure.endsWith(`nemar admin import-openneuro ${DS} --tag 1.0.0`)).toBe(true);
    expect(await git(bare, "rev-parse", "main")).toBe(tip);
    // The work directory prepare made for itself does not outlive the refusal.
    const made = /Working directory: (\S+)/.exec(r.log)?.[1];
    expect(made).toBeTruthy();
    expect(existsSync(made as string)).toBe(false);
  }, 120_000);

  test("unreleased, recorded at 1.0.0, imported at 1.0.1: retargeted, and 1.0.1 recorded", async () => {
    versions = [];
    const { root, bare, tip } = await world(RECORDED_1_0_0);
    const r = await prepare(root, "1.0.1");
    expect({ code: r.code, lastFailure: r.lastFailure }).toEqual({ code: 0, lastFailure: "" });
    const newTip = await git(bare, "rev-parse", "main");
    expect(newTip).not.toBe(tip);
    expect((await run(["git", "merge-base", "--is-ancestor", tip, newTip], bare)).exitCode).toBe(0);
    const desc = JSON.parse(await git(bare, "show", "main:dataset_description.json"));
    expect(sourceSnapshotOf(desc, DS).source_version).toBe("1.0.1");
    // README renamed to README.md by Step 6, content untouched.
    expect(await git(bare, "show", "main:README.md")).toBe("README at 1.0.1");
    // The tag imported is not OpenNeuro's latest, and the run says so.
    expect(r.log).toContain("importing 1.0.1, but OpenNeuro's latest is 1.0.2");
  }, 120_000);

  test("released, recorded at the tag imported: the same-version reset, no refusal", async () => {
    versions = [{ version: "v1.0.0", doi: "10.5072/FK2X", provider: "ezid", created_at: "x" }];
    const { root, bare } = await world(RECORDED_1_0_0);
    const r = await prepare(root, "1.0.0");
    expect({ code: r.code, lastFailure: r.lastFailure }).toEqual({ code: 0, lastFailure: "" });
    const desc = JSON.parse(await git(bare, "show", "main:dataset_description.json"));
    expect(sourceSnapshotOf(desc, DS).source_version).toBe("1.0.0");
  }, 120_000);

  test("origin records no tag: the hard reset records none either, and says the guard is inert", async () => {
    versions = [{ version: "v1.0.0", doi: "10.5072/FK2X", provider: "ezid", created_at: "x" }];
    const { root, bare } = await world(undefined);
    const r = await prepare(root, "1.0.1");
    expect({ code: r.code, lastFailure: r.lastFailure }).toEqual({ code: 0, lastFailure: "" });
    const desc = JSON.parse(await git(bare, "show", "main:dataset_description.json"));
    expect(hasSourceEntryFor(desc, DS)).toBe(false);
    expect(r.log).toContain(`${NEMAR_ID}'s main records no upstream tag for ${DS}`);
  }, 120_000);
});
