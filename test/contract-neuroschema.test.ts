/**
 * neuroschema conformance — the vendored bundle compiles and enforces the
 * v0.6.0 dataset schema (epic #896, #898). Pure: validates fixtures, no backend.
 * The live-response conformance check is in test/contract-live.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  DATA_PAPER_STRING_CAPS,
  MAX_DATA_PAPER_YEAR,
  MIN_DATA_PAPER_YEAR,
  normalizeDataPaper,
  validateDataPapers,
} from "../backend/src/services/data-papers";
import { digestManifest } from "../backend/src/services/data-router";
import type { VersionManifest } from "../backend/src/services/manifest";
import { COMPUTE_RECIPES } from "../shared/compute-recipes";
import { NEUROSCHEMA_VERSION, bidsIndexSchema } from "../shared/contract/index.js";
import {
  NEUROSCHEMA_LINE_RE,
  NEUROSCHEMA_TRANSITION_LINES,
  compileNeuroschemaDatasetValidator,
  compileNeuroschemaRecordValidator,
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";

const validate = compileNeuroschemaDatasetValidator();

/** Minimal object satisfying neuroschema core/dataset.schema.json required fields. */
const goodDataset = {
  schema_version: NEUROSCHEMA_VERSION,
  doc_type: "dataset",
  dataset_id: "nm000108",
  name: "Example EEG dataset",
  source: "nemar",
  recording_modality: ["EEG"],
};

describe("vendored neuroschema dataset bundle", () => {
  test("compiles (every bundled schema and $ref resolves)", () => {
    expect(typeof validate).toBe("function");
  });

  test("accepts a conformant dataset", () => {
    const ok = validate(goodDataset);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("rejects a bad source enum", () => {
    expect(validate({ ...goodDataset, source: "kaggle" })).toBe(false);
  });

  test("rejects a dataset_id violating the pattern", () => {
    expect(validate({ ...goodDataset, dataset_id: "NM_000108" })).toBe(false);
  });

  test("rejects a dataset missing a required field", () => {
    const { recording_modality, ...noModality } = goodDataset;
    void recording_modality;
    expect(validate(noModality)).toBe(false);
  });
});

// Epic #1144 Phase 2 (#1146): dataSummary's recording-duration fields
// (neuroschema v0.4.0, PR nemarOrg/neuroschema#12).
describe("data_summary recording-duration fields (v0.4.0)", () => {
  test("accepts total_recording_duration + recording_duration_range populated", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        total_files: 620,
        size_bytes: 12_000_000,
        size_human: "12.0 MB",
        recording_count: 126,
        recordings_unavailable: 2,
        total_recording_duration: 3343170,
        recording_duration_range: { min: 22410, max: 31860 },
        channel_count_range: { min: 19, max: 24 },
      },
    };
    const ok = validate(ds);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts total_recording_duration null (unmeasured) with no range objects", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        total_files: null,
        size_bytes: null,
        size_human: null,
        recording_count: 3,
        recordings_unavailable: 3,
        total_recording_duration: null,
      },
    };
    expect(validate(ds)).toBe(true);
  });

  test("rejects a negative total_recording_duration", () => {
    const ds = { ...goodDataset, data_summary: { total_recording_duration: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects a negative recording_count (S2)", () => {
    // The bundle gives recording_count the same minimum:0 as
    // total_recording_duration -- confirm it's actually enforced, not just
    // declared.
    const ds = { ...goodDataset, data_summary: { recording_count: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects a negative recordings_unavailable (S2)", () => {
    const ds = { ...goodDataset, data_summary: { recordings_unavailable: -1 } };
    expect(validate(ds)).toBe(false);
  });

  test("rejects recording_duration_range carrying an unknown key -- additionalProperties:false is doing real work", () => {
    const ds = {
      ...goodDataset,
      data_summary: {
        recording_duration_range: { min: 100, max: 200, units: "seconds" },
      },
    };
    expect(validate(ds)).toBe(false);
  });

  test("rejects channel_count_range carrying an unknown key", () => {
    const ds = {
      ...goodDataset,
      data_summary: { channel_count_range: { min: 19, max: 24, extra: true } },
    };
    expect(validate(ds)).toBe(false);
  });
});

// Epic #1144 Phase 2b (#1153): signal_defaults (definitions/inheritable.schema.json).
// The power_line_frequency enum is THE trap this phase's plan calls out --
// these tests assert the REAL vendored schema enforces it, not a
// hand-written expectation of what the enum should be.
describe("signal_defaults field (v0.4.0, epic #1144 Phase 2b #1153)", () => {
  test("accepts every field populated with a valid value", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: {
        sampling_frequency: 500,
        power_line_frequency: 60,
        reference: "average",
        recording_type: null,
        channel_system: "10-20",
        placement_scheme: "extended 10-10% system",
      },
    };
    const ok = validate(ds);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts every field null (nothing probed yet)", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: {
        sampling_frequency: null,
        power_line_frequency: null,
        reference: null,
        recording_type: null,
        channel_system: null,
        placement_scheme: null,
      },
    };
    expect(validate(ds)).toBe(true);
  });

  test("accepts power_line_frequency: 50 (the other enum member)", () => {
    const ds = { ...goodDataset, signal_defaults: { power_line_frequency: 50 } };
    expect(validate(ds)).toBe(true);
  });

  test("REJECTS power_line_frequency out of the {50, 60, null} enum -- enforced by the real vendored schema, not a hand-written check", () => {
    // A measured value close to 60 -- the exact "don't round" trap.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: 59.94 } })).toBe(
      false,
    );
    // BIDS "not applicable" numeric convention -- distinct from JSON null.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: 0 } })).toBe(false);
    // Same class as Phase 2's negative-number gap.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: -60 } })).toBe(
      false,
    );
    // Stringly-typed, as some hand-authored sidecars carry it.
    expect(validate({ ...goodDataset, signal_defaults: { power_line_frequency: "60" } })).toBe(
      false,
    );
  });

  test("rejects sampling_frequency below the schema's minimum:0", () => {
    expect(validate({ ...goodDataset, signal_defaults: { sampling_frequency: -1 } })).toBe(false);
  });

  test("rejects an unknown key inside signal_defaults -- additionalProperties:false is doing real work", () => {
    const ds = {
      ...goodDataset,
      signal_defaults: { sampling_frequency: 500, extra_field: true },
    };
    expect(validate(ds)).toBe(false);
  });
});

// Neuroschema v0.4.1 (nemarOrg/neuroschema#17): the optional top-level
// `data_papers` key (ADR 0077). The documents below run through the REAL vendored
// schema, and the writer's own output is checked against it too, so the writer
// and the schema cannot drift apart unnoticed.
describe("data_papers field (v0.4.1, ADR 0077)", () => {
  const SCI_DATA = {
    doi: "10.1038/s41597-019-0027-4",
    title: "Multi-channel EEG recordings during a sustained-attention driving task",
    year: 2019,
    venue: "Scientific Data",
    judge_model: "claude-sonnet-5-5",
  };
  const withPapers = (data_papers: unknown) => ({ ...goodDataset, data_papers });

  test("the vendored bundle is stamped with the version NEUROSCHEMA_VERSION names", () => {
    // NEUROSCHEMA_VERSION is hand-set; the bundle stamp is machine-written. They
    // must move together.
    const bundle = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../shared/contract/neuroschema/dataset.bundle.json"),
        "utf8",
      ),
    ) as { _provenance: { neuroschema_version: string }; schemas: { $id: string }[] };
    expect(bundle._provenance.neuroschema_version).toBe(NEUROSCHEMA_VERSION);
    expect(bundle.schemas.map((x) => x.$id)).toContain("nsc:/definitions/dataPaper.schema.json");
  });

  test("a document without the key still validates (it is optional)", () => {
    expect(validate(goodDataset)).toBe(true);
  });

  test("accepts a full item", () => {
    const ok = validate(withPapers([SCI_DATA]));
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("accepts an item with only a doi, and one with every detail null", () => {
    expect(validate(withPapers([{ doi: "10.5524/100542" }]))).toBe(true);
    expect(
      validate(
        withPapers([
          { doi: "10.5524/100542", title: null, year: null, venue: null, judge_model: null },
        ]),
      ),
    ).toBe(true);
  });

  test("accepts an empty list (judged, and no data paper)", () => {
    expect(validate(withPapers([]))).toBe(true);
  });

  test("accepts more than one paper", () => {
    expect(validate(withPapers([SCI_DATA, { doi: "10.6084/m9.figshare.6427334.v5" }]))).toBe(true);
  });

  test("rejects an item with no doi", () => {
    expect(validate(withPapers([{ title: "no doi" }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, doi: undefined }]))).toBe(false);
  });

  test("rejects an item carrying a key the schema does not declare", () => {
    expect(validate(withPapers([{ ...SCI_DATA, relation_type: "IsDescribedBy" }]))).toBe(false);
  });

  test.each([
    ["a resolver URL", "https://doi.org/10.1038/s41597-019-0027-4"],
    ["a doi: prefix", "doi:10.1038/s41597-019-0027-4"],
    ["no suffix", "10.1038"],
    ["a registrant that is too short", "10.12/abc"],
    ["whitespace in the suffix", "10.1038/has space"],
    ["an empty string", ""],
  ])("rejects a malformed doi: %s", (_label, doi) => {
    expect(validate(withPapers([{ ...SCI_DATA, doi }]))).toBe(false);
  });

  test.each([
    ["a non-ASCII letter in the suffix", "10.1038/caf\u00e9"],
    ["a non-breaking space in the suffix", "10.1038/a\u00a0b"],
    ["a tab in the suffix", "10.1038/a\tb"],
    ["a trailing newline", "10.1038/abc\n"],
    ["non-ASCII digits in the registrant", "10.\u0661\u0662\u0663\u0664/abc"],
    ["a registrant of ten digits", "10.1234567890/abc"],
  ])("rejects a doi outside printable ASCII or the registrant bounds: %s", (_label, doi) => {
    expect(validate(withPapers([{ ...SCI_DATA, doi }]))).toBe(false);
  });

  test("the writer's doi rule is neuroschema 0.6.0 dataPaper.doi, case for case", () => {
    // normalizeDataPaper trims, so the corpus holds no surrounding whitespace: what it judges is the
    // pattern itself, which must give the schema's verdict for every case.
    for (const doi of [
      "10.1038/s41597-019-0027-4",
      "10.5524/100542",
      "10.6084/m9.figshare.6427334.v5",
      "10.1000/<x>",
      "10.1000/!~",
      "10.123456789/a",
      "10.1234567890/a",
      "10.123/a",
      "10.1038/caf\u00e9",
      "10.1038/a\u00a0b",
      "10.1038/a\u2028b",
      "10.1038/a b",
      "10.\u0661\u0662\u0663\u0664/abc",
      "10.1038/",
      "https://doi.org/10.1038/abc",
    ]) {
      const schema = validate(withPapers([{ doi }])) as boolean;
      expect(normalizeDataPaper({ doi }) !== null, JSON.stringify(doi)).toBe(schema);
    }
  });

  test("rejects a wrong-typed detail", () => {
    expect(validate(withPapers([{ ...SCI_DATA, year: "2019" }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, year: 2019.5 }]))).toBe(false);
    expect(validate(withPapers([{ ...SCI_DATA, title: 12 }]))).toBe(false);
  });

  test("rejects data_papers that is not a list of objects", () => {
    expect(validate(withPapers({ doi: SCI_DATA.doi }))).toBe(false);
    expect(validate(withPapers(["10.1038/s41597-019-0027-4"]))).toBe(false);
    expect(validate(withPapers(null))).toBe(false);
  });

  test("whatever the writer accepts, the schema accepts (including at every limit)", () => {
    const prefix = "10.1000/";
    const atLimits = {
      doi: prefix + "a".repeat(DATA_PAPER_STRING_CAPS.doi - prefix.length),
      title: "t".repeat(DATA_PAPER_STRING_CAPS.title),
      year: MAX_DATA_PAPER_YEAR,
      venue: "v".repeat(DATA_PAPER_STRING_CAPS.venue),
      judge_model: "m".repeat(DATA_PAPER_STRING_CAPS.judge_model),
    };
    for (const input of [
      [SCI_DATA],
      [],
      [{ doi: "10.5524/100542" }],
      [{ ...SCI_DATA, year: MIN_DATA_PAPER_YEAR }],
      [atLimits],
    ]) {
      const res = validateDataPapers(input, "nm000275");
      if (!res.ok) throw new Error(`writer refused ${JSON.stringify(input)}: ${res.reason}`);
      const ok = validate(withPapers(res.papers));
      if (!ok)
        throw new Error(`schema refused what the writer accepted: ${formatAjvErrors(validate)}`);
    }
  });
});

// The live checks (test/contract-live.test.ts, test/data-route.test.ts) accept a
// deployed backend on the same MAJOR.MINOR (any PATCH), and, while a MINOR
// release is being deployed, the previous MINOR named in
// NEUROSCHEMA_TRANSITION_LINES (0.4, the deployed line, for the 0.6.0 release:
// ADR 0137; the epic's 0.5.0 step was never deployed).
describe("the live schema_version pin (NEUROSCHEMA_LINE_RE)", () => {
  const [major, minor, patch] = NEUROSCHEMA_VERSION.split(".").map(Number);

  test("accepts the same MAJOR.MINOR with the current, an earlier or a later PATCH", () => {
    for (const p of [0, patch, patch + 1, 12]) {
      expect(NEUROSCHEMA_LINE_RE.test(`${major}.${minor}.${p}`)).toBe(true);
    }
  });

  test("accepts the transition line 0.4.x while 0.6.0 deploys, and not the undeployed 0.5.x", () => {
    expect(NEUROSCHEMA_TRANSITION_LINES).toEqual(["0.4"]);
    for (const v of ["0.4.0", "0.4.1", "0.4.9"]) expect(NEUROSCHEMA_LINE_RE.test(v)).toBe(true);
    for (const v of ["0.3.9", "0.5.0", "0.5.9", "0.40.1", "0.4", "0.4.1-rc1"])
      expect(NEUROSCHEMA_LINE_RE.test(v)).toBe(false);
  });

  test("rejects another MINOR or MAJOR, and anything that is not a plain x.y.z", () => {
    for (const v of [
      `${major}.${minor + 1}.0`,
      `${major}.${minor - 1}.9`,
      `${major}.${minor - 3}.9`,
      `${major + 1}.${minor}.${patch}`,
      `${major}.${minor}`,
      `${major}.${minor}0.0`,
      `${major}.${minor}.${patch}-rc1`,
      `v${major}.${minor}.${patch}`,
      "",
    ]) {
      expect(NEUROSCHEMA_LINE_RE.test(v)).toBe(false);
    }
  });
});

// Since neuroschema 0.5.0 (ADR 0134, epic #2324 phase 2): the bundle carries a
// record root beside the dataset root and the three processing extensions, and
// any bundled schema can be compiled on its own by its nsc:/ id.
describe("neuroschema bundle: record root and processing extensions", () => {
  const bundle = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../shared/contract/neuroschema/dataset.bundle.json"),
      "utf8",
    ),
  ) as {
    _provenance: { neuroschema_version: string; source_commit: string };
    root: string;
    roots: { dataset: string; record: string };
    schemas: { $id: string }[];
  };
  const fixture = (name: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures/neuroschema", name), "utf8"));

  test("names both roots and keeps root as the dataset root", () => {
    expect(bundle.root).toBe("nsc:/core/dataset.schema.json");
    expect(bundle.roots).toEqual({
      dataset: "nsc:/core/dataset.schema.json",
      record: "nsc:/core/record.schema.json",
    });
  });

  test("carries the processing extensions and their shared definitions", () => {
    const ids = bundle.schemas.map((x) => x.$id);
    for (const id of [
      "nsc:/core/record.schema.json",
      "nsc:/extensions/processing.schema.json",
      "nsc:/extensions/dataQuality.schema.json",
      "nsc:/extensions/signalJourney.schema.json",
      "nsc:/definitions/checkpointCounts.schema.json",
      "nsc:/definitions/qualityMetric.schema.json",
      "nsc:/definitions/processingTypes.schema.json",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("the neuroschema dataset example validates through the dataset root", () => {
    const ok = validate(fixture("dataset-ds002718-processing.json"));
    if (!ok) throw new Error(formatAjvErrors(validate));
  });

  test("the neuroschema record example validates through the record root", () => {
    const record = compileNeuroschemaRecordValidator();
    const doc = fixture("record-ds002718-processing.json");
    if (!record(doc)) throw new Error(formatAjvErrors(record));
    expect(record({ ...doc, modality: undefined })).toBe(false);
  });

  test("a single schema compiles by its id, and a fragment by id#pointer", () => {
    const counts = compileNeuroschemaValidator("nsc:/definitions/checkpointCounts.schema.json");
    expect(counts({ passed: 1, failed: 0, skipped: 0, total: 1 })).toBe(true);
    expect(counts({ passed: 1, failed: 0, skipped: 0 })).toBe(false);
    const link = compileNeuroschemaValidator(
      "nsc:/extensions/signalJourney.schema.json#/$defs/recordLink",
    );
    expect(
      link({
        recipe_version: "1.0.0",
        processing_status: "in_progress",
        location: null,
        sha256: null,
        sj_version: null,
      }),
    ).toBe(true);
    expect(() => compileNeuroschemaValidator("nsc:/extensions/none.schema.json")).toThrow();
  });
});

// neuroschema 0.6.0 (ADR 0137, epic #2324 phase N1a): the release that names
// views. The bundle reaches the view schemas through dataQuality, and the view
// vocabulary's data files (registry, parity vectors, montages, the example
// product) are vendored beside it in views/, each held to views/SHA256SUMS.json.
describe("neuroschema 0.6.0: views and the vendored view files", () => {
  const VENDOR_DIR = join(import.meta.dir, "../shared/contract/neuroschema");
  const VIEWS_DIR = join(VENDOR_DIR, "views");
  // The 0.6.0 release (tag v0.6.0, e09ed407) plus its sensor vectors regenerated at the recipes' eegprep
  // commit (nemarOrg/neuroschema#40, #2411). Still stamped 0.6.0: it moves to the 0.6.1 release commit.
  const RELEASE_COMMIT = "1cf0d2addc287fdf16a0218d46f32d10f8e4f4ef";
  const bundle = JSON.parse(readFileSync(join(VENDOR_DIR, "dataset.bundle.json"), "utf8")) as {
    _provenance: { neuroschema_version: string; source_commit: string };
    schemas: { $id: string }[];
  };
  const sums = JSON.parse(readFileSync(join(VIEWS_DIR, "SHA256SUMS.json"), "utf8")) as {
    format: string;
    neuroschema_version: string;
    source_commit: string;
    files: { path: string; source: string; size: number; sha256: string }[];
  };
  const fixture = (name: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures/neuroschema", name), "utf8"));
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  test("the bundle and the view files are stamped 0.6.0 at the vendored commit", () => {
    expect(NEUROSCHEMA_VERSION).toBe("0.6.0");
    expect(bundle._provenance.neuroschema_version).toBe("0.6.0");
    expect(bundle._provenance.source_commit).toBe(RELEASE_COMMIT);
    expect(sums.format).toBe("nemar.vendored-files.v1");
    expect(sums.neuroschema_version).toBe("0.6.0");
    expect(sums.source_commit).toBe(RELEASE_COMMIT);
  });

  test("the bundle carries the view declaration and every view kind and transform", () => {
    const ids = bundle.schemas.map((x) => x.$id);
    expect(ids).toContain("nsc:/definitions/view.schema.json");
    const registry = JSON.parse(readFileSync(join(VIEWS_DIR, "registry.json"), "utf8")) as {
      kinds: { kind: string; schema: string }[];
    };
    expect(registry.kinds.length).toBeGreaterThanOrEqual(10);
    for (const k of registry.kinds) {
      expect(ids, k.kind).toContain(`nsc:/${k.schema.replace(/^schema\//, "")}`);
    }
  });

  test("every vendored view file matches SHA256SUMS, and SHA256SUMS lists every file", () => {
    const onDisk = (readdirSync(VIEWS_DIR, { recursive: true }) as string[])
      .map((p) => p.split(sep).join("/"))
      .filter((p) => p !== "SHA256SUMS.json" && statSync(join(VIEWS_DIR, p)).isFile())
      .sort();
    expect(onDisk).toEqual(sums.files.map((f) => f.path));
    // Guards the guard: the four groups ADR 0137 vendors are all there.
    for (const prefix of ["registry.json", "vectors/", "montages/PROVENANCE.json", "examples/"]) {
      expect(
        onDisk.some((p) => p.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    for (const f of sums.files) {
      const bytes = readFileSync(join(VIEWS_DIR, f.path));
      expect(bytes.length, f.path).toBe(f.size);
      expect(sha256(bytes), f.path).toBe(f.sha256);
    }
  });

  test("the eegprep commit the vectors were made with is the recipes' engine commit", () => {
    const commits = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o.implementation === "eegprep" && typeof o.commit === "string") commits.add(o.commit);
        Object.values(o).forEach(visit);
      }
    };
    const vectors = sums.files.filter((f) => f.path.startsWith("vectors/"));
    for (const f of vectors) visit(JSON.parse(readFileSync(join(VIEWS_DIR, f.path), "utf8")));
    const engines = new Set(COMPUTE_RECIPES.map((r) => r.engine.split("+")[1]));
    expect(engines.size).toBe(1);
    expect(commits.size).toBe(1);
    expect([...commits]).toEqual([...engines]);
  });

  test("the record example validates with views and is refused with figures", () => {
    const record = compileNeuroschemaRecordValidator();
    const doc = fixture("record-ds002718-processing.json");
    if (!record(doc)) throw new Error(formatAjvErrors(record));
    type Recipes = Record<string, Record<string, unknown>>;
    const names = Object.entries(doc.extensions.dataQuality.recipes as Recipes)
      .filter(([, r]) => Array.isArray(r.views))
      .map(([name]) => name);
    expect(names.length).toBeGreaterThan(0);
    // `figures` in place of `views` (the 0.5.0 shape), and `figures` beside `views`: both refused.
    const renamed = structuredClone(doc);
    const added = structuredClone(doc);
    for (const name of names) {
      const { views, ...rest } = renamed.extensions.dataQuality.recipes[name];
      renamed.extensions.dataQuality.recipes[name] = { ...rest, figures: views };
      added.extensions.dataQuality.recipes[name].figures = [];
    }
    expect(Object.keys(renamed.extensions.dataQuality.recipes[names[0]])).not.toContain("views");
    expect(record(renamed)).toBe(false);
    expect(record(added)).toBe(false);
  });

  test("the example product's record validates, and its declared files are the product's bytes", () => {
    const validateQuality = compileNeuroschemaValidator("nsc:/extensions/dataQuality.schema.json");
    const doc = JSON.parse(
      readFileSync(join(VIEWS_DIR, "examples/dataquality-record-nemar-ica.json"), "utf8"),
    );
    if (!validateQuality(doc)) throw new Error(formatAjvErrors(validateQuality));
    const declared = (
      doc.recipes["nemar-ica"].views as {
        data?: { location: string; size: number; sha256: string }[];
      }[]
    ).flatMap((v) => v.data ?? []);
    expect(declared.length).toBeGreaterThan(0);
    for (const d of declared) {
      const bytes = readFileSync(join(VIEWS_DIR, "examples/product", d.location));
      expect(bytes.length, d.location).toBe(d.size);
      expect(sha256(bytes), d.location).toBe(d.sha256);
    }
  });
});

// Epic #1586 Phase 2 (#1588): `extensions.nemar.bids_index.subjects.*.session_modalities`.
// neuroschema declares `extensions.nemar` with additionalProperties: true and
// does not describe `bids_index` at all, so the vendored bundle neither needs
// regenerating for the new key nor guards it. These tests pin both halves of
// that claim, so the day neuroschema does describe `bids_index` this fails and
// the bundle and `bidsIndexSchema` get updated together instead of drifting.
describe("extensions.nemar.bids_index carries session_modalities (#1588)", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../backend/test/fixtures/bids-index-sessions/manifest-on007347-v1.0.0.json",
      ),
      "utf8",
    ),
  ) as VersionManifest;
  const subjects = digestManifest(manifest).subjects;
  const withIndex = (bidsIndex: unknown) => ({
    ...goodDataset,
    extensions: { nemar: { bids_index: bidsIndex } },
  });

  test("the vendored schema accepts a dataset whose real index carries the field", () => {
    const ds = withIndex({ version: "v1.0.0", subjects });
    // Guards the guard: the index under test really has the new key.
    expect(subjects["sub-004"].session_modalities).toBeDefined();
    const ok = validate(ds);
    if (!ok) throw new Error(`expected valid, got: ${formatAjvErrors(validate)}`);
    expect(ok).toBe(true);
  });

  test("the vendored schema does not constrain the block; bidsIndexSchema is the guard", () => {
    const nonsense = {
      version: "v1.0.0",
      subjects: { "sub-01": { sessions: [], modalities: {}, session_modalities: "eeg" } },
    };
    expect(validate(withIndex(nonsense))).toBe(true);
    expect(bidsIndexSchema.safeParse(nonsense).success).toBe(false);
  });
});
