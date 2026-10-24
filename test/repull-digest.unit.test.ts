/**
 * The re-pull plan file's digest and the planner's read-only guard (ADR 0111, epic #1046 phase 5).
 *
 * The digest binds a reviewed plan to `--execute` (ADR 0111, decision 2), so it must be the same
 * for the same body whatever the key order, and it must not move with what a re-run legitimately
 * changes (when, where, and the preflight answers, which depend on the operator's token). The guard
 * is what makes "read-only" a property of the code rather than of each caller.
 */

import { describe, expect, test } from "bun:test";
import {
  PLAN_FILE_VERSION,
  PLAN_SCHEMA,
  type PlanBody,
  type PlanFile,
  VOLATILE_FIELDS,
  planDigest,
  planFileJson,
  readPlanFile,
} from "../src/lib/repull/digest";
import {
  ReadOnlyViolation,
  assertReadOnlyAws,
  assertReadOnlyGit,
  readOnlyFetch,
} from "../src/lib/repull/read-only";
import { localBase, openNeuroGraphqlUrl, remoteEnv } from "../src/lib/repull/sources";

const BODY: PlanBody = {
  planner: 1,
  dataset: "on099999",
  upstream: { ds: "ds099999", from_tag: "1.0.0", to_tag: "1.1.0" },
  paths: [
    {
      path: "a.tsv",
      class: "take-theirs",
      delta: true,
      target: { kind: "git", oid: "0".repeat(40) },
    },
  ],
  counts: { added: 1, data_changing: false },
  refusals: [],
};

function fileOf(body: PlanBody, over: Partial<PlanFile> = {}): PlanFile {
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_FILE_VERSION,
    digest: planDigest(body),
    created_at: "2026-10-24T00:00:00.000Z",
    environment: "https://api.nemar.org",
    sources: "remotes",
    preflight: [{ name: "release-pr", status: "unchecked", code: "no-token" }],
    executable: false,
    body,
    ...over,
  };
}

describe("the plan digest", () => {
  test("does not depend on the order keys were written in", () => {
    const reordered: PlanBody = {
      refusals: [],
      counts: { data_changing: false, added: 1 },
      paths: [
        {
          target: { oid: "0".repeat(40), kind: "git" },
          delta: true,
          class: "take-theirs",
          path: "a.tsv",
        },
      ],
      upstream: { to_tag: "1.1.0", from_tag: "1.0.0", ds: "ds099999" },
      dataset: "on099999",
      planner: 1,
    };
    expect(planDigest(reordered)).toBe(planDigest(BODY));
    expect(planDigest(BODY)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("moves with any body field, including an array's order", () => {
    expect(planDigest({ ...BODY, dataset: "on999998" })).not.toBe(planDigest(BODY));
    expect(planDigest({ ...BODY, refusals: [{ code: "gitlink", detail: "1" }] })).not.toBe(
      planDigest(BODY),
    );
    const two = {
      ...BODY,
      renames: [
        { from: "a", to: "b" },
        { from: "c", to: "d" },
      ],
    };
    const swapped = {
      ...BODY,
      renames: [
        { from: "c", to: "d" },
        { from: "a", to: "b" },
      ],
    };
    expect(planDigest(two)).not.toBe(planDigest(swapped));
  });

  test("a written file reads back to the same digest, whatever its volatile fields say", () => {
    const a = readPlanFile(planFileJson(fileOf(BODY)));
    const b = readPlanFile(
      planFileJson(
        fileOf(BODY, {
          created_at: "2031-01-01T00:00:00.000Z",
          environment: "http://127.0.0.1:1",
          sources: "test-bases",
          preflight: [{ name: "release-pr", status: "ok" }],
          executable: true,
        }),
      ),
    );
    expect(a.digest).toBe(planDigest(BODY));
    expect(b.digest).toBe(a.digest);
    expect(a.file.digest).toBe(a.digest);
    for (const field of VOLATILE_FIELDS) expect(Object.keys(a.body)).not.toContain(field);
  });

  test("a body may not carry a volatile field, which the digest would then skip", () => {
    expect(() => planFileJson(fileOf({ ...BODY, created_at: "x" }))).toThrow(
      /volatile field created_at/,
    );
  });
});

describe("the read-only guard", () => {
  test("allows exactly the planner's own calls", () => {
    for (const args of [
      [
        "clone",
        "--bare",
        "--quiet",
        "--filter=blob:limit=1m",
        "--depth=1",
        "--no-tags",
        "--branch",
        "1.1.0",
        "https://github.com/OpenNeuroDatasets/ds004362.git",
        "/tmp/x/upstream.git",
      ],
      ["clone", "--bare", "--branch", "main", "file:///tmp/origins/on099999", "/tmp/x/n.git"],
      ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", "+refs/tags/1.0.0:refs/tags/1.0.0"],
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "--quiet",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      ["ls-remote", "--refs", "https://github.com/nemarDatasets/on004362.git", "refs/tags/v*"],
      ["cat-file", "--batch"],
      ["ls-tree", "-r", "-z", "--full-tree", "abc123"],
      ["ls-tree", "-z", "--full-tree", "abc123", "--", "a/b/KEY.log", "-odd-name.log"],
      ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"],
      ["rev-parse", "--show-object-format"],
      ["rev-list", "--objects", "--missing=print", "--no-object-names", "abc123"],
    ]) {
      expect(() => assertReadOnlyGit(args)).not.toThrow();
    }
  });

  test("refuses anything else, in separated and attached forms", () => {
    for (const args of [
      ["push", "origin", "main"],
      ["annex", "copy", "--to", "nemar-s3"],
      ["config", "user.name", "x"],
      ["update-ref", "refs/heads/main", "0"],
      ["for-each-ref"],
      ["show", "git-annex:remote.log"],
      ["cat-file", "--batch-check"],
      ["-c", "core.sshCommand=evil", "fetch", "origin"],
      ["-ccore.hooksPath=/tmp", "fetch", "origin"],
      ["-c", "fetch.negotiationAlgorithm=skipping", "fetch", "origin"],
      ["-C", "/tmp", "fetch", "origin"],
      ["clone", "--upload-pack=evil", "https://github.com/a/b", "d"],
      ["clone", "-u", "evil", "https://github.com/a/b", "d"],
      ["clone", "-uevil", "https://github.com/a/b", "d"],
      ["clone", "-c", "core.hooksPath=/tmp", "https://github.com/a/b", "d"],
      ["clone", "-ccore.hooksPath=/tmp", "https://github.com/a/b", "d"],
      ["clone", "--template=/tmp/hooks", "https://github.com/a/b", "d"],
      ["clone", "--config", "core.hooksPath=/tmp", "https://github.com/a/b", "d"],
      ["clone", "--branch", "https://github.com/a/b", "d"],
      ["clone", "--branch", "--upload-pack=evil", "https://github.com/a/b", "d"],
      ["clone", "ext::sh -c touch% /tmp/pwned", "d"],
      ["clone", "https://evil.example/a/b", "d"],
      ["ls-remote", "--refs", "ssh://git@github.com/a/b"],
      ["fetch", "--upload-pack=evil", "origin"],
      ["fetch", "evil-remote", "refs/heads/main"],
      ["fetch", "--depth=1", "https://github.com/a/b"],
      ["ls-tree", "-r", "--name-only", "abc123"],
      ["rev-parse", "--git-path", "hooks"],
      ["cat-file", "--batch", "--", "x"],
      [],
    ]) {
      expect(() => assertReadOnlyGit(args)).toThrow(ReadOnlyViolation);
    }
  });

  test("aws is list-objects-v2 with its four options and JSON output only", () => {
    expect(() =>
      assertReadOnlyAws([
        "s3api",
        "list-objects-v2",
        "--bucket",
        "nemar",
        "--prefix",
        "on099999/objects/",
        "--region",
        "us-east-2",
        "--output",
        "json",
      ]),
    ).not.toThrow();
    for (const args of [
      ["s3", "cp", "a", "s3://nemar/x"],
      ["s3api", "put-object", "--bucket", "nemar", "--key", "x"],
      ["s3api", "list-objects-v2", "--bucket", "nemar", "--endpoint-url", "http://evil"],
      ["s3api", "list-objects-v2", "--bucket", "nemar", "--output", "text"],
      ["s3api", "list-objects-v2", "--bucket"],
      ["s3api", "list-objects-v2", "--bucket", "--prefix"],
    ]) {
      expect(() => assertReadOnlyAws(args)).toThrow(ReadOnlyViolation);
    }
  });

  test("HTTP is GET and HEAD only, and a GET goes out", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(readOnlyFetch("http://127.0.0.1:9/x", { method })).rejects.toThrow(
        ReadOnlyViolation,
      );
    }
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.method);
        return new Response("ok");
      },
    });
    try {
      const get = await readOnlyFetch(`http://127.0.0.1:${server.port}/x`);
      expect(await get.text()).toBe("ok");
      await readOnlyFetch(`http://127.0.0.1:${server.port}/x`, { method: "head" });
      expect(seen).toEqual(["GET", "HEAD"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("the credential environment of a remote", () => {
  test("a GitHub URL gets the helper reset and the token's helper; anything else gets nothing", () => {
    const gh = remoteEnv("https://github.com/nemarDatasets/on004362.git", "tok") ?? {};
    expect(gh.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(gh.GIT_CONFIG_VALUE_0).toBe("");
    expect(gh.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    // A token is never offered to a host that is not GitHub, a local test base included.
    expect(remoteEnv("file:///tmp/origins/on099999", "tok")).toBeUndefined();
  });
});

describe("the test seams refuse anything but a local target", () => {
  test("NEMAR_REPULL_OPENNEURO_URL is honored only for a loopback http address", () => {
    expect(openNeuroGraphqlUrl({})).toBeUndefined();
    expect(
      openNeuroGraphqlUrl({ NEMAR_REPULL_OPENNEURO_URL: "http://127.0.0.1:9/crn/graphql" }),
    ).toBe("http://127.0.0.1:9/crn/graphql");
    for (const url of ["https://openneuro.org/crn/graphql", "http://evil.example/x", "nonsense"]) {
      expect(() => openNeuroGraphqlUrl({ NEMAR_REPULL_OPENNEURO_URL: url })).toThrow(
        /loopback|127/,
      );
    }
  });

  test("a remote base is honored only as an absolute local path", () => {
    expect(localBase({ NEMAR_REPULL_ORIGIN_BASE: "/tmp/origins/" }, "origin")).toBe("/tmp/origins");
    for (const value of ["relative/dir", "https://github.com/x", "file:///tmp/x"]) {
      expect(() => localBase({ NEMAR_REPULL_ORIGIN_BASE: value }, "origin")).toThrow(/absolute/);
    }
  });
});
