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
  buildDatasetMetadata,
  buildLandingPayload,
  buildPersonList,
  buildRedirectUrl,
  type DatasetRowForMetadata,
  type DatasetVersionRow,
  deriveSessions,
  diffRemovedSince,
  escapeHtml,
  findLastSeenVersion,
  formatBytes,
  humanSize,
  pickResponseFormat,
  renderDatasetLandingHtml,
  renderIndexHtml,
  renderTombstone404Html,
  resolveFile,
  resolveVersion,
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
    // Catalog description from D1 takes precedence over enrichment.description
    expect(out.description).toBe("Hand gesture EMG");
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
    expect(out.provenance).toEqual({
      latest_snapshot: "1.0.0",
      publish_date: "2026-05-15T00:00:00Z",
    });
    expect(out.extensions.nemar.versions[0]).toEqual({
      version: "1.0.0",
      doi: "10.82901/NEMAR.nm099999.v1.0.0",
      created_at: "2026-05-15T00:00:00Z",
      manifest_url: "/nm099999/v1.0.0/manifest.json",
    });
    expect(out.extensions.nemar.bids_index?.version).toBe("1.0.0");
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
    expect(out.provenance.latest_snapshot).toBe("1.0.0");
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
