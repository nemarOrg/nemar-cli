/**
 * Unit tests for the pure functions backing the data.nemar.org route
 * (epic #449, phase 1). D1-dependent paths (resolveVersion("latest"))
 * and the annex-presign branch of buildRedirectUrl are covered in the
 * E2E test against a deployed backend instead -- per repo policy, no
 * mocked databases or AWS clients.
 */

import { describe, expect, test } from "bun:test";
import "./setup";

import {
  VERSION_TAG_RE,
  buildRedirectUrl,
  escapeHtml,
  humanSize,
  renderIndexHtml,
  resolveFile,
  resolveVersion,
} from "../backend/src/services/data-router";
import type { VersionManifest } from "../backend/src/services/manifest";

function fixture(): VersionManifest {
  return {
    dataset_id: "nm099999",
    version: "1.0.0",
    doi: null,
    concept_doi: null,
    created: "2026-05-14T00:00:00Z",
    files: {
      "dataset_description.json": { key: "git:abc123", size: 480, checksum: "git:abc123" },
      "participants.tsv": { key: "git:def456", size: 120, checksum: "git:def456" },
      "sub-01/eeg/sub-01_task-rest_eeg.edf": {
        key: "SHA256E-s12345--deadbeefcafebabe.edf",
        size: 12345,
        checksum: "sha256:deadbeefcafebabe",
      },
      "sub-01/eeg/sub-01_task-rest_events.tsv": {
        key: "git:111aaa",
        size: 220,
        checksum: "git:111aaa",
      },
      "sub-02/eeg/sub-02_task-rest_eeg.edf": {
        key: "SHA256E-s23456--feedfacefeedface.edf",
        size: 23456,
        checksum: "sha256:feedfacefeedface",
      },
    },
  };
}

describe("VERSION_TAG_RE", () => {
  test("accepts canonical vX.Y.Z", () => {
    expect(VERSION_TAG_RE.test("v1.0.0")).toBe(true);
    expect(VERSION_TAG_RE.test("v12.345.6789")).toBe(true);
  });
  test("rejects malformed", () => {
    expect(VERSION_TAG_RE.test("1.0.0")).toBe(false);
    expect(VERSION_TAG_RE.test("v1.0")).toBe(false);
    expect(VERSION_TAG_RE.test("v1.0.0-rc1")).toBe(false);
    expect(VERSION_TAG_RE.test("latest")).toBe(false);
    expect(VERSION_TAG_RE.test("../../etc/passwd")).toBe(false);
  });
});

describe("resolveVersion", () => {
  // The dummy DB cast below is only reached by branches that legitimately
  // return before any query (invalid version syntax, exact-tag passthrough).
  // The "latest" path is exercised in the E2E test, not here.
  test("rejects bogus version strings before touching the DB", async () => {
    const dummyDb = {} as D1Database;
    const r = await resolveVersion(dummyDb, "nm099999", "not-a-version");
    expect(r).toEqual({ ok: false, reason: "invalid_version" });
  });

  test("passes through valid vX.Y.Z without touching the DB", async () => {
    const dummyDb = {} as D1Database;
    const r = await resolveVersion(dummyDb, "nm099999", "v2.3.4");
    expect(r).toEqual({ ok: true, version: "v2.3.4" });
  });
});

describe("resolveFile", () => {
  test("top-level file hit", () => {
    const r = resolveFile(fixture(), "dataset_description.json");
    expect(r.kind).toBe("file");
    if (r.kind === "file") expect(r.file.key).toBe("git:abc123");
  });

  test("nested file hit", () => {
    const r = resolveFile(fixture(), "sub-01/eeg/sub-01_task-rest_eeg.edf");
    expect(r.kind).toBe("file");
    if (r.kind === "file") expect(r.file.size).toBe(12345);
  });

  test("root directory lists top-level children, sorted dirs-first", () => {
    const r = resolveFile(fixture(), "");
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    const names = r.children.map((c) => `${c.name}${c.kind === "dir" ? "/" : ""}`);
    expect(names).toEqual(["sub-01/", "sub-02/", "dataset_description.json", "participants.tsv"]);
  });

  test("nested directory listing dedupes immediate children", () => {
    const r = resolveFile(fixture(), "sub-01");
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => c.name)).toEqual(["eeg"]);
    expect(r.children[0].kind).toBe("dir");
  });

  test("nested directory leaf shows files with sizes", () => {
    const r = resolveFile(fixture(), "sub-01/eeg");
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => c.name).sort()).toEqual([
      "sub-01_task-rest_eeg.edf",
      "sub-01_task-rest_events.tsv",
    ]);
    expect(r.children.every((c) => c.kind === "file")).toBe(true);
  });

  test("trailing slash normalises", () => {
    const r = resolveFile(fixture(), "sub-01/eeg/");
    expect(r.kind).toBe("directory");
  });

  test("non-existent path returns not_found", () => {
    expect(resolveFile(fixture(), "sub-99/eeg").kind).toBe("not_found");
    expect(resolveFile(fixture(), "totally-bogus.txt").kind).toBe("not_found");
  });

  test("rejects path traversal", () => {
    expect(resolveFile(fixture(), "../etc/passwd").kind).toBe("not_found");
    expect(resolveFile(fixture(), "sub-01/../sub-02").kind).toBe("not_found");
    expect(resolveFile(fixture(), "/abs/path").kind).toBe("not_found");
  });

  test("URL-encoded traversal segments do not resolve to anything", () => {
    // Hono passes the path through without decoding; `%2E%2E` is a literal
    // segment that misses every manifest key. This test pins the contract
    // so a future "let's pre-decode the path" refactor fails loudly.
    expect(resolveFile(fixture(), "%2E%2E/etc/passwd").kind).toBe("not_found");
    expect(resolveFile(fixture(), "sub-01%2F..%2Fsub-02").kind).toBe("not_found");
  });

  test("rejects prototype-pollution-shaped segments", () => {
    expect(resolveFile(fixture(), "__proto__").kind).toBe("not_found");
    expect(resolveFile(fixture(), "constructor/prototype").kind).toBe("not_found");
  });

  test("root of an empty manifest returns an empty directory, not 404", () => {
    const empty: VersionManifest = {
      dataset_id: "nm099999",
      version: "0.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-05-14T00:00:00Z",
      files: {},
    };
    const r = resolveFile(empty, "");
    expect(r.kind).toBe("directory");
    if (r.kind === "directory") {
      expect(r.children).toEqual([]);
      expect(r.path).toBe("");
    }
  });

  test("non-root path on empty manifest is still 404", () => {
    const empty: VersionManifest = {
      dataset_id: "nm099999",
      version: "0.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-05-14T00:00:00Z",
      files: {},
    };
    expect(resolveFile(empty, "sub-01").kind).toBe("not_found");
  });

  test("unicode and special-char filenames resolve and round-trip", () => {
    const manifest: VersionManifest = {
      dataset_id: "nm099999",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-05-14T00:00:00Z",
      files: {
        "sub-01/eeg/sub-01_テスト.edf": {
          key: "SHA256E-s10--abc.edf",
          size: 10,
          checksum: "sha256:abc",
        },
        "weird name & symbols.txt": { key: "git:zzz", size: 7, checksum: "git:zzz" },
      },
    };
    const file = resolveFile(manifest, "weird name & symbols.txt");
    expect(file.kind).toBe("file");
    const root = resolveFile(manifest, "");
    expect(root.kind).toBe("directory");
    if (root.kind === "directory") {
      const names = root.children.map((c) => c.name);
      expect(names).toContain("weird name & symbols.txt");
      expect(names).toContain("sub-01");
    }
  });
});

describe("buildRedirectUrl", () => {
  const s3Options = {
    bucket: "nemar",
    region: "us-east-2",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  };

  test("git: keys produce a raw.githubusercontent URL pinned to the version tag", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "dataset_description.json",
      file: { key: "git:abc123", size: 480, checksum: "git:abc123" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toBe(
      "https://raw.githubusercontent.com/nemarDatasets/nm099999/v1.0.0/dataset_description.json",
    );
  });

  test("git: keys URL-encode each path segment but keep the slashes", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "sub-01/eeg/sub-01_task-rest events.tsv",
      file: { key: "git:zzz", size: 1, checksum: "git:zzz" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toBe(
      "https://raw.githubusercontent.com/nemarDatasets/nm099999/v1.0.0/sub-01/eeg/sub-01_task-rest%20events.tsv",
    );
  });

  test("SHA256E annex keys produce a presigned S3 GET URL against objects/<key>", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "sub-01/eeg/sub-01_task-rest_eeg.edf",
      file: {
        key: "SHA256E-s12345--deadbeef.edf",
        size: 12345,
        checksum: "sha256:deadbeef",
      },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toContain("https://nemar.s3.us-east-2.amazonaws.com/nm099999/objects/");
    expect(url).toContain("SHA256E-s12345--deadbeef.edf");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("MD5E annex keys also presign (legacy OpenNeuro imports)", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "sub-01/eeg/x.edf",
      file: { key: "MD5E-s100--cafe.edf", size: 100, checksum: "md5:cafe" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toContain("/nm099999/objects/MD5E-s100--cafe.edf");
    expect(url).toContain("X-Amz-Signature=");
  });

  test("SHA1E annex keys also presign", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "x.bin",
      file: { key: "SHA1E-s50--feed.bin", size: 50, checksum: "sha1:feed" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toContain("/nm099999/objects/SHA1E-s50--feed.bin");
  });

  test("rejects manifest keys it cannot classify", async () => {
    await expect(
      buildRedirectUrl({
        datasetId: "nm099999",
        version: "v1.0.0",
        bidsPath: "x.bin",
        file: { key: "weird-format", size: 1, checksum: "x:y" },
        s3Options,
        githubOrg: "nemarDatasets",
      }),
    ).rejects.toThrow(/Unrecognized manifest key/);
  });
});

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml('<script>alert("x")</script>&\'')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
    );
  });
});

describe("humanSize", () => {
  test("formats common ranges", () => {
    expect(humanSize(0)).toBe("0");
    expect(humanSize(512)).toBe("512");
    expect(humanSize(2048)).toBe("2.0K");
    expect(humanSize(1024 * 1024)).toBe("1.0M");
    expect(humanSize(1024 * 1024 * 1024 * 3.5)).toBe("3.5G");
    expect(humanSize(1024 * 1024 * 12)).toBe("12M");
  });
  test("guards bad inputs without rendering NaN/undefined to users", () => {
    expect(humanSize(Number.NaN)).toBe("?");
    expect(humanSize(-1)).toBe("?");
    expect(humanSize(Number.POSITIVE_INFINITY)).toBe("?");
    // Petabyte tier is the top unit; values above stay in P.
    expect(humanSize(1024 ** 5)).toBe("1.0P");
  });
});

describe("renderIndexHtml", () => {
  test("renders the root listing without a parent link", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [
        { kind: "dir", name: "sub-01" },
        { kind: "file", name: "dataset_description.json", size: 480 },
      ],
    });
    expect(html).toContain("<title>Index of /nm099999/v1.0.0/</title>");
    expect(html).not.toContain('href="../"');
    expect(html).toContain('<a href="sub-01/">sub-01/</a>');
    expect(html).toContain("dataset_description.json");
  });

  test("non-root listings include a parent link", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "sub-01/eeg",
      entries: [{ kind: "file", name: "sub-01_task-rest_eeg.edf", size: 12345 }],
    });
    expect(html).toContain('<a href="../">../</a>');
    expect(html).toContain("Index of /nm099999/v1.0.0/sub-01/eeg/");
  });

  test("HTML-escapes filenames in the label AND URL-encodes them in the href", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [{ kind: "file", name: "weird<name>&'\"file.txt", size: 1 }],
    });
    expect(html).toContain("weird&lt;name&gt;&amp;&#39;&quot;file.txt");
    expect(html).not.toContain("<weird<name>");
    // The href must not contain raw chars that would break out of the
    // href="..." attribute context or close the HTML tag. (` ' ` is left
    // alone by encodeURIComponent and is safe inside a double-quoted attr.)
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.some((h) => /[<>"]/.test(h))).toBe(false);
  });

  test("special chars in filename produce URL-encoded hrefs", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [{ kind: "file", name: "a&b?c#d.txt", size: 1 }],
    });
    expect(html).toContain('href="a%26b%3Fc%23d.txt"');
  });
});
