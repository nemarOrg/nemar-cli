import { describe, expect, test } from "bun:test";
import {
  type BucketPolicy,
  addPrivateDataset,
  buildPublicAccessPolicy,
  ensurePublicAccessStatement,
  isDatasetPrivate,
  listPrivateDatasets,
  MAX_BUCKET_POLICY_BYTES,
  policyByteSize,
  prefixArn,
  prefixIdFromArn,
  PUBLIC_ACCESS_SID,
  removePrivateDataset,
  STAGING_PREFIX,
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
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::other/nm000111/*`)).toBeNull();
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::${BUCKET}/nm000111`)).toBeNull();
    expect(prefixIdFromArn(BUCKET, `arn:aws:s3:::${BUCKET}/a/b/*`)).toBeNull();
  });
});
