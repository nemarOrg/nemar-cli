/**
 * `shared/contract/quality-route.ts`: the quality view route's paths, words, bounds and file headers (ADR 0137
 * decision 7, epic #2324 phase B2), held to the vendored neuroschema 0.6.0 registry and schemas they restate.
 * The view digest's vectors are replayed by `test/view-digest-contract.unit.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUALITY_FILE_MAX_BYTES,
  QUALITY_FORMAT_MEDIA_TYPES,
  QUALITY_PUBLIC_MAX_AGE,
  QUALITY_RECORDING_PATH_MAX,
  QUALITY_ROUTE_WORDS,
  qualityCacheTag,
  qualityFileHeaders,
  qualityFilePath,
  qualityRecordPath,
} from "../shared/contract/quality-route.js";

// biome-ignore lint/suspicious/noExplicitAny: vendored documents are read field by field
type Loose = any;
const NS = join(import.meta.dir, "../shared/contract/neuroschema");
const REGISTRY: Loose = JSON.parse(readFileSync(join(NS, "views/registry.json"), "utf8"));
const BUNDLE: Loose = JSON.parse(readFileSync(join(NS, "dataset.bundle.json"), "utf8"));
const schema = (id: string): Loose => BUNDLE.schemas.find((s: Loose) => s.$id === id);

describe("bounds restate neuroschema's", () => {
  test("a view file is at most the registry's bytes per role, the schema's size maximum", () => {
    expect(QUALITY_FILE_MAX_BYTES).toBe(REGISTRY.caps.bytes_per_role);
    const view = schema("nsc:/definitions/view.schema.json");
    expect(view.$defs.viewData.properties.size.maximum).toBe(QUALITY_FILE_MAX_BYTES);
    expect(view.$defs.fileInput.properties.size.maximum).toBe(QUALITY_FILE_MAX_BYTES);
  });

  test("a recording path is at most relativeLocation's length", () => {
    const types = schema("nsc:/definitions/processingTypes.schema.json");
    expect(types.$defs.relativeLocation.maxLength).toBe(QUALITY_RECORDING_PATH_MAX);
  });

  test("the formats served inline are the registry's, with its media types", () => {
    expect(Object.keys(QUALITY_FORMAT_MEDIA_TYPES).sort()).toEqual(
      Object.keys(REGISTRY.formats).sort(),
    );
    for (const [format, media] of Object.entries(QUALITY_FORMAT_MEDIA_TYPES)) {
      expect(media.split(";")[0]).toBe(REGISTRY.formats[format].media_type);
    }
  });

  test("a browser keeps a public answer at most 300 seconds (ADR 0137 decision 7)", () => {
    expect(QUALITY_PUBLIC_MAX_AGE).toBeLessThanOrEqual(300);
    expect(qualityCacheTag("nm000103")).toBe("nemar-dq-nm000103");
  });
});

describe("words", () => {
  test("each word has its fixed status, and only corruption and an unreadable record are 5xx", () => {
    expect(QUALITY_ROUTE_WORDS).toEqual({
      quality_not_found: 404,
      recording_path_invalid: 400,
      views_expired: 410,
      view_not_declared: 404,
      view_data_missing: 404,
      view_data_corrupt: 502,
      record_unreadable: 502,
    });
  });
});

describe("paths", () => {
  test("segments are encoded one by one; the recording's slashes stay", () => {
    expect(qualityRecordPath("nm000103", "nemar-ica", "sub-01/eeg/sub-01_task-a b_eeg.edf")).toBe(
      "/nm000103/quality/v1/nemar-ica/record/sub-01/eeg/sub-01_task-a%20b_eeg.edf",
    );
    expect(
      qualityFilePath(
        "nm000103",
        "nemar-ica",
        "a".repeat(64),
        "b".repeat(64),
        "sub-01/eeg/x_eeg.edf",
      ),
    ).toBe(
      `/nm000103/quality/v1/nemar-ica/file/${"a".repeat(64)}/${"b".repeat(64)}/sub-01/eeg/x_eeg.edf`,
    );
  });
});

describe("file headers (RFC 6266, nosniff)", () => {
  test("a listed format is served inline as its media type", () => {
    expect(qualityFileHeaders("sub-01/eeg/a_spectrum.tsv", "tsv")).toEqual({
      "Content-Type": "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": "inline; filename*=UTF-8''a_spectrum.tsv",
      "X-Content-Type-Options": "nosniff",
    });
    expect(qualityFileHeaders("a.json", "json")["Content-Type"]).toBe("application/json");
  });

  test("any other format, or none, is an octet-stream attachment, so a declared page is never rendered", () => {
    for (const [location, format] of [
      ["sub-01/eeg/a.html", "html"],
      ["sub-01/eeg/a.svg", "svg"],
      ["sub-01/eeg/a.npy", null],
      ["a.tsv", "constructor"],
      ["a.tsv", "__proto__"],
    ] as const) {
      const h = qualityFileHeaders(location, format);
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"].startsWith("attachment; filename*=UTF-8''")).toBe(true);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  test("the file name is percent-encoded, quotes and parentheses included", () => {
    expect(qualityFileHeaders('d/it\'s (µ) "x".tsv', "tsv")["Content-Disposition"]).toBe(
      "inline; filename*=UTF-8''it%27s%20%28%C2%B5%29%20%22x%22.tsv",
    );
  });
});
