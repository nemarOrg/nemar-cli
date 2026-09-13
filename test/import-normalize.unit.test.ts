/**
 * The parts of the import normalization that are pure text and pure selection
 * (#1159, ADR 0057). Split from `import-normalize.test.ts` so they do not each
 * pay for a git-annex repository and a special remote in `beforeEach`.
 */

import { describe, expect, test } from "bun:test";
import { isGitPlumbingPattern, stripLargefilesAttributes } from "../src/lib/import-normalize";
import { type ImportManifestItem, selectShardCopyItems } from "../src/lib/s3-server-copy";

describe("stripLargefilesAttributes", () => {
  test("removes only the largefiles attribute, keeping the rest of the line", () => {
    const { content, stripped, skipped } = stripLargefilesAttributes(
      "*.tsv text eol=lf annex.largefiles=largerthan=1mb\n",
    );
    expect(content).toBe("*.tsv text eol=lf\n");
    expect(stripped).toBe(1);
    expect(skipped).toEqual([]);
  });

  test("drops a line whose only attribute was largefiles", () => {
    const { content, stripped } = stripLargefilesAttributes(
      "* annex.backend=SHA256E\n*.bval annex.largefiles=nothing\n",
    );
    expect(content).toBe("* annex.backend=SHA256E\n");
    expect(stripped).toBe(1);
  });

  test("keeps the git-plumbing line untouched", () => {
    const input = "**/.git* annex.largefiles=nothing\n.gitattributes annex.largefiles=nothing\n";
    const { content, stripped } = stripLargefilesAttributes(input);
    expect(content).toBe(input);
    expect(stripped).toBe(0);
  });

  test("handles the unset spellings as well as the assignment", () => {
    const { content, stripped } = stripLargefilesAttributes(
      "a.tsv -annex.largefiles text\nb.tsv !annex.largefiles text\nc.tsv annex.largefiles text\n",
    );
    expect(content).toBe("a.tsv text\nb.tsv text\nc.tsv text\n");
    expect(stripped).toBe(3);
  });

  test("preserves comments, blank lines and the missing final newline", () => {
    const { content } = stripLargefilesAttributes(
      "# upstream policy\n\n*.tsv annex.largefiles=largerthan=1mb text",
    );
    expect(content).toBe("# upstream policy\n\n*.tsv text");
  });

  test("leaves a file with nothing to strip byte-identical", () => {
    const input = "* annex.backend=MD5E\n**/.git* annex.largefiles=nothing\n";
    expect(stripLargefilesAttributes(input)).toEqual({
      content: input,
      stripped: 0,
      skipped: [],
    });
  });

  test("declines a quoted pattern instead of cutting it in half", () => {
    // Splitting on whitespace would turn `"sub 01/*.tsv"` into two tokens and
    // leave the tail as a bogus attribute. Reported, not mangled.
    const input = '"sub 01/*.tsv" annex.largefiles=largerthan=1mb text\n';
    const { content, stripped, skipped } = stripLargefilesAttributes(input);
    expect(content).toBe(input);
    expect(stripped).toBe(0);
    expect(skipped).toEqual(['"sub 01/*.tsv" annex.largefiles=largerthan=1mb text']);
  });
});

describe("isGitPlumbingPattern", () => {
  test("recognizes the spellings DataLad and OpenNeuro write", () => {
    expect(isGitPlumbingPattern("**/.git*")).toBe(true);
    expect(isGitPlumbingPattern(".git*")).toBe(true);
    expect(isGitPlumbingPattern(".gitattributes")).toBe(true);
    expect(isGitPlumbingPattern("sub-01/.gitignore")).toBe(true);
  });

  test("does not swallow dataset content", () => {
    expect(isGitPlumbingPattern("*.tsv")).toBe(false);
    expect(isGitPlumbingPattern("phenotype/*.tsv")).toBe(false);
    expect(isGitPlumbingPattern("dataset_description.json")).toBe(false);
  });
});

describe("selectShardCopyItems", () => {
  const local = (key: string): ImportManifestItem => ({
    key,
    sourceUrl: null,
    source: null,
    destUri: `s3://nemar/on007788/objects/${key}`,
    origin: "local",
  });
  const upstream = (key: string): ImportManifestItem => ({
    key,
    sourceUrl: `https://openneuro.org/${key}`,
    source: null,
    destUri: `s3://nemar/on007788/objects/${key}`,
  });

  test("never hands a locally-uploaded key to the copy phase", () => {
    const items = [local("SHA256E-s1--a"), upstream("SHA256E-s2--b"), local("SHA256E-s3--c")];
    const { shardItems, localSkipped } = selectShardCopyItems(items, { index: 0, count: 1 });
    expect(localSkipped).toBe(2);
    expect(shardItems.map((i) => i.key)).toEqual(["SHA256E-s2--b"]);
  });

  test("an item with no origin is upstream, so old manifests still copy", () => {
    const { shardItems, localSkipped } = selectShardCopyItems([upstream("SHA256E-s2--b")], {
      index: 0,
      count: 1,
    });
    expect(localSkipped).toBe(0);
    expect(shardItems).toHaveLength(1);
  });

  test("the shards still partition the upstream keys exactly once", () => {
    const items = [
      upstream("SHA256E-s1--a"),
      upstream("SHA256E-s2--b"),
      upstream("SHA256E-s3--c"),
      upstream("SHA256E-s4--d"),
      local("SHA256E-s5--e"),
    ];
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(
        ...selectShardCopyItems(items, { index: i, count: 3 }).shardItems.map((s) => s.key),
      );
    }
    expect(seen.sort()).toEqual([
      "SHA256E-s1--a",
      "SHA256E-s2--b",
      "SHA256E-s3--c",
      "SHA256E-s4--d",
    ]);
  });

  test("each shard counts only the local keys it owns", () => {
    // Counting them manifest-wide made all N shards log the same total, so an
    // operator summing the shard logs saw N times the real number.
    const items = [
      local("SHA256E-s1--a"),
      local("SHA256E-s2--b"),
      local("SHA256E-s3--c"),
      local("SHA256E-s4--d"),
      local("SHA256E-s5--e"),
    ];
    const total = [0, 1, 2, 3].reduce(
      (sum, index) => sum + selectShardCopyItems(items, { index, count: 4 }).localSkipped,
      0,
    );
    expect(total).toBe(items.length);
  });
});

describe("the manifest as it crosses S3 staging", () => {
  test("origin survives the JSON round trip between phases", () => {
    // prepare, copy and finalize are separate processes that share only this
    // document, so a local key that lost its origin in transit would be handed
    // back to the copy phase with no source to copy from.
    const manifest = {
      openneuroId: "ds007788",
      nemarId: "on007788",
      nemarUuid: "uuid",
      items: [
        {
          key: "SHA256E-s300000--aaa.tsv",
          sourceUrl: null,
          source: null,
          destUri: "s3://nemar/on007788/objects/SHA256E-s300000--aaa.tsv",
          origin: "local" as const,
        },
        {
          key: "SHA256E-s2--b",
          sourceUrl: "https://openneuro.org/x",
          source: null,
          destUri: "s3://nemar/on007788/objects/SHA256E-s2--b",
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    const { shardItems, localSkipped } = selectShardCopyItems(round.items, {
      index: 0,
      count: 1,
    });
    expect(localSkipped).toBe(1);
    expect(shardItems.map((i) => i.key)).toEqual(["SHA256E-s2--b"]);
  });
});
