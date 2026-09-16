/**
 * Recovering a dataset's missing content end to end (#1396).
 *
 * Driven against a real git-annex repository and a real `aws` on PATH -- a shim
 * that prints what the AWS CLI prints -- because the parts that matter here are
 * the seams: what a key's `.log.rmet` says, what `git annex find` reports, and
 * what the code does with an answer from S3 that does not match the key.
 *
 * The test with teeth is the last one. A copy that arrives wrong must leave
 * nothing behind: an object sitting under the key's name is what the next
 * registration sweep would find and advertise as the dataset's content.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annexedKeyPaths,
  destinationPrefix,
  readPinnedSources,
  recoverDatasetContent,
} from "../src/lib/fleet-content-recovery";
import { REMOTE_NAME } from "../src/lib/fleet-key-registration";
import { runCommand } from "../src/lib/git-annex/run-command";
import { annexKeyDeclaredSize } from "../src/lib/s3-server-copy";

let root: string;
let origin: string;
let workRoot: string;
let shimDir: string;
let realPath: string | undefined;
const scratch: string[] = [];

/** Where the shim records every invocation, so assertions are about real calls. */
function shimLog(): string[] {
  const path = join(shimDir, "calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function installAwsShim(body: string): void {
  writeFileSync(
    join(shimDir, "aws"),
    `#!/bin/sh
echo "$@" >> "${join(shimDir, "calls.log")}"
case "$1" in
  --version) echo "aws-cli/2.0.0 shim"; exit 0 ;;
esac
${body}
`,
  );
  chmodSync(join(shimDir, "aws"), 0o755);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

/**
 * Commit a file onto the git-annex branch, which has no porcelain.
 *
 * `setpresentkey` writes a location log and nothing writes an `.rmet` from
 * outside git-annex, so the remote-metadata records this reads have to be built
 * with plumbing -- against a real branch, read back by the real parser.
 */
async function writeAnnexBranchFile(repo: string, path: string, content: string): Promise<void> {
  const blob = (
    await runCommand(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: content })
  ).stdout.trim();
  const index = join(repo, ".git", "annex-branch-index");
  const env = { GIT_INDEX_FILE: index };
  await runCommand(["git", "read-tree", "git-annex"], { cwd: repo, env });
  await runCommand(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], {
    cwd: repo,
    env,
  });
  const tree = (await runCommand(["git", "write-tree"], { cwd: repo, env })).stdout.trim();
  const commit = (
    await runCommand(["git", "commit-tree", tree, "-p", "git-annex", "-m", "test record"], {
      cwd: repo,
      env,
    })
  ).stdout.trim();
  await git(["git", "update-ref", "refs/heads/git-annex", commit], repo);
  rmSync(index, { force: true });
}

/** The hash-directory git-annex files a key's records under. */
async function hashDir(repo: string, key: string): Promise<string> {
  const out = await git(["git", "annex", "examinekey", "--format=${hashdirlower}", key], repo);
  return out.trim();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nemar-recovery-"));
  scratch.push(root);
  shimDir = join(root, "bin");
  mkdirSync(shimDir, { recursive: true });
  realPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${realPath ?? ""}`;

  origin = join(root, "origin");
  workRoot = join(root, "work");
  mkdirSync(origin, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  await git(["git", "init", "-q", "--initial-branch", "main", "."], origin);
  await git(["git", "config", "user.email", "test@nemar.test"], origin);
  await git(["git", "config", "user.name", "NEMAR Test"], origin);
  // A clone of this is pushed to later by nothing, but git-annex still refuses
  // to work in a bare-less repo it cannot check out.
  await git(["git", "config", "receive.denyCurrentBranch", "ignore"], origin);
  await git(["git", "annex", "init", "--quiet", "origin"], origin);
}, 120_000);

afterEach(() => {
  // `process.env.PATH = undefined` writes the STRING "undefined" for the rest of
  // this shared `bun test` process, which would break every later test that
  // shells out. Delete instead, the way curl-stream-copy.unit.test.ts does.
  // Restoring env needs the key GONE: assigning undefined stores the literal
  // string "undefined" for the rest of this shared `bun test` process, which
  // breaks every later test that shells out.
  if (realPath === undefined) {
    // biome-ignore lint/performance/noDelete: the rule targets hot-path objects, not env teardown.
    delete process.env.PATH;
  } else {
    process.env.PATH = realPath;
  }
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Annex one file in the origin and return its key. */
async function addAnnexedFile(name: string, content: string): Promise<string> {
  const path = join(origin, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  await git(["git", "annex", "add", "--quiet", name], origin);
  await git(["git", "commit", "-qm", `add ${name}`], origin);
  const listed = await git(
    ["git", "annex", "find", "--include", "*", "--format=${key} ${file}\n"],
    origin,
  );
  const line = listed.split("\n").find((l) => l.endsWith(` ${name}`));
  if (!line) throw new Error(`no key for ${name}`);
  return line.slice(0, line.length - name.length - 1);
}

describe("annexedKeyPaths", () => {
  test("reports every path that references a key, not just one", async () => {
    // An upstream lookup is by path, and a key stored under two names has two
    // chances to be found. Keeping only the first would report content as
    // unrecoverable because the name it happened to pick was the renamed one.
    const key = await addAnnexedFile("a.dat", "shared content");
    writeFileSync(join(origin, "b.dat"), readFileSync(join(origin, "a.dat")));
    await git(["git", "annex", "add", "--quiet", "b.dat"], origin);
    await git(["git", "commit", "-qm", "add b"], origin);

    const paths = await annexedKeyPaths(origin);

    expect(paths.get(key)?.sort()).toEqual(["a.dat", "b.dat"]);
  }, 120_000);
});

describe("readPinnedSources", () => {
  test("reads the S3 version git-annex recorded for a key", async () => {
    const key = await addAnnexedFile("a.dat", "content of a");
    await writeAnnexBranchFile(
      origin,
      "remote.log",
      "9e1479f6-49e0-413b-8222-a7f8000f55a6 bucket=openneuro.org name=s3-PUBLIC type=S3 versioning=yes\n",
    );
    await writeAnnexBranchFile(
      origin,
      `${await hashDir(origin, key)}${key}.log.rmet`,
      "1789149471s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +VERSIONID#ds000001/a.dat\n",
    );

    const pins = await readPinnedSources(origin, [key]);

    expect(pins.get(key)).toEqual([
      {
        bucket: "openneuro.org",
        object: "ds000001/a.dat",
        version: "VERSIONID",
        remoteName: "s3-PUBLIC",
      },
    ]);
  }, 120_000);

  test("returns nothing for a key whose record is for a remote with no bucket", async () => {
    const key = await addAnnexedFile("a.dat", "content of a");
    await writeAnnexBranchFile(
      origin,
      "remote.log",
      "d23d62dc-2acd-4407-ac4a-cbba92096832 externaltype=openneuro name=openneuro type=external\n",
    );
    await writeAnnexBranchFile(
      origin,
      `${await hashDir(origin, key)}${key}.log.rmet`,
      "1789149471s d23d62dc-2acd-4407-ac4a-cbba92096832:V +V#ds/a.dat\n",
    );

    expect(await readPinnedSources(origin, [key])).toEqual(new Map());
  }, 120_000);
});

describe("destinationPrefix", () => {
  test("uses the remote's own fileprefix, so a copy lands where it looks", async () => {
    await writeAnnexBranchFile(
      origin,
      "remote.log",
      "ca4da2fe-2a4c-49b1-abd6-00fc9ec1ff30 bucket=nemar fileprefix=on000001/annexed/ name=nemar-s3 type=S3\n",
    );
    expect(await destinationPrefix(origin, "on000001")).toBe("on000001/annexed/");
  }, 120_000);

  test("falls back to the conventional prefix when the branch names none", async () => {
    expect(await destinationPrefix(origin, "on000001")).toBe("on000001/objects/");
  }, 120_000);

  test("refuses to guess a prefix when the branch could not be read at all", async () => {
    // The fallback is right for "asked, and there is no such remote". It is a
    // guess for "could not ask", and a wrong prefix sends the copy somewhere
    // the annex never looks: reported recovered, still missing on the next
    // sweep. git distinguishes the two ("does not exist in" versus an invalid
    // object name) and so must this.
    await expect(destinationPrefix(origin, "on000001", REMOTE_NAME, "no-such-ref")).rejects.toThrow(
      /could not read/,
    );
  }, 120_000);
});

describe("readPinnedSources failing loudly", () => {
  test("throws rather than reporting every key unpinned when the ref is unreadable", async () => {
    // ADR 0064 records a pin-parsing bug of exactly this shape that hid 3,186
    // pins and 11.5 GB of readable content. An empty map here is not a neutral
    // result: it makes planKeyRecovery report "no upstream object of this key's
    // size" and turns every oversized key unrecoverable.
    const key = await addAnnexedFile("a.dat", "content of a");

    await expect(readPinnedSources(origin, [key], "no-such-ref")).rejects.toThrow(
      /could not read|could not list/,
    );
  }, 120_000);
});

describe("recoverDatasetContent", () => {
  const sha256Base64 = (content: string) =>
    Buffer.from(new Bun.CryptoHasher("sha256").update(content).digest()).toString("base64");

  async function setUpPinnedDataset(content: string): Promise<string> {
    const key = await addAnnexedFile("sub-01/a.dat", content);
    await writeAnnexBranchFile(
      origin,
      "remote.log",
      [
        "9e1479f6-49e0-413b-8222-a7f8000f55a6 bucket=openneuro.org name=s3-PUBLIC type=S3 versioning=yes",
        "ca4da2fe-2a4c-49b1-abd6-00fc9ec1ff30 bucket=nemar fileprefix=on000001/objects/ name=nemar-s3 type=S3",
        "",
      ].join("\n"),
    );
    await writeAnnexBranchFile(
      origin,
      `${await hashDir(origin, key)}${key}.log.rmet`,
      "1789149471s 9e1479f6-49e0-413b-8222-a7f8000f55a6:V +VERSIONID#ds000001/sub-01/a.dat\n",
    );
    return key;
  }

  test("copies a pinned key in and reports the checksum that proved it", async () => {
    const content = "the real content of this recording";
    const key = await setUpPinnedDataset(content);
    installAwsShim(`
case "$2" in
  copy-object) echo '{"CopyObjectResult":{"ChecksumSHA256":"${sha256Base64(content)}"}}'; exit 0 ;;
  head-object) echo '{"ContentLength":${content.length},"ChecksumSHA256":"${sha256Base64(content)}"}'; exit 0 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("recovered");
    expect(outcome.missing).toBe(1);
    expect(outcome.keys[0]).toMatchObject({
      key,
      action: "recovered",
      origin: "pinned",
      verification: "checksum",
    });
    // The copy really was asked for, with the pinned version.
    expect(shimLog().find((line) => line.startsWith("s3api copy-object"))).toContain(
      "versionId=VERSIONID",
    );
  }, 180_000);

  test("deletes an object S3 hashed to something other than the key", async () => {
    // The defect this whole module exists to avoid: content that is not the
    // content, sitting in the bucket under a key's name, waiting to be
    // advertised as the dataset by the next registration sweep.
    await setUpPinnedDataset("the real content of this recording");
    installAwsShim(`
case "$2" in
  copy-object) echo '{"CopyObjectResult":{"ChecksumSHA256":"${sha256Base64("something else entirely")}"}}'; exit 0 ;;
  head-object) echo '{"ContentLength":34,"ChecksumSHA256":"${sha256Base64("something else entirely")}"}'; exit 0 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("failed");
    expect(outcome.keys[0].action).toBe("failed");
    expect(outcome.keys[0].detail).toContain("deleted");
    // The refusing check is named, and `verification` is NOT set: that field now
    // means "and this is how it was proven", so a failed key must not carry one.
    expect(outcome.keys[0].detail).toContain("refused by checksum");
    expect(outcome.keys[0].verification).toBeUndefined();
    expect(outcome.keys[0].leftInBucket).toBeFalsy();
    // WHICH object was deleted, not merely that a delete happened: deleting the
    // wrong key would pass a prefix-only assertion while leaving the bad object.
    const deletes = shimLog().filter((line) => line.startsWith("s3api delete-object"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("--bucket nemar");
    expect(deletes[0]).toContain(`--key on000001/objects/${outcome.keys[0].key}`);
  }, 180_000);

  test("reports an object it could not delete as still in the bucket", async () => {
    // ADR 0063 calls this the one outcome worse than not copying at all: a
    // right-size, wrong-content object under a real key's name, which the next
    // registration sweep advertises because it checks name and size, never
    // content. It has to reach the operator as a field, not buried in a string.
    await setUpPinnedDataset("the real content of this recording");
    installAwsShim(`
case "$2" in
  copy-object) echo '{"CopyObjectResult":{"ChecksumSHA256":"${sha256Base64("something else")}"}}'; exit 0 ;;
  head-object) echo '{"ContentLength":34,"ChecksumSHA256":"${sha256Base64("something else")}"}'; exit 0 ;;
  delete-object)
    echo "aws: [ERROR]: An error occurred (AccessDenied) when calling the DeleteObject operation" >&2
    exit 254 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("failed");
    expect(outcome.keys[0].leftInBucket).toBe(true);
    expect(outcome.keys[0].detail).toContain("LEFT IN THE BUCKET");
    // And the reason the delete failed, which used to be discarded entirely.
    expect(outcome.keys[0].detail).toContain("AccessDenied");
  }, 180_000);

  test("will not treat a COMPOSITE checksum as a whole-object CRC64", async () => {
    // A composite checksum is a hash of PART hashes: two objects built from
    // different part sizes have different composite values for identical bytes,
    // so it cannot prove a copy matches its source. Only FULL_OBJECT can, which
    // is why the multipart upload asks for that type explicitly.
    const composite = "content whose checksum type is composite";
    await setUpPinnedDataset(composite);
    installAwsShim(`
case "$2" in
  copy-object) echo '{"CopyObjectResult":{"ETag":"abc-2"}}'; exit 0 ;;
  head-object)
    echo '{"ContentLength":${composite.length},"ChecksumCRC64NVME":"AAAAAAAAAAA=","ChecksumType":"COMPOSITE"}'
    exit 0 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    // The pin plus a matching size is what is left, and that is what it must say.
    expect(outcome.keys[0].action).toBe("recovered");
    expect(outcome.keys[0].verification).toBe("size-and-pin");
    expect(outcome.keys[0].verification).not.toBe("crc64-of-source");
  }, 180_000);

  test("without --apply it copies nothing and still says what it would do", async () => {
    await setUpPinnedDataset("content");
    installAwsShim("case \"$2\" in list-object-versions) echo '[]'; exit 0 ;; esac\nexit 0");

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: false,
      originUrl: origin,
    });

    expect(outcome.action).toBe("would-recover");
    expect(shimLog().some((line) => line.startsWith("s3api copy-object"))).toBe(false);
  }, 180_000);

  test("a key the bucket already holds is not missing and is never copied", async () => {
    const key = await setUpPinnedDataset("content");
    installAwsShim("exit 0");

    const outcome = await recoverDatasetContent(
      "on000001",
      async () => new Map([[key, annexKeyDeclaredSize(key) ?? 0]]),
      {
        workRoot,
        apply: true,
        originUrl: origin,
      },
    );

    expect(outcome.action).toBe("nothing-missing");
    expect(outcome.missing).toBe(0);
    expect(shimLog().some((line) => line.startsWith("s3api copy-object"))).toBe(false);
  }, 180_000);

  test("recovers a key whose object is there but empty", async () => {
    // A zero-byte object is what a failed copy leaves behind, and it is NOT
    // content: on003645 has 653 of them. If the bucket listing is read by name
    // alone, this key looks present and is never repaired.
    const content = "the real content of this recording";
    const key = await setUpPinnedDataset(content);
    installAwsShim(`
case "$2" in
  copy-object) echo '{"CopyObjectResult":{"ChecksumSHA256":"${sha256Base64(content)}"}}'; exit 0 ;;
  head-object) echo '{"ContentLength":${content.length},"ChecksumSHA256":"${sha256Base64(content)}"}'; exit 0 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map([[key, 0]]), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.missing).toBe(1);
    expect(outcome.keys[0]).toMatchObject({ action: "recovered", verification: "checksum" });
  }, 180_000);

  test("reports a key nothing accounts for rather than inventing a source", async () => {
    // on006159's shape: no pin, and upstream has no object of that size either.
    await addAnnexedFile("sub-01/a.dat", "orphaned content");
    installAwsShim("case \"$2\" in list-object-versions) echo '[]'; exit 0 ;; esac\nexit 0");

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("unrecoverable");
    expect(outcome.keys[0].action).toBe("unrecoverable");
    expect(outcome.keys[0].detail).toContain("no upstream object");
  }, 180_000);

  test("calls a refused copy unrecoverable when upstream serves nobody", async () => {
    // Five of the sixteen datasets are this: the object is listed upstream, with
    // the right size, and 403s for an anonymous caller as readily as for us.
    // Reporting that as a failure invites an operator to re-run it forever.
    //
    // The unsigned probe emits the real CLI's wording, which is what the
    // classifier reads: `An error occurred (403) ... Forbidden`. A bare non-zero
    // exit is deliberately NOT this case -- see the test below.
    await setUpPinnedDataset("content that upstream will not serve");
    installAwsShim(`
case "$2" in
  copy-object)
    echo "aws: [ERROR]: An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied" >&2
    exit 254 ;;
  head-object)
    echo "aws: [ERROR]: An error occurred (403) when calling the HeadObject operation: Forbidden" >&2
    exit 254 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("unrecoverable");
    expect(outcome.keys[0].detail).toContain("will not serve any recorded source");
    // It asked without credentials, which is what makes the claim about upstream
    // rather than about our access.
    expect(
      shimLog().some(
        (line) => line.startsWith("s3api head-object") && line.includes("--no-sign-request"),
      ),
    ).toBe(true);
  }, 180_000);

  test("will not call a key unrecoverable when the probe itself failed", async () => {
    // The distinction ADR 0064 exists to enforce. A probe that cannot reach S3
    // -- a throttle outliving its retries, an expired session, a DNS blip, a
    // missing binary -- says nothing about whether OpenNeuro serves the object,
    // and scoring it as `unrecoverable` is exactly how nine datasets were filed
    // `upstream_403` without anyone measuring them. Only a parsed 403/404 is an
    // answer about the source; anything else is a failure to retry.
    await setUpPinnedDataset("content whose availability is unknown");
    installAwsShim(`
case "$2" in
  copy-object)
    echo "aws: [ERROR]: An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied" >&2
    exit 254 ;;
  head-object)
    echo "Could not connect to the endpoint URL: \\"https://s3.amazonaws.com/\\"" >&2
    exit 255 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("failed");
    expect(outcome.keys[0].detail).toContain("could not be probed");
    // And it must NOT assert the thing it never established.
    expect(outcome.keys[0].detail).not.toContain("will not serve");
  }, 180_000);

  test("keeps a refused copy a failure when the source is readable without us", async () => {
    // Same 403, opposite meaning: the object serves fine unsigned, so what was
    // refused is OUR request, and that is worth retrying with other credentials.
    await setUpPinnedDataset("content upstream serves");
    installAwsShim(`
case "$2" in
  copy-object)
    echo "aws: [ERROR]: An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied" >&2
    exit 254 ;;
  head-object)
    case "$*" in *--no-sign-request*) echo '{"ContentLength":10}'; exit 0 ;; esac
    exit 254 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("failed");
    expect(outcome.keys[0].detail).toContain("Access Denied");
  }, 180_000);
  test("falls through to a discovered alternative when the pinned version is gone", async () => {
    // The on003645 shape, and the fall-through has no other coverage: deleting
    // the line that attaches `alternatives` leaves every other test green.
    // OpenNeuro's recorded versions were all refused while the same bytes sat at
    // the same path under a newer version id, and this is what recovered 619
    // keys there.
    const content = "bytes that moved to a new version id";
    const key = await setUpPinnedDataset(content);
    const size = content.length;
    installAwsShim(`
case "$2" in
  list-object-versions)
    echo '[["ds000001/sub-01/a.dat","CURRENTVER",${size},"etag-current"]]'; exit 0 ;;
  copy-object)
    case "$*" in
      *versionId=VERSIONID*)
        echo "aws: [ERROR]: An error occurred (InvalidArgument) when calling the CopyObject operation: Invalid version id specified" >&2
        exit 254 ;;
    esac
    echo '{"CopyObjectResult":{"ChecksumSHA256":"${sha256Base64(content)}"}}'; exit 0 ;;
  head-object)
    echo '{"ContentLength":${size},"ChecksumSHA256":"${sha256Base64(content)}"}'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("recovered");
    expect(outcome.keys[0].origin).toBe("version-match");
    // Both were really attempted: the pin first, then the discovered version.
    const copies = shimLog().filter((line) => line.startsWith("s3api copy-object"));
    expect(copies).toHaveLength(2);
    expect(copies[0]).toContain("versionId=VERSIONID");
    expect(copies[1]).toContain("versionId=CURRENTVER");
    expect(key).toBeTruthy();
  }, 180_000);

  test("a dry run PROBES the source rather than assuming a record is readable", async () => {
    // ADR 0064 names "a dry run that reported would-recover without probing" as
    // one of the five defects that made content look recoverable when it was
    // not: on004475's keys all carry pins and every one of those objects is
    // gone, so a plan built from the records alone promised 30 recoveries and an
    // apply delivered none.
    await setUpPinnedDataset("content whose pin is dead");
    installAwsShim(`
case "$2" in
  head-object)
    echo "aws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found" >&2
    exit 254 ;;
  list-object-versions) echo '[]'; exit 0 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: false,
      originUrl: origin,
    });

    expect(outcome.keys[0].action).toBe("unrecoverable");
    expect(outcome.keys[0].detail).toContain("unreadable");
    // The probe really ran, and unsigned, which is what makes it a statement
    // about upstream rather than about our credentials.
    expect(
      shimLog().some(
        (line) => line.startsWith("s3api head-object") && line.includes("--no-sign-request"),
      ),
    ).toBe(true);
    // And nothing was copied, because this is a dry run.
    expect(shimLog().some((line) => line.startsWith("s3api copy-object"))).toBe(false);
  }, 180_000);

  test("a failed upstream listing fails the dataset instead of emptying it", async () => {
    // listUpstreamObjectVersions refuses rather than under-reporting, and this
    // is what that buys: a partial listing would file a recoverable dataset as
    // unrecoverable, and since ADR 0064 that feeds a withdrawal.
    await addAnnexedFile("sub-01/a.dat", "content with no pin");
    await writeAnnexBranchFile(
      origin,
      "remote.log",
      "9e1479f6-49e0-413b-8222-a7f8000f55a6 bucket=openneuro.org name=s3-PUBLIC type=S3 versioning=yes\n",
    );
    installAwsShim(`
case "$2" in
  list-object-versions)
    echo "aws: [ERROR]: An error occurred (AccessDenied) when calling the ListObjectVersions operation" >&2
    exit 254 ;;
esac
exit 0`);

    const outcome = await recoverDatasetContent("on000001", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("failed");
    expect(outcome.error).toBeTruthy();
    // And it must not have manufactured a verdict about the content.
    expect(outcome.keys.some((k) => k.action === "unrecoverable")).toBe(false);
    // Unknown is not zero: nothing was measured, so the counts are not a result.
    expect(outcome.measured).toBe(false);
  }, 180_000);
});
