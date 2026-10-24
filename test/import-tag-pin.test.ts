/**
 * An OpenNeuro import is cloned at the upstream tag it imports, never at the mirror's default HEAD,
 * and a tag the mirror does not have yet refuses as a mirror lag (epic #1046 Phase 3, ADR 0111
 * decision 10).
 *
 * Real git and git-annex throughout: the upstream is a real annex repository shaped like an
 * OpenNeuro mirror (test/helpers/tagged-upstream.ts) with two tags and a HEAD past both, so a clone
 * left at HEAD, or at the other tag, cannot pass. OpenNeuro's GraphQL is reached only on its error
 * paths here, through a local server that answers the way the real API fails; the success path,
 * against the real API and a real mirror, is in import-tag-pin.integration.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import { classifyImportFailure } from "../backend/src/services/import-failure-cause";
import { decideRetryAction } from "../backend/src/services/import-retry";
import { ImportRefused, OPENNEURO_MIRROR_LAG_MARKER } from "../src/lib/import-markers";
import {
  EXPLICIT_TAG_LOOKUP_MS,
  appendSourceDatasetEntry,
  cloneOpenNeuroAtTag,
  sourceDatasetEntry,
} from "../src/lib/import-openneuro";
import { recordedUpstreamTag } from "../src/lib/import-upstream-tag";
import { fetchOpenNeuroLatestTag } from "../src/lib/openneuro";
import { makeScratch, run } from "./helpers/annex-repo";
import {
  RECORDING,
  type TaggedUpstream,
  UPSTREAM_ID,
  buildTaggedUpstream,
} from "./helpers/tagged-upstream";
import { startS3Standin } from "./scrub/helpers/s3-standin";

const scratch = makeScratch("import-tag-pin");
let upstream: TaggedUpstream;
let clones = 0;

/** A local GraphQL endpoint answering as OpenNeuro's does when it cannot name a tag. */
let graphql: ReturnType<typeof Bun.serve>;
let graphqlAnswer: () => Response = () => new Response("unavailable", { status: 503 });
let graphqlRequests = 0;

beforeAll(async () => {
  upstream = await buildTaggedUpstream(scratch.root);
  graphql = Bun.serve({
    port: 0,
    fetch: () => {
      graphqlRequests++;
      return graphqlAnswer();
    },
  });
}, 60_000);

// Every test starts from the failing endpoint and a zero count, whatever the last one set.
beforeEach(() => {
  graphqlAnswer = () => new Response("unavailable", { status: 503 });
  graphqlRequests = 0;
});

afterAll(() => {
  graphql.stop(true);
  scratch.cleanup();
});

function cloneDir(): string {
  clones += 1;
  return join(scratch.root, `clone-${clones}`);
}

const fastLookup = () => ({
  graphqlUrl: `http://127.0.0.1:${graphql.port}/crn/graphql`,
  attempts: 2,
  retryDelayMs: 1,
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run(["git", ...args], dir);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function refusal(p: Promise<unknown>): Promise<ImportRefused> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ImportRefused) return err;
    throw err;
  }
  throw new Error("expected a refusal, got none");
}

describe("the clone is at the tag, not at HEAD", () => {
  for (const tag of ["1.0.0", "1.0.1"] as const) {
    test(`an explicit tag ${tag}: commit, tree and checked-out content are the tag's`, async () => {
      const dir = cloneDir();
      const pinned = await cloneOpenNeuroAtTag(UPSTREAM_ID, dir, {
        tag,
        repoUrl: upstream.dir,
        lookup: fastLookup(),
      });

      expect(pinned.tag).toBe(tag);
      expect(pinned.commit).toBe(upstream.commits[tag]);
      expect(await git(dir, "rev-parse", "HEAD")).toBe(upstream.commits[tag]);
      // The branch moved, not a detached HEAD: prepare renames and pushes that branch.
      expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await git(dir, "rev-parse", "HEAD^{tree}")).toBe(
        await git(upstream.dir, "rev-parse", `${tag}^{tree}`),
      );
      expect(await git(dir, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(dir, "README"), "utf8")).toBe(`README at ${tag}\n`);
      // The recording's key is the tag's, which is what the copy manifest is built from. At the tag
      // the recording is an annex symlink, whose last path component is its key.
      const link = await git(upstream.dir, "show", `${tag}:${RECORDING}`);
      expect(await git(dir, "annex", "lookupkey", RECORDING)).toBe(
        link.slice(link.lastIndexOf("/") + 1),
      );
      // git-annex is initialized in the clone, as before the pin.
      expect(existsSync(join(dir, ".git", "annex"))).toBe(true);
      // OpenNeuro could not say what its latest is, so there is nothing to compare against.
      expect(pinned.latestTag).toBeNull();
    }, 60_000);
  }
});

describe("with an explicit tag the latest-tag lookup is one short try", () => {
  test("a failing OpenNeuro is asked once, not retried, and the clone goes ahead", async () => {
    graphqlAnswer = () => new Response("unavailable", { status: 503 });
    graphqlRequests = 0;
    // The fixture allows two attempts; an explicit tag must still make only one.
    const pinned = await cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), {
      tag: "1.0.0",
      repoUrl: upstream.dir,
      lookup: fastLookup(),
    });
    expect(graphqlRequests).toBe(1);
    expect(pinned.latestTag).toBeNull();
    expect(EXPLICIT_TAG_LOOKUP_MS).toBeLessThanOrEqual(10_000);
  }, 60_000);
});

describe("a tag the mirror does not have refuses as a mirror lag", () => {
  test("refused with the marker, classified mirror_lag, retried and not parked", async () => {
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), {
        tag: "1.0.2",
        repoUrl: upstream.dir,
        lookup: fastLookup(),
      }),
    );
    expect(err.marker).toBe(OPENNEURO_MIRROR_LAG_MARKER);
    expect(err.message.startsWith(`${OPENNEURO_MIRROR_LAG_MARKER} ${UPSTREAM_ID}:`)).toBe(true);
    expect(err.message).toContain("1.0.2");
    // The line the Worker receives classifies as a mirror lag, and a retry inside the window
    // re-dispatches it rather than parking it.
    expect(classifyImportFailure({ stage: "prepare", lastError: err.message }).cause).toBe(
      "mirror_lag",
    );
    const now = Date.now();
    expect(
      decideRetryAction({
        now,
        verified: { complete: false },
        firstIncompleteAtMs: now,
        lastError: err.message,
        recoveryAttempts: 0,
        hasSourceId: true,
      }).action,
    ).toBe("dispatch");
  }, 60_000);

  test("only a tag answers: a name that is also an abbreviated commit does not stand in for it", async () => {
    // `refs/tags/<tag>` is what is resolved. A bare name would also match a commit by its
    // abbreviated SHA, and an all-digit legacy tag (`00001`) is a valid one: asked for a tag the
    // mirror lacks, the import would then sit at whatever commit happened to share the prefix.
    const prefix = upstream.commits.head.slice(0, 10);
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), {
        tag: prefix,
        repoUrl: upstream.dir,
        lookup: fastLookup(),
      }),
    );
    expect(err.marker).toBe(OPENNEURO_MIRROR_LAG_MARKER);
  }, 60_000);
});

describe("with no tag, the tag is OpenNeuro's latest, and not knowing it refuses", () => {
  test("OpenNeuro unreachable: refused as a mirror lag naming the reason, after its retries", async () => {
    graphqlAnswer = () => new Response("unavailable", { status: 503 });
    graphqlRequests = 0;
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), { repoUrl: upstream.dir, lookup: fastLookup() }),
    );
    expect(err.marker).toBe(OPENNEURO_MIRROR_LAG_MARKER);
    expect(err.message).toContain("HTTP 503");
    expect(graphqlRequests).toBe(2);
  }, 60_000);

  test("a dataset with no snapshot: refused, and not retried within the run", async () => {
    graphqlAnswer = () => Response.json({ data: { dataset: { latestSnapshot: null } } });
    graphqlRequests = 0;
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), { repoUrl: upstream.dir, lookup: fastLookup() }),
    );
    expect(err.message).toContain("no snapshot");
    expect(graphqlRequests).toBe(1);
  }, 60_000);

  test("a dataset OpenNeuro does not know: refused with OpenNeuro's own words", async () => {
    // The shape openneuro.org answered for ds999999 on 2026-10-23.
    graphqlAnswer = () =>
      Response.json({
        errors: [{ message: "Dataset ds000001 does not exist.", path: ["dataset"] }],
        data: { dataset: null },
      });
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), { repoUrl: upstream.dir, lookup: fastLookup() }),
    );
    expect(err.message).toContain("does not exist");
  }, 60_000);

  test("a latest tag of an unexpected shape is not used", async () => {
    graphqlAnswer = () =>
      Response.json({ data: { dataset: { latestSnapshot: { tag: "1.0.0; touch /tmp/x" } } } });
    expect((await fetchOpenNeuroLatestTag(UPSTREAM_ID, fastLookup())).tag).toBeNull();
    const err = await refusal(
      cloneOpenNeuroAtTag(UPSTREAM_ID, cloneDir(), { repoUrl: upstream.dir, lookup: fastLookup() }),
    );
    expect(err.marker).toBe(OPENNEURO_MIRROR_LAG_MARKER);
  }, 60_000);
});

describe("an explicit tag of the wrong shape is a usage error, not a refusal", () => {
  test("it is rejected before anything is cloned", async () => {
    const dir = cloneDir();
    const p = cloneOpenNeuroAtTag(UPSTREAM_ID, dir, {
      tag: "--upload-pack=x",
      repoUrl: upstream.dir,
      lookup: fastLookup(),
    });
    await expect(p).rejects.toThrow(/Invalid upstream tag/);
    await p.catch((err) => expect(err).not.toBeInstanceOf(ImportRefused));
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});

describe("a refusal removes the work directory it made, never the caller's", () => {
  test("the created directory goes, read-only annex directories and all; --dir stays", async () => {
    const created = join(scratch.root, "created-work-dir");
    const named = join(scratch.root, "named-work-dir");
    // What a clone leaves: git-annex makes its object directories read-only.
    mkdirSync(join(created, "on000001", ".git", "annex", "objects", "xx"), { recursive: true });
    writeFileSync(join(created, "on000001", ".git", "annex", "objects", "xx", "KEY"), "x");
    chmodSync(join(created, "on000001", ".git", "annex", "objects", "xx"), 0o555);
    mkdirSync(named, { recursive: true });
    const script = join(scratch.root, "refuse-workdir.ts");
    writeFileSync(
      script,
      [
        `import { ImportRefused, OPENNEURO_MIRROR_LAG_MARKER } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-markers.ts"))};`,
        `import { refuseImport } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-openneuro.ts"))};`,
        `await refuseImport(new ImportRefused(OPENNEURO_MIRROR_LAG_MARKER, "ds000001: test"), "on000001", { workDir: ${JSON.stringify(named)} }, ${JSON.stringify(created)});`,
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], {
      env: { PATH: process.env.PATH ?? "", HOME: scratch.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(1);
    expect(existsSync(created)).toBe(false);
    expect(existsSync(named)).toBe(true);
  }, 60_000);
});

describe("a refusal clears the staging an earlier attempt left", () => {
  // The copy and finalize jobs run under `if: !cancelled()`, so after prepare refuses they still
  // run, and read `<id>/staging/manifest.json`. A manifest an earlier attempt left would then be
  // copied and finalized -- published, even -- under a prepare that just refused. Real `aws` CLI,
  // against the S3 stand-in, isolated from the developer's own AWS setup.
  const awsInstalled = which("aws") !== null;

  // CI has the aws CLI; a skip there would hide this coverage, so it is a failure instead.
  test.if(process.env.CI === "true")("the aws CLI is present in CI", () => {
    expect(awsInstalled).toBe(true);
  });

  test.skipIf(!awsInstalled)(
    "refuseImport removes <id>/staging/ and nothing else, then exits 1",
    async () => {
      const standin = startS3Standin({ region: "us-east-2" });
      const home = join(scratch.root, "aws-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config"), "");
      writeFileSync(join(home, "credentials"), "");
      try {
        const bytes = new TextEncoder().encode("{}");
        standin.putObject("nemar", "on000001/staging/manifest.json", bytes);
        standin.putObject("nemar", "on000001/objects/SHA256E-s2--ab.edf", bytes);
        const script = join(scratch.root, "refuse-staging.ts");
        writeFileSync(
          script,
          [
            `import { ImportRefused, OPENNEURO_MIRROR_LAG_MARKER } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-markers.ts"))};`,
            `import { refuseImport } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-openneuro.ts"))};`,
            'await refuseImport(new ImportRefused(OPENNEURO_MIRROR_LAG_MARKER, "ds000001: test"), "on000001", { persistStaging: true });',
          ].join("\n"),
        );
        const child = Bun.spawn(["bun", script], {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
            AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForTagPinTest",
            AWS_CONFIG_FILE: join(home, "config"),
            AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_MAX_ATTEMPTS: "1",
            AWS_ENDPOINT_URL_S3: standin.url,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(await child.exited).toBe(1);
        expect(standin.current("nemar", "on000001/staging/manifest.json")).toBeUndefined();
        expect(standin.current("nemar", "on000001/objects/SHA256E-s2--ab.edf")).toBeDefined();
        // The refusal is still the last failure line, after the cleanup's own output.
        const failures = (out + err).split("\n").filter((l) => l.includes("✖"));
        expect(failures.at(-1)).toContain(`${OPENNEURO_MIRROR_LAG_MARKER} ds000001: test`);
      } finally {
        standin.stop();
      }
    },
    60_000,
  );
});

describe("the import records the snapshot it is, in SourceDatasets", () => {
  async function pinnedAt(tag: "1.0.0" | "1.0.1"): Promise<string> {
    const dir = cloneDir();
    await cloneOpenNeuroAtTag(UPSTREAM_ID, dir, {
      tag,
      repoUrl: upstream.dir,
      lookup: fastLookup(),
    });
    return dir;
  }

  test("appended beside upstream's own entries, read back as the tag, and staged as a git blob", async () => {
    const dir = await pinnedAt("1.0.1");
    const descPath = join(dir, "dataset_description.json");
    // Upstream's own SourceDatasets, which is kept.
    const upstreamDesc = JSON.parse(readFileSync(descPath, "utf8"));
    const theirs = { URL: "https://example.org/raw-recordings" };
    writeFileSync(descPath, JSON.stringify({ ...upstreamDesc, SourceDatasets: [theirs] }));

    // A repository whose policy would annex everything (git-annex's default with no policy set,
    // which some OpenNeuro mirrors effectively have for their metadata): the description must stay
    // a git blob regardless.
    await git(dir, "annex", "config", "--set", "annex.largefiles", "anything");

    expect(await appendSourceDatasetEntry(dir, UPSTREAM_ID, "1.0.1")).toBe("appended");

    const staged = JSON.parse(await git(dir, "show", ":dataset_description.json"));
    expect(staged.SourceDatasets).toEqual([theirs, sourceDatasetEntry(UPSTREAM_ID, "1.0.1")]);
    expect(staged.SourceDatasets[1]).toEqual({
      DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.1`,
      URL: `https://openneuro.org/datasets/${UPSTREAM_ID}/versions/1.0.1`,
      Version: "1.0.1",
    });
    // Every other key is upstream's, untouched.
    expect({ ...staged, SourceDatasets: undefined }).toEqual({
      ...upstreamDesc,
      SourceDatasets: undefined,
    });
    // What the upstream-moved guard reads back is the tag that was imported.
    expect(recordedUpstreamTag(staged, UPSTREAM_ID)).toBe("1.0.1");
    // A regular blob in git (mode 100644), never an annex pointer.
    expect((await git(dir, "ls-files", "-s", "dataset_description.json")).split(" ")[0]).toBe(
      "100644",
    );
    expect(await git(dir, "annex", "find", "--include", "*", "dataset_description.json")).toBe("");
  }, 60_000);

  test("never a second entry for the same dataset", async () => {
    const dir = await pinnedAt("1.0.0");
    expect(await appendSourceDatasetEntry(dir, UPSTREAM_ID, "1.0.0")).toBe("appended");
    const once = readFileSync(join(dir, "dataset_description.json"), "utf8");
    expect(await appendSourceDatasetEntry(dir, UPSTREAM_ID, "1.0.0")).toBe("already-recorded");
    // Nor when the entry already there names another version: one entry per ds, so the recorded
    // tag never disagrees with itself.
    expect(await appendSourceDatasetEntry(dir, UPSTREAM_ID, "1.0.1")).toBe("already-recorded");
    expect(readFileSync(join(dir, "dataset_description.json"), "utf8")).toBe(once);
  }, 60_000);

  /** Rewrite the clone's description with `sources`, then record 1.0.1 and return what is staged. */
  async function recordOver(sources: unknown[]): Promise<{
    outcome: string;
    staged: Record<string, unknown> & { SourceDatasets: unknown[] };
    onDisk: Record<string, unknown> & { SourceDatasets: unknown[] };
  }> {
    const dir = await pinnedAt("1.0.1");
    const descPath = join(dir, "dataset_description.json");
    const upstreamDesc = JSON.parse(readFileSync(descPath, "utf8"));
    writeFileSync(descPath, JSON.stringify({ ...upstreamDesc, SourceDatasets: sources }));
    const outcome = await appendSourceDatasetEntry(dir, UPSTREAM_ID, "1.0.1");
    return {
      outcome,
      staged: JSON.parse(await git(dir, "show", ":dataset_description.json")),
      onDisk: JSON.parse(readFileSync(descPath, "utf8")),
    };
  }

  test("an untagged entry for this dataset alone is completed in place, never joined by a second", async () => {
    // Left untouched, an untagged entry was enough to skip the record, and then nothing recorded a
    // tag: the upstream-moved guard could never fire on this dataset.
    const entry = sourceDatasetEntry(UPSTREAM_ID, "1.0.1");
    const conceptDoi = `doi:10.18112/openneuro.${UPSTREAM_ID}`;
    const page = `https://openneuro.org/datasets/${UPSTREAM_ID}`;

    const doiOnly = await recordOver([{ DOI: conceptDoi }]);
    expect(doiOnly.outcome).toBe("completed");
    expect(doiOnly.staged.SourceDatasets).toEqual([
      { DOI: conceptDoi, URL: entry.URL, Version: "1.0.1" },
    ]);
    expect(recordedUpstreamTag(doiOnly.staged, UPSTREAM_ID)).toBe("1.0.1");

    const urlOnly = await recordOver([{ URL: page, Name: "upstream's own label" }]);
    expect(urlOnly.outcome).toBe("completed");
    expect(urlOnly.staged.SourceDatasets).toEqual([
      { URL: page, Name: "upstream's own label", DOI: entry.DOI, Version: "1.0.1" },
    ]);
    expect(recordedUpstreamTag(urlOnly.staged, UPSTREAM_ID)).toBe("1.0.1");
  }, 60_000);

  test("an entry that already records a tag, in the live on004362 shape, is left alone", async () => {
    const tagged = [{ DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.0` }];
    const { outcome } = await recordOver(tagged);
    expect(outcome).toBe("already-recorded");
  }, 60_000);

  test("an entry naming two datasets is not edited; the record is appended beside it", async () => {
    const twoDatasets = {
      DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}`,
      URL: "https://openneuro.org/datasets/ds000002",
    };
    const { outcome, staged } = await recordOver([twoDatasets, null]);
    expect(outcome).toBe("appended");
    expect(staged.SourceDatasets).toEqual([
      twoDatasets,
      null,
      sourceDatasetEntry(UPSTREAM_ID, "1.0.1"),
    ]);
    expect(recordedUpstreamTag(staged, UPSTREAM_ID)).toBe("1.0.1");
  }, 60_000);

  test("entries that already disagree are left alone: no third tag beside them", async () => {
    const disagreeing = [
      { DOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.0` },
      { URL: `https://openneuro.org/datasets/${UPSTREAM_ID}/versions/0.9.0` },
    ];
    const { outcome, onDisk } = await recordOver(disagreeing);
    expect(outcome).toBe("disagree");
    // Nothing was written: the file is still what the test wrote.
    expect(onDisk.SourceDatasets).toEqual(disagreeing);
  }, 60_000);

  test("an untagged entry carrying someone else's Version or a non-text DOI is not overwritten", async () => {
    const page = `https://openneuro.org/datasets/${UPSTREAM_ID}`;
    for (const theirs of [
      // Not a tag (a slash), so the entry records none, and it is not this import's to overwrite.
      { URL: page, Version: "n/a" },
      { URL: page, DOI: ["doi:10.18112/openneuro.ds000001", "doi:10.5281/zenodo.1"] },
    ]) {
      const { outcome, staged } = await recordOver([theirs]);
      expect(outcome).toBe("appended");
      expect(staged.SourceDatasets).toEqual([theirs, sourceDatasetEntry(UPSTREAM_ID, "1.0.1")]);
      expect(recordedUpstreamTag(staged, UPSTREAM_ID)).toBe("1.0.1");
    }
  }, 60_000);

  test("a leading v on the tag does not reach the DOI", () => {
    expect(sourceDatasetEntry(UPSTREAM_ID, "v1.0.1").DOI).toBe(
      `doi:10.18112/openneuro.${UPSTREAM_ID}.v1.0.1`,
    );
  });
});
