/**
 * The finalize publish gate (`src/lib/import-finalize-gate.ts`), extracted from `finalizeImport` so
 * an upstream re-pull's register step (ADR 0111) runs the same three steps.
 *
 * Real throughout: the tree is a real git-annex repository (three sized keys and one `URL--` key
 * that declares no size), the remote is git-annex's `directory` remote, and the listing the gate
 * compares the tree with is read from the S3 stand-in by the real `aws` through
 * `listExistingObjects`, the call finalize makes. The texts are pinned word for word, because the
 * Worker classifies them and files the import-failure tracker from them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import {
  IMPORT_DATA_UNAVAILABLE_MARKER_FOR_CLASSIFY,
  classifyImportFailure,
} from "../backend/src/services/import-failure-cause";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import {
  DATA_AVAILABILITY_MARKER,
  registerTreeKeys,
  treeGate,
  verifyManifestObjects,
} from "../src/lib/import-finalize-gate";
import { DATA_AVAILABILITY_MARKER as REEXPORTED } from "../src/lib/import-openneuro";
import {
  type ImportManifest,
  type ImportManifestItem,
  listExistingObjects,
} from "../src/lib/s3-server-copy";
import { initDirectoryRemote, makeScratch, run } from "./helpers/annex-repo";
import { useTestGitIdentity } from "./helpers/git-identity";
import { toolOrFail } from "./scrub/helpers/require-tools";
import { type S3Standin, startS3Standin } from "./scrub/helpers/s3-standin";

const ID = "on099999";
const BUCKET = "nemar";
const REGION = "us-east-2";
const PREFIX = `${ID}/objects/`;
const URL_KEY = "URL--https&c%%example.com%x.bin";

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const scratch = makeScratch("finalize-gate");
let restoreIdentity: () => void;
let standin: S3Standin;
let awsEnv: Record<string, string>;
let repo: string;
let uuid: string;
let keys: { a: string; b: string; c: string };
let treeKeys: Set<string>;

async function ok(cmd: string[], cwd: string, stdin?: string): Promise<string> {
  const r = await run(cmd, cwd, stdin === undefined ? {} : { stdin });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** The listing finalize reads, with the stand-in as the endpoint and nothing of the host's AWS setup. */
async function listing(): Promise<Map<string, number>> {
  const saved = Object.keys(awsEnv).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, awsEnv);
  try {
    return await listExistingObjects(BUCKET, PREFIX, REGION);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

function put(key: string, bytes: number): void {
  standin.putObject(BUCKET, `${PREFIX}${key}`, new Uint8Array(bytes));
}

const item = (key: string, origin?: "local"): ImportManifestItem => ({
  key,
  sourceUrl: null,
  source: null,
  destUri: `s3://${BUCKET}/${PREFIX}${key}`,
  ...(origin ? { origin } : {}),
});

describe.skipIf(!awsInstalled)("the finalize publish gate", () => {
  beforeAll(async () => {
    restoreIdentity = useTestGitIdentity();
    standin = startS3Standin({ region: REGION });
    const home = join(scratch.root, "aws-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config"), "[profile finalize-gate-test]\nregion = us-east-2\n");
    writeFileSync(join(home, "credentials"), "");
    awsEnv = {
      HOME: home,
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForFinalizeGateTest",
      AWS_CONFIG_FILE: join(home, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_ENDPOINT_URL_S3: standin.url,
      AWS_PROFILE: "finalize-gate-test",
    };

    repo = join(scratch.root, ID);
    mkdirSync(repo, { recursive: true });
    await ok(["git", "init", "-q", "-b", "main"], repo);
    await ok(["git", "annex", "init", "-q", "finalize-gate"], repo);
    for (const [path, size] of [
      ["sub-01/eeg/a.edf", 100],
      ["sub-01/eeg/b.edf", 200],
      ["sub-01/eeg/c.set", 300],
    ] as const) {
      mkdirSync(join(repo, "sub-01/eeg"), { recursive: true });
      writeFileSync(join(repo, path), Buffer.alloc(size, path.length + size));
    }
    await ok(["git", "-c", "annex.largefiles=anything", "annex", "add", "-q", "."], repo);
    await ok(["git", "annex", "fromkey", "--force", URL_KEY, "web/x.bin"], repo);
    await ok(["git", "commit", "-qm", "tree"], repo);
    await initDirectoryRemote(scratch.root, repo, "nemar-s3");
    uuid = (await ok(["git", "config", "remote.nemar-s3.annex-uuid"], repo)).trim();
    const byPath = await listAnnexedKeys(repo);
    keys = {
      a: byPath.get("sub-01/eeg/a.edf") as string,
      b: byPath.get("sub-01/eeg/b.edf") as string,
      c: byPath.get("sub-01/eeg/c.set") as string,
    };
    treeKeys = new Set(byPath.values());
  }, 120_000);

  afterAll(() => {
    standin?.stop();
    restoreIdentity?.();
    scratch.cleanup();
  });

  test("the marker finalize prints is the gate's, and the Worker's copy agrees", () => {
    expect(REEXPORTED).toBe(DATA_AVAILABILITY_MARKER);
    expect(IMPORT_DATA_UNAVAILABLE_MARKER_FOR_CLASSIFY).toBe(DATA_AVAILABILITY_MARKER);
  });

  test("a missing object and one of the wrong size are both missing, with the remedy split by origin", async () => {
    put(keys.a, 100);
    put(keys.b, 10);
    const existing = await listing();
    const verified = verifyManifestObjects(
      [item(keys.a), item(keys.b), item(keys.c, "local")],
      existing,
    );
    expect(verified.missing.map((m) => m.key)).toEqual([keys.b, keys.c]);
    expect(verified.missingUpstream).toBe(1);
    expect(verified.missingLocal).toBe(1);
    expect(verified.message).toBe(
      "2 of 3 objects missing or wrong size at the destination. 1 copied from upstream: re-run the copy phase (a shard likely failed or was cancelled); 1 uploaded by prepare from the clone: re-run PREPARE, not copy -- the copy phase skips these keys by design and their content exists only in a clone.",
    );
    expect(verifyManifestObjects([item(keys.a)], existing).message).toBeNull();
  }, 60_000);

  test("a tree key with no object refuses with the availability figure the Worker classifies", async () => {
    put(keys.a, 100);
    put(keys.b, 10);
    put(URL_KEY, 7);
    const existing = await listing();
    const gate = treeGate(treeKeys, existing, { bucket: BUCKET, datasetId: ID, manifestItems: 2 });
    if (gate.ok) throw new Error("the gate passed a tree with keys the bucket cannot back");
    expect([...gate.unbacked].sort()).toEqual([keys.b, keys.c].sort());
    expect(gate.available).toBe(0.5);
    expect(gate.message).toBe(
      [
        "[nemar-data-unavailable] 50.0% of data keys available.",
        `2 of 4 annexed key(s) in the tree have no object in s3://nemar/${ID}/objects/`,
        `(e.g. ${gate.unbacked.slice(0, 3).join(", ")}).`,
        "That is 50.0% of its data available, below the 90% a listed dataset must reach (ADR 0064).",
        "The manifest accounted for 2.",
        "Refusing to register: those keys would be advertised as NEMAR content that no clone can fetch.",
        "Re-run the copy phase, or prepare if the content exists only in a clone.",
        "If the copy phase cannot get them, check whether OpenNeuro still serves them before assuming a NEMAR bug:",
        `\`nemar admin fleet content-recovery ${ID}\` reports, per key, whether any recorded source is readable.`,
      ].join(" "),
    );
    expect(classifyImportFailure({ stage: "finalize", lastError: gate.message }).cause).toBe(
      "data_unavailable",
    );
  }, 60_000);

  test("a backed tree passes, and a key that declares no size is said, not folded in", async () => {
    put(keys.a, 100);
    put(keys.b, 200);
    put(keys.c, 300);
    put(URL_KEY, 7);
    const gate = treeGate(treeKeys, await listing(), {
      bucket: BUCKET,
      datasetId: ID,
      manifestItems: 3,
    });
    expect(gate).toEqual({
      ok: true,
      unsized: [URL_KEY],
      message:
        "Every one of 4 annexed key(s) has an object; 1 declare no size and were checked by name only",
    });
  }, 60_000);

  test("registration is proven from the location log, and a key it will not record refuses", async () => {
    const registered = await registerTreeKeys(repo, [...treeKeys], uuid);
    expect(registered).toEqual({
      ok: true,
      registered: 4,
      message: "Registered 4 files in git-annex",
    });
    for (const key of treeKeys) {
      expect(await ok(["git", "annex", "whereis", "--key", key], repo)).toContain(uuid);
    }
    const refused = await registerTreeKeys(repo, [keys.a, "not-a-valid-key"], uuid);
    expect(refused).toEqual({
      ok: false,
      message:
        "1 of 2 git-annex key registrations are not in the location log (e.g. not-a-valid-key). Aborting before publish — those blobs would be unfindable for clones. Re-run finalize to retry.",
    });
  }, 120_000);
});

/**
 * `finalizeImport` itself, so the gate is proven wired in, not only correct on its own. It runs in
 * a child process because finalize ends a failure with `process.exit(1)`.
 *
 * Nothing reaches GitHub, AWS or an API: the child's git config rewrites
 * `https://github.com/nemarDatasets/` to a local bare origin (GIT_CONFIG_GLOBAL, no system
 * config), its GitHub token is a dummy, its AWS endpoint is the S3 stand-in, and its API URL is a
 * closed port. `nemar-s3` is an S3 remote record in the origin's git-annex branch, which
 * `enableremote` sets up without a request.
 */
describe.skipIf(!awsInstalled)("finalizeImport stops at the gate", () => {
  const FINAL_ID = "on099998";
  const S3_PREFIX = `${FINAL_ID}/objects/`;
  let root: { root: string; cleanup: () => void };
  let restore: () => void;
  let stand: S3Standin;
  let childEnv: Record<string, string>;
  let origin: string;
  let backed: string;
  let unbacked: string;
  let remoteUuid: string;

  beforeAll(async () => {
    restore = useTestGitIdentity();
    root = makeScratch("finalize-wiring");
    stand = startS3Standin({ region: REGION });
    const home = join(root.root, "aws-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config"), "[profile finalize-wiring]\nregion = us-east-2\n");
    writeFileSync(join(home, "credentials"), "");
    const origins = join(root.root, "origins");
    mkdirSync(origins, { recursive: true });
    const gitconfig = join(root.root, "gitconfig");
    writeFileSync(
      gitconfig,
      `[url "file://${origins}/"]\n\tinsteadOf = https://github.com/nemarDatasets/\n[init]\n\tdefaultBranch = main\n`,
    );

    // The dataset as prepare and copy left it: two annexed keys, nemar-s3 recorded in the branch.
    const work = join(root.root, "work");
    mkdirSync(join(work, "sub-01", "eeg"), { recursive: true });
    await ok(["git", "init", "-q", "-b", "main"], work);
    await ok(["git", "annex", "init", "-q", "prepare"], work);
    writeFileSync(join(work, "dataset_description.json"), '{"Name": "gate wiring"}\n');
    writeFileSync(join(work, "sub-01/eeg/backed.edf"), Buffer.alloc(150, 1));
    writeFileSync(join(work, "sub-01/eeg/unbacked.edf"), Buffer.alloc(250, 2));
    await ok(["git", "-c", "annex.largefiles=include=*.edf", "annex", "add", "-q", "."], work);
    await ok(["git", "commit", "-qm", "prepared"], work);
    const keys = await listAnnexedKeys(work);
    backed = keys.get("sub-01/eeg/backed.edf") as string;
    unbacked = keys.get("sub-01/eeg/unbacked.edf") as string;
    remoteUuid = crypto.randomUUID();
    const blob = (
      await ok(
        ["git", "hash-object", "-w", "--stdin"],
        work,
        `${remoteUuid} bucket=nemar datacenter=us-east-2 encryption=none fileprefix=${S3_PREFIX} name=nemar-s3 type=S3 timestamp=1790000000s\n`,
      )
    ).trim();
    const index = join(root.root, "annex-index");
    const env = { GIT_INDEX_FILE: index };
    const inIndex = async (cmd: string[], stdin?: string) => {
      const r = await run(cmd, work, stdin === undefined ? { env } : { env, stdin });
      if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await inIndex(["git", "read-tree", "refs/heads/git-annex"]);
    await inIndex(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},remote.log`]);
    const tree = await inIndex(["git", "write-tree"]);
    const commit = await inIndex([
      "git",
      "commit-tree",
      tree,
      "-p",
      "refs/heads/git-annex",
      "-m",
      "nemar-s3",
    ]);
    await ok(["git", "update-ref", "refs/heads/git-annex", commit], work);
    origin = join(origins, `${FINAL_ID}.git`);
    await ok(["git", "init", "-q", "--bare", "-b", "main", origin], root.root);
    await ok(["git", "push", "-q", origin, "main", "git-annex"], work);

    // The copy landed one key; the other never reached the bucket.
    stand.putObject("nemar", `${S3_PREFIX}${backed}`, new Uint8Array(150));

    childEnv = {
      HOME: home,
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForFinalizeWiring",
      AWS_CONFIG_FILE: join(home, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_ENDPOINT_URL_S3: stand.url,
      AWS_PROFILE: "finalize-wiring",
      GH_TOKEN: "dummy-token-for-a-local-origin",
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: "1",
      NEMAR_CONFIG_DIR: join(root.root, "nemar-config"),
      TEST_API_URL: "http://127.0.0.1:9",
    };
  }, 120_000);

  afterAll(() => {
    stand?.stop();
    restore?.();
    root?.cleanup();
  });

  test("a tree key with no object exits 1 with the availability line, and nothing is registered", async () => {
    const before = await ok(["git", "rev-parse", "refs/heads/git-annex"], origin);
    const manifest: ImportManifest = {
      openneuroId: "ds099998",
      nemarId: FINAL_ID,
      nemarUuid: remoteUuid,
      items: [item(backed)].map((it) => ({ ...it, destUri: `s3://nemar/${S3_PREFIX}${backed}` })),
    };
    const script = join(root.root, "finalize.ts");
    writeFileSync(
      script,
      [
        `import { finalizeImport } from ${JSON.stringify(join(import.meta.dir, "../src/lib/import-openneuro.ts"))};`,
        'await finalizeImport("ds099998", { workDir: process.env.FINALIZE_WORKDIR }, JSON.parse(process.env.FINALIZE_MANIFEST));',
        'console.log("FINALIZE-RETURNED");',
        "",
      ].join("\n"),
    );
    const workDir = join(root.root, "finalize-work");
    mkdirSync(workDir, { recursive: true });
    const child = Bun.spawn(["bun", "run", script], {
      env: {
        ...process.env,
        ...childEnv,
        FINALIZE_WORKDIR: workDir,
        FINALIZE_MANIFEST: JSON.stringify(manifest),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const all = `${out}\n${err}`;
    expect(code, all).toBe(1);
    expect(all).toContain(
      `${DATA_AVAILABILITY_MARKER} 50.0% of data keys available. 1 of 2 annexed key(s) in the tree have no object in s3://nemar/${S3_PREFIX} (e.g. ${unbacked}).`,
    );
    expect(all).not.toContain("Registered");
    expect(all).not.toContain("FINALIZE-RETURNED");
    // The origin's git-annex branch was not pushed: no key was advertised.
    expect(await ok(["git", "rev-parse", "refs/heads/git-annex"], origin)).toBe(before);
  }, 180_000);
});
