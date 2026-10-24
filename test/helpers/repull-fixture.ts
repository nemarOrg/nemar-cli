/**
 * A mirror and its upstream, built the way production builds them, for the re-pull planner's
 * tests (ADR 0111, epic #1046 phase 5).
 *
 * Nothing here stands in for the planner's business logic. The upstream `ds099999` is a real
 * git-annex repository in OpenNeuro's shape: OpenNeuro's own `.gitattributes`, recordings over a
 * size bar annexed with their public S3 URL registered, sidecars and tables in git, an `s3-PUBLIC`
 * special remote on `openneuro.org` in `remote.log`, and `.log.rmet` version pins written by
 * plumbing (nothing writes an `.rmet` from outside git-annex, as `fleet-content-recovery.test.ts`
 * says). NEMAR's `on099999` is made by the REAL import step (`prepareImportedTreeForCopy`, with
 * `nemar-s3` a `type=directory` special remote and upstream's bytes served by a local HTTP
 * server), then the real README rename and metadata seed, then the publish step's shared edits
 * (`applyConceptDoiToDescription`, `selectPublishReadmes` plus `planReadmeBadgeCommit`, the
 * `.bidsignore` line). Its `main` is then given a fresh root commit, so it shares no ancestry with
 * upstream, as an early rewritten import does not.
 *
 * Both origins are bare repositories served over `file://` with `uploadpack.allowFilter` and
 * `uploadpack.allowAnySHA1InWant`, so the planner's blob-filtered, depth-1 clones and its blob
 * fetches behave as they do against GitHub.
 *
 * Tag 1.0.0 (A) to tag 1.1.0 (B), upstream: an EDF added (pinned); `channels.tsv` modified; one
 * sidecar deleted; `events.tsv` renamed; an MD5E `.set` re-keyed; a git-held `_motion.tsv`
 * changed and another added; `code/run.sh` flipped from 644 to 755; `GeneratedBy` added to the
 * description; a line appended to `CHANGES`; `participants.tsv` changed. NEMAR, after the import:
 * a sidecar edited (a correction) and `participants.tsv` edited (a conflict).
 *
 * Every name, date and code in a header below is invented.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashDirLower } from "../../scripts/scrub/git/git-lib";
import { appendLedger, changeLogEntry } from "../../scripts/scrub/ledger";
import { EDF_HEADER_BYTES } from "../../shared/identifier-scan";
import {
  NEMAR_BIDSIGNORE_ENTRY,
  withBidsignoreEntry,
} from "../../shared/standard-edits/bidsignore";
import { applyConceptDoiToDescription } from "../../shared/standard-edits/description";
import { ensureParticipantsTsv } from "../../shared/standard-edits/participants";
import {
  buildDoiBadge,
  planReadmeBadgeCommit,
  selectPublishReadmes,
} from "../../shared/standard-edits/readme";
import { runCommand } from "../../src/lib/git-annex/run-command";
import { getAnnexWhereisAll, listAnnexedKeys } from "../../src/lib/git-annex/transfer";
import { annexCopyUpload } from "../../src/lib/import-normalize";
import {
  buildManifestItems,
  ensureReadmeMd,
  findUnannexedData,
  seedMetadata,
} from "../../src/lib/import-openneuro";
import {
  IMPORT_SCANNER_ID,
  httpUpstreamReader,
  prepareImportedTreeForCopy,
} from "../../src/lib/import-scrub";
import { isLocallyUploaded } from "../../src/lib/s3-server-copy";

/**
 * Within the API's 0-99999 id cap (AGENTS.md, "Dataset ID bands"), so the real routers accept it.
 * No OpenNeuro dataset has this number, and nothing here reaches a real remote: every remote is a
 * local path or a loopback stand-in.
 */
export const NEMAR_ID = "on099999";
export const UPSTREAM_ID = "ds099999";
export const CONCEPT_DOI = "10.82901/nemar.on099999";
export const TAG_A = "1.0.0";
export const TAG_B = "1.1.0";
/** A legacy-shaped tag that compares equal to 1.0.0 and is not OpenNeuro's latest (order-unverified). */
export const TAG_LEGACY = "00001";
const BUCKET_PATH = `openneuro.org/${UPSTREAM_ID}`;
const PUBLIC_UUID = "9e1479f6-49e0-413b-8222-a7f8000f55a6";
const OTHER_UUID = "5d2c6f0e-1a4b-4c3d-9e8f-7a6b5c4d3e2f";
const FIXED_NOW = new Date("2026-10-06T12:00:00.000Z");

export const PATHS = {
  flaggedEdf: "sub-01/eeg/sub-01_task-rest_eeg.edf",
  cleanEdf: "sub-02/eeg/sub-02_task-rest_eeg.edf",
  addedEdf: "sub-03/eeg/sub-03_task-rest_eeg.edf",
  sidecar: "sub-01/eeg/sub-01_task-rest_eeg.json",
  deletedSidecar: "sub-02/eeg/sub-02_task-rest_eeg.json",
  channels: "sub-01/eeg/sub-01_task-rest_channels.tsv",
  events: "sub-01/eeg/sub-01_task-rest_events.tsv",
  eventsRenamed: "sub-01/eeg/sub-01_task-rest_run-1_events.tsv",
  set: "sub-01/eeg/sub-01_task-rest_eeg.set",
  motion: "sub-01/motion/sub-01_task-walk_motion.tsv",
  motionAdded: "sub-02/motion/sub-02_task-walk_motion.tsv",
  script: "code/run.sh",
  participants: "participants.tsv",
  description: "dataset_description.json",
  changes: "CHANGES",
  /** With `deadKeys`: a copy of tag A's `.set`, whose key NEMAR marked dead. */
  copiedSet: "sub-02/eeg/sub-02_task-rest_eeg.set",
  /** With `deadKeys`: where tag B moves the recording the import scrubbed. */
  movedEdf: "sub-04/eeg/sub-04_task-rest_eeg.edf",
  /** With `privacyEdits`: a small recording git holds, whose header the import scrubs in place. */
  gitHeldEdf: "sub-01/eeg/sub-01_task-short_eeg.edf",
  /** With `privacyEdits`: a sidecar with an identifier-keyed value the import blanks. */
  blankedJson: "sub-01/eeg/sub-01_task-rest_acq.json",
  /** With `privacyEdits`: a scans table whose dated `acq_time` the import sets to 1 January. */
  scans: "sub-01/sub-01_scans.tsv",
  provenance: "sourcedata/sourcedata_provenance.json",
  provenanceReadme: "sourcedata/README_sourcedata_provenance.md",
  /** With `subtypes`: a path both sides add with different content. */
  bothAdded: "sub-03/eeg/sub-03_task-rest_eeg.json",
  /** With `subtypes`: a path only NEMAR adds. */
  nemarAdded: "code/nemar-notes.txt",
  /** With `gitlink`: a submodule tag B adds. */
  gitlink: "vendor/tool",
} as const;

const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.json text eol=lf annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=nothing
*.md annex.largefiles=nothing
README annex.largefiles=nothing
CHANGES annex.largefiles=nothing
*.sh annex.largefiles=nothing
*.txt annex.largefiles=nothing
.bidsignore annex.largefiles=nothing
*.set annex.backend=MD5E
*.set annex.largefiles=largerthan=2kb
*.edf annex.largefiles=largerthan=2kb
`;

function edfBytes(patient: string, payloadBytes: number, seed: number, dated: boolean): Uint8Array {
  const out = new Uint8Array(EDF_HEADER_BYTES + payloadBytes);
  out.fill(0x20, 0, EDF_HEADER_BYTES);
  const put = (text: string, start: number, width: number) => {
    for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
  };
  put("0", 0, 8);
  put(patient, 8, 80);
  put(dated ? "Startdate 14-MAR-2023 X X X" : "Startdate 01-JAN-2023 X X X", 88, 80);
  put(dated ? "14.03.23" : "01.01.23", 168, 8);
  put("10.11.12", 176, 8);
  noise(out, EDF_HEADER_BYTES, seed);
  return out;
}

function noise(out: Uint8Array, from: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  for (let i = from; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

/** A headerless motion recording of about `bytes` bytes, rows from a seeded sequence. */
function motionTable(bytes: number, seed: number): string {
  const rows: string[] = [];
  let x = seed;
  let n = 0;
  while (n < bytes) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const row = `${(x % 1000) / 10}\t${(x % 777) / 10}\t${(x % 555) / 10}\n`;
    rows.push(row);
    n += row.length;
  }
  return rows.join("");
}

/** A setup the tests can vary. */
export interface FixtureOptions {
  /** Leave the re-keyed `.set` without a version pin at tag B (test: an unpinned key). */
  unpinnedSet?: boolean;
  /** Append a `headers-scrubbed` line (a recorded correction) to NEMAR's ledger. */
  recordedCorrection?: boolean;
  /** Append the line an earlier re-pull's delta scrub writes (`repull-scrubbed`) to NEMAR's ledger. */
  repullScrubbedLine?: boolean;
  /** Leave out NEMAR's contributor edits, so nothing is unexplained. */
  noContributorEdits?: boolean;
  /** What the bucket's `annex-uuid` marker says; the `nemar-s3` UUID by default, null for none. */
  marker?: string | null;
  /**
   * NEMAR's `CHANGES` beyond upstream's text: ADR 0085's sentence as a correction's rewrite appends
   * it (`sentence`), a near spelling of it (`forged`), or the sentence followed by more text
   * (`not-at-end`).
   */
  changes?: "sentence" | "forged" | "not-at-end";
  /** NEMAR edits the sidecar only (one correction, no conflict), instead of every contributor edit. */
  sidecarEditOnly?: boolean;
  /** A line that does not parse is appended to NEMAR's ledger. */
  corruptLedger?: boolean;
  /** NEMAR's `.nemar/metadata.json` does not parse. */
  brokenNemarMetadata?: boolean;
  /** Tag B adds a submodule (a gitlink). */
  gitlink?: boolean;
  /** NEMAR's README badge names another DOI than the concept DOI (a stale badge). */
  staleBadge?: boolean;
  /** The publish step wrote the Zenodo badge it wrote before #1182. */
  legacyBadge?: boolean;
  /** Upstream's root README: a bare `README` (the default), `README.md`, or none at all. */
  readme?: "bare" | "md" | "none";
  /** NEMAR edits README.md's text (a conflict once upstream changes its README). */
  readmeEdit?: boolean;
  /**
   * Tag A carries what the import changes in place: a git-held recording whose header it scrubs, a
   * sidecar it blanks, a scans table whose date it sets, the provenance file and its README it
   * annotates, and an upstream `.bidsignore` the publish step appends to.
   */
  privacyEdits?: boolean;
  /** NEMAR replaces the scrubbed recording with content of another size; upstream's key stays dead. */
  wrongSizeScrubbedKey?: boolean;
  /** NEMAR's location log already records tag B's `.set` key at nemar-s3. */
  heldSetB?: boolean;
  /** Upstream annexes `README` and `CHANGES`; the import un-annexes root metadata (#768). */
  annexedRootMetadata?: boolean;
  /** NEMAR's edits that make one path of every conflict and correction subtype. */
  subtypes?: boolean;
  /** Tag B changes metadata only. */
  metadataOnlyB?: boolean;
  /**
   * Make the git-held `_motion.tsv` 1.1 MiB, over the clones' 1 MiB blob filter, so the planner
   * must fetch it to see that NEMAR's annexed copy hashes to it.
   */
  bigMotion?: boolean;
  /**
   * NEMAR's git-annex branch marks tag A's `.set` key dead, and tag B both adds a copy of that
   * `.set` and moves the scrubbed recording, so N.0.0 would name two dead keys.
   */
  deadKeys?: boolean;
  /**
   * Upstream ships no `participants.tsv` at either tag, and NEMAR's holds the enrichment's
   * placeholder for its own tree (`ensureParticipantsTsv`), or with `"edited"` that placeholder
   * with one value filled in afterwards. Tag B adds sub-03, so its placeholder differs.
   */
  generatedParticipants?: true | "edited";
}

/** The ADR 0085 sentence a correction appends to `CHANGES` (`changeLogEntry`). */
export const CHANGES_SENTENCE = `\n${changeLogEntry("2026-10-07", ["v1.0.0"])}\n`;

/** A near spelling of the ADR 0085 sentence, which no correction writes. */
export const CHANGES_FORGED =
  "\n2026-10-07: privacy correction. Identification fields in recording file headers were changed in v1.0.0. See .nemar/corrections.jsonl.\n";

/** Upstream's README at tag A. */
export const README_A = "A fixture dataset for the re-pull planner.\n";

/** Upstream's README at tag B. */
export const README_B = "A fixture dataset for the re-pull planner.\nVersion 1.1.0 adds sub-03.\n";

export interface RepullFixture {
  root: string;
  /** The directory holding the bare NEMAR origin (`<originBase>/<id>`). */
  originBase: string;
  /** The planner's test bases. */
  env: Record<string, string>;
  originRepo: string;
  upstreamRepo: string;
  /** The `nemar-s3` directory special remote's store. */
  store: string;
  bucketBase: string;
  nemarUuid: string;
  keys: {
    flaggedUpstream: string;
    flaggedNemar: string;
    motionNemar: string;
    addedEdf: string;
    setA: string;
    setB: string;
    /** With `annexedRootMetadata`: upstream's key for `CHANGES` at tag B. */
    changesB: string | null;
  };
  cleanup(): void;
}

/**
 * OpenNeuro's snapshots of the fixture's upstream, as its GraphQL lists them: oldest first, each
 * with its creation time. The legacy `00001` was made first, so creation order and the numbers
 * agree here; a test that needs them to disagree sets its own list.
 */
export const UPSTREAM_SNAPSHOTS: ReadonlyArray<{ tag: string; created: string | null }> = [
  { tag: TAG_LEGACY, created: "2025-06-01T00:00:00.000Z" },
  { tag: TAG_A, created: "2026-01-01T00:00:00.000Z" },
  { tag: TAG_B, created: "2026-06-01T00:00:00.000Z" },
];

/**
 * OpenNeuro's GraphQL endpoint as the planner's snapshot query (`fetchOpenNeuroSnapshots`, the
 * staleness report's query for one dataset) reads it, in the shape OpenNeuro answers
 * (`backend/test/fixtures/openneuro-graphql/`): `latest` is the tag it names as latest, with the
 * creation time its entry in `snapshots` carries, and `null` answers that the dataset has no
 * snapshot (and an empty list); `status` answers every request with that HTTP status instead.
 */
export interface LatestSnapshotStandin {
  url: string;
  latest: string | null;
  snapshots: Array<{ tag: string; created: string | null }>;
  status: number | null;
  requests: number;
  stop(): void;
}

export function startLatestSnapshotStandin(latest: string | null = TAG_B): LatestSnapshotStandin {
  const state = {
    latest,
    snapshots: UPSTREAM_SNAPSHOTS.map((s) => ({ ...s })),
    status: null as number | null,
    requests: 0,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      state.requests++;
      if (state.status !== null) return new Response("unavailable", { status: state.status });
      if (req.method !== "POST") return new Response("method", { status: 405 });
      const body = (await req.json()) as { variables?: Record<string, string> };
      const id = body.variables?.a0;
      if (typeof id !== "string") return Response.json({ errors: [{ message: "no a0" }] });
      const node =
        state.latest === null
          ? { id, latestSnapshot: null, snapshots: [] }
          : {
              id,
              latestSnapshot: {
                tag: state.latest,
                created: state.snapshots.find((s) => s.tag === state.latest)?.created ?? null,
              },
              snapshots: state.snapshots,
            };
      return Response.json({ data: { a0: node } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/crn/graphql`,
    get latest() {
      return state.latest;
    },
    set latest(v) {
      state.latest = v;
    },
    get snapshots() {
      return state.snapshots;
    },
    set snapshots(v) {
      state.snapshots = v;
    },
    get status() {
      return state.status;
    },
    set status(v) {
      state.status = v;
    },
    get requests() {
      return state.requests;
    },
    stop: () => server.stop(true),
  };
}

/** Run git in a repository and return stdout; throws on failure. For tests that move a ref. */
export async function gitIn(repo: string, args: string[]): Promise<string> {
  return run(["git", ...args], repo);
}

async function run(
  args: string[],
  cwd: string,
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  const r = await runCommand(args, {
    cwd,
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (r.exitCode !== 0)
    throw new Error(`${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  return r.stdout;
}

async function identity(dir: string, description: string): Promise<void> {
  await run(["git", "config", "user.email", "test@nemar.test"], dir);
  await run(["git", "config", "user.name", "NEMAR Test"], dir);
  await run(["git", "annex", "init", "--quiet", description], dir);
}

function write(dir: string, path: string, bytes: Uint8Array | string): void {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  rmSync(abs, { force: true });
  writeFileSync(abs, bytes);
}

/** Commit one file onto a repository's git-annex branch (works in a bare repository too). */
export async function writeAnnexBranchFile(
  repo: string,
  path: string,
  content: string,
): Promise<void> {
  const blob = (
    await run(["git", "hash-object", "-w", "--stdin"], repo, { stdin: content })
  ).trim();
  const indexDir = mkdtempSync(join(tmpdir(), "nemar-repull-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    await run(["git", "read-tree", "refs/heads/git-annex"], repo, { env });
    await run(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], repo, {
      env,
    });
    const tree = (await run(["git", "write-tree"], repo, { env })).trim();
    const commit = (
      await run(
        ["git", "commit-tree", tree, "-p", "refs/heads/git-annex", "-m", "test record"],
        repo,
        {
          env: {
            ...env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        },
      )
    ).trim();
    await run(["git", "update-ref", "refs/heads/git-annex", commit], repo);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

async function bareOrigin(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", "."], dir);
  await run(["git", "config", "uploadpack.allowFilter", "true"], dir);
  await run(["git", "config", "uploadpack.allowAnySHA1InWant", "true"], dir);
}

/** Every ref of a repository, for the "nothing changed" check. */
export async function refsOf(repo: string): Promise<string> {
  return run(["git", "for-each-ref", "--format=%(refname) %(objectname)"], repo);
}

/** Build the fixture. The caller must call `cleanup()`. */
export async function buildRepullFixture(opts: FixtureOptions = {}): Promise<RepullFixture> {
  const root = mkdtempSync(join(tmpdir(), "nemar-repull-fixture-"));
  const served = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const bytes = served.get(path);
      if (!bytes) return new Response("NoSuchKey", { status: 404 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.length - 1);
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
        });
      }
      return new Response(bytes, { status: 200 });
    },
  });
  try {
    return await build(root, served, `http://localhost:${server.port}`, opts);
  } catch (err) {
    Bun.spawnSync(["chmod", "-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
    throw err;
  } finally {
    server.stop(true);
  }
}

async function build(
  root: string,
  served: Map<string, Uint8Array>,
  baseUrl: string,
  opts: FixtureOptions,
): Promise<RepullFixture> {
  const up = join(root, "upstream-work");
  mkdirSync(up, { recursive: true });
  await run(["git", "init", "-q", "--initial-branch", "main", "."], up);
  await identity(up, "upstream");

  // ---- Tag A ----
  const flagged = edfBytes("Qwfixturelast M 14-MAR-1993 Zxfixturename", 4000, 1, true);
  const files: Record<string, Uint8Array | string> = {
    ".gitattributes": UPSTREAM_GITATTRIBUTES,
    [PATHS.description]: `${JSON.stringify(
      {
        Name: "Repull fixture",
        BIDSVersion: "1.9.0",
        License: "CC0",
        Authors: ["A. Fixture"],
        DatasetDOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v${TAG_A}`,
      },
      null,
      2,
    )}\n`,
    ...(opts.readme === "none"
      ? {}
      : { [opts.readme === "md" ? "README.md" : "README"]: README_A }),
    [PATHS.changes]: `${TAG_A} 2026-01-01\n  - Initial snapshot.\n`,
    ...(opts.generatedParticipants
      ? {}
      : { [PATHS.participants]: "participant_id\tage\nsub-01\t30\nsub-02\t31\n" }),
    [PATHS.flaggedEdf]: flagged,
    [PATHS.cleanEdf]: edfBytes("X X X X", 4000, 2, false),
    [PATHS.sidecar]: `{\n  "TaskName": "rest",\n  "SamplingFrequency": 256\n}\n`,
    [PATHS.deletedSidecar]: `{\n  "TaskName": "rest",\n  "SamplingFrequency": 512\n}\n`,
    [PATHS.channels]: "name\ttype\tunits\nFz\tEEG\tuV\n",
    [PATHS.events]: "onset\tduration\ttrial_type\n1.0\t0.5\tgo\n",
    [PATHS.set]: noise(new Uint8Array(3000), 0, 7),
    [PATHS.motion]: opts.bigMotion
      ? motionTable(1.1 * 1024 * 1024, 1)
      : "0.1\t0.2\t0.3\n0.4\t0.5\t0.6\n",
    [PATHS.script]: "#!/bin/sh\necho fixture\n",
    ...(opts.privacyEdits
      ? {
          [PATHS.gitHeldEdf]: edfBytes("Qwfixturelast F 02-FEB-1990 Zxfixturename", 400, 9, true),
          [PATHS.blankedJson]: `{\n  "TaskName": "rest",\n  "Acq": {\n    "PatientName": "Zxfixturename Qwfixturelast"\n  }\n}\n`,
          [PATHS.scans]: "filename\tacq_time\neeg/sub-01_task-rest_eeg.edf\t2023-03-14T10:11:12\n",
          [PATHS.provenance]: `{\n  "files": [\n    { "file": "eeg/sub-01_task-rest_eeg.edf", "sha256": "00" }\n  ]\n}\n`,
          [PATHS.provenanceReadme]: "Provenance of the sourcedata files.\n",
          ".bidsignore": "code/\n",
        }
      : {}),
  };
  const attributes = opts.annexedRootMetadata
    ? UPSTREAM_GITATTRIBUTES.replace(
        "README annex.largefiles=nothing",
        "README annex.largefiles=anything",
      ).replace("CHANGES annex.largefiles=nothing", "CHANGES annex.largefiles=anything")
    : UPSTREAM_GITATTRIBUTES;
  files[".gitattributes"] = attributes;
  for (const [p, b] of Object.entries(files)) {
    write(up, p, b);
    served.set(`${BUCKET_PATH}/${p}`, typeof b === "string" ? text(b) : b);
  }
  await run(["git", "annex", "add", "--quiet", "."], up);
  await run(["git", "commit", "-qm", "upstream 1.0.0"], up);
  await run(["git", "tag", TAG_A], up);
  await run(["git", "tag", TAG_LEGACY], up);
  for (const [path, key] of await listAnnexedKeys(up)) {
    await run(
      ["git", "annex", "registerurl", key, `https://s3.amazonaws.com/${BUCKET_PATH}/${path}`],
      up,
    );
  }
  const upKeysA = await listAnnexedKeys(up);

  // ---- The import of tag A, as prepare runs it ----
  const work = join(root, "import");
  mkdirSync(work, { recursive: true });
  const clone = join(work, NEMAR_ID);
  await run(["git", "clone", "-q", up, clone], work);
  await identity(clone, "import clone");
  const store = join(root, "nemar-s3-store");
  mkdirSync(store, { recursive: true });
  await run(
    [
      "git",
      "annex",
      "initremote",
      "nemar-s3",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ],
    clone,
  );
  const nemarUuid = (await run(["git", "config", "remote.nemar-s3.annex-uuid"], clone)).trim();
  if (opts.annexedRootMetadata) {
    // `ensureRootMetadataUnannexed` (#768) as prepare's step 1 runs it: the annexed root metadata
    // is replaced by its bytes and staged as git content. The function itself fetches from
    // OpenNeuro's public S3 URL, which a test cannot point elsewhere, so its two writes are made
    // here with the bytes upstream committed.
    for (const name of ["README", PATHS.changes]) {
      rmSync(join(clone, name), { force: true });
      writeFileSync(join(clone, name), files[name] as string);
    }
    await run(["git", "-c", "annex.largefiles=nothing", "add", "README", PATHS.changes], clone);
  }
  const unannexedData = await findUnannexedData(clone);
  const { urlMap } = await getAnnexWhereisAll(clone);
  const prepared = await prepareImportedTreeForCopy({
    datasetPath: clone,
    nemarId: NEMAR_ID,
    bucket: "nemar",
    remoteName: "nemar-s3",
    keyUrlMap: urlMap,
    upstreamItems: buildManifestItems(urlMap, NEMAR_ID).items,
    unannexedData,
    reimport: false,
    skipData: false,
    reader: httpUpstreamReader({ baseUrl, retryDelayMs: 1 }),
    upload: annexCopyUpload({ credentials: "inherit" }),
    now: FIXED_NOW,
    actor: "fixture-actor",
  });
  const desc = JSON.parse(readFileSync(join(clone, PATHS.description), "utf8"));
  const openNeuroDoi = String(desc.DatasetDOI).replace(/^doi:/, "");
  ensureReadmeMd(clone, UPSTREAM_ID, openNeuroDoi);
  seedMetadata(clone, NEMAR_ID, UPSTREAM_ID, desc, openNeuroDoi);
  await run(["git", "-c", "annex.largefiles=nothing", "add", "-A"], clone);
  await run(["git", "commit", "-qm", "Seed NEMAR metadata"], clone);
  // The copy and finalize phases, as far as the git-annex branch sees them: every upstream key
  // the manifest names is recorded present at nemar-s3.
  const copied = prepared.manifest.items.filter((it) => !isLocallyUploaded(it)).map((it) => it.key);
  if (copied.length > 0) {
    await run(["git", "annex", "setpresentkey", "--batch"], clone, {
      stdin: copied.map((k) => `${k} ${nemarUuid} 1\n`).join(""),
    });
  }

  // ---- The publish step's shared edits ----
  const applied = applyConceptDoiToDescription(desc, CONCEPT_DOI);
  write(clone, PATHS.description, JSON.stringify(applied.description, null, 2));
  const rootFiles = (await run(["git", "ls-tree", "--name-only", "HEAD"], clone))
    .split("\n")
    .filter(Boolean);
  const readmes = selectPublishReadmes(rootFiles.map((path) => ({ path })));
  const source = readmes.contentSource
    ? readFileSync(join(clone, readmes.contentSource.path), "utf8")
    : "";
  const badgeDoi = opts.staleBadge ? "10.82901/nemar.stale" : CONCEPT_DOI;
  const badge = planReadmeBadgeCommit({
    readmeContent: source,
    doiBadge: opts.legacyBadge
      ? `[![DOI](https://zenodo.org/badge/DOI/${badgeDoi}.svg)](https://doi.org/${badgeDoi})`
      : buildDoiBadge(badgeDoi),
    conceptDoi: badgeDoi,
    contentSourcePath: readmes.contentSource?.path,
  });
  if (badge.commit) write(clone, "README.md", badge.content);
  for (const r of readmes.remove) rmSync(join(clone, r.path));
  const ignore = join(clone, ".bidsignore");
  write(
    clone,
    ".bidsignore",
    withBidsignoreEntry(
      existsSync(ignore) ? readFileSync(ignore, "utf8") : "",
      NEMAR_BIDSIGNORE_ENTRY,
    ).content,
  );
  write(clone, ".github/workflows/validate.yml", "name: validate\non: push\njobs: {}\n");
  if (opts.recordedCorrection) {
    appendLedger(join(clone, ".nemar/corrections.jsonl"), {
      version: 1,
      at: "2026-10-07T00:00:00.000Z",
      dataset: NEMAR_ID,
      action: "headers-scrubbed",
      versions: ["v1.0.0"],
      counts: { headers_scrubbed: 1 },
      scanner: IMPORT_SCANNER_ID,
      verification: "scanner-clean",
      actor: "fixture-actor",
    });
  }
  if (opts.repullScrubbedLine) {
    appendLedger(join(clone, ".nemar/corrections.jsonl"), {
      version: 1,
      at: "2026-10-08T00:00:00.000Z",
      dataset: NEMAR_ID,
      action: "repull-scrubbed",
      versions: [],
      counts: { headers_scrubbed: 1, json_values_blanked: 1 },
      scanner: IMPORT_SCANNER_ID,
      verification: "scanner-clean+payload-identical",
      actor: "fixture-actor",
    });
  }
  if (opts.changes) {
    const appended = {
      sentence: CHANGES_SENTENCE,
      forged: CHANGES_FORGED,
      "not-at-end": `${CHANGES_SENTENCE}Trailing text after the sentence.\n`,
    }[opts.changes];
    write(clone, PATHS.changes, `${readFileSync(join(clone, PATHS.changes), "utf8")}${appended}`);
  }
  // Value-looking tokens: a parser's message would quote them, and nothing may echo them.
  if (opts.brokenNemarMetadata) write(clone, ".nemar/metadata.json", "{ Jane Doe\n");
  if (opts.corruptLedger) {
    const ledger = join(clone, ".nemar/corrections.jsonl");
    write(clone, ".nemar/corrections.jsonl", `${readFileSync(ledger, "utf8")}Jane Doe\n`);
  }
  if (!opts.noContributorEdits || opts.sidecarEditOnly) {
    write(
      clone,
      PATHS.sidecar,
      `{\n  "TaskName": "rest",\n  "SamplingFrequency": 256,\n  "PowerLineFrequency": 60\n}\n`,
    );
  }
  if (opts.generatedParticipants) {
    // The enrichment's commit, from the tree as it stands (GitHub's listing names files and their
    // directories; the subjects are the same either way).
    const listed = (await run(["git", "ls-files"], clone)).split("\n").filter(Boolean);
    const placeholder = ensureParticipantsTsv(listed.map((path) => ({ path }))).contentToCommit;
    if (placeholder === null) throw new Error("the fixture's tree has no subjects");
    write(
      clone,
      PATHS.participants,
      opts.generatedParticipants === "edited"
        ? placeholder.replace("sub-01\tn/a\tn/a", "sub-01\t30\tn/a")
        : placeholder,
    );
  }
  if (!opts.noContributorEdits && !opts.sidecarEditOnly) {
    if (!opts.generatedParticipants) {
      write(clone, PATHS.participants, "participant_id\tage\nsub-01\t29\nsub-02\t31\n");
    }
    const described = JSON.parse(readFileSync(join(clone, PATHS.description), "utf8"));
    described.HowToAcknowledge = "Cite the NEMAR mirror.";
    write(clone, PATHS.description, JSON.stringify(described, null, 2));
  }
  if (opts.readmeEdit) {
    write(clone, "README.md", `${readFileSync(join(clone, "README.md"), "utf8")}A NEMAR note.\n`);
  }
  if (opts.subtypes) {
    // upstream-deleted/nemar-changed, nemar-deleted/upstream-changed, both-added (tag B adds the
    // same path), nemar-added, nemar-deleted.
    write(clone, PATHS.deletedSidecar, `{\n  "TaskName": "rest",\n  "SamplingFrequency": 500\n}\n`);
    rmSync(join(clone, PATHS.channels));
    write(clone, PATHS.bothAdded, `{\n  "TaskName": "rest",\n  "Source": "nemar"\n}\n`);
    write(clone, PATHS.nemarAdded, "Notes NEMAR added.\n");
    rmSync(join(clone, PATHS.sidecar));
  }
  if (opts.wrongSizeScrubbedKey) {
    // Another recording of another size where the scrubbed one was; upstream's key stays dead.
    write(clone, PATHS.flaggedEdf, edfBytes("X X X X", 4744, 5, false));
    await run(["git", "annex", "add", "--quiet", PATHS.flaggedEdf], clone);
  }
  if (opts.deadKeys) {
    // Retired the way the scrub and ADR 0085's annex-registry retire a key: every holder
    // retracted, then the key marked dead.
    const setA = upKeysA.get(PATHS.set) as string;
    // `whereis` exits 1 for a key with no copy, so its JSON is read, never its exit code.
    const listed = await runCommand(["git", "annex", "whereis", "--key", setA, "--json"], {
      cwd: clone,
    });
    const where = JSON.parse(listed.stdout.split("\n")[0] as string) as {
      whereis?: Array<{ uuid: string }>;
      untrusted?: Array<{ uuid: string }>;
    };
    const holders = [...(where.whereis ?? []), ...(where.untrusted ?? [])].map((w) => w.uuid);
    await run(["git", "annex", "setpresentkey", "--batch"], clone, {
      stdin: holders.map((u: string) => `${setA} ${u} 0\n`).join(""),
    });
    await run(["git", "annex", "dead", "--key", setA], clone);
  }
  await run(["git", "-c", "annex.largefiles=nothing", "add", "-A"], clone);
  await run(["git", "commit", "-qm", "Publish edits"], clone);

  // A fresh root commit, as an early rewritten import has: no shared ancestry with upstream.
  const tree = (await run(["git", "rev-parse", "HEAD^{tree}"], clone)).trim();
  const rootCommit = (
    await run(["git", "commit-tree", tree, "-m", "Import of ds099999 1.0.0"], clone)
  ).trim();
  await run(["git", "update-ref", "refs/heads/main", rootCommit], clone);
  await run(["git", "tag", "v1.0.0", rootCommit], clone);

  const originBase = join(root, "origins");
  const originRepo = join(originBase, NEMAR_ID);
  await bareOrigin(originRepo);
  await run(["git", "remote", "add", "nemar", originRepo], clone);
  await run(["git", "push", "-q", "nemar", "main", "git-annex", "refs/tags/v1.0.0"], clone);
  // Production's nemar-s3 is an S3 remote with a bucket and a prefix; the planner reads its
  // remote.log line, so the pushed line says what production's says (the store stays a directory).
  await writeAnnexBranchFile(
    originRepo,
    "remote.log",
    `${nemarUuid} bucket=nemar datacenter=us-east-2 encryption=none fileprefix=${NEMAR_ID}/objects/ name=nemar-s3 type=S3 timestamp=1790000000s\n`,
  );

  // ---- Tag B, upstream ----
  const added = edfBytes("X X X X", 4000, 3, false);
  const dataB = opts.metadataOnlyB
    ? {}
    : {
        [PATHS.addedEdf]: added,
        [PATHS.set]: noise(new Uint8Array(3000), 0, 8),
        [PATHS.motion]: opts.bigMotion
          ? motionTable(1.1 * 1024 * 1024, 2)
          : "0.1\t0.2\t0.3\n0.4\t0.5\t0.7\n",
        [PATHS.motionAdded]: "1.1\t1.2\t1.3\n",
      };
  const readmeB =
    opts.readme === "none" || opts.annexedRootMetadata
      ? {}
      : { [opts.readme === "md" ? "README.md" : "README"]: README_B };
  const changes: Record<string, Uint8Array | string> = {
    ...dataB,
    ...readmeB,
    [PATHS.channels]: "name\ttype\tunits\nFz\tEEG\tuV\nCz\tEEG\tuV\n",
    [PATHS.description]: `${JSON.stringify(
      {
        Name: "Repull fixture",
        BIDSVersion: "1.9.0",
        License: "CC0",
        Authors: ["A. Fixture"],
        DatasetDOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v${TAG_B}`,
        GeneratedBy: [{ Name: "fixture-pipeline" }],
      },
      null,
      2,
    )}\n`,
    [PATHS.changes]: `${TAG_A} 2026-01-01\n  - Initial snapshot.\n${TAG_B} 2026-06-01\n  - Added sub-03.\n`,
    ...(opts.generatedParticipants
      ? {}
      : {
          [PATHS.participants]: "participant_id\tage\nsub-01\t30\nsub-02\t31\nsub-03\t32\n",
        }),
  };
  if (opts.deadKeys) changes[PATHS.copiedSet] = files[PATHS.set] as Uint8Array;
  if (opts.subtypes) {
    changes[PATHS.bothAdded] = `{\n  "TaskName": "rest",\n  "SamplingFrequency": 128\n}\n`;
  }
  for (const [p, b] of Object.entries(changes)) write(up, p, b);
  if (opts.deadKeys) {
    mkdirSync(join(up, dirname(PATHS.movedEdf)), { recursive: true });
    await run(["git", "mv", PATHS.flaggedEdf, PATHS.movedEdf], up);
  }
  await run(["git", "rm", "-q", PATHS.deletedSidecar], up);
  await run(["git", "mv", PATHS.events, PATHS.eventsRenamed], up);
  await run(["git", "annex", "add", "--quiet", "."], up);
  if (!opts.metadataOnlyB) await run(["git", "update-index", "--chmod=+x", PATHS.script], up);
  if (opts.gitlink) {
    const commit = (await run(["git", "rev-parse", "HEAD"], up)).trim();
    await run(
      ["git", "update-index", "--add", "--cacheinfo", `160000,${commit},${PATHS.gitlink}`],
      up,
    );
  }
  await run(["git", "commit", "-qm", "upstream 1.1.0"], up);
  await run(["git", "tag", TAG_B], up);
  const upKeysB = await listAnnexedKeys(up);

  // OpenNeuro's versioned bucket, as the git-annex branch records it: the remote and one pin per
  // key it exported, `<versionId>#<object path>`.
  // A second versioned remote on another bucket, whose pins the planner must not take.
  await writeAnnexBranchFile(
    up,
    "remote.log",
    `${PUBLIC_UUID} bucket=openneuro.org name=s3-PUBLIC type=S3 versioning=yes timestamp=1700000000s\n${OTHER_UUID} bucket=elsewhere.example name=s3-OTHER type=S3 versioning=yes timestamp=1700000000s\n`,
  );
  const pin = async (path: string, key: string, version: string, uuid = PUBLIC_UUID) =>
    writeAnnexBranchFile(
      up,
      `${hashDirLower(key)}${key}.log.rmet`,
      `1700000001s ${uuid}:V +${version}#${UPSTREAM_ID}/${path}\n`,
    );
  const addedKey = upKeysB.get(PATHS.addedEdf) as string;
  const setB = upKeysB.get(PATHS.set) as string;
  const changesB = opts.annexedRootMetadata ? (upKeysB.get(PATHS.changes) as string) : null;
  if (!opts.metadataOnlyB) {
    await pin(PATHS.addedEdf, addedKey, "VERSIONADDED");
    await pin(PATHS.set, setB, "VERSIONSETB", opts.unpinnedSet ? OTHER_UUID : PUBLIC_UUID);
  }
  if (changesB) await pin(PATHS.changes, changesB, "VERSIONCHANGESB");

  const upstreamBase = join(root, "upstreams");
  const upstreamRepo = join(upstreamBase, UPSTREAM_ID);
  mkdirSync(upstreamBase, { recursive: true });
  await run(["git", "clone", "-q", "--bare", up, upstreamRepo], root);
  await run(["git", "config", "uploadpack.allowFilter", "true"], upstreamRepo);
  await run(["git", "config", "uploadpack.allowAnySHA1InWant", "true"], upstreamRepo);
  // A bare clone copies branches; make sure the git-annex branch and every tag are there.
  await run(
    [
      "git",
      "fetch",
      "-q",
      up,
      "+refs/heads/git-annex:refs/heads/git-annex",
      "+refs/tags/*:refs/tags/*",
    ],
    upstreamRepo,
  );

  if (opts.heldSetB) {
    // As if an earlier, abandoned re-pull had already copied tag B's .set into the bucket.
    await writeAnnexBranchFile(
      originRepo,
      `${hashDirLower(setB)}${setB}.log`,
      `1790000001s 1 ${nemarUuid}\n`,
    );
  }

  const bucketBase = join(root, "bucket");
  if (opts.marker !== null) {
    write(bucketBase, `${NEMAR_ID}/objects/annex-uuid`, opts.marker ?? nemarUuid);
  } else {
    mkdirSync(bucketBase, { recursive: true });
  }

  const nemarKeys = await listAnnexedKeys(clone);
  Bun.spawnSync(["chmod", "-R", "u+w", work]);
  rmSync(work, { recursive: true, force: true });
  const fixture: RepullFixture = {
    root,
    originBase,
    env: {
      NEMAR_REPULL_ORIGIN_BASE: originBase,
      NEMAR_REPULL_UPSTREAM_BASE: upstreamBase,
      NEMAR_REPULL_BUCKET_BASE: bucketBase,
    },
    originRepo,
    upstreamRepo,
    store,
    bucketBase,
    nemarUuid,
    keys: {
      flaggedUpstream: upKeysA.get(PATHS.flaggedEdf) as string,
      flaggedNemar: nemarKeys.get(PATHS.flaggedEdf) as string,
      motionNemar: nemarKeys.get(PATHS.motion) as string,
      addedEdf: addedKey,
      setA: upKeysA.get(PATHS.set) as string,
      setB,
      changesB,
    },
    cleanup() {
      Bun.spawnSync(["chmod", "-R", "u+w", root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}
