/**
 * Unit tests for the pure decision helpers in src/lib/import-openneuro.ts.
 *
 * The orchestration function `importOpenNeuro()` itself can only be tested
 * end-to-end through `nemarDatasets/.github/workflows/onboard-openneuro.yml`
 * (no-mocks policy + live GitHub / S3 / backend dependencies). What CAN be
 * tested here is `decideSkipCiCheck`, the small pure function that gates
 * publication approval against the (deployed?, poll outcome, trust-upstream)
 * matrix. Wrong branch here publishes unvalidated data, so the matrix is
 * worth covering exhaustively.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENNEURO_UPSTREAM_MARKER,
  coerceFunding,
  decidePublicationRequestAction,
  decideSkipCiCheck,
  detectModalitiesFromDataset,
  ensureReadmeMd,
  findAnnexedRootMetadata,
  isAlreadyExistsImportError,
  isNeverAnnexedMetadata,
  openNeuroCurrentUrl,
  seedMetadata,
} from "../src/lib/import-openneuro";

describe("decideSkipCiCheck", () => {
  test("CI not deployed always aborts, regardless of --trust-upstream", () => {
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({ ciDeployed: false, poll: null, trustUpstream });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeDefined();
      expect(d.abortReason).toContain("CI workflows did not deploy");
    }
  });

  test("poll found: defer to ci_check (skipCiCheck=false, no abort)", () => {
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({
        ciDeployed: true,
        poll: { kind: "found" },
        trustUpstream,
      });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeUndefined();
    }
  });

  test("poll timeout + --trust-upstream: skip ci check (the #431 fast-path)", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "timeout" },
      trustUpstream: true,
    });
    expect(d.skipCiCheck).toBe(true);
    expect(d.abortReason).toBeUndefined();
  });

  test("poll timeout WITHOUT --trust-upstream: abort, do not silently skip", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "timeout" },
      trustUpstream: false,
    });
    expect(d.skipCiCheck).toBe(false);
    expect(d.abortReason).toBeDefined();
    expect(d.abortReason).toContain("Re-run with --trust-upstream");
  });

  test("every poll errored: ALWAYS abort, even under --trust-upstream", () => {
    // This is the trust-hole #431 was meant to close: we never actually
    // observed validation state, so --trust-upstream must not approve.
    for (const trustUpstream of [true, false]) {
      const d = decideSkipCiCheck({
        ciDeployed: true,
        poll: { kind: "error", lastError: new Error("HTTP 401: Unauthorized") },
        trustUpstream,
      });
      expect(d.skipCiCheck).toBe(false);
      expect(d.abortReason).toBeDefined();
      expect(d.abortReason).toContain("Every BIDS validation poll attempt failed");
      expect(d.abortReason).toContain("HTTP 401");
    }
  });

  test("error branch stringifies non-Error throws", () => {
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: { kind: "error", lastError: "raw string thrown" },
      trustUpstream: true,
    });
    expect(d.abortReason).toContain("raw string thrown");
  });

  test("null poll (CI not deployed branch never polled): handled by ciDeployed=false guard", () => {
    // The orchestrator passes poll=null only when ciDeployed=false; that path
    // is covered above. If callers somehow pass poll=null with ciDeployed=true
    // we treat that as "no observation needed" and approve normally.
    const d = decideSkipCiCheck({
      ciDeployed: true,
      poll: null,
      trustUpstream: false,
    });
    expect(d.skipCiCheck).toBe(false);
    expect(d.abortReason).toBeUndefined();
  });
});

describe("coerceFunding (#512)", () => {
  test("missing Funding field returns empty array", () => {
    expect(coerceFunding({})).toEqual([]);
  });

  test("non-array Funding (string) returns empty array", () => {
    // Some BIDS authors write Funding as a single string by mistake. RFC says
    // array; we treat the spec violation as "no funding" rather than crashing.
    expect(coerceFunding({ Funding: "NIH grant 1R01EB123456" })).toEqual([]);
  });

  test("array of strings maps to funder_name entries", () => {
    expect(
      coerceFunding({
        Funding: ["NIH 1R01EB123456", "NSF 2024-1234", "EU H2020-12345"],
      }),
    ).toEqual([
      { funder_name: "NIH 1R01EB123456" },
      { funder_name: "NSF 2024-1234" },
      { funder_name: "EU H2020-12345" },
    ]);
  });

  test("trims whitespace and drops empty entries", () => {
    expect(
      coerceFunding({
        Funding: ["  NIH 1R01EB123456  ", "", "   ", "NSF 2024-1234"],
      }),
    ).toEqual([{ funder_name: "NIH 1R01EB123456" }, { funder_name: "NSF 2024-1234" }]);
  });

  test("drops non-string array entries (defensive against malformed source)", () => {
    expect(
      coerceFunding({
        Funding: ["NIH grant", 12345, null, undefined, { funder: "x" }, "NSF grant"],
      }),
    ).toEqual([{ funder_name: "NIH grant" }, { funder_name: "NSF grant" }]);
  });
});

describe("detectModalitiesFromDataset (#512)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "modality-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("non-existent path returns empty (helper must not throw inside seedMetadata)", () => {
    expect(detectModalitiesFromDataset(join(tmpRoot, "missing"))).toEqual([]);
  });

  test("empty dataset returns empty", () => {
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual([]);
  });

  test("sub-XX/eeg shape: detects eeg modality", () => {
    mkdirSync(join(tmpRoot, "sub-01/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-02/eeg"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual(["eeg"]);
  });

  test("sub-XX/ses-XX/datatype shape: walks session level", () => {
    mkdirSync(join(tmpRoot, "sub-01/ses-1/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-01/ses-2/emg"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual(["eeg", "emg"]);
  });

  test("mixed sessioned + unsessioned subjects: union of modalities", () => {
    mkdirSync(join(tmpRoot, "sub-01/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-02/ses-1/meg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-03/ses-pre/anat"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual(["anat", "eeg", "meg"]);
  });

  test("ignores non-BIDS datatype directories", () => {
    mkdirSync(join(tmpRoot, "sub-01/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-01/code"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-01/derivatives"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-01/random-dir"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual(["eeg"]);
  });

  test("ignores top-level non-sub-* directories", () => {
    // derivatives/, code/, stimuli/, sourcedata/ etc. live at the root in
    // BIDS; they don't count toward dataset-level recording_modality.
    mkdirSync(join(tmpRoot, "derivatives/sub-01/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "code"), { recursive: true });
    mkdirSync(join(tmpRoot, "sourcedata/sub-01/eeg"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual([]);
  });

  test("returns sorted, deduplicated list", () => {
    mkdirSync(join(tmpRoot, "sub-01/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-01/meg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-02/eeg"), { recursive: true });
    mkdirSync(join(tmpRoot, "sub-02/anat"), { recursive: true });
    expect(detectModalitiesFromDataset(tmpRoot)).toEqual(["anat", "eeg", "meg"]);
  });
});

describe("seedMetadata (#512)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "seed-meta-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readMeta(): Record<string, unknown> {
    const path = join(tmpRoot, ".nemar", "metadata.json");
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  test("minimal BIDS description: writes baseline fields only, no empty optionals", () => {
    seedMetadata(tmpRoot, "on007262", "ds007262", { Name: "Test dataset" }, null);
    const meta = readMeta();
    expect(meta.version).toBe("2.0");
    expect(meta.dataset_id).toBe("on007262");
    expect(meta.source).toBe("openneuro");
    expect(meta.source_id).toBe("ds007262");
    expect(meta.title).toBe("Test dataset");
    expect(meta.license).toBe("CC0");
    expect(meta.dataset_type).toBe("raw");
    expect(meta.pipeline_stage).toBe("seeded");
    expect(meta.related_identifiers).toEqual([]);
    // Optional fields should be absent when there's no input — keeps the
    // seeded JSON small and makes "this came from LLM enrichment" obvious.
    expect(meta).not.toHaveProperty("bids_version");
    expect(meta).not.toHaveProperty("recording_modality");
    expect(meta).not.toHaveProperty("datatypes");
    expect(meta).not.toHaveProperty("funding_references");
    expect(meta).not.toHaveProperty("acknowledgements");
  });

  test("rich BIDS description: populates all the new #512 fields", () => {
    // Create sub-01/eeg so modality detection finds something
    mkdirSync(join(tmpRoot, "sub-01/eeg"), { recursive: true });
    seedMetadata(
      tmpRoot,
      "on005262",
      "ds005262",
      {
        Name: "EEG resting state",
        License: "CC-BY-4.0",
        DatasetType: "raw",
        BIDSVersion: "1.8.0",
        Authors: ["Jane Doe", "John Roe"],
        Funding: ["NIH 1R01EB123456", "NSF 2024-1234"],
        Acknowledgements: "Thanks to the participants.",
      },
      "10.18112/openneuro.ds005262.v1.0.0",
    );
    const meta = readMeta();
    expect(meta.title).toBe("EEG resting state");
    expect(meta.license).toBe("CC-BY-4.0");
    expect(meta.bids_version).toBe("1.8.0");
    expect(meta.recording_modality).toEqual(["eeg"]);
    expect(meta.datatypes).toEqual(["eeg"]);
    expect(meta.funding_references).toEqual([
      { funder_name: "NIH 1R01EB123456" },
      { funder_name: "NSF 2024-1234" },
    ]);
    expect(meta.acknowledgements).toBe("Thanks to the participants.");
    expect(meta.related_identifiers).toEqual([
      {
        identifier: "10.18112/openneuro.ds005262.v1.0.0",
        identifier_type: "DOI",
        relation_type: "IsIdenticalTo",
      },
    ]);
    expect(meta.authors).toEqual({ "Jane Doe": {}, "John Roe": {} });
  });

  test("missing License defaults to CC0 (matches OpenNeuro upstream default)", () => {
    seedMetadata(tmpRoot, "on000001", "ds000001", { Name: "x" }, null);
    expect(readMeta().license).toBe("CC0");
  });

  test("malformed Acknowledgements (whitespace-only) is omitted", () => {
    seedMetadata(tmpRoot, "on000001", "ds000001", { Name: "x", Acknowledgements: "   " }, null);
    expect(readMeta()).not.toHaveProperty("acknowledgements");
  });

  test("pre-existing .nemar/ directory is not blown away", () => {
    mkdirSync(join(tmpRoot, ".nemar"), { recursive: true });
    writeFileSync(join(tmpRoot, ".nemar", "config.json"), JSON.stringify({ foo: "bar" }));
    seedMetadata(tmpRoot, "on000001", "ds000001", { Name: "x" }, null);
    // metadata.json appears, config.json survives.
    expect(readMeta().dataset_id).toBe("on000001");
    const config = JSON.parse(readFileSync(join(tmpRoot, ".nemar", "config.json"), "utf-8"));
    expect(config.foo).toBe("bar");
  });
});

describe("ensureReadmeMd (#642)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "readmeMd-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readFile(name: string): string {
    return readFileSync(join(tmpRoot, name), "utf-8");
  }
  function exists(name: string): boolean {
    try {
      readFileSync(join(tmpRoot, name));
      return true;
    } catch {
      return false;
    }
  }

  test("README with no extension → renamed to README.md, content untouched", () => {
    const body = "# Loneliness EEG\n\nFull upstream methods, paradigm, citation...\n";
    writeFileSync(join(tmpRoot, "README"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds007827", "10.18112/openneuro.ds007827.v1.0.0");

    expect(outcome).toEqual({ kind: "renamed", from: "README", to: "README.md" });
    expect(exists("README")).toBe(false);
    expect(readFile("README.md")).toBe(body);
  });

  test("README.md exists → kept as-is, never overwritten with a stub", () => {
    const body = "# Existing project README\n\nReal content.\n";
    writeFileSync(join(tmpRoot, "README.md"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds007827", "10.18112/openneuro.ds007827.v1.0.0");

    expect(outcome).toEqual({ kind: "kept", path: "README.md" });
    expect(readFile("README.md")).toBe(body);
  });

  test("README.rst exists → kept, no README.md is created", () => {
    const body = "Project README\n==============\n\nrst content\n";
    writeFileSync(join(tmpRoot, "README.rst"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds007827", null);

    expect(outcome).toEqual({ kind: "kept", path: "README.rst" });
    expect(readFile("README.rst")).toBe(body);
    expect(exists("README.md")).toBe(false);
  });

  test("README.txt exists → kept, no README.md is created", () => {
    writeFileSync(join(tmpRoot, "README.txt"), "plaintext readme\n");

    const outcome = ensureReadmeMd(tmpRoot, "ds007827", null);

    expect(outcome).toEqual({ kind: "kept", path: "README.txt" });
    expect(exists("README.md")).toBe(false);
  });

  test("no README of any shape → fallback stub written to README.md with DOI", () => {
    const outcome = ensureReadmeMd(tmpRoot, "ds000117", "10.18112/openneuro.ds000117.v1.0.0");

    expect(outcome).toEqual({ kind: "created", path: "README.md" });
    const out = readFile("README.md");
    expect(out).toContain("<!-- nemar:provenance -->");
    expect(out).toContain("[ds000117](https://openneuro.org/datasets/ds000117)");
    expect(out).toContain("10.18112/openneuro.ds000117.v1.0.0");
  });

  test("no README + no DOI → fallback stub omits the DOI line", () => {
    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome.kind).toBe("created");
    const out = readFile("README.md");
    expect(out).toContain("<!-- nemar:provenance -->");
    expect(out).not.toContain("doi.org");
  });

  test("idempotent on re-run after rename: README.md is kept, no double-write", () => {
    writeFileSync(join(tmpRoot, "README"), "original body\n");

    const first = ensureReadmeMd(tmpRoot, "ds000117", null);
    const firstContent = readFile("README.md");
    const second = ensureReadmeMd(tmpRoot, "ds000117", null);
    const secondContent = readFile("README.md");

    expect(first.kind).toBe("renamed");
    expect(second).toEqual({ kind: "kept", path: "README.md" });
    expect(secondContent).toBe(firstContent);
  });

  test("Readme.md (mixed case) → kept; fallback never overwrites case variant", () => {
    // Case-sensitivity regression. If the regex misses `Readme.md`, the
    // fallback would `writeFileSync('README.md', stub)` and clobber the
    // upstream-authored file on a case-insensitive FS. The `/i` flag on
    // README_FILENAME_REGEX prevents this.
    const body = "# Mixed-case upstream README\n";
    writeFileSync(join(tmpRoot, "Readme.md"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "kept", path: "Readme.md" });
    expect(readFile("Readme.md")).toBe(body);
  });

  test("readme (lowercase, no extension) → kept-as-renamed, content preserved", () => {
    // Lowercase bare README is unusual but legal upstream; we still want
    // to canonicalize to `README.md` so GitHub renders it.
    const body = "lowercase readme body\n";
    writeFileSync(join(tmpRoot, "readme"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "renamed", from: "README", to: "README.md" });
    expect(readFile("README.md")).toBe(body);
  });

  test("both README (bare) and README.md present → prefer .md, no rename", () => {
    // Collision case. `entries.find()` order is OS-dependent; without an
    // explicit preference rule, a Linux scan could rename `README` over
    // the existing `README.md` and destroy upstream content. The
    // preference rule (`suffixed` branch first) makes this deterministic.
    const bare = "stale bare README content (would be lost without the fix)\n";
    const md = "# Real upstream README.md\n\nAuthored markdown content.\n";
    writeFileSync(join(tmpRoot, "README"), bare);
    writeFileSync(join(tmpRoot, "README.md"), md);

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "kept", path: "README.md" });
    expect(readFile("README.md")).toBe(md);
    // Bare README is left in place; the import flow doesn't stage it,
    // so it won't end up in the commit. Existing git tracking (if any)
    // is preserved.
    expect(readFile("README")).toBe(bare);
  });

  test("README.MD (uppercase ext) → kept, never collides with stub fallback", () => {
    const body = "uppercase-ext README\n";
    writeFileSync(join(tmpRoot, "README.MD"), body);

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "kept", path: "README.MD" });
    expect(readFile("README.MD")).toBe(body);
  });

  test("READMEx → not a README, fallback creates stub (regex anchors)", () => {
    // Regression pin: the regex anchors must not match similar names.
    writeFileSync(join(tmpRoot, "READMEx"), "not a README\n");

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "created", path: "README.md" });
    expect(readFile("READMEx")).toBe("not a README\n");
  });

  test("README.md.bak → not a README, fallback creates stub", () => {
    writeFileSync(join(tmpRoot, "README.md.bak"), "backup file\n");

    const outcome = ensureReadmeMd(tmpRoot, "ds000117", null);

    expect(outcome).toEqual({ kind: "created", path: "README.md" });
  });
});

describe("isNeverAnnexedMetadata (#768)", () => {
  test("dataset-level metadata files match NEMAR never-annex policy", () => {
    for (const name of [
      "dataset_description.json",
      "participants.tsv",
      "participants.json",
      "task-rsvp_events.json",
      "README",
      "README.md",
      "README.txt",
      "Readme.rst",
      "LICENSE",
      "license.txt",
      "CHANGES",
      "CHANGES.md",
      ".bidsignore",
      ".gitignore",
      "config.yml",
      "config.yaml",
    ]) {
      expect(isNeverAnnexedMetadata(name)).toBe(true);
    }
  });

  test("data files are NOT metadata (stay annexed)", () => {
    for (const name of [
      "sub-01_task-rsvp_eeg.edf",
      "sub-01_task-rsvp_eeg.set",
      "data.fif",
      "recording.bdf",
      "scan.nii.gz",
      "blob.bin",
    ]) {
      expect(isNeverAnnexedMetadata(name)).toBe(false);
    }
  });

  test("uppercase extensions are matched (policy is case-insensitive)", () => {
    for (const name of ["dataset.JSON", "participants.TSV", "config.YAML", "notes.TXT"]) {
      expect(isNeverAnnexedMetadata(name)).toBe(true);
    }
  });

  test("CHANGELOG is not CHANGES — prefix rule is prefix-only", () => {
    // `changelog` is a different file and must NOT be un-annexed by the prefix
    // rule; `changeslog.bin` documents that the rule is prefix-anchored, not
    // word-boundary-anchored.
    expect(isNeverAnnexedMetadata("CHANGELOG")).toBe(false);
    expect(isNeverAnnexedMetadata("changelog")).toBe(false);
    expect(isNeverAnnexedMetadata("changeslog.bin")).toBe(true);
  });
});

describe("findAnnexedRootMetadata (#768)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "annexed-meta-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // A git-annex locked file is a symlink whose target embeds the annex object
  // path. We reproduce that shape exactly (the target need not resolve — a
  // freshly cloned, un-fetched annex file is a *dangling* symlink, which is the
  // ds007964 failure case).
  const annexLink = (name: string) =>
    symlinkSync(
      ".git/annex/objects/Qx/QV/SHA256E-s603--deadbeef.json/SHA256E-s603--deadbeef.json",
      join(tmpRoot, name),
    );

  test("detects annexed root metadata symlinks (dangling), sorted", () => {
    annexLink("dataset_description.json");
    annexLink("README.txt");
    annexLink("CHANGES");
    expect(findAnnexedRootMetadata(tmpRoot)).toEqual([
      "CHANGES",
      "README.txt",
      "dataset_description.json",
    ]);
  });

  test("ignores regular metadata files already committed in git", () => {
    writeFileSync(join(tmpRoot, "dataset_description.json"), "{}\n");
    writeFileSync(join(tmpRoot, "participants.tsv"), "id\n");
    expect(findAnnexedRootMetadata(tmpRoot)).toEqual([]);
  });

  test("mixed: only annexed metadata is returned, regular files left alone", () => {
    // The realistic ds007964 shape: some metadata annexed, some plain git.
    annexLink("dataset_description.json");
    writeFileSync(join(tmpRoot, "participants.tsv"), "id\n");
    writeFileSync(join(tmpRoot, "README.md"), "# readme\n");
    expect(findAnnexedRootMetadata(tmpRoot)).toEqual(["dataset_description.json"]);
  });

  test("ignores annexed DATA symlinks (only metadata is un-annexed)", () => {
    symlinkSync(
      ".git/annex/objects/aa/bb/SHA256E-s1--x.edf/SHA256E-s1--x.edf",
      join(tmpRoot, "sub-01_eeg.edf"),
    );
    expect(findAnnexedRootMetadata(tmpRoot)).toEqual([]);
  });

  test("ignores symlinks that do not point into the annex", () => {
    symlinkSync("../somewhere/dataset_description.json", join(tmpRoot, "dataset_description.json"));
    expect(findAnnexedRootMetadata(tmpRoot)).toEqual([]);
  });

  test("missing directory degrades to empty list", () => {
    expect(findAnnexedRootMetadata(join(tmpRoot, "does-not-exist"))).toEqual([]);
  });
});

describe("openNeuroCurrentUrl (#808)", () => {
  test("builds the public CURRENT-by-path S3 url (not git-annex's versioned url)", () => {
    expect(openNeuroCurrentUrl("ds007541", "dataset_description.json")).toBe(
      "https://s3.amazonaws.com/openneuro.org/ds007541/dataset_description.json",
    );
    // No ?versionId= -- the versioned object needs s3:GetObjectVersion, which
    // anonymous reads can't do; the current object by path is what is public.
    expect(openNeuroCurrentUrl("ds006159", "README")).not.toContain("versionId");
  });

  test("url-encodes path segments but keeps the slash separators", () => {
    expect(openNeuroCurrentUrl("ds000001", "sub-01/eeg/a b.tsv")).toBe(
      "https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/eeg/a%20b.tsv",
    );
  });

  test("OPENNEURO_UPSTREAM_MARKER is a stable, greppable token", () => {
    // Listing/triage greps for this exact token; keep it constant.
    expect(OPENNEURO_UPSTREAM_MARKER).toBe("[openneuro-upstream-inaccessible]");
  });
});

describe("isAlreadyExistsImportError (#969 idempotent prepare)", () => {
  test("matches the D1 duplicate-dataset 409 message", () => {
    expect(isAlreadyExistsImportError("Dataset on007523 already exists")).toBe(true);
  });

  test("matches the GitHub-repo-exists 409 message", () => {
    expect(isAlreadyExistsImportError("GitHub repo nemarDatasets/on007523 already exists")).toBe(
      true,
    );
  });

  test("matches a bare HTTP 409 status in the message", () => {
    expect(isAlreadyExistsImportError("request failed: 409")).toBe(true);
  });

  test("does not match an unrelated failure", () => {
    expect(isAlreadyExistsImportError("network timeout")).toBe(false);
    expect(isAlreadyExistsImportError("HTTP 500 Internal Server Error")).toBe(false);
    expect(isAlreadyExistsImportError("")).toBe(false);
  });
});

describe("decidePublicationRequestAction (#985 recover idempotency)", () => {
  test("requests publication for a private (not yet published) dataset", () => {
    expect(decidePublicationRequestAction("private")).toBe("request");
  });

  test("skips publication for an already-public dataset", () => {
    // The #967 recover case: finalize re-runs against a dataset whose data
    // was silently under-delivered the first time but which already
    // completed publish/approve (visibility flipped to 'public'). Must not
    // re-request/re-approve.
    expect(decidePublicationRequestAction("public")).toBe("skip-already-published");
  });
});
