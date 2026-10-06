/**
 * The ledger command line, run for real: the real CLI process, the real `aws` binary, the S3
 * stand-in. The standing rule it protects is "append-only": an upload that would drop or rewrite a
 * line is refused, and a dry run changes nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { SCANNER_RULE_FILES, extendsLedger, scannerRevision } from "../../scripts/scrub/ledger-cli";
import { type S3Standin, startS3Standin } from "./helpers/s3-standin";

const SCRIPT = join(import.meta.dir, "../../scripts/scrub/ledger-cli.ts");
const BUCKET = "nemar";
const DATASET = "xx090411";
const KEY = `${DATASET}/corrections/ledger.jsonl`;
const SLOW = 60_000;

let standin: S3Standin | undefined;
const dirs: string[] = [];
afterEach(() => {
  standin?.stop();
  standin = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function work(): string {
  const d = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  dirs.push(d);
  return d;
}

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ["bun", SCRIPT, ...args],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_ACCESS_KEY_ID: "ASIATESTTESTTESTTEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "us-east-2",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      ...(standin ? { AWS_ENDPOINT_URL_S3: standin.url } : {}),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, all: `${stdout}\n${stderr}` };
}

const append = (file: string, action: string, extra: string[] = []) =>
  cli([
    "append",
    "--file",
    file,
    "--dataset",
    DATASET,
    "--action",
    action,
    "--versions",
    "v1.0.0,v1.0.1",
    "--counts",
    "objects=3,headers=3",
    "--verification",
    "scanner-clean",
    "--actor",
    "someone",
    ...extra,
  ]);

describe("ledger-cli append", () => {
  test(
    "writes a validated line with a derived scanner revision, and refuses what the ledger refuses",
    async () => {
      const file = join(work(), "ledger.jsonl");
      const ok = await append(file, "headers-scrubbed");
      expect(ok.exitCode, ok.all).toBe(0);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0] as string);
      expect(entry.scanner).toMatch(/^identifier-scan@[0-9a-f]{7,40}$/);
      expect(entry.counts).toEqual({ objects: 3, headers: 3 });
      expect(entry.action).toBe("headers-scrubbed");

      // Free text where only a closed word is allowed, and a non-numeric count: refused, nothing appended.
      const badVerification = await cli([
        "append",
        "--file",
        file,
        "--dataset",
        DATASET,
        "--action",
        "plan",
        "--verification",
        "looked fine to me",
        "--actor",
        "someone",
        "--scanner",
        "identifier-scan@abcdef1",
      ]);
      expect(badVerification.exitCode).toBe(3);
      const badCount = await append(file, "plan", ["--counts", "objects=lots"]);
      expect(badCount.exitCode).toBe(2);
      expect(readFileSync(file, "utf8").trim().split("\n").length).toBe(1);
    },
    SLOW,
  );
});

describe("ledger-cli file modes", () => {
  test(
    "the ledger it creates is owner-only, whatever umask it was started with",
    async () => {
      const file = join(work(), "ledger.jsonl");
      const args = [
        "append",
        "--file",
        file,
        "--dataset",
        DATASET,
        "--action",
        "plan",
        "--verification",
        "scanner-clean",
        "--actor",
        "someone",
        "--scanner",
        "identifier-scan@abcdef1",
      ];
      const proc = spawn({
        cmd: [
          "sh",
          "-c",
          `umask 022; exec bun ${[SCRIPT, ...args].map((a) => `'${a}'`).join(" ")}`,
        ],
        env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited, err).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
    SLOW,
  );
});

describe("ledger-cli publish", () => {
  test(
    "a dry run changes nothing; --execute uploads and reads back identical",
    async () => {
      standin = startS3Standin();
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      await append(file, "headers-scrubbed");

      const dry = await cli(["publish", "--file", file, "--dataset", DATASET]);
      expect(dry.exitCode, dry.all).toBe(0);
      expect(dry.stdout).toContain("dry run");
      expect(standin.calls("PutObject").length).toBe(0);
      expect(standin.keys(BUCKET, KEY)).toEqual([]);

      const real = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(real.exitCode, real.all).toBe(0);
      expect(real.stdout).toContain("read back identical");
      const stored = standin.current(BUCKET, KEY) as { data: Uint8Array };
      expect(Buffer.from(stored.data).toString("utf8")).toBe(readFileSync(file, "utf8"));
    },
    SLOW,
  );

  test(
    "an extension is accepted; dropping or rewriting a line is refused and the object is untouched",
    async () => {
      standin = startS3Standin();
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      const first = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(first.exitCode, first.all).toBe(0);
      const before = Buffer.from(
        (standin.current(BUCKET, KEY) as { data: Uint8Array }).data,
      ).toString("utf8");

      await append(file, "headers-scrubbed");
      const more = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(more.exitCode, more.all).toBe(0);
      const after = Buffer.from(
        (standin.current(BUCKET, KEY) as { data: Uint8Array }).data,
      ).toString("utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after.trim().split("\n").length).toBe(2);

      // A local file that lost its first line is not an append.
      const dropped = join(work(), "dropped.jsonl");
      writeFileSync(dropped, `${after.trim().split("\n")[1]}\n`);
      const refused = await cli(["publish", "--file", dropped, "--dataset", DATASET, "--execute"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr).toContain("not-an-append");

      // A line rewritten in place is not an append either.
      const rewritten = join(work(), "rewritten.jsonl");
      writeFileSync(rewritten, after.replace('"objects":3', '"objects":4'));
      const refused2 = await cli([
        "publish",
        "--file",
        rewritten,
        "--dataset",
        DATASET,
        "--execute",
      ]);
      expect(refused2.exitCode).toBe(3);
      expect(
        Buffer.from((standin.current(BUCKET, KEY) as { data: Uint8Array }).data).toString("utf8"),
      ).toBe(after);
    },
    SLOW,
  );

  test(
    "a ledger holding another dataset's line is refused before any call",
    async () => {
      standin = startS3Standin();
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      const wrong = await cli(["publish", "--file", file, "--dataset", "xx090412", "--execute"]);
      expect(wrong.exitCode).toBe(3);
      expect(wrong.stderr).toContain("ledger-other-dataset");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );
});

/** The remote ledger's text as the stand-in holds it now. */
const remoteText = () =>
  Buffer.from((standin?.current(BUCKET, KEY) as { data: Uint8Array }).data).toString("utf8");

/** A two-line ledger already published, and a local file holding only its first line. */
async function twoLineRemote(): Promise<{ remote: string; oneLine: string }> {
  const file = join(work(), "ledger.jsonl");
  await append(file, "plan");
  await append(file, "headers-scrubbed");
  const remote = readFileSync(file, "utf8");
  standin?.putObject(BUCKET, KEY, new TextEncoder().encode(remote));
  const oneLine = join(work(), "one.jsonl");
  writeFileSync(oneLine, `${remote.split("\n")[0]}\n`);
  return { remote, oneLine };
}

/** A local ledger one line longer than `base`, which must already be in a file. */
async function extended(base: string): Promise<string> {
  const file = join(work(), "ledger.jsonl");
  writeFileSync(file, base);
  await append(file, "history-rewritten");
  return file;
}

describe("ledger-cli publish: only a genuine not-found is absence (C1)", () => {
  test(
    "an unreachable endpoint refuses, in the dry run and with --execute, and never says (new)",
    async () => {
      const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
      const url = `http://127.0.0.1:${closed.port}`;
      closed.stop(true);
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      for (const extra of [[], ["--execute"]]) {
        const r = await cli(["publish", "--file", file, "--dataset", DATASET, ...extra], {
          AWS_ENDPOINT_URL_S3: url,
        });
        expect(r.exitCode, r.all).toBe(3);
        expect(r.stderr.trim()).toBe("remote-ledger-unreadable (GetObject:unreachable)");
        expect(r.stdout).not.toContain("(new)");
      }
    },
    SLOW,
  );

  test(
    "a 403 on the read refuses: a shorter local file never replaces a longer ledger",
    async () => {
      standin = startS3Standin();
      const { remote, oneLine } = await twoLineRemote();
      standin.inject("GetObject", { code: "AccessDenied", status: 403 });
      const r = await cli(["publish", "--file", oneLine, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(3);
      expect(r.stderr.trim()).toBe("remote-ledger-unreadable (GetObject:access-denied)");
      expect(standin.calls("PutObject").length).toBe(0);
      expect(remoteText()).toBe(remote);
    },
    SLOW,
  );

  test(
    "a 500 on the read refuses, and nothing is written",
    async () => {
      standin = startS3Standin();
      const { remote, oneLine } = await twoLineRemote();
      standin.inject("GetObject", { code: "InternalError", status: 500 });
      const r = await cli(["publish", "--file", oneLine, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(3);
      expect(r.stderr.trim()).toBe("remote-ledger-unreadable (GetObject:failed)");
      expect(standin.calls("PutObject").length).toBe(0);
      expect(remoteText()).toBe(remote);
    },
    SLOW,
  );

  test(
    "a first publish is conditional on absence: a writer that got in first stands",
    async () => {
      standin = startS3Standin();
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      const theirs = "theirs\n";
      // Between the read (not found) and the put, another writer creates the object.
      standin.beforeOp("PutObject", () => {
        standin?.putObject(BUCKET, KEY, new TextEncoder().encode(theirs));
      });
      const r = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(3);
      expect(r.stderr.trim()).toBe("remote-ledger-changed");
      expect(standin.calls("PutObject")[0]?.ifNoneMatch).toBe("*");
      expect(remoteText()).toBe(theirs);
    },
    SLOW,
  );

  test(
    "an extension is conditional on the ETag read: a writer that got in between stands",
    async () => {
      standin = startS3Standin();
      const { remote } = await twoLineRemote();
      const file = await extended(remote);
      const theirs = `${remote}theirs\n`;
      standin.beforeOp("PutObject", () => {
        standin?.putObject(BUCKET, KEY, new TextEncoder().encode(theirs));
      });
      const r = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(3);
      expect(r.stderr.trim()).toBe("remote-ledger-changed");
      expect(standin.calls("PutObject")[0]?.ifMatch).toMatch(/^"[0-9a-f]{32}"$/);
      expect(remoteText()).toBe(theirs);
    },
    SLOW,
  );

  test(
    "a read-back that differs after the put is its own word and exit 4, not done (T7)",
    async () => {
      standin = startS3Standin();
      const file = join(work(), "ledger.jsonl");
      await append(file, "plan");
      // GetObject 1 is the read (not found), 2 the read-back: something else is there by then.
      standin.beforeOp(
        "GetObject",
        () => {
          standin?.putObject(BUCKET, KEY, new TextEncoder().encode("other\n"));
        },
        2,
      );
      const r = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stderr.trim()).toBe("read-back-differs-after-write");
      expect(r.stdout).not.toContain("read back identical");
    },
    SLOW,
  );

  test(
    "a remote ledger ending in a partial line is refused as a base (T7)",
    async () => {
      standin = startS3Standin();
      const { remote } = await twoLineRemote();
      const partial = remote.slice(0, -1);
      standin.putObject(BUCKET, KEY, new TextEncoder().encode(partial));
      const file = await extended(remote);
      const r = await cli(["publish", "--file", file, "--dataset", DATASET, "--execute"]);
      expect(r.exitCode, r.all).toBe(3);
      expect(r.stderr.trim()).toBe("remote-ledger-partial-line");
      expect(remoteText()).toBe(partial);
      // The rule itself: no whole-line extension of a partial line exists.
      expect(extendsLedger(partial, remote)).toBe(false);
      expect(extendsLedger(remote, `${remote}x\n`)).toBe(true);
    },
    SLOW,
  );
});

describe("ledger-cli: what a line says is read from a proof, and the rules are versioned (I9)", () => {
  const deleted = (dataset = DATASET) => ({
    version: 1,
    dataset,
    deletedAt: "2026-10-05T00:00:00.000Z",
    assembledSha256: "a".repeat(64),
    counts: { keys: 2, versions: 5, markers: 2, prunedVersions: 3, prunedMarkers: 1 },
  });
  const deletion = (file: string, extra: string[]) =>
    cli([
      "append",
      "--file",
      file,
      "--dataset",
      DATASET,
      "--action",
      "old-versions-deleted",
      "--actor",
      "someone",
      "--scanner",
      "identifier-scan@abcdef1",
      ...extra,
    ]);

  test(
    "an interrupted and resumed delete-old: the earlier run's counts are added to the proof's, and only those",
    async () => {
      const dir = work();
      const file = join(dir, "ledger.jsonl");
      const proofPath = join(dir, "deleted.json");
      writeFileSync(proofPath, `${JSON.stringify(deleted())}\n`);
      const ok = await deletion(file, [
        "--proof",
        proofPath,
        "--earlier-run-counts",
        "versions=170,markers=1,pruned_versions=40,pruned_markers=9",
      ]);
      expect(ok.exitCode, ok.all).toBe(0);
      const line = JSON.parse(readFileSync(file, "utf8").trim());
      // The proof said versions 5, markers 2, pruned 3 and 1; keys is the plan's and is not added.
      expect(line.counts).toEqual({
        keys: 2,
        versions: 175,
        markers: 3,
        pruned_versions: 43,
        pruned_markers: 10,
      });
      // A subset is fine, and the others stay as the proof says.
      const partial = await deletion(file, [
        "--proof",
        proofPath,
        "--earlier-run-counts",
        "pruned_markers=5",
      ]);
      expect(partial.exitCode, partial.all).toBe(0);
      const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1) as string);
      expect(last.counts).toEqual({
        keys: 2,
        versions: 5,
        markers: 2,
        pruned_versions: 3,
        pruned_markers: 6,
      });

      // Never `keys`, never an unknown or malformed name, never without a proof, never for
      // another action; each is a usage error and leaves the file as it was.
      const before = readFileSync(file, "utf8");
      for (const bad of ["keys=1", "objects=1", "versions=-1", "versions", "versions=1,"]) {
        const r = await deletion(file, ["--proof", proofPath, "--earlier-run-counts", bad]);
        expect([r.exitCode, bad].join(" "), r.all).toBe(`2 ${bad}`);
      }
      const noProof = await deletion(file, ["--earlier-run-counts", "versions=1"]);
      expect(noProof.exitCode).toBe(2);
      const other = await append(file, "plan", [
        "--counts",
        "keys=1",
        "--verification",
        "plan-only",
        "--earlier-run-counts",
        "versions=1",
      ]);
      expect(other.exitCode, other.all).toBe(2);
      expect(readFileSync(file, "utf8")).toBe(before);
    },
    SLOW,
  );

  test(
    "old-versions-deleted takes its counts and its verification from deleted.json, never from typing",
    async () => {
      const dir = work();
      const file = join(dir, "ledger.jsonl");
      const proofPath = join(dir, "deleted.json");
      const text = `${JSON.stringify(deleted())}\n`;
      writeFileSync(proofPath, text);
      const ok = await deletion(file, ["--proof", proofPath]);
      expect(ok.exitCode, ok.all).toBe(0);
      const line = JSON.parse(readFileSync(file, "utf8").trim());
      expect(line.counts).toEqual({
        keys: 2,
        versions: 5,
        markers: 2,
        pruned_versions: 3,
        pruned_markers: 1,
      });
      const sha = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
      expect(line.verification).toBe(`authoritative-listing-empty+proof-${sha}`);

      // Typed counts, no proof, a proof of another dataset, a malformed proof, a contradicting word.
      const before = readFileSync(file, "utf8");
      const noProof = await deletion(file, ["--verification", "authoritative-listing-empty"]);
      expect(noProof.exitCode).toBe(2);
      expect(noProof.stderr).toContain("missing --proof");
      const typed = await deletion(file, ["--proof", proofPath, "--counts", "keys=99"]);
      expect(typed.exitCode).toBe(2);
      writeFileSync(proofPath, JSON.stringify(deleted("xx090412")));
      const other = await deletion(file, ["--proof", proofPath]);
      expect([other.exitCode, other.stderr.trim()]).toEqual([3, "proof-wrong-dataset"]);
      writeFileSync(proofPath, JSON.stringify({ ...deleted(), extra: 1 }));
      const bad = await deletion(file, ["--proof", proofPath]);
      expect([bad.exitCode, bad.stderr.trim()]).toEqual([3, "proof-invalid"]);
      writeFileSync(proofPath, text);
      const contradicts = await deletion(file, [
        "--proof",
        proofPath,
        "--verification",
        "scanner-clean",
      ]);
      expect([contradicts.exitCode, contradicts.stderr.trim()]).toEqual([
        3,
        "verification-contradicts-proof",
      ]);
      // And the listing's word cannot be claimed by another action, with or without a proof.
      const claimed = await append(file, "plan", ["--verification", "authoritative-listing-empty"]);
      expect([claimed.exitCode, claimed.stderr.trim()]).toEqual([3, "verification-needs-deletion"]);
      expect(readFileSync(file, "utf8")).toBe(before);
    },
    SLOW,
  );

  test(
    "a deletion whose plan had raw copies records them, and an earlier run's raw counts are added",
    async () => {
      const dir = work();
      const file = join(dir, "ledger.jsonl");
      const proofPath = join(dir, "deleted.json");
      const withRaw = {
        ...deleted(),
        counts: { ...deleted().counts, rawVersions: 747, rawMarkers: 127 },
      };
      writeFileSync(proofPath, `${JSON.stringify(withRaw)}\n`);
      const ok = await deletion(file, ["--proof", proofPath]);
      expect(ok.exitCode, ok.all).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8").trim()).counts).toEqual({
        keys: 2,
        versions: 5,
        markers: 2,
        pruned_versions: 3,
        pruned_markers: 1,
        raw_versions: 747,
        raw_markers: 127,
      });
      // An interrupted run removed some raw copies before the last one: those are added too.
      const resumed = await deletion(file, [
        "--proof",
        proofPath,
        "--earlier-run-counts",
        "raw_versions=3,raw_markers=1,versions=1",
      ]);
      expect(resumed.exitCode, resumed.all).toBe(0);
      const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1) as string);
      expect(last.counts).toMatchObject({ versions: 6, raw_versions: 750, raw_markers: 128 });

      // A proof without raw copies records none, and takes no raw count from an earlier run: no
      // run of that plan deleted one.
      writeFileSync(proofPath, `${JSON.stringify(deleted())}\n`);
      const before = readFileSync(file, "utf8");
      const plain = await deletion(file, ["--proof", proofPath]);
      expect(plain.exitCode, plain.all).toBe(0);
      const plainLine = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1) as string);
      expect(Object.keys(plainLine.counts)).not.toContain("raw_versions");
      expect(Object.keys(plainLine.counts)).not.toContain("raw_markers");
      const afterPlain = readFileSync(file, "utf8");
      for (const extra of ["raw_versions=1", "raw_markers=1", "raw_names=1"]) {
        const r = await deletion(file, ["--proof", proofPath, "--earlier-run-counts", extra]);
        expect([r.exitCode, extra].join(" "), r.all).toBe(`2 ${extra}`);
      }
      expect(readFileSync(file, "utf8")).toBe(afterPlain);
      expect(afterPlain.startsWith(before)).toBe(true);
      // Half the pair is not a proof delete-old writes.
      writeFileSync(
        proofPath,
        JSON.stringify({ ...deleted(), counts: { ...deleted().counts, rawVersions: 1 } }),
      );
      const half = await deletion(file, ["--proof", proofPath]);
      expect([half.exitCode, half.stderr.trim()]).toEqual([3, "proof-invalid"]);
    },
    SLOW,
  );

  test("the scanner revision is the last commit that touched ANY rule file", () => {
    const repo = work();
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
    };
    const g = (...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: repo, env });
      if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
      return new TextDecoder().decode(r.stdout).trim();
    };
    g("init", "-q", "-b", "main");
    // Written out here, not taken from the module: a list that lost a file must fail this.
    const RULES = [
      "shared/identifier-scan.ts",
      "shared/identifier-scrub.ts",
      "scripts/scrub/s3/zarr-json.ts",
    ];
    expect([...SCANNER_RULE_FILES] as string[]).toEqual(RULES);
    for (const f of RULES) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), "1\n");
    }
    writeFileSync(join(repo, "other.txt"), "1\n");
    g("add", ".");
    g("commit", "-q", "-m", "all");
    // Each rule file touched last in turn; a commit touching no rule file after it changes nothing.
    for (const f of [...RULES].reverse()) {
      writeFileSync(join(repo, f), `changed ${f}\n`);
      g("commit", "-q", "-am", `touch ${f}`);
      const want = g("rev-parse", "--short", "HEAD");
      writeFileSync(join(repo, "other.txt"), `${f}\n`);
      g("commit", "-q", "-am", "unrelated");
      expect(scannerRevision(repo), f).toBe(`identifier-scan@${want}`);
    }
  });
});
