/**
 * The shapes a re-pull checks where it reads a value that becomes a URL, a host, a ref, a branch
 * name or an S3 call (epic #1046, the round 1 review of the epic's pull request, finding C5; ADR
 * 0111).
 *
 * The values come from two places nobody on this machine wrote: the dataset's own `remote.log`
 * (the bucket and the region of `nemar-s3`) and the plan file (the dataset ids, the tags and the
 * versions). Each is checked at its read, and a value that is not the shape it must be is refused
 * with words that name the field and the shape and never the value.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the predicates accept what the system produces and refuse what could name another host, a
 *    ref range, an option or a path;
 *  - `nemarRemoteOf` reports a bucket or a datacenter S3 cannot have, and its words do not echo it;
 *  - the annex-uuid read makes NO request for such a bucket or region, and the right request for a
 *    valid one (the host it builds is the one S3 serves the bucket at);
 *  - `planFacts` refuses each malformed scalar of a plan, by field, and passes a valid plan.
 *
 * Fetch is routed here, as `withFakeS3` is in `doctor-fix-route.test.ts`: a request is recorded and
 * answered locally, and nothing leaves the machine.
 *
 * CI TIER: unit-pure (no repository, no network).
 */

import { describe, expect, test } from "bun:test";
import type { PlanBody } from "../src/lib/repull/digest";
import { planFacts } from "../src/lib/repull/execute/body";
import { ExecuteRefused } from "../src/lib/repull/execute/verify-plan";
import { nemarRemoteOf } from "../src/lib/repull/plan";
import {
  isAwsRegion,
  isCommitId,
  isNemarDatasetId,
  isNemarVersion,
  isOpenNeuroDatasetId,
  isS3BucketName,
  s3RemoteProblem,
} from "../src/lib/repull/shapes";
import { listBucketObjects, readAnnexUuidMarker } from "../src/lib/repull/sources";

describe("the shape predicates", () => {
  test("a bucket name is S3's: 3 to 63 lowercase letters, digits, dots and hyphens", () => {
    for (const ok of [
      "nemar",
      "nemar-dev",
      "openneuro.org",
      "a1b",
      "x".repeat(63),
      "my.bucket-1",
    ]) {
      expect([ok, isS3BucketName(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "",
      "ab",
      "x".repeat(64),
      "Nemar",
      "nemar_x",
      "-nemar",
      "nemar-",
      ".nemar",
      "nemar.",
      "ne..mar",
      "192.168.5.4",
      "evil.example/x",
      "evil.example#",
      "evil@example",
      "evil.example:443",
      "nemar?x=1",
      "nemar\n",
      "nemar bucket",
    ]) {
      expect([bad, isS3BucketName(bad)]).toEqual([bad, false]);
    }
    expect(isS3BucketName(undefined)).toBe(false);
    expect(isS3BucketName(42)).toBe(false);
  });

  test("a region is a region name, which cannot name another host", () => {
    for (const ok of [
      "us-east-2",
      "us-east-1",
      "eu-central-1",
      "ap-southeast-1",
      "us-gov-west-1",
    ]) {
      expect([ok, isAwsRegion(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "",
      "us-east",
      "us-east-2.evil.example",
      "us-east-2/x",
      "us-east-2#",
      "us-east-2@evil",
      "US-EAST-2",
      "us east 2",
      "../x",
      "us-east-2\n",
      `us-${"east-".repeat(10)}2`,
    ]) {
      expect([bad, isAwsRegion(bad)]).toEqual([bad, false]);
    }
    expect(isAwsRegion(undefined)).toBe(false);
  });

  test("a commit id is a full 40 lowercase hex digits and nothing else", () => {
    for (const ok of ["0123456789abcdef0123456789abcdef01234567", "f".repeat(40), "0".repeat(40)]) {
      expect([ok, isCommitId(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "",
      "abc1234",
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(64),
      "A".repeat(40),
      `${"a".repeat(39)}z`,
      "--upload-pack=x",
      "HEAD",
      `${"a".repeat(40)}\n`,
    ]) {
      expect([bad, isCommitId(bad)]).toEqual([bad, false]);
    }
    expect(isCommitId(undefined)).toBe(false);
    expect(isCommitId(1)).toBe(false);
  });

  test("a dataset id is two letters or ds and six digits, a version is N.N.N", () => {
    expect(isOpenNeuroDatasetId("ds004362")).toBe(true);
    for (const bad of ["ds4362", "DS004362", "ds004362/x", "ds004362 ", "on004362", ""]) {
      expect([bad, isOpenNeuroDatasetId(bad)]).toEqual([bad, false]);
    }
    expect(isNemarDatasetId("on004362")).toBe(true);
    expect(isNemarDatasetId("xx099991")).toBe(true);
    for (const bad of ["ON004362", "on00436", "on0043620", "on004362/..", "ds4", ""]) {
      expect([bad, isNemarDatasetId(bad)]).toEqual([bad, false]);
    }
    for (const ok of ["1.0.0", "2.0.1", "10.20.30"]) expect(isNemarVersion(ok)).toBe(true);
    for (const bad of ["2", "2.0", "v2.0.0", "2.0.0-rc1", "2.0.0 ", "../2.0.0", "", 2]) {
      expect([bad, isNemarVersion(bad)]).toEqual([bad, false]);
    }
  });
});

describe("s3RemoteProblem and nemarRemoteOf", () => {
  const UUID = "11111111-2222-4333-8444-555555555555";
  const log = (fields: string) =>
    `${UUID} ${fields} fileprefix=on004362/objects/ name=nemar-s3 type=S3 timestamp=1790000002s\n`;

  test("a valid bucket and datacenter are no problem, and a missing datacenter takes the default", () => {
    const named = nemarRemoteOf(
      log("bucket=nemar datacenter=us-east-2 encryption=none"),
      "on004362",
    );
    expect(named).toMatchObject({ uuid: UUID, region: "us-east-2", problem: null });
    expect(named.record?.bucket).toBe("nemar");
    const bare = nemarRemoteOf(log("bucket=nemar encryption=none"), "on004362");
    expect(bare).toMatchObject({ region: "us-east-2", problem: null });
    expect(s3RemoteProblem("nemar", "us-east-2")).toBeNull();
  });

  test("a bucket or a datacenter S3 cannot have is a problem, in words that do not echo it", () => {
    for (const [fields, offending] of [
      ["bucket=evil.example/x# datacenter=us-east-2", "evil.example/x#"],
      ["bucket=Nemar datacenter=us-east-2", "Nemar"],
      ["bucket=ne datacenter=us-east-2", "ne"],
      ["bucket=nemar datacenter=us-east-2.evil.example", "us-east-2.evil.example"],
      ["bucket=nemar datacenter=", ""],
      ["bucket=nemar datacenter=../x", "../x"],
    ] as const) {
      const remote = nemarRemoteOf(log(fields), "on004362");
      expect([fields, typeof remote.problem]).toEqual([fields, "string"]);
      expect(remote.problem).toMatch(/bucket name|AWS region/);
      if (offending.length > 2) expect(remote.problem).not.toContain(offending);
    }
  });

  test("no nemar-s3, or a bucket the log does not name, is not this problem", () => {
    // The callers' own refusal says "names no single nemar-s3 bucket".
    expect(nemarRemoteOf("", "on004362").problem).toBeNull();
    expect(nemarRemoteOf(log("datacenter=us-east-2"), "on004362").problem).toBeNull();
    expect(s3RemoteProblem(undefined, "us-east-2")).toBeNull();
    expect(s3RemoteProblem(undefined, "nonsense")).toMatch(/AWS region/);
  });
});

/**
 * Runs `fn` with `fetch` answered here: each request's URL is recorded, `answer` says what it gets,
 * and nothing is sent anywhere. The real `fetch` comes back even if `fn` throws.
 */
async function withFetch<T>(
  answer: (url: string) => Response,
  fn: () => Promise<T>,
): Promise<{ value: T; urls: string[] }> {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve(answer(url));
  }) as typeof fetch;
  try {
    return { value: await fn(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

describe("the annex-uuid read builds its host only from a bucket and a region S3 can have", () => {
  const args = (bucket: string, region: string) => ({
    bucket,
    region,
    prefix: "on004362/objects/",
    env: {},
  });

  test("a valid pair is requested at the host S3 serves the bucket at, once", async () => {
    const { value, urls } = await withFetch(
      () => new Response("uuid-from-bucket\n", { status: 200 }),
      () => readAnnexUuidMarker(args("nemar", "us-east-2")),
    );
    expect(urls).toEqual(["https://nemar.s3.us-east-2.amazonaws.com/on004362/objects/annex-uuid"]);
    expect(value).toEqual({ status: "ok", uuid: "uuid-from-bucket" });
  });

  test("a bucket or a region that could name another host makes no request at all", async () => {
    for (const [bucket, region] of [
      ["evil.example#", "us-east-2"],
      ["evil.example/x", "us-east-2"],
      ["evil@example", "us-east-2"],
      ["nemar", "us-east-2.evil.example"],
      ["nemar", "us-east-2#"],
      ["nemar", ""],
    ] as const) {
      const { value, urls } = await withFetch(
        () => new Response("hello", { status: 200 }),
        () => readAnnexUuidMarker(args(bucket, region)),
      );
      expect([bucket, region, urls]).toEqual([bucket, region, []]);
      expect(value).toMatchObject({ status: "error" });
      expect((value as { detail: string }).detail).toContain("nothing was requested");
    }
  });

  test("the bucket listing refuses such a pair before it starts the aws CLI", async () => {
    await expect(listBucketObjects(args("evil.example/x", "us-east-2"))).rejects.toThrow(
      "not one S3 can have",
    );
    await expect(listBucketObjects(args("nemar", "us-east-2.evil.example"))).rejects.toThrow(
      "not one S3 can have",
    );
  });
});

describe("planFacts refuses a scalar of the plan that is not the shape execution builds from", () => {
  const SHA = "a".repeat(40);
  const body = (over: {
    dataset?: unknown;
    ds?: unknown;
    from_tag?: unknown;
    to_tag?: unknown;
    current?: unknown;
    n0?: unknown;
    n1?: unknown;
    to_commit?: unknown;
    main_commit?: unknown;
    annex_commit?: unknown;
  }): PlanBody =>
    ({
      dataset: "dataset" in over ? over.dataset : "on004362",
      upstream: {
        ds: "ds" in over ? over.ds : "ds004362",
        from_tag: "from_tag" in over ? over.from_tag : "1.0.0",
        to_tag: "to_tag" in over ? over.to_tag : "1.1.0",
        to_commit: "to_commit" in over ? over.to_commit : SHA,
      },
      nemar: {
        main_commit: "main_commit" in over ? over.main_commit : SHA,
        annex_commit: "annex_commit" in over ? over.annex_commit : SHA,
      },
      versions: {
        current: "current" in over ? over.current : "1.0.0",
        n0: "n0" in over ? over.n0 : "2.0.0",
        n1: "n1" in over ? over.n1 : "2.0.1",
      },
      planner: 2,
      lineage: { recordable: true },
      description: { merged_json: null },
    }) as unknown as PlanBody;

  function refusal(over: Parameters<typeof body>[0]): ExecuteRefused {
    try {
      planFacts(body(over));
    } catch (err) {
      if (err instanceof ExecuteRefused) return err;
      throw err;
    }
    throw new Error("the plan was accepted");
  }

  test("a plan of valid values is read, a null N.0.1 version included, and odd but legal ones too", () => {
    expect(planFacts(body({}))).toMatchObject({
      datasetId: "on004362",
      ds: "ds004362",
      fromTag: "1.0.0",
      toTag: "1.1.0",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      patchVersion: "2.0.1",
    });
    expect(planFacts(body({ n1: null })).patchVersion).toBeNull();
    // Full commit ids of any hex digits, the three of them, are read as they are.
    const ids = ["0123456789abcdef0123456789abcdef01234567", "f".repeat(40), "1".repeat(40)];
    expect(
      planFacts(body({ to_commit: ids[0], main_commit: ids[1], annex_commit: ids[2] })),
    ).toMatchObject({ toCommit: ids[0], mainCommit: ids[1], annexCommit: ids[2] });
    // A legacy five-digit tag, a v-prefixed one and a release candidate are tags the system reads.
    for (const tag of ["00002", "v1.0.0", "2.1.0-rc1", "A.b_c-9"]) {
      expect(planFacts(body({ to_tag: tag })).toTag).toBe(tag);
    }
    expect(planFacts(body({ current: "10.20.30", n0: "11.0.0" })).toVersion).toBe("11.0.0");
  });

  const COMMIT_CASES = [
    "",
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
    "a".repeat(64),
    `${"a".repeat(39)}g`,
    "--upload-pack=touch-x",
    "HEAD",
    "refs/heads/main",
    `${"a".repeat(40)}\n`,
    `${"a".repeat(40)} `,
    ` ${"a".repeat(40)}`,
  ];

  const CASES: Array<
    [field: string, over: (v: unknown) => Parameters<typeof body>[0], bad: string[]]
  > = [
    ["dataset id", (v) => ({ dataset: v }), ["ON004362", "on00436", "on004362/../x", "on004362\n"]],
    [
      "upstream dataset id",
      (v) => ({ ds: v }),
      ["ds4362", "DS004362", "ds004362/../x", "ds004362 --x"],
    ],
    [
      "from tag",
      (v) => ({ from_tag: v }),
      ["", "-1.0.0", "1.0.0/../x", "1..0", "a b", "x".repeat(65)],
    ],
    ["to tag", (v) => ({ to_tag: v }), ["", "--upload-pack=x", "refs/tags/1", "1..0", "1.0.0\n"]],
    [
      "current version",
      (v) => ({ current: v }),
      ["2", "2.0", "v2.0.0", "2.0.0-rc1", "../2.0.0", ""],
    ],
    ["N.0.0 version", (v) => ({ n0: v }), ["2", "2.0", "v2.0.0", "2.0.0 ", "../2.0.0", ""]],
    ["N.0.1 version", (v) => ({ n1: v }), ["2", "2.0", "v2.0.1", "2.0.1\n", "../2.0.1", ""]],
    // A commit id ends up as an argument of git: a short, long, upper-case, SHA-256, non-hex or
    // option-looking value is refused, and so is one with a newline or a space after a valid id.
    ["upstream commit", (v) => ({ to_commit: v }), COMMIT_CASES],
    ["main commit", (v) => ({ main_commit: v }), COMMIT_CASES],
    ["git-annex commit", (v) => ({ annex_commit: v }), COMMIT_CASES],
  ];

  for (const [field, over, bad] of CASES) {
    test(`a malformed ${field} is refused as plan-schema, naming the field and not the value`, () => {
      for (const value of bad) {
        const err = refusal(over(value));
        expect([field, value, err.code]).toEqual([field, value, "plan-schema"]);
        expect([field, value, err.message]).toEqual([
          field,
          value,
          expect.stringContaining(`The plan's ${field} is not`),
        ]);
        if (value.trim().length > 3) expect(err.message).not.toContain(value.trim());
      }
    });
  }

  test("a field the plan does not state at all is still refused by the planner's own shape error", () => {
    const err = (() => {
      try {
        planFacts({ ...body({}), dataset: undefined } as unknown as PlanBody);
      } catch (e) {
        return e as ExecuteRefused;
      }
      throw new Error("accepted");
    })();
    expect(err.code).toBe("plan-schema");
    expect(err.message).toContain("does not have the planner's shape");
  });
});
