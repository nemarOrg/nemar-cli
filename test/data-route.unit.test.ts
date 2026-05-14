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
    const names = r.children.map((c) => `${c.name}${c.isDir ? "/" : ""}`);
    expect(names).toEqual(["sub-01/", "sub-02/", "dataset_description.json", "participants.tsv"]);
  });

  test("nested directory listing dedupes immediate children", () => {
    const r = resolveFile(fixture(), "sub-01");
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => c.name)).toEqual(["eeg"]);
    expect(r.children[0].isDir).toBe(true);
  });

  test("nested directory leaf shows files with sizes", () => {
    const r = resolveFile(fixture(), "sub-01/eeg");
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => c.name).sort()).toEqual([
      "sub-01_task-rest_eeg.edf",
      "sub-01_task-rest_events.tsv",
    ]);
    expect(r.children.every((c) => !c.isDir)).toBe(true);
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

  test("annex keys produce a presigned S3 GET URL against objects/<key>", async () => {
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
});

describe("renderIndexHtml", () => {
  test("renders the root listing without a parent link", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [
        { name: "sub-01", isDir: true },
        { name: "dataset_description.json", isDir: false, size: 480 },
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
      entries: [{ name: "sub-01_task-rest_eeg.edf", isDir: false, size: 12345 }],
    });
    expect(html).toContain('<a href="../">../</a>');
    expect(html).toContain("Index of /nm099999/v1.0.0/sub-01/eeg/");
  });

  test("HTML-escapes filenames in the listing", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [{ name: "weird<name>&'\"file.txt", isDir: false, size: 1 }],
    });
    expect(html).toContain("weird&lt;name&gt;&amp;&#39;&quot;file.txt");
    expect(html).not.toContain("<weird<name>");
  });
});
