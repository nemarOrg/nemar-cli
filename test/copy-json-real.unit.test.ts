/**
 * `git annex copy --json --json-error-messages`, parsed from what git-annex really
 * prints.
 *
 * Every failing record below is captured from a real failing copy against a real
 * `directory` special remote: a read-only store, which fails mid-transfer, and a
 * missing store, which git-annex declines up front. The two differ in where the
 * reason lives (`error-messages` against `note`), which is exactly what error JSON
 * written by hand cannot be trusted to get right.
 *
 * Assertions that read git-annex's own prose, or the shape of a record, rather than
 * ours are marked "version-coupled": they hold on git-annex 10.20260901 and are the
 * ones to look at first if a different git-annex build fails this file.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { redactCredentials } from "../src/lib/git-annex/run-command";
import {
  checkRemoteHolds,
  copyPathsToAnnexRemote,
  copyToAnnexRemote,
  extractCopyJsonError,
  parseCopyJson,
} from "../src/lib/git-annex/transfer";
import {
  chmodTreeWritable,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";
import { installGitShim } from "./helpers/git-shim";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-copy-json");
// A read-only directory does not stop root, so the read-only captures cannot run as
// root; under root the test of the de-duplication (which only that failure shape
// exercises) is skipped, and removing the de-duplication goes unnoticed there.
const canBlockWrites = process.getuid?.() !== 0;

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

interface Capture {
  repo: string;
  store: string;
  paths: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

function copyArgs(paths: string[]): string[] {
  return [
    "git",
    "annex",
    "copy",
    "--to",
    "store",
    "-J",
    "2",
    "--json",
    "--json-error-messages",
    "--",
    ...paths,
  ];
}

/**
 * Annex `count` files, break the remote as `how`, and capture a real JSON copy.
 *
 * `read-only` first copies one file so the store has its `tmp` directory, then makes
 * the store read-only: the next object cannot create its hash directory, which is the
 * failure whose message git-annex repeats inside the record. The copy that is
 * captured covers only the files after that first one.
 */
async function captureCopy(how: "none" | "read-only" | "missing", count: number): Promise<Capture> {
  const repo = await newDatasetRepo(scratch.root, `capture-${how}`);
  const all = Array.from({ length: count + 1 }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
  for (const [i, p] of all.entries()) writeFile(repo, p, `${i}`.repeat(2_000 + i));
  expect((await gitAnnexAdd(repo, all)).success).toBe(true);
  const store = await initDirectoryRemote(scratch.root, repo, "store");
  let paths = all.slice(0, count);
  if (how === "read-only") {
    const first = await run(["git", "annex", "copy", "--to", "store", "--", all[0]], repo);
    expect(first.exitCode).toBe(0);
    paths = all.slice(1);
    chmodSync(store, 0o555);
  }
  if (how === "missing") renameSync(store, `${store}.gone`);
  const copy = await run(
    [
      "git",
      "annex",
      "copy",
      "--to",
      "store",
      "-J",
      "2",
      "--json",
      "--json-error-messages",
      "--",
      ...paths,
    ],
    repo,
  );
  return { repo, store, paths, ...copy };
}

describe("parseCopyJson against real output", () => {
  test("a successful copy yields one success record per file, and the progress note is no error", async () => {
    const cap = await captureCopy("none", 3);
    expect(cap.exitCode).toBe(0);
    const records = parseCopyJson(cap.stdout);
    expect(records.map((r) => r.file).sort()).toEqual([...cap.paths].sort());
    for (const r of records) {
      expect(r.success).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.key).toMatch(/^SHA256E-s\d+--/);
    }
  });

  test("a record says whether git-annex moved the content or found it already there", async () => {
    // Guards `transferred`. The first copy sends everything; the second finds it all
    // already at the store and moves nothing; with the store emptied behind git-annex's
    // back the third is a re-send, even though the location log still says "present".
    const cap = await captureCopy("none", 3);
    expect(parseCopyJson(cap.stdout).map((r) => r.transferred)).toEqual([true, true, true]);

    const again = await run(copyArgs(cap.paths), cap.repo);
    expect(again.exitCode).toBe(0);
    const present = parseCopyJson(again.stdout);
    expect(present).toHaveLength(3);
    expect(present.every((r) => r.success && !r.transferred)).toBe(true);

    chmodTreeWritable(cap.store);
    for (const entry of readdirSync(cap.store)) {
      rmSync(join(cap.store, entry), { recursive: true, force: true });
    }
    const resent = await run(copyArgs(cap.paths), cap.repo);
    expect(parseCopyJson(resent.stdout).every((r) => r.success && r.transferred)).toBe(true);
    // The functions built on it carry the count.
    const counted = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(counted).toMatchObject({ success: true, filesCopied: 3, filesSent: 0 });
  });

  test("a failed record that carries only the progress note has no reason to report", () => {
    // Pure on purpose: no real failure was found that puts ONLY the progress note in a
    // failed record, so this guards the filter against that shape rather than a capture.
    const stdout =
      '{"command":"copy","error-messages":[],"file":"a.edf","key":"K","note":"to store...","success":false}\n';
    expect(parseCopyJson(stdout)).toEqual([
      { file: "a.edf", key: "K", success: false, transferred: false, errors: [] },
    ]);
  });

  test("lines that are not JSON records are ignored around real ones", async () => {
    const cap = await captureCopy("none", 2);
    const noisy = `(recording state in git...)\n${cap.stdout}\n{not json\n{"command":"copy"}\n`;
    expect(parseCopyJson(noisy)).toEqual(parseCopyJson(cap.stdout));
    expect(parseCopyJson(noisy)).toHaveLength(2);
  });

  test("a record of another command is not counted as a copy", async () => {
    const cap = await captureCopy("none", 1);
    const found = await run(["git", "annex", "whereis", "--json", "--", cap.paths[0]], cap.repo);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain('"command":"whereis"');
    expect(parseCopyJson(found.stdout)).toEqual([]);
  });

  test.skipIf(!canBlockWrites)(
    "a transfer that failed carries its reason once per record, de-duplicated",
    async () => {
      const cap = await captureCopy("read-only", 2);
      expect(cap.exitCode).not.toBe(0);
      const raw = cap.stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { "error-messages": string[] });
      const records = parseCopyJson(cap.stdout);
      expect(records).toHaveLength(2);
      for (const [i, r] of records.entries()) {
        expect(r.success).toBe(false);
        // The premise, measured: git-annex repeats the message inside the record...
        expect(raw[i]["error-messages"].length).toBeGreaterThan(1);
        // ...and the parse keeps it once.
        expect(r.errors).toHaveLength(1);
        // Version-coupled: the OS wording. What matters is that a reason is present
        // and names the store it could not write to.
        expect(r.errors[0]).toContain(cap.store);
      }
    },
  );

  test("a remote git-annex declined up front has its reason in the note, not in error-messages", async () => {
    const cap = await captureCopy("missing", 2);
    expect(cap.exitCode).not.toBe(0);
    // Version-coupled: the shape that broke the first parse (success false,
    // error-messages empty, reason in the note). An older git-annex may put the
    // reason in error-messages, and then this premise, not the parse, is what moves.
    const raw = cap.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw).toHaveLength(2);
    for (const r of raw) {
      expect(r.success).toBe(false);
      expect(r["error-messages"]).toEqual([]);
    }
    const records = parseCopyJson(cap.stdout);
    for (const r of records) {
      expect(r.success).toBe(false);
      expect(r.errors).toHaveLength(1);
      // Version-coupled: git-annex's wording; the store it names is the stable part.
      expect(r.errors[0]).toContain(cap.store);
    }
  });
});

describe("a git-annex that exits 0 and says something unexpected", () => {
  test("is reported as unrecognized, so a count of zero is not read as a verdict", async () => {
    // The shim stands in for a git-annex whose output format changed. The location log
    // is still the authority on what arrived; this only keeps "confirmed 0 of N" from
    // being printed as though it measured something.
    const cap = await captureCopy("none", 2);
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: "Wir haben kopiert (pretend new format)" },
    ]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result).toMatchObject({
        success: true,
        filesCopied: 0,
        filesSent: 0,
        output: "unrecognized",
      });
    } finally {
      restore();
    }
  });

  test("a clean exit with fewer records than paths is partial: readable and incomplete", async () => {
    // `git annex copy` skips a path whose content is not here, with exit 0 and no record.
    // Two paths and one record means one path went unreported, so the counts are partial.
    // The output WAS understood; it is the answer that is incomplete, and the two are
    // worded differently for the person reading them.
    const cap = await captureCopy("none", 2);
    const one = `{"command":"copy","error-messages":[],"file":"${cap.paths[0]}","key":"K","success":true}`;
    const restore = installGitShim(scratch.root, [{ match: "annex copy", stdout: one }]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result).toMatchObject({ success: true, filesCopied: 1, output: "partial" });
    } finally {
      restore();
    }
  });

  test("a clean exit with a failed record is a failure, whatever the exit status says", async () => {
    const cap = await captureCopy("none", 1);
    const failed = `{"command":"copy","error-messages":["store rejected it"],"file":"${cap.paths[0]}","key":"K","success":false}`;
    const restore = installGitShim(scratch.root, [{ match: "annex copy", stdout: failed }]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("store rejected it");
    } finally {
      restore();
    }
  });
});

describe("counting by the note must never decide success", () => {
  // The count of files "sent" rests on the progress note git-annex puts in a record that
  // moved content. A git-annex that omits or rewords it makes the count low; these show
  // that costs wording only: success, the records counted as copied, and recognition stay.
  const record = (file: string, note?: string) =>
    JSON.stringify({
      command: "copy",
      "error-messages": [],
      file,
      key: `K-${file}`,
      ...(note === undefined ? {} : { note }),
      success: true,
    });

  test("records with no note at all are successes that sent nothing, as far as anyone can tell", async () => {
    const cap = await captureCopy("none", 2);
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: cap.paths.map((p) => record(p)).join("\n") },
    ]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result).toEqual({
        success: true,
        filesCopied: 2,
        filesSent: 0,
        output: "understood",
      });
    } finally {
      restore();
    }
  });

  test("notes worded differently are not counted as sent, and change nothing else", () => {
    const stdout = [
      record("a.edf", "uploading to store"),
      record("b.edf", "to store..."),
      record("c.edf", "Uploading to store..."),
    ].join("\n");
    const records = parseCopyJson(stdout);
    expect(records.map((r) => r.success)).toEqual([true, true, true]);
    expect(records.map((r) => r.transferred)).toEqual([false, true, false]);
  });
});

describe("file names in error text", () => {
  test("extractCopyJsonError shows a failed file's name escaped", () => {
    // Guards displayName on `file`/`key`: the error text is printed to a terminal.
    const records = parseCopyJson(
      JSON.stringify({
        command: "copy",
        "error-messages": ["store rejected it"],
        file: "bad\x1b[2Jname\n.edf",
        key: "K",
        success: false,
      }),
    );
    // The parsed record keeps the real name, which callers match against their own paths.
    expect(records[0].file).toBe("bad\x1b[2Jname\n.edf");
    const text = extractCopyJsonError(records, "", "", 1);
    expect(text).toContain("bad\\x1b[2Jname\\n.edf: store rejected it");
    expect(text).not.toContain("\x1b");
  });

  test("a real failed copy of a file with an ESCAPE in its name prints no ESCAPE", async () => {
    if (!canBlockWrites) return;
    const repo = await newDatasetRepo(scratch.root, "copy-escape-name");
    const name = "esc\x1b[31mred.edf";
    writeFile(repo, name, "x".repeat(3_000));
    writeFile(repo, "first.edf", "y".repeat(3_000));
    expect((await gitAnnexAdd(repo, [name, "first.edf"])).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect(
      (await run(["git", "annex", "copy", "--to", "store", "--", "first.edf"], repo)).exitCode,
    ).toBe(0);
    chmodSync(store, 0o555);
    try {
      const result = await copyPathsToAnnexRemote(repo, "store", [name], 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("red.edf");
      expect(result.error).not.toContain("\x1b");
    } finally {
      chmodSync(store, 0o755);
    }
  });
});

describe("credentials never reach what is printed", () => {
  // Captured from a real failing git-annex call (an S3 initremote through a refused
  // proxy, with a made-up session token). git-annex redacts only `Authorization`; the
  // request it prints carries `X-Amz-Security-Token` in clear, and the same dump is what
  // lands in a copy record's `note` when a presence check or an upload fails.
  const TOKEN = "FAKE-SESSION-TOKEN-0123456789";
  const SECRET = "fakesecretkeyfakesecretkey";
  const DUMP = `git-annex: HttpExceptionRequest Request {
  host                 = "no-such-bucket-zzz.s3-us-east-2.amazonaws.com"
  port                 = 443
  secure               = True
  requestHeaders       = [("Date","Thu, 08 Oct 2026 05:59:01 GMT"),("Authorization","<REDACTED>"),("X-Amz-Content-Sha256","2cdb5df2bf7e7601d5b4af81469c0bcbf2a1f82d770a6ceddfbb574e7d97a6a7"),("X-Amz-Date","20261008T055901Z"),("X-Amz-Security-Token","${TOKEN}"),("User-Agent","git-annex/10.20260901")]
  path                 = "/"
  queryString          = ""
  method               = "PUT"
  proxy                = Nothing
  rawBody              = False
  redirectCount        = 10
  responseTimeout      = ResponseTimeoutDefault
  requestVersion       = HTTP/1.1
  proxySecureMode      = ProxySecureWithConnect
}
 (InternalException (HostCannotConnect "127.0.0.1" [Network.Socket.connect: <socket: 12>: does not exist (Connection refused)]))`;
  const failedLine = (note: string) =>
    JSON.stringify({
      command: "copy",
      "error-messages": [],
      file: "a.edf",
      key: "K",
      note,
      success: false,
    });

  test("the premise: the dump really carries the token", () => {
    expect(DUMP).toContain(TOKEN);
  });

  test("a failed record's note is stripped of x-amz-* and authorization headers and cut to a line", () => {
    const [record] = parseCopyJson(failedLine(DUMP));
    const reason = record.errors.join(" ");
    expect(reason).not.toContain(TOKEN);
    expect(reason).not.toContain('x-amz-security-token","FAKE');
    expect(reason).toContain("<redacted>");
    // What matters for diagnosis survives: the exception at the end of the dump.
    expect(reason).toContain("HostCannotConnect");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(700);
  });

  test("a very long reason is cut in the middle, keeping its start and the exception at its end", () => {
    // Guards the cap. The dump above is under it; a request with many headers is not.
    const long = `${DUMP.replace("requestHeaders", `pad = [${'("X-Pad","y")'.repeat(400)}]\n  requestHeaders`)}`;
    expect(long.length).toBeGreaterThan(5_000);
    const [record] = parseCopyJson(failedLine(long));
    const reason = record.errors.join(" ");
    expect(reason.length).toBeLessThanOrEqual(700);
    expect(reason.startsWith("git-annex: HttpExceptionRequest")).toBe(true);
    expect(reason).toContain(" ... ");
    expect(reason).toContain("HostCannotConnect");
    expect(reason).not.toContain(TOKEN);
  });

  test("the same goes for error-messages, and for a secret that is not in a header", () => {
    const line = JSON.stringify({
      command: "copy",
      "error-messages": [DUMP, `signing with ${SECRET} failed`],
      file: "a.edf",
      key: "K",
      success: false,
    });
    const [record] = parseCopyJson(line, [SECRET, TOKEN]);
    const text = record.errors.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("signing with <redacted> failed");
  });

  test("through copyPathsToAnnexRemote the token is in neither the error nor what git-annex printed on stderr", async () => {
    const cap = await captureCopy("none", 1);
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: failedLine(DUMP), exit: 1 },
    ]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2, {
        accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
        secretAccessKey: SECRET,
        sessionToken: TOKEN,
      });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain(TOKEN);
      expect(result.error).not.toContain(SECRET);
      expect(result.error).toContain("HostCannotConnect");
    } finally {
      restore();
    }
  });

  test("stderr is redacted too", async () => {
    const cap = await captureCopy("none", 1);
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", message: `fatal: request signed with ${TOKEN}`, exit: 1 },
    ]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2, {
        accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
        secretAccessKey: SECRET,
        sessionToken: TOKEN,
      });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain(TOKEN);
      expect(result.error).toContain("<redacted>");
    } finally {
      restore();
    }
  });

  test("credentials the process inherits are redacted too, not only the ones it was handed", async () => {
    // Guards credentialValues reading process.env. The import path runs on ambient AWS_*
    // variables and passes no credentials down, yet the child inherits them.
    const ambient = "AMBIENT-SESSION-TOKEN-0123456789";
    const cap = await captureCopy("none", 1);
    const failed = JSON.stringify({
      command: "copy",
      "error-messages": [`signing with ${ambient} failed`],
      file: cap.paths[0],
      key: "K",
      success: false,
    });
    const restore = installGitShim(scratch.root, [
      { match: "annex copy", stdout: failed, exit: 1 },
    ]);
    const before = process.env.AWS_SESSION_TOKEN;
    process.env.AWS_SESSION_TOKEN = ambient;
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("signing with <redacted> failed");
      expect(result.error).not.toContain(ambient);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "AWS_SESSION_TOKEN");
      else process.env.AWS_SESSION_TOKEN = before;
      restore();
    }
  });

  test("redactCredentials blanks header tuples in any case and any given secret", () => {
    expect(redactCredentials('("x-amz-security-token","abc")', [])).toBe(
      '("x-amz-security-token","<redacted>")',
    );
    expect(redactCredentials('("AUTHORIZATION","AWS4 Credential=x")', [])).toBe(
      '("AUTHORIZATION","<redacted>")',
    );
    expect(redactCredentials("value LONGSECRETVALUE here", ["LONGSECRETVALUE"])).toBe(
      "value <redacted> here",
    );
    // A short or empty "secret" must not blank half the message.
    expect(redactCredentials("a b c", ["", "b"])).toBe("a b c");
    expect(redactCredentials("unrelated text", [TOKEN])).toBe("unrelated text");
  });
});

describe("checkRemoteHolds: files whose content is not in this repository", () => {
  /** n files copied to the store, then every local copy of their content dropped. */
  async function droppedAfterCopy(name: string, n: number) {
    const repo = await newDatasetRepo(scratch.root, name);
    const paths = Array.from({ length: n }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
    for (const [i, p] of paths.entries()) writeFile(repo, p, `${i}`.repeat(2_000 + i));
    expect((await gitAnnexAdd(repo, paths)).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect(
      (await run(["git", "annex", "copy", "--to", "store", "--", ...paths], repo)).exitCode,
    ).toBe(0);
    expect((await run(["git", "annex", "drop", "--force", "--", ...paths], repo)).exitCode).toBe(0);
    return { repo, store, paths };
  }

  test("copy cannot check them: it exits 0 with no record and never contacts the remote", async () => {
    // The premise that makes this function necessary, measured: with the remote's object
    // gone, a copy over the path still exits 0 and reports nothing about it.
    const { repo, store, paths } = await droppedAfterCopy("copy-skips", 2);
    chmodTreeWritable(store);
    for (const entry of readdirSync(store))
      rmSync(join(store, entry), { recursive: true, force: true });
    const result = await copyPathsToAnnexRemote(repo, "store", paths, 2);
    expect(result.success).toBe(true);
    expect(result.filesCopied).toBe(0);
    expect(result.output).toBe("partial");
  });

  test("a file the remote holds is present, a file it lost is reported absent and the log is corrected", async () => {
    const { repo, store, paths } = await droppedAfterCopy("fsck-finds-loss", 3);
    const key = (await run(["git", "annex", "lookupkey", "--", paths[1]], repo)).stdout.trim();
    chmodTreeWritable(store);
    const victims = (readdirSync(store, { recursive: true }) as string[]).filter(
      (e) => e.endsWith(`/${key}`) || e.endsWith(`/${key}/${key}`),
    );
    expect(victims.length).toBeGreaterThan(0);
    for (const v of victims) rmSync(join(store, v), { recursive: true, force: true });
    // The log still says all three are there.
    expect((await run(["git", "annex", "find", "--not", "--in", "store"], repo)).stdout).toBe("");

    const outcome = await checkRemoteHolds(repo, "store", paths, 2);

    expect(outcome.success).toBe(true);
    expect(outcome.present).toBe(2);
    expect(outcome.absent.map((a) => a.file)).toEqual([paths[1]]);
    // git-annex wrote the loss into the location log, where the next walk sees it.
    expect(
      (await run(["git", "annex", "find", "--not", "--in", "store"], repo)).stdout.trim(),
    ).toBe(paths[1]);
  });

  test("a repository that wants two copies does not fail a file the remote holds", async () => {
    // Guards --numcopies=1 --mincopies=1. fsck also enforces the repository's numcopies:
    // with `git annex numcopies 2` and the one copy at the store it fails a file the store
    // DOES hold ("Only 1 of 2 trustworthy copies exist"), and no re-run can help.
    const { repo, paths } = await droppedAfterCopy("fsck-numcopies", 2);
    expect((await run(["git", "annex", "numcopies", "2"], repo)).exitCode).toBe(0);
    // The premise: a bare fsck over the same files does fail them.
    const bare = await run(
      ["git", "annex", "fsck", "--fast", "--from", "store", "--", ...paths],
      repo,
    );
    expect(bare.exitCode).not.toBe(0);

    const outcome = await checkRemoteHolds(repo, "store", paths, 2);

    expect(outcome).toMatchObject({
      success: true,
      present: 2,
      absent: [],
      unanswered: [],
      output: "understood",
    });
  });

  test("a path fsck printed no record for is unanswered, never present", async () => {
    // Guards `unanswered`. A clean exit with one record for two paths leaves one path
    // unasked; the old reading counted what it saw and called the rest fine.
    const { repo, paths } = await droppedAfterCopy("fsck-partial", 2);
    const one = `{"command":"fsck","error-messages":[],"file":"${paths[0]}","key":"K","success":true}`;
    const restore = installGitShim(scratch.root, [{ match: "annex fsck", stdout: one }]);
    try {
      const outcome = await checkRemoteHolds(repo, "store", paths, 2);
      expect(outcome).toMatchObject({
        success: true,
        present: 1,
        absent: [],
        unanswered: [paths[1]],
        output: "partial",
      });
    } finally {
      restore();
    }
  });

  test("a file name with an ESCAPE in it never reaches the reasons raw", async () => {
    // Guards `clean`. git-annex echoes the name inside its messages ("** Based on the
    // location log, <name>"), and shortening only collapses whitespace, so an ESCAPE
    // sequence in the name would reach the terminal through the reason.
    const repo = await newDatasetRepo(scratch.root, "fsck-escape-name");
    const name = "esc\x1b[31mred.edf";
    writeFile(repo, name, "x".repeat(3_000));
    expect((await gitAnnexAdd(repo, [name])).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect((await run(["git", "annex", "copy", "--to", "store", "--", name], repo)).exitCode).toBe(
      0,
    );
    expect((await run(["git", "annex", "drop", "--force", "--", name], repo)).exitCode).toBe(0);
    chmodTreeWritable(store);
    for (const entry of readdirSync(store))
      rmSync(join(store, entry), { recursive: true, force: true });

    const outcome = await checkRemoteHolds(repo, "store", [name], 2);

    expect(outcome.absent).toHaveLength(1);
    // The record keeps the real path: callers match it against what they asked about.
    expect(outcome.absent[0].file).toBe(name);
    const reasons = outcome.absent[0].errors.join("\n");
    expect(reasons).toContain("red.edf");
    expect(reasons).not.toContain("\x1b");
    expect(reasons).toContain("\\x1b[31mred.edf");
  });

  test("a remote that cannot be reached is reported per file with its reason, not as present", async () => {
    const { repo, store, paths } = await droppedAfterCopy("fsck-unreachable", 2);
    renameSync(store, `${store}.gone`);
    const outcome = await checkRemoteHolds(repo, "store", paths, 2);
    expect(outcome.present).toBe(0);
    expect(outcome.absent.map((a) => a.file).sort()).toEqual([...paths].sort());
    expect(outcome.absent[0]?.errors.join(" ")).toContain(store);
  });
});

describe("extractCopyJsonError against real output", () => {
  test("names each failed file with the cause git-annex gave, for a declined remote", async () => {
    const cap = await captureCopy("missing", 2);
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
    expect(msg).toContain("2 file(s) failed to copy:");
    for (const p of cap.paths) expect(msg).toContain(`${p}: `);
    expect(msg).toContain(cap.store);
    expect(msg).not.toMatch(/: failed$/m);
    // git-annex's own stderr summary is appended whatever it says.
    expect(msg).toContain(cap.stderr.trim());
  });

  test.skipIf(!canBlockWrites)(
    "names each failed file with the cause for a failed transfer",
    async () => {
      const cap = await captureCopy("read-only", 2);
      const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
      expect(msg).toContain("2 file(s) failed to copy:");
      for (const p of cap.paths) expect(msg).toContain(`${p}: `);
      // Once per file, not twice: the duplicate inside each record is dropped.
      expect(msg.split(cap.store).length - 1).toBe(cap.paths.length);
    },
  );

  test("with no failed record it says what it knows: stderr and the exit code", async () => {
    const cap = await captureCopy("none", 1);
    expect(
      extractCopyJsonError(parseCopyJson(cap.stdout), "", "fatal: not a git repository", 128),
    ).toBe("git annex copy failed with exit code 128: fatal: not a git repository");
  });

  test("success-only output with a non-zero exit never turns a JSON line into the message", async () => {
    // Every record carries an `error-messages` key, so searching stdout for error words
    // would match a SUCCESS record and surface the raw JSON as the error.
    const cap = await captureCopy("none", 2);
    expect(cap.stdout).toContain("error-messages");
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, "", 1);
    expect(msg).toBe("git annex copy failed with exit code 1 without saying why");
    expect(msg).not.toContain("{");
  });

  test("output that is not copy records is called what it is", () => {
    expect(extractCopyJsonError([], "something unexpected\n", "", 1)).toBe(
      "git annex copy failed with exit code 1; its output was not recognized as copy records",
    );
    expect(extractCopyJsonError([], "something unexpected\n", "boom", 2)).toBe(
      "git annex copy failed with exit code 2; its output was not recognized as copy records: boom",
    );
  });

  test("a killed git-annex is reported with its exit code, not as a generic failure", async () => {
    // The shim kills only `git annex copy`; everything else runs the real git.
    const cap = await captureCopy("none", 2);
    const restore = installGitShim(scratch.root, [{ match: "annex copy", kill: true }]);
    try {
      const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("exit code 137");
      expect(result.error).not.toBe("Failed to copy to remote");
    } finally {
      restore();
    }
  });

  test("bounds a many-file failure to the last failures, and says how many it left out", async () => {
    const cap = await captureCopy("missing", 30);
    const records = parseCopyJson(cap.stdout);
    expect(records).toHaveLength(30);
    const lines = extractCopyJsonError(records, cap.stdout, cap.stderr).split("\n");
    expect(lines[0]).toBe("30 file(s) failed to copy:");
    expect(lines[1]).toContain("10 earlier failed files omitted");
    // header, omission line, the 20 kept failures, git-annex's own summary line
    expect(lines).toHaveLength(23);
  });
});

describe("the copy functions report the cause end to end", () => {
  test("copyPathsToAnnexRemote returns the declined-remote reason and counts no success", async () => {
    const cap = await captureCopy("none", 2);
    // Re-break the remote for the production function under test.
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(result.success).toBe(false);
    expect(result.filesCopied).toBe(0);
    expect(result.error).toContain(cap.store);
  });

  test("copyToAnnexRemote returns the declined-remote reason too", async () => {
    const cap = await captureCopy("none", 2);
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyToAnnexRemote(cap.repo, "store", 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain(cap.store);
  });
});
