/**
 * The re-pull's write guard (ADR 0111, decisions 2 and 8; epic #1046 phase 6, #1912): every push
 * and every S3 call execution makes after `prepared` is one of a closed list of forms. A supplement
 * to the integration suites, which drive the guard through the real `git` and `aws` calls; this
 * pins every allowed form and the refusals the module comment promises, one by one.
 */

import { describe, expect, test } from "bun:test";
import {
  type AwsGuardContext,
  RepullWriteRefused,
  assertRepullAws,
  assertRepullPush,
  guardedAws,
} from "../src/lib/repull/write-guard";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const CTX = { versions: ["2.0.0", "2.0.1"] };

function refusedPush(args: string[]): string {
  try {
    assertRepullPush(args, CTX);
  } catch (err) {
    if (err instanceof RepullWriteRefused) return err.what;
    throw err;
  }
  throw new Error(`allowed: ${args.join(" ")}`);
}

describe("pushes", () => {
  test("every allowed form", () => {
    for (const args of [
      ["push", "origin", `${SHA}:refs/heads/release/v2.0.0`],
      ["push", "--porcelain", "origin", `${SHA}:refs/heads/release/v2.0.1`],
      ["push", "--quiet", "--porcelain", "origin", `${SHA}:refs/heads/git-annex`],
      ["push", "--porcelain", "origin", "--delete", "refs/heads/release/v2.0.0"],
      [
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/release/v2.0.0:${OTHER}`,
        "origin",
        `${SHA}:refs/heads/release/v2.0.0`,
      ],
    ]) {
      expect(() => assertRepullPush(args, CTX)).not.toThrow();
    }
  });

  test("main, a tag, another branch and a version not this re-pull's are refused", () => {
    expect(refusedPush(["push", "origin", `${SHA}:refs/heads/main`])).toBe(
      "destination-not-allowed",
    );
    expect(refusedPush(["push", "origin", `${SHA}:main`])).toBe("destination-not-allowed");
    expect(refusedPush(["push", "origin", `${SHA}:refs/tags/v2.0.0`])).toBe(
      "destination-not-allowed",
    );
    expect(refusedPush(["push", "origin", `${SHA}:refs/heads/release/v3.0.0`])).toBe(
      "destination-not-allowed",
    );
    expect(refusedPush(["push", "origin", `${SHA}:refs/heads/release/v2.0.0-x`])).toBe(
      "destination-not-allowed",
    );
    expect(refusedPush(["push", "origin", "--delete", "refs/heads/main"])).toBe(
      "delete-not-a-release-branch",
    );
    expect(refusedPush(["push", "origin", "--delete", "refs/heads/git-annex"])).toBe(
      "delete-not-a-release-branch",
    );
  });

  test("a forced push, a + refspec, a mirror and every unlisted option are refused", () => {
    expect(refusedPush(["push", "origin", `+${SHA}:refs/heads/release/v2.0.0`])).toBe(
      "source-not-a-commit-id",
    );
    for (const o of [
      "--force",
      "-f",
      "--mirror",
      "--all",
      "--tags",
      "--follow-tags",
      "--force-with-lease",
      "--force-if-includes",
      "--receive-pack=/bin/sh",
      "--exec=/bin/sh",
      "--no-verify",
      "--atomic",
      "-u",
    ]) {
      expect(refusedPush(["push", o, "origin", `${SHA}:refs/heads/release/v2.0.0`])).toBe(
        "option-not-allowed",
      );
    }
    // An option after the remote is a second refspec, not an option.
    expect(refusedPush(["push", "origin", "--force", `${SHA}:refs/heads/release/v2.0.0`])).toBe(
      "one-refspec-only",
    );
  });

  test("another remote, a URL, two refspecs and a ref name as the source are refused", () => {
    expect(refusedPush(["push", "upstream", `${SHA}:refs/heads/release/v2.0.0`])).toBe(
      "remote-not-origin",
    );
    expect(
      refusedPush(["push", "https://github.com/x/y.git", `${SHA}:refs/heads/release/v2.0.0`]),
    ).toBe("remote-not-origin");
    expect(
      refusedPush([
        "push",
        "origin",
        `${SHA}:refs/heads/release/v2.0.0`,
        `${SHA}:refs/heads/git-annex`,
      ]),
    ).toBe("one-refspec-only");
    expect(refusedPush(["push", "origin", "HEAD:refs/heads/release/v2.0.0"])).toBe(
      "source-not-a-commit-id",
    );
    expect(refusedPush(["push", "origin", "refs/heads/git-annex:refs/heads/git-annex"])).toBe(
      "source-not-a-commit-id",
    );
    expect(refusedPush(["push", "origin", ":refs/heads/release/v2.0.0"])).toBe(
      "source-not-a-commit-id",
    );
    expect(refusedPush(["-c", "x=y", "push", "origin", `${SHA}:refs/heads/git-annex`])).toBe(
      "not-a-push",
    );
  });

  test("a lease must name the branch it pushes, and only a release branch", () => {
    expect(
      refusedPush([
        "push",
        `--force-with-lease=refs/heads/release/v2.0.1:${OTHER}`,
        "origin",
        `${SHA}:refs/heads/release/v2.0.0`,
      ]),
    ).toBe("lease-mismatch");
    expect(
      refusedPush([
        "push",
        `--force-with-lease=refs/heads/main:${OTHER}`,
        "origin",
        `${SHA}:refs/heads/main`,
      ]),
    ).toBe("option-not-allowed");
    expect(
      refusedPush([
        "push",
        `--force-with-lease=refs/heads/release/v2.0.0:${OTHER}`,
        "origin",
        `${SHA}:refs/heads/git-annex`,
      ]),
    ).toBe("lease-mismatch");
  });
});

const AWS: AwsGuardContext = {
  destBucket: "nemar",
  prefix: "on099999/objects/",
  stagingKey: "on099999/staging/repull-1.1.0.json",
  sourceBucket: "openneuro.org",
  sourcePrefix: "ds099999/",
};
const SRC = "openneuro.org/ds099999/sub-01/eeg/sub-01_task-rest_eeg.edf?versionId=abc.DEF_12-3";
const KEY = "on099999/objects/SHA256E-s4256--abc.edf";

function refusedAws(op: string, args: string[], ctx: AwsGuardContext = AWS): string {
  try {
    assertRepullAws(op, args, ctx);
  } catch (err) {
    if (err instanceof RepullWriteRefused) return err.what;
    throw err;
  }
  throw new Error(`allowed: ${op} ${args.join(" ")}`);
}

describe("S3 calls", () => {
  test("every allowed form", () => {
    const ok: Array<[string, string[]]> = [
      [
        "head-object",
        ["--bucket", "openneuro.org", "--key", "ds099999/sub-01/eeg/x.edf", "--version-id", "v1"],
      ],
      ["head-object", ["--bucket", "nemar", "--key", KEY]],
      [
        "copy-object",
        ["--bucket", "nemar", "--key", KEY, "--copy-source", SRC, "--copy-source-if-match", '"e"'],
      ],
      ["create-multipart-upload", ["--bucket", "nemar", "--key", KEY]],
      [
        "upload-part-copy",
        [
          "--bucket",
          "nemar",
          "--key",
          KEY,
          "--upload-id",
          "up-1",
          "--part-number",
          "1",
          "--copy-source",
          SRC,
          "--copy-source-range",
          "bytes=0-99",
          "--copy-source-if-match",
          '"e"',
        ],
      ],
      [
        "complete-multipart-upload",
        ["--bucket", "nemar", "--key", KEY, "--upload-id", "up-1", "--multipart-upload", "{}"],
      ],
      ["abort-multipart-upload", ["--bucket", "nemar", "--key", KEY, "--upload-id", "up-1"]],
      [
        "list-objects-v2",
        ["--bucket", "nemar", "--prefix", "on099999/objects/", "--max-keys", "1000"],
      ],
      [
        "put-object",
        ["--bucket", "nemar", "--key", AWS.stagingKey, "--body", "/tmp/x", "--content-type", "a/b"],
      ],
    ];
    for (const [op, args] of ok) expect(() => assertRepullAws(op, args, AWS)).not.toThrow();
  });

  test("a copy source without a version id, from another bucket or another dataset is refused", () => {
    const copy = (source: string) =>
      refusedAws("copy-object", [
        "--bucket",
        "nemar",
        "--key",
        KEY,
        "--copy-source",
        source,
        "--copy-source-if-match",
        '"e"',
      ]);
    expect(copy("openneuro.org/ds099999/sub-01/eeg/x.edf")).toBe("copy-source-unversioned");
    expect(copy("openneuro.org/ds099999/x.edf?versionId=")).toBe("copy-source-version-id");
    expect(copy("openneuro.org/ds099999/x.edf?versionId=a&b=c")).toBe("copy-source-version-id");
    expect(copy("elsewhere/ds099999/x.edf?versionId=v")).toBe("copy-source-bucket");
    expect(copy("openneuro.org/ds000001/x.edf?versionId=v")).toBe("copy-source-prefix");
    expect(copy("nemar/on099999/objects/K?versionId=v")).toBe("copy-source-bucket");
    // A copy without the ETag condition is refused, as one by path is.
    expect(
      refusedAws("copy-object", ["--bucket", "nemar", "--key", KEY, "--copy-source", SRC]),
    ).toBe("copy-without-if-match");
  });

  test("a key outside the prefix, another bucket and a second staging key are refused", () => {
    expect(
      refusedAws("copy-object", [
        "--bucket",
        "nemar",
        "--key",
        "on099998/objects/K",
        "--copy-source",
        SRC,
        "--copy-source-if-match",
        '"e"',
      ]),
    ).toBe("key-outside-prefix");
    expect(
      refusedAws("create-multipart-upload", ["--bucket", "nemar", "--key", "on099999/objects/"]),
    ).toBe("key-outside-prefix");
    expect(refusedAws("create-multipart-upload", ["--bucket", "other", "--key", KEY])).toBe(
      "bucket-not-allowed",
    );
    expect(
      refusedAws("put-object", [
        "--bucket",
        "nemar",
        "--key",
        "on099999/staging/repull-1.2.0.json",
        "--body",
        "/tmp/x",
      ]),
    ).toBe("put-not-the-staging-key");
    expect(refusedAws("put-object", ["--bucket", "nemar", "--key", KEY, "--body", "/tmp/x"])).toBe(
      "put-not-the-staging-key",
    );
    expect(refusedAws("list-objects-v2", ["--bucket", "nemar", "--prefix", "on099999/"])).toBe(
      "listing-outside-prefix",
    );
    // Upstream is read at a version only.
    expect(
      refusedAws("head-object", ["--bucket", "openneuro.org", "--key", "ds099999/sub-01/x.edf"]),
    ).toBe("source-read-unversioned");
  });

  test("the bypass flag, a metadata directive, a lock and every unlisted option or operation are refused", () => {
    const base = [
      "--bucket",
      "nemar",
      "--key",
      KEY,
      "--copy-source",
      SRC,
      "--copy-source-if-match",
      '"e"',
    ];
    for (const extra of [
      ["--bypass-governance-retention", "true"],
      ["--metadata-directive", "REPLACE"],
      ["--object-lock-mode", "GOVERNANCE"],
      ["--acl", "public-read"],
      ["--tagging-directive", "REPLACE"],
    ]) {
      expect(refusedAws("copy-object", [...base, ...extra])).toBe("option-not-allowed");
    }
    // A flag with no value (the bare bypass switch) is refused as malformed, never passed on.
    expect(refusedAws("copy-object", [...base, "--bypass-governance-retention"])).toBe(
      "argument-without-value",
    );
    for (const op of [
      "get-object",
      "delete-objects",
      "put-object-retention",
      "put-object-acl",
      "delete-object",
      "list-object-versions",
    ]) {
      expect(refusedAws(op, ["--bucket", "nemar", "--key", KEY])).toBe("operation-not-allowed");
    }
    expect(refusedAws("head-object", ["--bucket", "nemar", "--key", KEY, "--key", KEY])).toBe(
      "argument-repeated",
    );
  });

  test("the canary may delete by version id under its prefix, and list it by version", () => {
    const canary: AwsGuardContext = {
      ...AWS,
      prefix: "nm099999/repull-canary-20261024T000000Z/",
      stagingKey: "nm099999/repull-canary-20261024T000000Z/staging/repull-canary.json",
      canary: true,
    };
    const k = "nm099999/repull-canary-20261024T000000Z/copy-single";
    expect(() =>
      assertRepullAws(
        "delete-object",
        ["--bucket", "nemar", "--key", k, "--version-id", "v1"],
        canary,
      ),
    ).not.toThrow();
    expect(() =>
      assertRepullAws(
        "list-object-versions",
        ["--bucket", "nemar", "--prefix", canary.prefix, "--no-paginate"],
        canary,
      ),
    ).not.toThrow();
    // Never without a version id (that would leave a delete marker), never outside the prefix.
    expect(refusedAws("delete-object", ["--bucket", "nemar", "--key", k], canary)).toBe(
      "delete-unversioned",
    );
    expect(
      refusedAws(
        "delete-object",
        ["--bucket", "nemar", "--key", KEY, "--version-id", "v1"],
        canary,
      ),
    ).toBe("key-outside-prefix");
    expect(
      refusedAws(
        "delete-object",
        [
          "--bucket",
          "nemar",
          "--key",
          k,
          "--version-id",
          "v1",
          "--bypass-governance-retention",
          "x",
        ],
        canary,
      ),
    ).toBe("option-not-allowed");
  });

  test("a guarded runner refuses before the call is made", async () => {
    const calls: string[] = [];
    const runner = guardedAws(
      {
        api: async (op) => {
          calls.push(op);
          return {};
        },
      },
      AWS,
    );
    await runner.api("head-object", ["--bucket", "nemar", "--key", KEY]);
    await expect(runner.api("get-object", ["--bucket", "nemar", "--key", KEY])).rejects.toThrow(
      RepullWriteRefused,
    );
    expect(calls).toEqual(["head-object"]);
  });
});
