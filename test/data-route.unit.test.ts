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
  buildBidsIndex,
  buildCatalogIndexPayload,
  buildContentDisposition,
  buildDatasetMetadata,
  normalizeBidsPath,
  qaListingToDirectory,
  buildLandingPayload,
  buildPersonList,
  buildRedirectUrl,
  type CatalogIndexRow,
  type DatasetRowForMetadata,
  type DatasetVersionRow,
  deriveSessions,
  diffRemovedSince,
  escapeHtml,
  findLastSeenVersion,
  formatBytes,
  humanSize,
  isPublicCatalogId,
  pickResponseFormat,
  renderCatalogIndexHtml,
  renderDatasetLandingHtml,
  renderIndexHtml,
  renderTombstone404Html,
  resolveFile,
  resolveVersion,
  toHttpDate,
  toVersionTag,
} from "../backend/src/services/data-router";
import type { ManifestFile, VersionManifest } from "../backend/src/services/manifest";
import type { NemarMetadataV1, NemarMetadataV2 } from "../shared/datacite-constants";

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

  test("annex-keyed presigned URLs carry response-content-disposition with BIDS basename (#513)", async () => {
    const url = await buildRedirectUrl({
      datasetId: "nm000104",
      version: "v2.0.0",
      bidsPath: "sub-01438774/ses-1625258895/emg/sub-01438774_ses-1625258895_task-typing_emg.bdf",
      file: {
        key: "SHA256E-s197576448--c70cae6e4a043e2124d7e5ee94422d02.bdf",
        size: 197576448,
        checksum: "sha256:c70cae6e4a043e2124d7e5ee94422d02",
      },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    expect(url).toContain("response-content-disposition=");
    // Decode the URL the way an HTTP client would. aws4fetch round-trips through
    // URLSearchParams which may form-encode spaces as `+`; tolerate that here so
    // the test stays robust regardless of the encoder choice.
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain(
      'attachment;filename="sub-01438774_ses-1625258895_task-typing_emg.bdf"',
    );
    expect(decoded).toContain(
      "filename*=UTF-8''sub-01438774_ses-1625258895_task-typing_emg.bdf",
    );
    // Signature MUST cover the disposition param or S3 will reject the request.
    expect(url).toContain("X-Amz-Signature=");
  });

  test("response-content-disposition uses BIDS basename, not the SHA-named key (#513)", async () => {
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
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain('filename="sub-01_task-rest_eeg.edf"');
    expect(decoded).not.toContain('filename="SHA256E-');
  });

  test("annex file with trailing-slash bidsPath still gets the right basename (defensive)", async () => {
    // The manifest resolver normalizes trailing slashes today, but the
    // basename derivation defends against a future caller that doesn't.
    // Without the filter(Boolean), `"sub-01/eeg/".split("/").pop()` returns
    // "" and the fallback would put the whole path in the filename.
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "sub-01/eeg/sub-01_task-rest_eeg.edf/",
      file: { key: "SHA256E-s10--abc.edf", size: 10, checksum: "sha256:abc" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain('filename="sub-01_task-rest_eeg.edf"');
    expect(decoded).not.toContain('filename="sub-01/eeg/');
  });

  test("top-level annex file (no slash in bidsPath) still gets the right basename", async () => {
    // Defends the `bidsPath.split("/").pop()` path against a future refactor
    // that uses the wrong segment index. Today most root files are git: keyed,
    // but #509 fixed cases where small root files like dataset_description.json
    // can be annex pointers; the disposition path must work for them too.
    const url = await buildRedirectUrl({
      datasetId: "nm099999",
      version: "v1.0.0",
      bidsPath: "CHANGES",
      file: { key: "SHA256E-s512--root.txt", size: 512, checksum: "sha256:root" },
      s3Options,
      githubOrg: "nemarDatasets",
    });
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain('filename="CHANGES"');
  });

  test("response-content-disposition is signed (appears before X-Amz-Signature in query order)", async () => {
    // aws4fetch sorts canonical query params alphabetically; `r` < `X`, so
    // response-content-disposition always sorts before X-Amz-Signature in
    // the signed URL. Pinning this defends against a future presigner refactor
    // that appends the param after signing (which would unsign it).
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
    const dispoIdx = url.indexOf("response-content-disposition=");
    const sigIdx = url.indexOf("X-Amz-Signature=");
    expect(dispoIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeGreaterThan(-1);
    expect(dispoIdx).toBeLessThan(sigIdx);
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

describe("buildContentDisposition", () => {
  test("plain ASCII filename produces both plain and extended forms with no inter-token whitespace", () => {
    const out = buildContentDisposition("sub-01_task-rest_eeg.edf");
    expect(out).toBe(
      "attachment;filename=\"sub-01_task-rest_eeg.edf\";filename*=UTF-8''sub-01_task-rest_eeg.edf",
    );
  });

  test("non-ASCII filename: plain form replaces with _, extended form percent-encodes", () => {
    const out = buildContentDisposition("müller-α.tsv");
    expect(out).toContain('filename="m_ller-_.tsv"');
    expect(out).toContain("filename*=UTF-8''m%C3%BCller-%CE%B1.tsv");
  });

  test("filename with quotes and backslashes is sanitised in the plain form", () => {
    const out = buildContentDisposition('weird"file\\name.txt');
    expect(out).toContain('filename="weird_file_name.txt"');
    expect(out).toContain("filename*=UTF-8''weird%22file%5Cname.txt");
  });

  test("RFC 5987 attr-char fix-ups: ' ( ) * are percent-encoded in the extended form", () => {
    const out = buildContentDisposition("a*b'c(d)e!.txt");
    // encodeURIComponent leaves these unescaped; the helper must fix that up.
    // `!` is in RFC 5987 attr-char (allowed unencoded); the others are not.
    expect(out).toContain("filename*=UTF-8''a%2Ab%27c%28d%29e!.txt");
  });

  test("spaces in filename are replaced with _ in plain form, percent-encoded in extended form", () => {
    const out = buildContentDisposition("my file.txt");
    // No literal space in the plain form: avoids ambiguity when this value is
    // later embedded in a URL query parameter that may form-encode space->`+`.
    expect(out).toContain('filename="my_file.txt"');
    expect(out).toContain("filename*=UTF-8''my%20file.txt");
  });

  test("disposition has no whitespace tokens at all (defends against query-param encoding drift)", () => {
    const out = buildContentDisposition("sub-01_task-rest_eeg.edf");
    expect(out).not.toContain(" ");
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

// ===========================================================================
// metadata.json builders (epic #449 phase 2)
// ===========================================================================

function manifestFile(key: string, size = 100): ManifestFile {
  return { key, size, checksum: key };
}

function emptyRow(): DatasetRowForMetadata {
  return {
    dataset_id: "nm099999",
    name: "Test Dataset",
    description: null,
    github_repo: null,
    concept_doi: null,
    modalities: null,
    subject_count: null,
    age_min: null,
    age_max: null,
    file_size: null,
    total_files: null,
    tasks: null,
  };
}

describe("formatBytes", () => {
  test("null in, null out", () => {
    expect(formatBytes(null)).toBeNull();
  });
  test("renders human-readable units across three precision tiers", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    // < 10 -> 2 decimals
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.00 MB");
    expect(formatBytes(1024 ** 3 * 1.5)).toBe("1.50 GB");
    // [10, 100) -> 1 decimal
    expect(formatBytes(1024 ** 3 * 12.345)).toBe("12.3 GB");
    expect(formatBytes(1024 ** 2 * 99.5)).toBe("99.5 MB");
    // >= 100 -> 0 decimals
    expect(formatBytes(1024 ** 2 * 450)).toBe("450 MB");
    expect(formatBytes(1024 ** 3 * 150)).toBe("150 GB");
  });
  test("guards bad inputs", () => {
    expect(formatBytes(-1)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("buildPersonList", () => {
  test("null enrichment -> empty list", () => {
    expect(buildPersonList(null)).toEqual([]);
  });

  test("v2: map keyed by name -> Person array with affiliations", () => {
    const meta: NemarMetadataV2 = {
      version: "2.0",
      authors: {
        "Doe, Jane": {
          orcid: "https://orcid.org/0000-0001-2345-6789",
          affiliations: [
            { name: "Acme University", identifier: "https://ror.org/abc", scheme: "ROR" },
          ],
        },
        "Smith, John": {},
      },
    };
    const people = buildPersonList(meta);
    expect(people).toHaveLength(2);
    const jane = people.find((p) => p.name === "Doe, Jane");
    expect(jane?.orcid).toBe("https://orcid.org/0000-0001-2345-6789");
    expect(jane?.affiliations).toEqual([
      { name: "Acme University", identifier: "https://ror.org/abc", scheme: "ROR" },
    ]);
    const john = people.find((p) => p.name === "Smith, John");
    expect(john?.orcid).toBeUndefined();
    expect(john?.affiliations).toBeUndefined();
    expect(john?.name_type).toBe("Personal");
  });

  test("v1: singular affiliation string lifts to affiliations[]", () => {
    const meta: NemarMetadataV1 = {
      version: "1.0",
      authors: {
        "Doe, Jane": { orcid: "0000-0001-2345-6789", affiliation: "Acme University" },
      },
    };
    const people = buildPersonList(meta);
    expect(people).toEqual([
      {
        name: "Doe, Jane",
        name_type: "Personal",
        orcid: "0000-0001-2345-6789",
        affiliations: [{ name: "Acme University" }],
      },
    ]);
  });
});

describe("buildBidsIndex", () => {
  test("empty manifest -> empty subjects map", () => {
    expect(buildBidsIndex({})).toEqual({});
  });

  test("single subject without session", () => {
    const files = {
      "sub-01/eeg/sub-01_task-rest_eeg.edf": manifestFile("SHA256E-s1--a.edf"),
    };
    expect(buildBidsIndex(files)).toEqual({
      "sub-01": {
        sessions: [],
        modalities: { eeg: { tasks: { rest: { runs: [] } } } },
      },
    });
  });

  test("multi-session, multi-modality, multi-run, sorted output", () => {
    const files = {
      "sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-rest_run-02_eeg.edf": manifestFile(
        "SHA256E-s1--a.edf",
      ),
      "sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-rest_run-01_eeg.edf": manifestFile(
        "SHA256E-s2--b.edf",
      ),
      "sub-01/ses-followup/emg/sub-01_ses-followup_task-grip_emg.edf": manifestFile(
        "SHA256E-s3--c.edf",
      ),
      "sub-02/ses-baseline/eeg/sub-02_ses-baseline_task-rest_eeg.edf": manifestFile(
        "SHA256E-s4--d.edf",
      ),
    };
    const idx = buildBidsIndex(files);
    expect(Object.keys(idx)).toEqual(["sub-01", "sub-02"]);
    expect(idx["sub-01"].sessions).toEqual(["baseline", "followup"]);
    expect(Object.keys(idx["sub-01"].modalities)).toEqual(["eeg", "emg"]);
    expect(idx["sub-01"].modalities.eeg.tasks.rest.runs).toEqual(["01", "02"]);
    expect(idx["sub-01"].modalities.emg.tasks.grip.runs).toEqual([]);
  });

  test("non-BIDS paths skipped silently", () => {
    const files = {
      "README.md": manifestFile("git:abc"),
      "dataset_description.json": manifestFile("git:def"),
      "derivatives/preproc/sub-01/eeg/sub-01_task-rest_eeg.set": manifestFile("git:ghi"),
      "code/run.sh": manifestFile("git:jkl"),
      "sub-01/eeg/sub-01_task-rest_eeg.edf": manifestFile("SHA256E-s1--a.edf"),
    };
    const idx = buildBidsIndex(files);
    expect(Object.keys(idx)).toEqual(["sub-01"]);
    expect(idx["sub-01"].modalities.eeg.tasks.rest).toBeDefined();
  });

  test("sidecar JSON contributes to the index", () => {
    const files = {
      "sub-01/eeg/sub-01_task-rest_eeg.edf": manifestFile("SHA256E-s1--a.edf"),
      "sub-01/eeg/sub-01_task-rest_eeg.json": manifestFile("git:abc"),
      "sub-01/eeg/sub-01_task-rest_channels.tsv": manifestFile("git:def"),
    };
    const idx = buildBidsIndex(files);
    expect(idx["sub-01"].modalities.eeg.tasks.rest.runs).toEqual([]);
  });

  test("task-less files still register the subject and modality (anat, dwi)", () => {
    // Valid BIDS for anatomy, diffusion, fieldmaps -- no `_task-` token but
    // the subject must still appear in the index. The modality entry exists
    // with an empty tasks map; the task-less file itself doesn't add a task.
    const files = {
      "sub-01/anat/sub-01_T1w.nii.gz": manifestFile("SHA256E-s1--a.nii.gz"),
      "sub-01/dwi/sub-01_dwi.nii.gz": manifestFile("SHA256E-s2--b.nii.gz"),
    };
    const idx = buildBidsIndex(files);
    expect(Object.keys(idx)).toEqual(["sub-01"]);
    expect(idx["sub-01"].sessions).toEqual([]);
    expect(idx["sub-01"].modalities.anat).toEqual({ tasks: {} });
    expect(idx["sub-01"].modalities.dwi).toEqual({ tasks: {} });
  });

  test("subject-level sidecar (sub-01/sub-01_scans.tsv) registers the subject", () => {
    const files = {
      "sub-01/sub-01_scans.tsv": manifestFile("git:abc"),
      "sub-01/eeg/sub-01_task-rest_eeg.edf": manifestFile("SHA256E-s1--a.edf"),
    };
    const idx = buildBidsIndex(files);
    expect(idx["sub-01"].modalities.eeg.tasks.rest).toBeDefined();
  });

  test("mixed session and flat layouts under one subject", () => {
    // Longitudinal datasets sometimes keep a cross-session anatomy scan at
    // the subject root while task data lives under session dirs.
    const files = {
      "sub-01/anat/sub-01_T1w.nii.gz": manifestFile("SHA256E-s1--a.nii.gz"),
      "sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-rest_eeg.edf": manifestFile(
        "SHA256E-s2--b.edf",
      ),
    };
    const idx = buildBidsIndex(files);
    expect(idx["sub-01"].sessions).toEqual(["baseline"]);
    expect(Object.keys(idx["sub-01"].modalities).sort()).toEqual(["anat", "eeg"]);
    expect(idx["sub-01"].modalities.eeg.tasks.rest).toBeDefined();
  });
});

describe("deriveSessions", () => {
  test("collects unique sorted session labels (without ses- prefix)", () => {
    const files = {
      "sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-rest_eeg.edf": manifestFile("k"),
      "sub-02/ses-baseline/eeg/sub-02_ses-baseline_task-rest_eeg.edf": manifestFile("k"),
      "sub-01/ses-followup/eeg/sub-01_ses-followup_task-rest_eeg.edf": manifestFile("k"),
    };
    expect(deriveSessions(files)).toEqual(["baseline", "followup"]);
  });
  test("no sessions when no ses- segment", () => {
    expect(
      deriveSessions({ "sub-01/eeg/sub-01_task-rest_eeg.edf": manifestFile("k") }),
    ).toEqual([]);
  });
});

describe("buildDatasetMetadata", () => {
  test("no enrichment, no versions -> identity + empty arrays", () => {
    const out = buildDatasetMetadata({
      row: emptyRow(),
      parsedEnrichment: null,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.schema_version).toBe("0.3.0");
    expect(out.doc_type).toBe("dataset");
    expect(out.dataset_id).toBe("nm099999");
    expect(out.source).toBe("nemar");
    expect(out.authors).toEqual([]);
    expect(out.keywords).toEqual([]);
    expect(out.recording_modality).toEqual([]);
    expect(out.tasks).toEqual([]);
    expect(out.datatypes).toEqual([]);
    expect(out.sessions).toEqual([]);
    expect(out.sessions_count).toBeNull();
    expect(out.demographics).toBeNull();
    expect(out.data_summary).toBeNull();
    expect(out.extensions.nemar.versions).toEqual([]);
    expect(out.extensions.nemar.bids_index).toBeNull();
    expect(out.extensions.nemar.pipeline_stage).toBeNull();
    expect(out.provenance).toEqual({ latest_snapshot: null, publish_date: null });
  });

  test("full v2 enrichment + versions + manifest -> populated payload", () => {
    const row: DatasetRowForMetadata = {
      ...emptyRow(),
      name: "HD-sEMG",
      description: "Hand gesture EMG",
      github_repo: "nm099999",
      concept_doi: "10.82901/NEMAR.nm099999",
      modalities: "emg",
      subject_count: 20,
      age_min: 18,
      age_max: 65,
      file_size: 1024 * 1024 * 1024 * 2,
      total_files: 640,
      tasks: "flexion,extension",
    };
    const enrichment: NemarMetadataV2 = {
      version: "2.0",
      pipeline_stage: "validated",
      description: "Hand gesture EMG (full)",
      license: "ODC-By-1.0",
      authors: {
        "Liu, Xiangyu": {
          orcid: "https://orcid.org/0009-0001-0000-0000",
          affiliations: [{ name: "Fudan", identifier: "https://ror.org/x", scheme: "ROR" }],
        },
      },
      keywords: [
        { term: "EMG" },
        { term: "Electromyography", subject_scheme: "MeSH", classification_code: "D004576" },
      ],
      related_identifiers: [
        { identifier: "10.1038/s41597-021-00883-1", identifier_type: "DOI", relation_type: "IsDescribedBy" },
      ],
      funding_references: [
        { funder_name: "National Science Foundation", award_number: "2030859" },
      ],
      contributors: [{ name: "NEMAR", name_type: "Organizational", contributor_type: "HostingInstitution" }],
      dates: [{ date: "2026-02-17", date_type: "Issued" }],
    };
    const manifest: VersionManifest = {
      dataset_id: "nm099999",
      version: "1.0.0",
      doi: "10.82901/NEMAR.nm099999.v1.0.0",
      concept_doi: "10.82901/NEMAR.nm099999",
      created: "2026-05-15T00:00:00Z",
      files: {
        "dataset_description.json": manifestFile("git:abc", 480),
        "sub-01/emg/sub-01_task-flexion_run-01_emg.edf": manifestFile("SHA256E-s1--a.edf"),
        "sub-01/emg/sub-01_task-extension_emg.edf": manifestFile("SHA256E-s2--b.edf"),
      },
    };
    const out = buildDatasetMetadata({
      row,
      parsedEnrichment: enrichment,
      versions: [
        { version: "1.0.0", doi: "10.82901/NEMAR.nm099999.v1.0.0", created_at: "2026-05-15T00:00:00Z" },
      ],
      latestManifest: manifest,
      githubOrg: "nemarDatasets",
    });
    expect(out.name).toBe("HD-sEMG");
    // LLM-enriched description (v2.description) takes precedence over the
    // catalog row's stored description. The catalog field is a fallback for
    // datasets that have not been enriched yet, or a placeholder (e.g.,
    // "Imported from OpenNeuro ds...") that must not survive a successful
    // enrichment cycle. See #535.
    expect(out.description).toBe("Hand gesture EMG (full)");
    expect(out.license).toBe("ODC-By-1.0");
    expect(out.recording_modality).toEqual(["EMG"]);
    expect(out.datatypes).toEqual(["emg"]);
    expect(out.tasks).toEqual(["flexion", "extension"]);
    expect(out.authors[0].name).toBe("Liu, Xiangyu");
    expect(out.keywords).toHaveLength(2);
    expect(out.related_identifiers).toHaveLength(1);
    expect(out.contributors).toHaveLength(1);
    expect(out.dates).toHaveLength(1);
    expect(out.funding[0].funder_name).toBe("National Science Foundation");
    expect(out.rights).toEqual([
      {
        rights: "ODC-By-1.0",
        rights_uri: null,
        rights_identifier: "ODC-By-1.0",
        rights_identifier_scheme: "SPDX",
      },
    ]);
    expect(out.demographics).toEqual({ subjects_count: 20, age_min: 18, age_max: 65 });
    expect(out.data_summary?.total_files).toBe(640);
    expect(out.data_summary?.size_human).toBe("2.00 GB");
    expect(out.external_links).toEqual({
      dataset_doi: "10.82901/NEMAR.nm099999",
      github_url: "https://github.com/nemarDatasets/nm099999",
    });
    // Every version field on the wire uses the v-prefixed tag form,
    // regardless of whether the D1 row stored bare or tagged. Pinned
    // here to prevent the cross-phase drift the epic review caught
    // between buildLandingPayload (always tagged) and buildDatasetMetadata
    // (previously emitted bare versions in some fields).
    expect(out.provenance).toEqual({
      latest_snapshot: "v1.0.0",
      publish_date: "2026-05-15T00:00:00Z",
    });
    expect(out.extensions.nemar.versions[0]).toEqual({
      version: "v1.0.0",
      doi: "10.82901/NEMAR.nm099999.v1.0.0",
      created_at: "2026-05-15T00:00:00Z",
      manifest_url: "/nm099999/v1.0.0/manifest.json",
    });
    expect(out.extensions.nemar.bids_index?.version).toBe("v1.0.0");
    expect(out.extensions.nemar.bids_index?.subjects["sub-01"]).toBeDefined();
    expect(out.extensions.nemar.pipeline_stage).toBe("validated");
  });

  test("versions present but manifest fetch failed -> bids_index null, versions still listed", () => {
    const out = buildDatasetMetadata({
      row: { ...emptyRow(), modalities: "eeg", tasks: "rest" },
      parsedEnrichment: null,
      versions: [{ version: "1.0.0", doi: "doi:x", created_at: "2026-05-15T00:00:00Z" }],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.extensions.nemar.versions).toHaveLength(1);
    expect(out.extensions.nemar.bids_index).toBeNull();
    expect(out.sessions).toEqual([]);
    expect(out.sessions_count).toBeNull();
    expect(out.provenance.latest_snapshot).toBe("v1.0.0");
  });

  test("v1 enrichment has no license -> license null, rights empty", () => {
    const v1: NemarMetadataV1 = {
      version: "1.0",
      description: "v1 era",
      authors: { "Doe, Jane": { orcid: "abc" } },
    };
    const out = buildDatasetMetadata({
      row: emptyRow(),
      parsedEnrichment: v1,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.license).toBeNull();
    expect(out.rights).toEqual([]);
    // Description still falls back to the v1 enrichment when D1 is null.
    expect(out.description).toBe("v1 era");
    expect(out.authors[0].name).toBe("Doe, Jane");
  });

  test("description fallback: D1 null + v2 enrichment populates -> uses enrichment", () => {
    const v2: NemarMetadataV2 = {
      version: "2.0",
      description: "from enrichment",
    };
    const out = buildDatasetMetadata({
      row: { ...emptyRow(), description: null },
      parsedEnrichment: v2,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.description).toBe("from enrichment");
  });

  test("description priority: D1 'Imported from OpenNeuro' placeholder loses to v2 enrichment (#535)", () => {
    // Pre-fix, the import-openneuro CLI seeded `datasets.description` with a
    // placeholder string. `buildDatasetMetadata` used to short-circuit on
    // any non-null row.description, so the placeholder survived even after
    // a successful enrichment cycle wrote a real description to
    // `enrichment_json`. Pin the new priority so a regression to the old
    // ordering breaks this test.
    const v2: NemarMetadataV2 = {
      version: "2.0",
      pipeline_stage: "validated",
      description:
        "A multimodal neuroimaging dataset comprising structural MRI, functional MRI, and EEG recordings during face-perception tasks.",
    };
    const out = buildDatasetMetadata({
      row: { ...emptyRow(), description: "Imported from OpenNeuro ds000117" },
      parsedEnrichment: v2,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.description).toBe(v2.description);
    expect(out.description).not.toContain("Imported from OpenNeuro");
  });

  test("description fallback: no enrichment at all -> falls through to D1 row.description", () => {
    // The fallback path matters for newly-imported datasets whose
    // enrichment cycle has not yet run. They have row.description set
    // (whatever the importer wrote) but no parsedEnrichment yet. Make
    // sure those rows still surface SOMETHING rather than null.
    const out = buildDatasetMetadata({
      row: { ...emptyRow(), description: "User-provided dataset description" },
      parsedEnrichment: null,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.description).toBe("User-provided dataset description");
  });

  test("absolute github_repo URL passes through; bare repo name expands", () => {
    const out = buildDatasetMetadata({
      row: { ...emptyRow(), github_repo: "https://github.com/other-org/nm099999" },
      parsedEnrichment: null,
      versions: [],
      latestManifest: null,
      githubOrg: "nemarDatasets",
    });
    expect(out.external_links.github_url).toBe("https://github.com/other-org/nm099999");
  });
});

// ===========================================================================
// Phase 3 (#497): version picker, sitemap landing, tombstone 404s
// ===========================================================================

function multiVersionFixtures(): { v1: VersionManifest; v2: VersionManifest } {
  const shared = {
    "dataset_description.json": {
      key: "git:shared",
      size: 480,
      checksum: "git:shared",
    },
    "sub-01/eeg/sub-01_task-rest_eeg.edf": {
      key: "SHA256E-s100--a.edf",
      size: 100,
      checksum: "sha256:a",
    },
  };
  return {
    v1: {
      dataset_id: "nm099999",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-01-01T00:00:00Z",
      files: {
        ...shared,
        "sub-99/eeg/sub-99_task-rest_eeg.edf": {
          key: "SHA256E-s200--b.edf",
          size: 200,
          checksum: "sha256:b",
        },
        "sub-99/eeg/sub-99_task-rest_eeg.json": {
          key: "git:dropped",
          size: 50,
          checksum: "git:dropped",
        },
      },
    },
    v2: {
      dataset_id: "nm099999",
      version: "2.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-02-01T00:00:00Z",
      files: {
        ...shared,
        "sub-02/eeg/sub-02_task-rest_eeg.edf": {
          key: "SHA256E-s150--c.edf",
          size: 150,
          checksum: "sha256:c",
        },
      },
    },
  };
}

describe("toVersionTag", () => {
  test("passes through tag-form versions unchanged", () => {
    expect(toVersionTag("v1.0.0")).toBe("v1.0.0");
    expect(toVersionTag("v12.345.6789")).toBe("v12.345.6789");
  });

  test("prepends v to bare numeric versions", () => {
    // D1 has both tag-form ("v1.0.0", newer publishes) and bare-form
    // ("1.0.0", legacy rows from earlier in epic #449) version strings.
    // The route always wants tag-form -- this regression test pins the
    // coercion contract so a fileOrIndexHandler that misses the coercion
    // breaks indexOf on the version picker, the tombstone walk's
    // `slice(currentIdx + 1)`, and the "removed since" diff in one shot.
    expect(toVersionTag("1.0.0")).toBe("v1.0.0");
    expect(toVersionTag("2.3.4")).toBe("v2.3.4");
  });

  test("does not double-prefix when input already starts with v", () => {
    // Pin the asymmetric semantics: presence of a leading `v` is the
    // only signal that suppresses prepending. The function is not a
    // semver parser.
    expect(toVersionTag("v1.0.0")).toBe("v1.0.0");
    expect(toVersionTag(toVersionTag("1.0.0"))).toBe("v1.0.0");
  });
});

describe("findLastSeenVersion", () => {
  test("returns the first older version that contains the path", async () => {
    const { v1 } = multiVersionFixtures();
    const loadManifest = async (v: string) => (v === "v1.0.0" ? v1 : null);
    const hit = await findLastSeenVersion({
      path: "sub-99/eeg/sub-99_task-rest_eeg.edf",
      olderVersions: ["v1.0.0"],
      loadManifest,
    });
    expect(hit).toEqual({ version: "v1.0.0" });
  });

  test("returns null when the path never existed in any older version", async () => {
    const { v1 } = multiVersionFixtures();
    const loadManifest = async (v: string) => (v === "v1.0.0" ? v1 : null);
    const miss = await findLastSeenVersion({
      path: "sub-zz/eeg/never.edf",
      olderVersions: ["v1.0.0"],
      loadManifest,
    });
    expect(miss).toBeNull();
  });

  test("walks newest-first, stops at the first hit (doesn't probe further)", async () => {
    const { v1, v2 } = multiVersionFixtures();
    const consulted: string[] = [];
    const loadManifest = async (v: string) => {
      consulted.push(v);
      if (v === "v2.0.0") return v2;
      if (v === "v1.0.0") return v1;
      return null;
    };
    // Path exists in v2.0.0 (dataset_description.json is in shared) -> only v2 is consulted.
    const hit = await findLastSeenVersion({
      path: "dataset_description.json",
      olderVersions: ["v2.0.0", "v1.0.0"],
      loadManifest,
    });
    expect(hit).toEqual({ version: "v2.0.0" });
    expect(consulted).toEqual(["v2.0.0"]);
  });

  test("respects the lookback cap and does not consult beyond it", async () => {
    // 12-version chain; the path lives only in the oldest. With a cap of
    // 10 the search should miss without ever loading the oldest manifest.
    const consulted: string[] = [];
    const versions = Array.from({ length: 12 }, (_, i) => `v${12 - i}.0.0`);
    const oldest = versions[versions.length - 1];
    const loadManifest = async (v: string): Promise<VersionManifest | null> => {
      consulted.push(v);
      if (v !== oldest) return { dataset_id: "x", version: v, doi: null, concept_doi: null, created: "", files: {} };
      return {
        dataset_id: "x",
        version: v,
        doi: null,
        concept_doi: null,
        created: "",
        files: { "deep/ghost.txt": { key: "git:x", size: 1, checksum: "git:x" } },
      };
    };
    const miss = await findLastSeenVersion({
      path: "deep/ghost.txt",
      olderVersions: versions,
      loadManifest,
      lookback: 10,
    });
    expect(miss).toBeNull();
    expect(consulted).toHaveLength(10);
    expect(consulted).not.toContain(oldest);
  });

  test("treats manifest fetch failures (null) as 'not present in that version' and continues", async () => {
    const { v1 } = multiVersionFixtures();
    const loadManifest = async (v: string) => {
      if (v === "v2.0.0") return null;
      if (v === "v1.0.0") return v1;
      return null;
    };
    const hit = await findLastSeenVersion({
      path: "sub-99/eeg/sub-99_task-rest_eeg.edf",
      olderVersions: ["v2.0.0", "v1.0.0"],
      loadManifest,
    });
    expect(hit).toEqual({ version: "v1.0.0" });
  });
});

describe("diffRemovedSince", () => {
  test("reports names present in prior but absent in current at the same path", () => {
    const { v1 } = multiVersionFixtures();
    // Current v2 root: only sub-01, sub-02, dataset_description.json (no sub-99/).
    const currentChildren = [
      { kind: "dir" as const, name: "sub-01" },
      { kind: "dir" as const, name: "sub-02" },
      { kind: "file" as const, name: "dataset_description.json", size: 480 },
    ];
    const removed = diffRemovedSince(currentChildren, v1, "");
    expect(removed).toEqual(["sub-99"]);
  });

  test("returns empty when nothing changed (same listing)", () => {
    const { v1 } = multiVersionFixtures();
    const r1 = resolveFile(v1, "");
    if (r1.kind !== "directory") throw new Error("fixture invariant");
    const removed = diffRemovedSince(r1.children, v1, "");
    expect(removed).toEqual([]);
  });

  test("returns empty when prior version doesn't have this path either", () => {
    const { v2 } = multiVersionFixtures();
    // Prior is v2 which has no sub-99/; checking that path returns empty.
    const removed = diffRemovedSince([], v2, "sub-99/eeg");
    expect(removed).toEqual([]);
  });

  test("sorts results alphabetically", () => {
    const prior: VersionManifest = {
      dataset_id: "nm099999",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "",
      files: {
        "x/zeta.txt": { key: "git:z", size: 1, checksum: "git:z" },
        "x/alpha.txt": { key: "git:a", size: 1, checksum: "git:a" },
        "x/mid.txt": { key: "git:m", size: 1, checksum: "git:m" },
      },
    };
    const removed = diffRemovedSince([], prior, "x");
    expect(removed).toEqual(["alpha.txt", "mid.txt", "zeta.txt"]);
  });
});

describe("pickResponseFormat", () => {
  test("?format=json wins over Accept", () => {
    expect(pickResponseFormat({ accept: "text/html", formatParam: "json" })).toBe("json");
  });

  test("?format=html wins over Accept", () => {
    expect(pickResponseFormat({ accept: "application/json", formatParam: "html" })).toBe("html");
  });

  test("text/html in Accept (anywhere) -> html", () => {
    expect(pickResponseFormat({ accept: "text/html", formatParam: null })).toBe("html");
    expect(
      pickResponseFormat({
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        formatParam: null,
      }),
    ).toBe("html");
  });

  test("no Accept, no format param -> json (machine-default)", () => {
    expect(pickResponseFormat({ accept: null, formatParam: null })).toBe("json");
  });

  test("application/json Accept -> json", () => {
    expect(pickResponseFormat({ accept: "application/json", formatParam: null })).toBe("json");
  });

  test("'*/*' alone -> json (curl default)", () => {
    expect(pickResponseFormat({ accept: "*/*", formatParam: null })).toBe("json");
  });

  test("unrecognized format param falls through to Accept", () => {
    expect(pickResponseFormat({ accept: "text/html", formatParam: "xml" })).toBe("html");
    expect(pickResponseFormat({ accept: null, formatParam: "xml" })).toBe("json");
  });
});

describe("renderIndexHtml (Phase 3 extensions)", () => {
  test("no availableVersions arg -> no version picker rendered (back-compat)", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [{ kind: "dir", name: "sub-01" }],
    });
    expect(html).not.toContain('class="versions"');
    expect(html).not.toContain('class="removed"');
  });

  test("single-version availableVersions does not render a picker", () => {
    // Picker only adds value when there's somewhere to switch to.
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [],
      availableVersions: [{ version: "v1.0.0", isCurrent: true }],
    });
    expect(html).not.toContain('class="versions"');
  });

  test("multiple versions render the picker with the current version marked", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "",
      entries: [],
      availableVersions: [
        { version: "v2.0.0", isCurrent: true },
        { version: "v1.0.0", isCurrent: false },
      ],
    });
    expect(html).toContain('class="current">v2.0.0</span>');
    expect(html).toContain('<a href="/nm099999/v1.0.0/">v1.0.0</a>');
  });

  test("picker preserves the current sub-path when switching versions", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "sub-01/eeg",
      entries: [],
      availableVersions: [
        { version: "v2.0.0", isCurrent: true },
        { version: "v1.0.0", isCurrent: false },
      ],
    });
    expect(html).toContain('<a href="/nm099999/v1.0.0/sub-01/eeg/">v1.0.0</a>');
  });

  test("removedSinceNote renders a details/summary footer with links to the prior version", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "",
      entries: [{ kind: "dir", name: "sub-01" }],
      removedSinceNote: { lastSeenVersion: "v1.0.0", names: ["sub-99"] },
    });
    expect(html).toContain('<details class="removed">');
    expect(html).toContain("Files removed since v1.0.0 (1)");
    expect(html).toContain('<a href="/nm099999/v1.0.0/sub-99">sub-99</a>');
  });

  test("empty removedSinceNote.names suppresses the footer", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "",
      entries: [],
      removedSinceNote: { lastSeenVersion: "v1.0.0", names: [] },
    });
    expect(html).not.toContain('class="removed"');
  });

  test("footer 'all versions' link points to /<id>/", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [],
    });
    expect(html).toContain('<a href="/nm099999/">all versions</a>');
  });

  test("HTML-escapes the dataset id in the picker (defense in depth)", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1<bad>.0.0",
      path: "",
      entries: [],
      availableVersions: [
        { version: "v1<bad>.0.0", isCurrent: true },
        { version: "v2.0.0", isCurrent: false },
      ],
    });
    // Label is escaped in the current-version span.
    expect(html).toContain("v1&lt;bad&gt;.0.0");
    // No raw `<bad>` injected into the markup anywhere.
    expect(html).not.toContain("<bad>");
  });
});

describe("buildLandingPayload", () => {
  test("normalizes bare versions to vX.Y.Z and builds canonical hrefs", () => {
    const rows: DatasetVersionRow[] = [
      { version: "2.0.0", doi: "10.0/v2", created_at: "2026-02-01T00:00:00Z" },
      { version: "v1.0.0", doi: "10.0/v1", created_at: "2026-01-01T00:00:00Z" },
    ];
    const payload = buildLandingPayload({ datasetId: "nm099999", versionRows: rows });
    expect(payload.dataset_id).toBe("nm099999");
    expect(payload.latest).toBe("v2.0.0");
    expect(payload.metadata_url).toBe("/nm099999/metadata.json");
    expect(payload.versions).toHaveLength(2);
    expect(payload.versions[0]).toEqual({
      version: "v2.0.0",
      doi: "10.0/v2",
      created_at: "2026-02-01T00:00:00Z",
      manifest_url: "/nm099999/v2.0.0/manifest.json",
      browse_url: "/nm099999/v2.0.0/",
    });
    expect(payload.versions[1].version).toBe("v1.0.0");
  });

  test("empty version list -> latest=null and no rows", () => {
    const payload = buildLandingPayload({ datasetId: "nm099999", versionRows: [] });
    expect(payload.latest).toBeNull();
    expect(payload.versions).toEqual([]);
    expect(payload.metadata_url).toBe("/nm099999/metadata.json");
  });
});

describe("renderDatasetLandingHtml", () => {
  test("renders a row per version with browse, manifest, and DOI links", () => {
    const payload = buildLandingPayload({
      datasetId: "nm099999",
      versionRows: [
        { version: "v2.0.0", doi: "10.0/v2", created_at: "2026-02-01T00:00:00Z" },
        { version: "v1.0.0", doi: "10.0/v1", created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const html = renderDatasetLandingHtml(payload);
    expect(html).toContain("<title>nm099999</title>");
    expect(html).toContain('href="/nm099999/v2.0.0/"');
    expect(html).toContain('href="/nm099999/v2.0.0/manifest.json"');
    expect(html).toContain('href="https://doi.org/10.0/v2"');
    expect(html).toContain("(latest)");
    // Latest shortcut to /<id>/latest/
    expect(html).toContain('href="/nm099999/latest/"');
    // Created date trimmed to YYYY-MM-DD.
    expect(html).toContain("2026-02-01");
  });

  test("empty version list -> 'no published versions' notice, no table", () => {
    const html = renderDatasetLandingHtml(
      buildLandingPayload({ datasetId: "nm099999", versionRows: [] }),
    );
    expect(html).toContain("No published versions yet");
    expect(html).not.toContain("<table>");
    // Latest shortcut is suppressed when there's no latest version.
    expect(html).not.toContain('href="/nm099999/latest/"');
  });

  test("missing DOI renders '-' instead of a broken doi.org link", () => {
    const html = renderDatasetLandingHtml(
      buildLandingPayload({
        datasetId: "nm099999",
        versionRows: [{ version: "v1.0.0", doi: null as unknown as string, created_at: null as unknown as string }],
      }),
    );
    expect(html).not.toContain("doi.org");
  });
});

describe("renderTombstone404Html", () => {
  test("with lastSeen renders the last-seen URL and version", () => {
    const html = renderTombstone404Html({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "sub-99/eeg/sub-99_task-rest_eeg.edf",
      lastSeen: {
        version: "v1.0.0",
        href: "https://data.nemar.org/nm099999/v1.0.0/sub-99/eeg/sub-99_task-rest_eeg.edf",
      },
    });
    expect(html).toContain("last present in <strong>v1.0.0</strong>");
    expect(html).toContain(
      "https://data.nemar.org/nm099999/v1.0.0/sub-99/eeg/sub-99_task-rest_eeg.edf",
    );
    expect(html).toContain('href="/nm099999/">all versions');
  });

  test("without lastSeen renders the generic 'no record' copy", () => {
    const html = renderTombstone404Html({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "sub-zz/never.edf",
      lastSeen: null,
    });
    expect(html).toContain("no record of it in any recent version");
    expect(html).not.toContain("last present in");
  });

  test("escapes hostile dataset/version/path inputs (defense in depth)", () => {
    const html = renderTombstone404Html({
      datasetId: "<bad>",
      version: "<v>",
      path: "<p>",
      lastSeen: null,
    });
    expect(html).not.toContain("<bad>");
    expect(html).toContain("&lt;bad&gt;");
  });

  test("escapes lastSeen.href in both the link text AND the href attribute", () => {
    // Regression for the code-reviewer finding: the href attribute was
    // previously interpolated raw, only the link text was escaped. A
    // hostile last-seen URL (e.g. one constructed from a host that
    // includes `"` somehow, or a deliberate downstream concatenation
    // bug) must never break out of the href attribute.
    const html = renderTombstone404Html({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "x.edf",
      lastSeen: {
        version: "v1.0.0",
        href: `https://data.nemar.org/nm099999/v1.0.0/x.edf"><script>alert(1)</script>`,
      },
    });
    // The href attribute must not contain a raw `"` that closes it.
    const hrefMatches = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefMatches.some((h) => h.includes("<script"))).toBe(false);
    // The link text shows the escaped form.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

// ===========================================================================
// Phase 4 (#498): rclone-compatible listing + HEAD support
// ===========================================================================

describe("toHttpDate", () => {
  test("converts ISO 8601 to RFC 1123 / RFC 7231 HTTP-date", () => {
    expect(toHttpDate("2026-05-15T17:30:21Z")).toBe("Fri, 15 May 2026 17:30:21 GMT");
    expect(toHttpDate("2025-01-01T00:00:00Z")).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  test("passes through invalid input unchanged AND logs a warning", () => {
    // Manifest with a malformed `created` field shouldn't break the
    // file response; emit the bad value and let the client ignore it.
    // But operators need to see this in `wrangler tail` -- silent
    // passthrough would hide manifest corruption.
    const originalWarn = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    try {
      expect(toHttpDate("not-a-date")).toBe("not-a-date");
      expect(toHttpDate("")).toBe("");
      expect(warned).toHaveLength(2);
      expect(String(warned[0][0])).toContain("toHttpDate");
      expect(String(warned[0][0])).toContain("not-a-date");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("already-HTTP-date input passes through (defensive against double-conversion)", () => {
    const httpDate = "Fri, 15 May 2026 17:30:21 GMT";
    expect(toHttpDate(httpDate)).toBe(httpDate);
  });

  test("handles ISO with millisecond precision", () => {
    // toUTCString drops sub-second precision; that's correct per HTTP-date spec.
    expect(toHttpDate("2026-05-15T17:30:21.123Z")).toBe("Fri, 15 May 2026 17:30:21 GMT");
  });
});

describe("renderIndexHtml rclone-parser compat (Phase 4)", () => {
  // rclone's HTTP backend parses <a href="..."> tags to build a directory
  // listing. It treats trailing-slash hrefs as subdirectories and bare
  // names as files. Absolute hrefs (starting with `/`) and parent links
  // (`../`) are filtered out. This test extracts the rclone-relevant
  // hrefs from the rendered HTML and asserts they map exactly to the
  // BIDS file/dir layout -- so the Phase 3 chrome (version picker,
  // removed-since footer, all-versions link) doesn't accidentally
  // surface as a "file" or "directory" entry to rclone.
  function extractRcloneEntries(html: string): { dirs: string[]; files: string[] } {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const dirs: string[] = [];
    const files: string[] = [];
    for (const href of hrefs) {
      // rclone-parser filters:
      if (href.startsWith("/")) continue; // absolute -> ignored
      if (href.startsWith("?") || href.startsWith("#")) continue;
      if (/^https?:\/\//.test(href)) continue; // external -> ignored
      if (href === "../") continue; // parent -> ignored
      if (href.endsWith("/")) dirs.push(href);
      else files.push(href);
    }
    return { dirs, files };
  }

  test("plain directory listing exposes only file/dir entries to rclone", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [
        { kind: "dir", name: "sub-01" },
        { kind: "dir", name: "sub-02" },
        { kind: "file", name: "dataset_description.json", size: 480 },
        { kind: "file", name: "participants.tsv", size: 220 },
      ],
    });
    const { dirs, files } = extractRcloneEntries(html);
    expect(dirs.sort()).toEqual(["sub-01/", "sub-02/"]);
    // manifest.json is a relative href in the footer; rclone WILL see
    // it. Documented and acceptable (the route serves it as a real 200).
    expect(files.sort()).toEqual(["dataset_description.json", "manifest.json", "participants.tsv"]);
  });

  test("version picker absolute-href links are filtered out by rclone parser", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "",
      entries: [{ kind: "file", name: "x.edf", size: 1 }],
      availableVersions: [
        { version: "v2.0.0", isCurrent: true },
        { version: "v1.0.0", isCurrent: false },
      ],
    });
    const { dirs, files } = extractRcloneEntries(html);
    // No `v1.0.0/` directory leak from the picker.
    expect(dirs).toEqual([]);
    // x.edf is the only real file; manifest.json is the footer link.
    expect(files.sort()).toEqual(["manifest.json", "x.edf"]);
  });

  test("removed-since footer hrefs do not appear as files to rclone", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v2.0.0",
      path: "",
      entries: [{ kind: "dir", name: "sub-01" }],
      removedSinceNote: { lastSeenVersion: "v1.0.0", names: ["sub-99", "old.tsv"] },
    });
    const { dirs, files } = extractRcloneEntries(html);
    expect(dirs).toEqual(["sub-01/"]);
    // sub-99 and old.tsv must NOT be in files -- they're rendered with
    // absolute hrefs pointing at the prior version.
    expect(files).not.toContain("sub-99");
    expect(files).not.toContain("old.tsv");
    expect(files).toEqual(["manifest.json"]);
  });

  test("nested directory still exposes only its children + parent link", () => {
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "sub-01/eeg",
      entries: [
        { kind: "file", name: "sub-01_task-rest_eeg.edf", size: 12345 },
        { kind: "file", name: "sub-01_task-rest_eeg.json", size: 220 },
      ],
    });
    const { dirs, files } = extractRcloneEntries(html);
    expect(dirs).toEqual([]);
    expect(files.sort()).toEqual([
      "manifest.json",
      "sub-01_task-rest_eeg.edf",
      "sub-01_task-rest_eeg.json",
    ]);
  });

  test("URL-encoded names round-trip cleanly through the parser regex", () => {
    // The renderer percent-encodes special chars in hrefs. rclone
    // decodes them on its end. The parser regex here is naive but
    // matches rclone's enough that we can confirm the href value
    // isn't broken by escape conflicts.
    const html = renderIndexHtml({
      datasetId: "nm099999",
      version: "v1.0.0",
      path: "",
      entries: [{ kind: "file", name: "a&b?c#d.txt", size: 1 }],
    });
    const { files } = extractRcloneEntries(html);
    // Percent-encoded form is what's in the href attribute.
    expect(files).toContain("a%26b%3Fc%23d.txt");
  });
});

describe("normalizeBidsPath (#511 traversal contract for QA route)", () => {
  test("empty / root paths round-trip to empty string", () => {
    expect(normalizeBidsPath("")).toBe("");
    expect(normalizeBidsPath("/")).toBe("");
    expect(normalizeBidsPath("///")).toBe("");
  });

  test("strips leading and trailing slashes", () => {
    expect(normalizeBidsPath("sub-01/eeg")).toBe("sub-01/eeg");
    expect(normalizeBidsPath("/sub-01/eeg/")).toBe("sub-01/eeg");
    expect(normalizeBidsPath("//sub-01//eeg//")).toBeNull(); // empty interior segments reject
  });

  test("rejects path traversal", () => {
    expect(normalizeBidsPath("..")).toBeNull();
    expect(normalizeBidsPath("../etc/passwd")).toBeNull();
    expect(normalizeBidsPath("sub-01/../sub-02")).toBeNull();
  });

  test("rejects prototype-pollution-shaped segments", () => {
    expect(normalizeBidsPath("__proto__")).toBeNull();
    expect(normalizeBidsPath("constructor/prototype")).toBeNull();
    expect(normalizeBidsPath("a/__proto__/b")).toBeNull();
  });

  test("accepts BIDS-shaped paths with dots and underscores", () => {
    expect(normalizeBidsPath("sub-01_task-rest_eeg.edf")).toBe("sub-01_task-rest_eeg.edf");
    expect(normalizeBidsPath("sub-01/eeg/sub-01_task-rest_icaact.svg")).toBe(
      "sub-01/eeg/sub-01_task-rest_icaact.svg",
    );
  });
});

describe("qaListingToDirectory (#511)", () => {
  test("empty root listing returns an empty directory (not 404)", () => {
    const r = qaListingToDirectory({
      listing: { contents: [], commonPrefixes: [], truncated: false },
      path: "",
      absolutePrefix: "nm099999/qa/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children).toEqual([]);
    expect(r.path).toBe("");
    expect(r.truncated).toBe(false);
  });

  test("empty non-root listing is 404", () => {
    // The async wrapper resolveQaPath only gets here when the parent listing
    // confirmed the directory exists, but we should still reject empty
    // sub-listings — they shouldn't happen on a healthy tree.
    const r = qaListingToDirectory({
      listing: { contents: [], commonPrefixes: [], truncated: false },
      path: "sub-01",
      absolutePrefix: "nm099999/qa/sub-01/",
    });
    expect(r.kind).toBe("not_found");
  });

  test("partitions files and subdirectories with dirs sorted first", () => {
    const r = qaListingToDirectory({
      listing: {
        contents: [
          {
            key: "nm099999/qa/dataqual.json",
            size: 4321,
            lastModified: "2026-05-14T00:00:00Z",
          },
          {
            key: "nm099999/qa/nm099999_histogram.svg",
            size: 22000,
            lastModified: "2026-05-14T00:00:00Z",
          },
        ],
        commonPrefixes: ["nm099999/qa/sub-001/", "nm099999/qa/sub-002/"],
        truncated: false,
      },
      path: "",
      absolutePrefix: "nm099999/qa/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => `${c.name}${c.kind === "dir" ? "/" : ""}`)).toEqual([
      "sub-001/",
      "sub-002/",
      "dataqual.json",
      "nm099999_histogram.svg",
    ]);
  });

  test("ignores Contents whose key is not directly under the prefix (placeholder defence)", () => {
    // S3 sometimes returns a "directory placeholder" object whose key IS the
    // prefix itself (e.g. created by `aws s3api put-object --key foo/`).
    // Those entries have name === "" after the prefix strip and must be
    // dropped from the directory listing.
    const r = qaListingToDirectory({
      listing: {
        contents: [
          {
            key: "nm099999/qa/sub-001/",
            size: 0,
            lastModified: "2026-05-14T00:00:00Z",
          },
          {
            key: "nm099999/qa/sub-001/eeg_summary.json",
            size: 256,
            lastModified: "2026-05-14T00:00:00Z",
          },
        ],
        commonPrefixes: [],
        truncated: false,
      },
      path: "sub-001",
      absolutePrefix: "nm099999/qa/sub-001/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    // The placeholder MUST be suppressed; the eeg_summary file MUST appear.
    expect(r.children.map((c) => c.name)).toEqual(["eeg_summary.json"]);
  });

  test("ignores Contents nested deeper than one level (defence against missing delimiter)", () => {
    // If a caller forgot delimiter=/, S3 returns the entire subtree under
    // Contents. Our renderer is one-level; nested keys must be dropped (they
    // would have been rolled into CommonPrefixes had the delimiter been set).
    const r = qaListingToDirectory({
      listing: {
        contents: [
          {
            key: "nm099999/qa/dataqual.json",
            size: 123,
            lastModified: "2026-05-14T00:00:00Z",
          },
          {
            key: "nm099999/qa/sub-001/eeg/foo.svg",
            size: 1024,
            lastModified: "2026-05-14T00:00:00Z",
          },
        ],
        commonPrefixes: [],
        truncated: false,
      },
      path: "",
      absolutePrefix: "nm099999/qa/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.children.map((c) => c.name)).toEqual(["dataqual.json"]);
  });

  test("propagates the truncated flag so renderers can show a 'listing capped' affordance", () => {
    const r = qaListingToDirectory({
      listing: {
        contents: [
          { key: "nm099999/qa/x.json", size: 1, lastModified: "2026-05-14T00:00:00Z" },
        ],
        commonPrefixes: [],
        truncated: true,
      },
      path: "",
      absolutePrefix: "nm099999/qa/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.truncated).toBe(true);
  });

  test("deduplicates entries that appear in both Contents and CommonPrefixes", () => {
    // This shouldn't happen on a real S3 response (a key can't be both a file
    // and a prefix), but if S3 ever did emit overlap we should not double-list.
    const r = qaListingToDirectory({
      listing: {
        contents: [
          { key: "nm099999/qa/eeg", size: 0, lastModified: "2026-05-14T00:00:00Z" },
        ],
        commonPrefixes: ["nm099999/qa/eeg/"],
        truncated: false,
      },
      path: "",
      absolutePrefix: "nm099999/qa/",
    });
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    // Directory wins (added first, dedupe Set kicks in on the file).
    expect(r.children.map((c) => `${c.name}/${c.kind}`)).toEqual(["eeg/dir"]);
  });
});

describe("isPublicCatalogId (#584) — rejects sandbox, test, and malformed ids", () => {
  test("accepts a real nm dataset id", () => {
    expect(isPublicCatalogId("nm000132")).toBe(true);
  });
  test("rejects the nm099999 e2e test dataset", () => {
    expect(isPublicCatalogId("nm099999")).toBe(false);
  });
  test("rejects xx-prefix sandbox ids", () => {
    expect(isPublicCatalogId("xx000001")).toBe(false);
    expect(isPublicCatalogId("xx999999")).toBe(false);
  });
  test("rejects ids that don't match the canonical (nm|xx|on)NNNNNN shape", () => {
    expect(isPublicCatalogId("nm132")).toBe(false);
    expect(isPublicCatalogId("nm000132a")).toBe(false);
    expect(isPublicCatalogId("../etc/passwd")).toBe(false);
    expect(isPublicCatalogId('nm000132"><script>')).toBe(false);
    expect(isPublicCatalogId("")).toBe(false);
  });
});

describe("buildCatalogIndexPayload (#584) — SQL row to payload mapping", () => {
  const baseRow: CatalogIndexRow = {
    dataset_id: "nm000132",
    name: "EEG Pilot",
    concept_doi: "10.82901/NEMAR.nm000132",
    latest_version: "1.0.0",
    latest_published_at: "2026-05-12T10:00:00Z",
  };

  test("maps SQL rows to entries with normalized version tag and browse_url", () => {
    const { payload, droppedIds } = buildCatalogIndexPayload({ rows: [baseRow] });
    expect(payload.count).toBe(1);
    expect(payload.datasets).toHaveLength(1);
    expect(droppedIds).toEqual([]);
    const entry = payload.datasets[0];
    expect(entry.id).toBe("nm000132");
    expect(entry.title).toBe("EEG Pilot");
    expect(entry.latest).toBe("v1.0.0");
    expect(entry.doi).toBe("10.82901/NEMAR.nm000132");
    expect(entry.published).toBe("2026-05-12T10:00:00Z");
    expect(entry.browse_url).toBe("/nm000132/");
  });

  test("filters out xx, nm099999, and malformed ids — and surfaces them in droppedIds", () => {
    const { payload, droppedIds } = buildCatalogIndexPayload({
      rows: [
        baseRow,
        { ...baseRow, dataset_id: "nm099999" },
        { ...baseRow, dataset_id: "xx000005" },
        { ...baseRow, dataset_id: "nm132" },
      ],
    });
    expect(payload.count).toBe(1);
    expect(payload.datasets[0].id).toBe("nm000132");
    expect(droppedIds.sort()).toEqual(["nm099999", "nm132", "xx000005"]);
  });

  test("sorts datasets by id ascending regardless of input order", () => {
    const { payload } = buildCatalogIndexPayload({
      rows: [
        { ...baseRow, dataset_id: "nm000200" },
        { ...baseRow, dataset_id: "nm000103" },
        { ...baseRow, dataset_id: "nm000132" },
      ],
    });
    expect(payload.datasets.map((d) => d.id)).toEqual(["nm000103", "nm000132", "nm000200"]);
  });

  test("preserves nulls when version/title/doi are missing", () => {
    const { payload } = buildCatalogIndexPayload({
      rows: [
        {
          dataset_id: "nm000400",
          name: "",
          concept_doi: null,
          latest_version: null,
          latest_published_at: null,
        },
      ],
    });
    expect(payload.datasets[0]).toEqual({
      id: "nm000400",
      title: null,
      latest: null,
      doi: null,
      published: null,
      browse_url: "/nm000400/",
    });
  });

  test("empty input yields zero count + empty list + empty dropped", () => {
    const out = buildCatalogIndexPayload({ rows: [] });
    expect(out.payload).toEqual({ count: 0, datasets: [] });
    expect(out.droppedIds).toEqual([]);
  });
});

describe("renderCatalogIndexHtml (#584) — HTML escaping and edge cases", () => {
  test("renders one row per dataset with a link to /<id>/", () => {
    const html = renderCatalogIndexHtml({
      count: 2,
      datasets: [
        {
          id: "nm000103",
          title: "HBN-EEG NC",
          latest: "v1.0.0",
          doi: "10.82901/NEMAR.nm000103",
          published: "2026-04-01T00:00:00Z",
          browse_url: "/nm000103/",
        },
        {
          id: "nm000132",
          title: null,
          latest: null,
          doi: null,
          published: null,
          browse_url: "/nm000132/",
        },
      ],
    });
    expect(html).toContain('<a href="/nm000103/">nm000103/</a>');
    expect(html).toContain("HBN-EEG NC");
    expect(html).toContain("v1.0.0");
    expect(html).toContain('href="https://doi.org/10.82901/NEMAR.nm000103"');
    expect(html).toContain("2026-04-01");
    expect(html).toContain('<a href="/nm000132/">nm000132/</a>');
    expect(html).toContain("2 datasets hosted");
  });

  test("singular phrasing for count==1", () => {
    const html = renderCatalogIndexHtml({
      count: 1,
      datasets: [
        {
          id: "nm000103",
          title: "Solo",
          latest: "v1.0.0",
          doi: null,
          published: null,
          browse_url: "/nm000103/",
        },
      ],
    });
    expect(html).toContain("1 dataset hosted");
    expect(html).not.toContain("1 datasets hosted");
  });

  test("empty catalog renders the empty notice instead of an empty table", () => {
    const html = renderCatalogIndexHtml({ count: 0, datasets: [] });
    expect(html).toContain("No publicly-hosted datasets yet.");
    expect(html).not.toContain("<table>");
  });

  test("html-escapes dataset titles to block injection", () => {
    const html = renderCatalogIndexHtml({
      count: 1,
      datasets: [
        {
          id: "nm000999",
          title: "<script>alert(1)</script>",
          latest: null,
          doi: null,
          published: null,
          browse_url: "/nm000999/",
        },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("links to the json form in the footer", () => {
    const html = renderCatalogIndexHtml({ count: 0, datasets: [] });
    expect(html).toContain('<a href="/?format=json">json</a>');
  });

  test("html-escapes the DOI value so a quote in the doi can't break out of the href", () => {
    const html = renderCatalogIndexHtml({
      count: 1,
      datasets: [
        {
          id: "nm000999",
          title: "ok",
          latest: null,
          doi: '10.82901/bad"doi',
          published: null,
          browse_url: "/nm000999/",
        },
      ],
    });
    // The raw double-quote must not appear inside the rendered href.
    expect(html).not.toContain('href="https://doi.org/10.82901/bad"doi"');
    expect(html).toContain('href="https://doi.org/10.82901/bad&quot;doi"');
  });

  test("renders '-' for malformed or empty published values, not an empty cell", () => {
    const html = renderCatalogIndexHtml({
      count: 1,
      datasets: [
        {
          id: "nm000999",
          title: "ok",
          latest: null,
          doi: null,
          published: "",
          browse_url: "/nm000999/",
        },
      ],
    });
    // The published cell is the last <td> of the row.
    expect(html).toMatch(/<td>-<\/td><\/tr>/);
  });
});

