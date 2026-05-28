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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coerceFunding,
  decideSkipCiCheck,
  detectModalitiesFromDataset,
  ensureReadmeMd,
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
    const config = JSON.parse(
      readFileSync(join(tmpRoot, ".nemar", "config.json"), "utf-8"),
    );
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
});
