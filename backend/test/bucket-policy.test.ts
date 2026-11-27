import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BucketPolicy,
  MAX_BUCKET_POLICY_BYTES,
  POLICY_WARN_FRACTION,
  PUBLIC_ACCESS_SID,
  STAGING_PREFIX,
  addPrivateDataset,
  buildPublicAccessPolicy,
  compactPrivateIds,
  derivePublicPrefixes,
  ensurePublicAccessStatement,
  hasHeadroomForNewDataset,
  isDatasetPrivate,
  isPolicyNearCap,
  listPrivateDatasets,
  policyByteSize,
  prefixArn,
  prefixIdFromArn,
  removePrivateDataset,
} from "../src/services/bucket-policy";

const BUCKET = "nemar";

function stagingArn(): string {
  return prefixArn(BUCKET, STAGING_PREFIX);
}

function publicStatement(policy: BucketPolicy) {
  const stmt = policy.Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID);
  if (!stmt) throw new Error("public-access statement missing");
  return stmt;
}

describe("buildPublicAccessPolicy", () => {
  test("emits a single public-by-default Allow with NotResource carve-outs", () => {
    const policy = buildPublicAccessPolicy(BUCKET, ["nm000111", "nm000116"]);
    expect(policy.Statement).toHaveLength(1);
    const stmt = publicStatement(policy);
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Principal).toBe("*");
    expect(stmt.Action).toBe("s3:GetObject");
    expect(stmt.Resource).toBeUndefined();
    expect(stmt.NotResource).toEqual([
      stagingArn(),
      prefixArn(BUCKET, "nm000111"),
      prefixArn(BUCKET, "nm000116"),
    ]);
  });

  test("staging is always excluded, even with no private datasets", () => {
    const policy = buildPublicAccessPolicy(BUCKET, []);
    expect(publicStatement(policy).NotResource).toEqual([stagingArn()]);
    expect(listPrivateDatasets(policy, BUCKET)).toEqual([]);
  });

  test("private ARNs are sorted and de-duplicated", () => {
    const policy = buildPublicAccessPolicy(BUCKET, [
      "nm000300",
      "nm000100",
      "nm000300",
      "nm000200",
    ]);
    expect(listPrivateDatasets(policy, BUCKET)).toEqual(["nm000100", "nm000200", "nm000300"]);
  });
});

describe("isDatasetPrivate / listPrivateDatasets", () => {
  test("a carved-out dataset is private; others are public", () => {
    const policy = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(true);
    expect(isDatasetPrivate(policy, BUCKET, "nm000103")).toBe(false);
  });

  test("staging is never reported as a private dataset id", () => {
    const policy = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    expect(listPrivateDatasets(policy, BUCKET)).toEqual(["nm000111"]);
    expect(listPrivateDatasets(policy, BUCKET)).not.toContain(STAGING_PREFIX);
  });

  test("round-trips a set of private ids", () => {
    const ids = ["on004350", "nm000205", "nm000111"];
    const policy = buildPublicAccessPolicy(BUCKET, ids);
    expect(new Set(listPrivateDatasets(policy, BUCKET))).toEqual(new Set(ids));
  });
});

describe("addPrivateDataset", () => {
  test("adds a carve-out and is idempotent", () => {
    let policy = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    policy = addPrivateDataset(policy, BUCKET, "nm000116");
    expect(isDatasetPrivate(policy, BUCKET, "nm000116")).toBe(true);
    policy = addPrivateDataset(policy, BUCKET, "nm000116");
    expect(listPrivateDatasets(policy, BUCKET).filter((id) => id === "nm000116")).toHaveLength(1);
  });

  test("keeps staging and existing carve-outs", () => {
    let policy = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    policy = addPrivateDataset(policy, BUCKET, "nm000116");
    expect(publicStatement(policy).NotResource).toContain(stagingArn());
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(true);
  });

  test("creates the statement from an empty policy", () => {
    const policy = addPrivateDataset(null, BUCKET, "nm000111");
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(true);
    expect(publicStatement(policy).NotResource).toContain(stagingArn());
  });
});

describe("removePrivateDataset", () => {
  test("removes a carve-out (makes it public) and is idempotent", () => {
    let policy = buildPublicAccessPolicy(BUCKET, ["nm000111", "nm000116"]);
    policy = removePrivateDataset(policy, BUCKET, "nm000111");
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(false);
    expect(isDatasetPrivate(policy, BUCKET, "nm000116")).toBe(true);
    // removing an already-public dataset is a no-op
    policy = removePrivateDataset(policy, BUCKET, "nm000111");
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(false);
  });

  test("never removes the staging carve-out", () => {
    let policy = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    policy = removePrivateDataset(policy, BUCKET, "nm000111");
    expect(publicStatement(policy).NotResource).toEqual([stagingArn()]);
  });

  test("from a null policy yields a staging-only public statement", () => {
    const policy = removePrivateDataset(null, BUCKET, "nm000111");
    expect(publicStatement(policy).NotResource).toEqual([stagingArn()]);
    expect(isDatasetPrivate(policy, BUCKET, "nm000111")).toBe(false);
  });
});

describe("policy Version handling", () => {
  test("add/removePrivateDataset injects the default Version when input has none", () => {
    const noVersion: BucketPolicy = {
      Version: "",
      Statement: [buildPublicAccessPolicy(BUCKET, ["nm000111"]).Statement[0]],
    };
    expect(addPrivateDataset(noVersion, BUCKET, "nm000112").Version).toBe("2012-10-17");
    expect(removePrivateDataset(noVersion, BUCKET, "nm000111").Version).toBe("2012-10-17");
  });
});

describe("statement preservation", () => {
  test("add/remove only touches the public-access statement", () => {
    const other = {
      Sid: "SomeUnrelatedDeny",
      Effect: "Deny" as const,
      Principal: "*" as const,
      Action: "s3:DeleteObject",
      Resource: `arn:aws:s3:::${BUCKET}/locked/*`,
    };
    const base: BucketPolicy = {
      Version: "2012-10-17",
      Statement: [buildPublicAccessPolicy(BUCKET, ["nm000111"]).Statement[0], other],
    };
    const added = addPrivateDataset(base, BUCKET, "nm000116");
    expect(added.Statement).toContainEqual(other);
    const removed = removePrivateDataset(added, BUCKET, "nm000111");
    expect(removed.Statement).toContainEqual(other);
  });
});

describe("ensurePublicAccessStatement", () => {
  test("creates a staging-only statement from null", () => {
    const policy = ensurePublicAccessStatement(null, BUCKET);
    expect(publicStatement(policy).NotResource).toEqual([stagingArn()]);
  });

  test("preserves the private set when already present", () => {
    const before = buildPublicAccessPolicy(BUCKET, ["nm000111", "nm000116"]);
    const after = ensurePublicAccessStatement(before, BUCKET);
    expect(new Set(listPrivateDatasets(after, BUCKET))).toEqual(new Set(["nm000111", "nm000116"]));
  });

  test("on a legacy allow-list policy carves out only staging and keeps legacy statements", () => {
    // Bucket state just before migration: two datasets already published
    // (legacy per-dataset Allow), no PUBLIC_ACCESS_SID statement yet.
    const legacy = legacyAllowPolicy(["nm000103", "nm000104"]);
    const result = ensurePublicAccessStatement(legacy, BUCKET);
    expect(publicStatement(result).NotResource).toEqual([stagingArn()]);
    // Legacy statements are preserved (withPrivateSet keeps non-PUBLIC_ACCESS_SID entries).
    expect(result.Statement.some((s) => s.Sid === "PublicReadDataset_nm000103")).toBe(true);
  });
});

function legacyAllowPolicy(publicIds: string[]): BucketPolicy {
  return {
    Version: "2012-10-17",
    Statement: publicIds.map((id) => ({
      Sid: `PublicReadDataset_${id}`,
      Effect: "Allow" as const,
      Principal: "*" as const,
      Action: "s3:GetObject",
      Resource: prefixArn(BUCKET, id),
    })),
  };
}

describe("derivePublicPrefixes (migration source-of-truth)", () => {
  const allPrefixes = ["nm000103", "nm000104", "nm000111", STAGING_PREFIX];

  test("null policy -> nothing public", () => {
    expect(derivePublicPrefixes(null, BUCKET, allPrefixes).size).toBe(0);
  });

  test("legacy allow-list -> public = datasets named by Allow statements", () => {
    const legacy = legacyAllowPolicy(["nm000103", "nm000104"]);
    const pub = derivePublicPrefixes(legacy, BUCKET, allPrefixes);
    expect(pub).toEqual(new Set(["nm000103", "nm000104"]));
    // nm000111 (no Allow) is private; staging is never public.
    expect(pub.has("nm000111")).toBe(false);
    expect(pub.has(STAGING_PREFIX)).toBe(false);
  });

  test("already-migrated policy -> public = everything not carved out", () => {
    const migrated = buildPublicAccessPolicy(BUCKET, ["nm000111"]);
    const pub = derivePublicPrefixes(migrated, BUCKET, allPrefixes);
    expect(pub).toEqual(new Set(["nm000103", "nm000104"]));
  });

  test("supports the AWS object principal form { AWS: '*' }", () => {
    const policy: BucketPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadDataset_nm000103",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: ["s3:GetObject"],
          Resource: prefixArn(BUCKET, "nm000103"),
        },
      ],
    };
    expect(derivePublicPrefixes(policy, BUCKET, allPrefixes)).toEqual(new Set(["nm000103"]));
  });

  test("migration round-trip preserves equal access (legacy -> new policy)", () => {
    const legacy = legacyAllowPolicy(["nm000103", "nm000104"]);
    const publicSet = derivePublicPrefixes(legacy, BUCKET, allPrefixes);
    const privateIds = allPrefixes.filter((p) => p !== STAGING_PREFIX && !publicSet.has(p));
    const migrated = buildPublicAccessPolicy(BUCKET, privateIds);
    for (const id of publicSet) expect(isDatasetPrivate(migrated, BUCKET, id)).toBe(false);
    for (const id of privateIds) expect(isDatasetPrivate(migrated, BUCKET, id)).toBe(true);
  });
});

describe("equal-access invariant (migration safety)", () => {
  test("public stays public, private stays private", () => {
    const publicIds = ["nm000103", "nm000104", "nm000105", "on002999"];
    const privateIds = ["nm000111", "nm000116", "nm000203", "xx000001"];
    const policy = buildPublicAccessPolicy(BUCKET, privateIds);
    for (const id of publicIds) {
      expect(isDatasetPrivate(policy, BUCKET, id)).toBe(false);
    }
    for (const id of privateIds) {
      expect(isDatasetPrivate(policy, BUCKET, id)).toBe(true);
    }
  });
});

describe("byte-size bound", () => {
  test("a large private set stays well under the 20KB cap", () => {
    // The legacy allow-list hit the cap at ~149 *public* datasets (~137 bytes
    // each). The new policy scales only with the *private* set, in one
    // statement. Even an unrealistically large private set is comfortably under.
    const ids = Array.from({ length: 300 }, (_, i) => `nm${String(100000 + i)}`);
    const policy = buildPublicAccessPolicy(BUCKET, ids);
    expect(policyByteSize(policy)).toBeLessThan(MAX_BUCKET_POLICY_BYTES);
  });
});

describe("prefixIdFromArn", () => {
  test("parses a dataset id from a prefix ARN", () => {
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::${BUCKET}/nm000111/*`)).toBe("nm000111");
    expect(prefixIdFromArn(BUCKET, stagingArn())).toBe(STAGING_PREFIX);
  });

  test("rejects non-matching ARNs", () => {
    expect(prefixIdFromArn(BUCKET, "arn:aws:s3:::other/nm000111/*")).toBeNull();
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::${BUCKET}/nm000111`)).toBeNull();
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::${BUCKET}/a/b/*`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Compaction (#2497). Every test below works on a real policy document: the
// statement the code writes, or one shaped exactly like the live one.
// ---------------------------------------------------------------------------

/** A policy whose carve-out is the given entries verbatim (as AWS returns it). */
function rawPolicy(entries: string[]): BucketPolicy {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: PUBLIC_ACCESS_SID,
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        NotResource: entries.map((e) => prefixArn(BUCKET, e)),
      },
    ],
  };
}

function decade(prefix: string): string[] {
  return Array.from({ length: 10 }, (_, d) => `${prefix}${d}`);
}

function notResource(policy: BucketPolicy): string[] {
  const nr = publicStatement(policy).NotResource;
  return Array.isArray(nr) ? nr : [nr as string];
}

describe("compaction: the canonical form", () => {
  test("a full decade compacts to one ? entry", () => {
    const policy = buildPublicAccessPolicy(BUCKET, [...decade("nm00054"), "nm000551"]);
    expect(notResource(policy)).toEqual([
      stagingArn(),
      prefixArn(BUCKET, "nm00054?"),
      prefixArn(BUCKET, "nm000551"),
    ]);
  });

  test("nine of ten never compact", () => {
    const nine = decade("nm00054").slice(0, 9);
    expect(compactPrivateIds(nine)).toEqual(nine);
  });

  test("ten full decades of a hundred compact to one ?? entry", () => {
    const ids: string[] = [];
    for (let t = 0; t < 10; t++) ids.push(...decade(`nm0005${t}`));
    expect(compactPrivateIds([...ids, "nm000600"])).toEqual(["nm0005??", "nm000600"]);
  });

  test("nine full decades stay nine decade entries", () => {
    const ids: string[] = [];
    for (let t = 0; t < 9; t++) ids.push(...decade(`nm0005${t}`));
    expect(compactPrivateIds(ids)).toEqual(Array.from({ length: 9 }, (_, t) => `nm0005${t}?`));
  });

  test("decades of different prefixes never merge", () => {
    expect(compactPrivateIds([...decade("nm00054"), ...decade("on00054")])).toEqual([
      "nm00054?",
      "on00054?",
    ]);
  });

  test("an id of another shape is kept explicit and never grouped", () => {
    expect(compactPrivateIds(["abc", "nm00054"])).toEqual(["abc", "nm00054"]);
  });

  test("no wildcard is ever written with * inside the id", () => {
    const ids: string[] = [];
    for (let t = 0; t < 10; t++) ids.push(...decade(`nm0005${t}`));
    for (const arn of notResource(buildPublicAccessPolicy(BUCKET, ids))) {
      const id = prefixIdFromArn(BUCKET, arn);
      expect(id?.includes("*")).toBe(false);
    }
  });
});

describe("compaction: reading both forms back", () => {
  test("explicit and wildcard entries round-trip to the same id set", () => {
    const ids = [...decade("nm00054"), "nm000551", "on004350"];
    const explicit = rawPolicy(ids);
    const compacted = buildPublicAccessPolicy(BUCKET, ids);
    expect(listPrivateDatasets(compacted, BUCKET)).toEqual([...ids].sort());
    expect(listPrivateDatasets(explicit, BUCKET)).toEqual([...ids].sort());
    // Rewriting the explicit form yields exactly the compacted form.
    expect(ensurePublicAccessStatement(explicit, BUCKET)).toEqual(compacted);
  });

  test("an id covered by a decade wildcard is private", () => {
    const policy = rawPolicy(["staging", "nm00054?"]);
    for (const id of decade("nm00054")) expect(isDatasetPrivate(policy, BUCKET, id)).toBe(true);
    expect(isDatasetPrivate(policy, BUCKET, "nm000550")).toBe(false);
    expect(isDatasetPrivate(policy, BUCKET, "nm000539")).toBe(false);
  });

  test("an id covered by a hundred wildcard is private", () => {
    const policy = rawPolicy(["nm0005??"]);
    expect(isDatasetPrivate(policy, BUCKET, "nm000500")).toBe(true);
    expect(isDatasetPrivate(policy, BUCKET, "nm000599")).toBe(true);
    expect(isDatasetPrivate(policy, BUCKET, "nm000600")).toBe(false);
    expect(listPrivateDatasets(policy, BUCKET)).toHaveLength(100);
  });

  test("derivePublicPrefixes (the migration audit) sees a covered id as private", () => {
    const policy = rawPolicy(["staging", "nm00054?"]);
    const pub = derivePublicPrefixes(policy, BUCKET, ["nm000541", "nm000550", "staging"]);
    expect([...pub]).toEqual(["nm000550"]);
  });

  test("staging is preserved through every rewrite and never read as an id", () => {
    const policy = addPrivateDataset(rawPolicy(["staging", ...decade("nm00054")]), BUCKET, "x1");
    expect(notResource(policy)[0]).toBe(stagingArn());
    expect(listPrivateDatasets(policy, BUCKET)).not.toContain(STAGING_PREFIX);
  });

  test("an entry this module does not write is kept verbatim, never widened", () => {
    const foreign = `arn:aws:s3:::${BUCKET}/nm*/*`;
    const otherBucket = "arn:aws:s3:::other/nm000111/*";
    const policy: BucketPolicy = rawPolicy(["staging", "nm000111"]);
    (publicStatement(policy).NotResource as string[]).push(foreign, otherBucket);
    const next = removePrivateDataset(policy, BUCKET, "nm000111");
    expect(notResource(next)).toContain(foreign);
    expect(notResource(next)).toContain(otherBucket);
    expect(listPrivateDatasets(next, BUCKET)).toEqual([]);
  });
});

describe("compaction: transitions", () => {
  test("adding the tenth id of a decade compacts it", () => {
    const nine = rawPolicy(["staging", ...decade("nm00054").slice(0, 9)]);
    const next = addPrivateDataset(nine, BUCKET, "nm000549");
    expect(notResource(next)).toEqual([stagingArn(), prefixArn(BUCKET, "nm00054?")]);
  });

  test("removing one id of a covered decade expands it; the other nine stay private", () => {
    const policy = rawPolicy(["staging", "nm00054?"]);
    const next = removePrivateDataset(policy, BUCKET, "nm000543");
    expect(isDatasetPrivate(next, BUCKET, "nm000543")).toBe(false);
    for (const id of decade("nm00054").filter((i) => i !== "nm000543")) {
      expect(isDatasetPrivate(next, BUCKET, id)).toBe(true);
    }
    expect(notResource(next)).toHaveLength(10); // staging + nine explicit
    expect(notResource(next).some((a) => a.includes("?"))).toBe(false);
  });

  test("removing one id of a covered hundred keeps the other 99 private and compacts the rest", () => {
    const next = removePrivateDataset(rawPolicy(["nm0005??"]), BUCKET, "nm000543");
    expect(listPrivateDatasets(next, BUCKET)).toHaveLength(99);
    expect(isDatasetPrivate(next, BUCKET, "nm000543")).toBe(false);
    // Nine decades stay wildcards, the broken one is nine explicit ids.
    expect(notResource(next)).toHaveLength(1 + 9 + 9);
  });

  test("a non-private id is never covered, whatever the set", () => {
    const ids = [...decade("nm00054").slice(0, 9), ...decade("nm00055")];
    const policy = buildPublicAccessPolicy(BUCKET, ids);
    expect(isDatasetPrivate(policy, BUCKET, "nm000549")).toBe(false);
    expect(new Set(listPrivateDatasets(policy, BUCKET))).toEqual(new Set(ids));
  });
});

describe("compaction: the live carve-out of 2026-11-27 (#2497)", () => {
  const lines = readFileSync(
    join(import.meta.dir, "fixtures/bucket-policy/carveout-2026-11-27.txt"),
    "utf8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const ids = lines.filter((l) => l !== STAGING_PREFIX);
  const live = rawPolicy(lines);

  test("the fixture is the measured list: 628 entries, near the cap", () => {
    expect(lines).toHaveLength(628);
    expect(lines).toContain(STAGING_PREFIX);
    // 20,240 bytes for this statement alone; the live policy measured 20,431
    // with its second (list-only) statement, against the 20,480 cap.
    expect(policyByteSize(live)).toBeGreaterThan(20_000);
  });

  test("compacts below 10 KB and every id stays private", () => {
    const compacted = ensurePublicAccessStatement(live, BUCKET);
    const size = policyByteSize(compacted);
    expect(size).toBeLessThan(10_000);
    for (const id of ids) expect(isDatasetPrivate(compacted, BUCKET, id)).toBe(true);
    expect(listPrivateDatasets(compacted, BUCKET)).toEqual([...new Set(ids)].sort());
    expect(notResource(compacted)[0]).toBe(stagingArn());
    expect(hasHeadroomForNewDataset(compacted, BUCKET).ok).toBe(true);
  });

  test("the first transition after deploy writes the compacted form", () => {
    const next = addPrivateDataset(live, BUCKET, "nm099001");
    expect(policyByteSize(next)).toBeLessThan(10_000);
    expect(isDatasetPrivate(next, BUCKET, "nm099001")).toBe(true);
  });
});

describe("headroom and the near-cap guard", () => {
  /** Explicit ids no two of which share a decade, so nothing compacts. */
  function sparse(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `nm${String(i * 10).padStart(6, "0")}`);
  }

  test("refuses exactly when one more explicit entry would exceed the cap", () => {
    let n = 1;
    while (hasHeadroomForNewDataset(buildPublicAccessPolicy(BUCKET, sparse(n)), BUCKET).ok) n++;
    const full = buildPublicAccessPolicy(BUCKET, sparse(n));
    const fits = buildPublicAccessPolicy(BUCKET, sparse(n - 1));
    // The last policy with headroom really does take one more id under the cap.
    expect(policyByteSize(addPrivateDataset(fits, BUCKET, "nm999990"))).toBeLessThanOrEqual(
      MAX_BUCKET_POLICY_BYTES,
    );
    // The refused one really would not.
    expect(policyByteSize(addPrivateDataset(full, BUCKET, "nm999990"))).toBeGreaterThan(
      MAX_BUCKET_POLICY_BYTES,
    );
    expect(hasHeadroomForNewDataset(full, BUCKET).ok).toBe(false);
  });

  test("the near-cap guard trips above 80 percent and not at it", () => {
    const threshold = MAX_BUCKET_POLICY_BYTES * POLICY_WARN_FRACTION;
    expect(isPolicyNearCap(Math.floor(threshold))).toBe(false);
    expect(isPolicyNearCap(Math.floor(threshold) + 1)).toBe(true);
  });
});
