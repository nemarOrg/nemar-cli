/**
 * The fleet annex-policy backfill, against real repositories (#1374, ADR 0060).
 *
 * Two bare origins stand in for imported datasets: one shaped like the ordinary
 * case (upstream's `.gitattributes`, every recording already annexed, no policy in
 * the git-annex branch) and one that also keeps a recording in git. A local HTTP
 * server answers the three GitHub reads the scan makes -- tree, blob, and
 * `config.log` on the git-annex branch -- by running git against those origins, so
 * the scan parses real tree modes, real sizes and a real git-annex log rather than
 * a hand-written fixture, and the verification after a push reads the pushed state
 * back the same way.
 *
 * Nothing here reaches github.com, S3 or the NEMAR API: the backfill's ordinary
 * path moves no data and needs no credentials, which is the property that makes a
 * 600-repository sweep something other than a 600-repository upload.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyAnnexPolicyToDataset,
  createGitHubReader,
  labelAnnexPolicyState,
  scanDatasetAnnexPolicy,
  sweepAnnexPolicy,
  verifyAnnexPolicyLanded,
} from "../src/lib/fleet-annex-policy";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { buildLargefilesExpression } from "../src/lib/git-annex/policy";
import { runCommand } from "../src/lib/git-annex/run-command";

/** What every OpenNeuro clone ships, and what the import preserved (#1374). */
const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=largerthan=1mb
dataset_description.json annex.largefiles=nothing
`;

const BIG_MOTION = "sub-01/motion/sub-01_task-long_tracksys-imu_motion.tsv";
const SMALL_MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
const CHANNELS = "sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv";

/** The dataset with nothing left in git: the ordinary fleet case. */
const POLICY_ONLY = "on999901";
/** The dataset that also kept a recording in git: needs the S3 leg, not this. */
const WITH_DATA = "on999902";

let root: string;
let workRoot: string;
let origins: Map<string, string>;
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl: string;
const scratch: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

/**
 * git-annex leaves its object files and their directories read-only, which a plain
 * recursive delete cannot enter, so make the tree writable first.
 */
function removeTree(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

/**
 * Build a bare origin shaped like an imported dataset.
 *
 * `withGitResidentMotion` is the difference between the two populations #1374 has
 * to tell apart: upstream annexes on size alone, so a recording under its ~1 MB bar
 * stays a plain git blob and NEMAR's policy says it should not have.
 */
async function buildOrigin(
  datasetId: string,
  options: { withGitResidentMotion: boolean },
): Promise<string> {
  const source = join(root, `source-${datasetId}`);
  const bare = join(root, `${datasetId}.git`);
  mkdirSync(source, { recursive: true });

  await run(["git", "init", "-q", "--initial-branch", "main", "."], source);
  writeFileSync(join(source, ".gitattributes"), UPSTREAM_GITATTRIBUTES);
  writeFileSync(join(source, "dataset_description.json"), '{"Name":"fleet fixture"}');
  const files: Array<[string, number]> = [
    [BIG_MOTION, 1_500_000],
    [CHANNELS, 200_000],
  ];
  if (options.withGitResidentMotion) files.push([SMALL_MOTION, 300_000]);
  for (const [path, size] of files) {
    const abs = join(source, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(size));
  }
  await run(["git", "annex", "init", "--quiet", "upstream"], source);
  const added = await gitAnnexAdd(source, [
    ".gitattributes",
    "dataset_description.json",
    ...files.map(([path]) => path),
  ]);
  if (!added.success) throw new Error(`gitAnnexAdd: ${added.error}`);
  await run(["git", "commit", "-qm", "imported dataset"], source);
  await run(["git", "tag", "v1.0.0"], source);

  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", bare], root);
  await run(["git", "remote", "add", "origin", bare], source);
  await run(["git", "push", "-q", "--all", "origin"], source);
  await run(["git", "push", "-q", "--tags", "origin"], source);
  return bare;
}

/**
 * The three GitHub reads the scan makes, answered by running git against the real
 * origin. An adapter over real data, not a fabricated response: modes, sizes and
 * blob contents are whatever git says they are.
 */
/**
 * How many more reads of the git-annex config should answer as if the push had not
 * landed yet. GitHub is eventually consistent after a push, and that is the whole
 * reason `verifyAnnexPolicyLanded` retries; without a way to produce a stale read
 * the retry cannot be tested, and the test that named it passed with the loop
 * deleted.
 */
/**
 * What origin actually carries: `main`'s commit, and whether NEMAR's expression is
 * configured on the git-annex branch.
 *
 * Deliberately NOT the git-annex branch's SHA. git-annex pushes its own bookkeeping
 * to a remote it can write to, and these fixtures use a local path as origin, so
 * that ref moves for reasons that have nothing to do with the policy -- on the CI
 * runner, though not on every developer machine. `main` and the configuration are
 * what a dataset is actually judged by.
 */
async function originPolicyState(
  origin: string,
): Promise<{ main: string; configured: boolean; attributes: string }> {
  const main = (await run(["git", "rev-parse", "main"], origin)).trim();
  const config = await runCommand(["git", "show", "git-annex:config.log"], { cwd: origin });
  const attributes = await runCommand(["git", "show", "main:.gitattributes"], { cwd: origin });
  return {
    main,
    configured: config.exitCode === 0 && config.stdout.includes("_motion.tsv"),
    attributes: attributes.exitCode === 0 ? attributes.stdout : "",
  };
}

let staleConfigReads = 0;

/**
 * Paths the tree listing should pretend not to see.
 *
 * GitHub truncates a tree past about 65,000 entries, and an unlocked annexed file
 * is a plain blob, so the scan can genuinely miss git-resident data that the clone
 * then finds. That disagreement is the guard which stops an unrequested S3 upload,
 * and it is unreachable from a fixture where the tree tells the truth.
 */
let hiddenTreePaths = new Set<string>();

function serveGitHub(): { server: ReturnType<typeof Bun.serve>; baseUrl: string } {
  const started = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      // repos/nemarDatasets/<id>/...
      if (parts[0] !== "repos" || parts[1] !== "nemarDatasets") {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      const datasetId = parts[2];
      const bare = origins.get(datasetId);
      if (!bare) return new Response('{"message":"Not Found"}', { status: 404 });

      if (parts[3] === "git" && parts[4] === "trees") {
        const branch = parts[5];
        const listed = await runCommand(["git", "ls-tree", "-r", "-l", branch], { cwd: bare });
        if (listed.exitCode !== 0) {
          return new Response('{"message":"Not Found"}', { status: 404 });
        }
        const tree = listed.stdout
          .split("\n")
          .filter(Boolean)
          .filter((line) => !hiddenTreePaths.has(line.split("\t")[1]))
          .map((line) => {
            const [meta, path] = line.split("\t");
            const [mode, type, sha, size] = meta.split(/\s+/);
            return {
              path,
              mode,
              type,
              sha,
              ...(size === "-" ? {} : { size: Number(size) }),
            };
          });
        return Response.json({ sha: "fixture", tree, truncated: false });
      }

      if (parts[3] === "git" && parts[4] === "blobs") {
        const sha = parts[5];
        const shown = await runCommand(["git", "cat-file", "blob", sha], { cwd: bare });
        if (shown.exitCode !== 0) {
          return new Response('{"message":"Not Found"}', { status: 404 });
        }
        return Response.json({
          sha,
          encoding: "base64",
          content: Buffer.from(shown.stdout, "utf8").toString("base64"),
        });
      }

      if (parts[3] === "contents") {
        const path = parts.slice(4).join("/");
        const ref = url.searchParams.get("ref") ?? "main";
        if (staleConfigReads > 0 && path.endsWith("config.log")) {
          staleConfigReads--;
          // The state before the push: the file is simply not there yet.
          return new Response('{"message":"Not Found"}', { status: 404 });
        }
        const shown = await runCommand(["git", "show", `${ref}:${path}`], { cwd: bare });
        if (shown.exitCode !== 0) {
          return new Response('{"message":"Not Found"}', { status: 404 });
        }
        return Response.json({
          path,
          encoding: "base64",
          content: Buffer.from(shown.stdout, "utf8").toString("base64"),
        });
      }

      return new Response('{"message":"Not Found"}', { status: 404 });
    },
  });
  return { server: started, baseUrl: `http://127.0.0.1:${started.port}` };
}

beforeEach(async () => {
  staleConfigReads = 0;
  hiddenTreePaths = new Set();
  root = mkdtempSync(join(tmpdir(), "nemar-fleet-"));
  scratch.push(root);
  workRoot = join(root, "work");
  mkdirSync(workRoot, { recursive: true });

  // git-annex commits to its own branch on init and on `config --set`, and the
  // required CI tier runs with no git identity configured anywhere. These env vars
  // cover the repositories this test does not create itself -- the clone the
  // backfill makes -- so the suite does not depend on the machine.
  setEnv("GIT_AUTHOR_NAME", "NEMAR Test");
  setEnv("GIT_AUTHOR_EMAIL", "test@nemar.test");
  setEnv("GIT_COMMITTER_NAME", "NEMAR Test");
  setEnv("GIT_COMMITTER_EMAIL", "test@nemar.test");
  // The reader refuses to run on the anonymous rate limit, and must not shell out
  // to `gh` here; the stand-in ignores the value.
  setEnv("GH_TOKEN", "fixture-token");

  origins = new Map([
    [POLICY_ONLY, await buildOrigin(POLICY_ONLY, { withGitResidentMotion: false })],
    [WITH_DATA, await buildOrigin(WITH_DATA, { withGitResidentMotion: true })],
  ]);
  const served = serveGitHub();
  server = served.server;
  baseUrl = served.baseUrl;
}, 240_000);

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    removeTree(dir);
  }
});

describe("scanning a dataset without cloning it", () => {
  test("reports both halves of the policy, and what git still holds", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const state = await scanDatasetAnnexPolicy(WITH_DATA, reader);

    // Upstream's file carries three largefiles rules; the `**/.git*` line is kept
    // deliberately (annexing a .gitattributes would hide it from git-annex itself),
    // so two are removable.
    expect(state.attributeFiles.map((f) => f.path)).toEqual([".gitattributes"]);
    expect(state.attributeFiles[0].rulesRemoved).toBe(2);
    expect(state.attributeFiles[0].declined).toEqual([]);

    // An imported repository has no annex.largefiles configured at all: this is the
    // half that is invisible in the tree and was missed until #1374.
    expect(state.policyConfigured).toBe(false);
    expect(state.configuredExpression).toBeNull();

    // The recording upstream annexed is a symlink and is not data git holds; the one
    // under upstream's 1 MB bar is.
    expect(state.gitResidentData.map((f) => f.path)).toEqual([SMALL_MOTION]);
    expect(state.gitResidentData[0].size).toBe(300_000);
    // A sidecar keeps its metadata status whatever its size (ADR 0031).
    expect(state.gitResidentData.map((f) => f.path)).not.toContain(CHANNELS);
    expect(state.pointerSuspects).toEqual([]);
    expect(state.treeTruncated).toBe(false);
    expect(labelAnnexPolicyState(state)).toBe("policy-and-data");
  }, 240_000);

  test("the ordinary fleet case is policy-only: nothing to move", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const state = await scanDatasetAnnexPolicy(POLICY_ONLY, reader);
    expect(state.gitResidentData).toEqual([]);
    expect(labelAnnexPolicyState(state)).toBe("policy");
  }, 240_000);

  test("a sweep records a dataset it cannot read and keeps going", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const summary = await sweepAnnexPolicy([POLICY_ONLY, "on999999", WITH_DATA], reader, {
      concurrency: 2,
    });
    expect(summary.scanned).toBe(2);
    expect(summary.byLabel.policy).toEqual([POLICY_ONLY]);
    expect(summary.byLabel["policy-and-data"]).toEqual([WITH_DATA]);
    expect(summary.failed.map((f) => f.datasetId)).toEqual(["on999999"]);
    expect(summary.failed[0].error).toContain("404");
  }, 240_000);
});

describe("backfilling one dataset", () => {
  test("strips the attributes, configures the policy, pushes both branches, and verifies", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(POLICY_ONLY) as string;
    const before = await run(["git", "rev-parse", "main"], origin);

    const outcome = await applyAnnexPolicyToDataset(POLICY_ONLY, reader, {
      workRoot,
      originUrl: origin,
    });

    expect(outcome.action).toBe("applied");
    expect(outcome.committed).toBe(true);
    expect(outcome.pushed).toBe(true);

    // Verified by reading GitHub back, which is what the fleet run reports on.
    expect(outcome.after?.attributeFiles).toEqual([]);
    expect(outcome.after?.policyConfigured).toBe(true);
    expect(outcome.after?.configuredExpression).toBe(buildLargefilesExpression());

    // And directly at the origin: a new commit on main, upstream's rule gone, the
    // plumbing line kept, and the expression on the git-annex branch.
    expect(await run(["git", "rev-parse", "main"], origin)).not.toBe(before);
    const attrs = await run(["git", "show", "main:.gitattributes"], origin);
    expect(attrs).not.toContain("largerthan=1mb");
    expect(attrs).toContain("**/.git* annex.largefiles=nothing");
    expect(attrs).toContain("* annex.backend=SHA256E");
    expect(await run(["git", "show", "git-annex:config.log"], origin)).toContain(
      "include=*_motion.tsv",
    );

    // The published tag still resolves to exactly what it did: this is a forward fix.
    expect(await run(["git", "show", "v1.0.0:.gitattributes"], origin)).toContain("largerthan=1mb");

    // The clone is gone: 600 of them would not fit on the disk.
    expect(existsSync(join(workRoot, POLICY_ONLY))).toBe(false);
  }, 300_000);

  test("a second pass reports the dataset compliant and changes nothing", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(POLICY_ONLY) as string;
    await applyAnnexPolicyToDataset(POLICY_ONLY, reader, { workRoot, originUrl: origin });
    const settled = await originPolicyState(origin);

    const again = await applyAnnexPolicyToDataset(POLICY_ONLY, reader, {
      workRoot,
      originUrl: origin,
    });
    expect(again.action).toBe("compliant");
    expect(again.committed).toBeUndefined();
    expect(await originPolicyState(origin)).toEqual(settled);
  }, 300_000);

  test("a dataset that also keeps data in git is skipped, not half-fixed", async () => {
    // Its fix needs the S3 leg -- credentials, an upload, and a verification -- so it
    // belongs to `nemar admin annex-normalize` with an operator watching, not to a
    // sweep of 600. Skipping has to leave the repository exactly as it was: a
    // half-applied policy (attributes stripped, recording still in git) is worse than
    // either state.
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(WITH_DATA) as string;
    const before = await originPolicyState(origin);

    const outcome = await applyAnnexPolicyToDataset(WITH_DATA, reader, {
      workRoot,
      originUrl: origin,
    });

    expect(outcome.action).toBe("skipped-has-data");
    expect(outcome.notes?.join(" ")).toContain("annex-normalize");
    expect(await originPolicyState(origin)).toEqual(before);
    expect(existsSync(join(workRoot, WITH_DATA))).toBe(false);
  }, 300_000);

  test("the verification re-reads before it calls a push unlanded", async () => {
    // GitHub is only eventually consistent after a push, so one drift reading is not
    // evidence -- over 598 datasets that difference is the whole signal-to-noise of
    // the run. The retry must not turn into optimism either: on a dataset that really
    // has not been fixed it reads again and still says no.
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(POLICY_ONLY) as string;

    const before = await verifyAnnexPolicyLanded(POLICY_ONLY, reader, {
      attempts: 2,
      delayMs: 10,
    });
    expect(before.landed).toBe(false);
    expect(before.state.policyConfigured).toBe(false);

    await applyAnnexPolicyToDataset(POLICY_ONLY, reader, { workRoot, originUrl: origin });

    // One stale read, then the truth: exactly the shape the retry exists for.
    // A single attempt sees the stale one and calls the push unlanded...
    staleConfigReads = 1;
    const impatient = await verifyAnnexPolicyLanded(POLICY_ONLY, reader, {
      attempts: 1,
      delayMs: 10,
    });
    expect(impatient.landed).toBe(false);

    // ...and a second attempt reaches the same repository's real state. Without
    // the retry loop this assertion fails, which is what makes it a test of it.
    staleConfigReads = 1;
    const after = await verifyAnnexPolicyLanded(POLICY_ONLY, reader, {
      attempts: 2,
      delayMs: 10,
    });
    expect(after.landed).toBe(true);
    expect(after.remainingDeclined).toEqual([]);
  }, 300_000);

  test("the clone overrides the tree when the tree missed git-resident data", async () => {
    // The stated safety net, and until now the only untested branch of it. GitHub
    // truncates a large tree, so the scan can report a dataset as policy-only when
    // it actually keeps recordings in git. The clone sees them, and stopping there
    // is what prevents an S3 upload nobody asked for.
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(WITH_DATA) as string;
    const before = await originPolicyState(origin);

    hiddenTreePaths = new Set([BIG_MOTION, SMALL_MOTION]);
    const scanned = await scanDatasetAnnexPolicy(WITH_DATA, reader);
    // The tree agrees there is nothing to move...
    expect(scanned.gitResidentData).toEqual([]);
    expect(labelAnnexPolicyState(scanned)).toBe("policy");

    const outcome = await applyAnnexPolicyToDataset(WITH_DATA, reader, {
      workRoot,
      originUrl: origin,
    });

    // ...and the clone says otherwise, which wins.
    expect(outcome.action).toBe("skipped-has-data");
    expect(outcome.notes?.join(" ")).toContain("the clone found");
    expect(await originPolicyState(origin)).toEqual(before);
  }, 300_000);

  test("a push whose read-back never agrees is unverified, not applied", async () => {
    // `unverified` gates the command's exit code and is what told us about the two
    // datasets whose default branch was git-annex (#1386). It had no test at all.
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(POLICY_ONLY) as string;

    // More stale reads than the verification will make attempts.
    staleConfigReads = 10;
    const outcome = await applyAnnexPolicyToDataset(POLICY_ONLY, reader, {
      workRoot,
      originUrl: origin,
    });

    expect(outcome.action).toBe("unverified");
    // The work itself DID happen, and saying otherwise would send an operator to
    // redo a push that already landed.
    expect(outcome.pushed).toBe(true);
    staleConfigReads = 0;
    const truth = await verifyAnnexPolicyLanded(POLICY_ONLY, reader, { attempts: 1 });
    expect(truth.landed).toBe(true);
  }, 300_000);

  test("a rehearsal commits locally and pushes nothing", async () => {
    const reader = await createGitHubReader({ baseUrl });
    const origin = origins.get(POLICY_ONLY) as string;
    const before = await originPolicyState(origin);

    const outcome = await applyAnnexPolicyToDataset(POLICY_ONLY, reader, {
      workRoot,
      originUrl: origin,
      push: false,
      keepClone: true,
    });

    expect(outcome.action).toBe("applied");
    expect(outcome.pushed).toBe(false);
    // No re-read to verify, because there is nothing at the origin to verify yet.
    expect(outcome.after).toBeUndefined();
    expect(await originPolicyState(origin)).toEqual(before);
    // And the clone stays, so the rehearsal can be inspected.
    const clonePath = join(workRoot, POLICY_ONLY);
    expect(existsSync(clonePath)).toBe(true);
    expect(await run(["git", "show", "HEAD:.gitattributes"], clonePath)).not.toContain(
      "largerthan=1mb",
    );
  }, 300_000);
});
