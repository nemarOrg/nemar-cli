/**
 * Unit tests for the local catalog builder. The pure helper is the part
 * that can break in subtle ways (author shape detection, search_text
 * composition, COALESCE-of-null defaults), so it's worth pinning here.
 *
 * The bulk syncCatalogFromLocal function is integration-tested via the
 * /admin/catalog/sync-local endpoint and post-deploy assertions; it's
 * straight database I/O with no per-row branching.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCatalogRecordFromLocal,
  type LocalDatasetRow,
} from "../backend/src/services/catalog-from-local";

function row(over: Partial<LocalDatasetRow> = {}): LocalDatasetRow {
  return {
    dataset_id: "nm000166",
    name: "M3CV: EEG Database",
    description: "64-ch EEG",
    concept_doi: "10.82901/nemar.nm000166",
    modalities: "eeg",
    subject_count: 95,
    age_min: 18,
    age_max: 35,
    tasks: "rest,p300",
    file_size: 23154528416,
    total_files: 1024,
    created_at: "2026-04-08 08:32:30",
    source: null,
    source_id: null,
    is_sandbox: 0,
    enrichment_json: null,
    owner_username: "bruaristimunha",
    ...over,
  };
}

describe("buildCatalogRecordFromLocal", () => {
  test("preserves every typed datasets.* column", () => {
    const out = buildCatalogRecordFromLocal(row(), null);
    expect(out.id).toBe("nm000166");
    expect(out.modalities).toBe("eeg");
    expect(out.participants).toBe(95);
    expect(out.age_min).toBe(18);
    expect(out.age_max).toBe(35);
    expect(out.tasks).toBe("rest,p300");
    expect(out.file_size).toBe(23154528416);
    expect(out.file_size_formatted).toBe("21.56 GB");
    expect(out.total_files).toBe(1024);
    expect(out.doi).toBe("10.82901/nemar.nm000166");
    expect(out.uploader).toBe("bruaristimunha");
  });

  test("defaults nullable numeric columns to 0 (nemar_catalog NOT NULL contract)", () => {
    const out = buildCatalogRecordFromLocal(
      row({ subject_count: null, age_min: null, age_max: null, file_size: null, total_files: null }),
      null,
    );
    expect(out.participants).toBe(0);
    expect(out.age_min).toBe(0);
    expect(out.age_max).toBe(0);
    expect(out.file_size).toBe(0);
    expect(out.total_files).toBe(0);
    expect(out.file_size_formatted).toBeNull();
  });

  test("falls back name to dataset_id when both name and enrichment.title are absent", () => {
    const out = buildCatalogRecordFromLocal(row({ name: null }), null);
    expect(out.name).toBe("nm000166");
  });

  test("prefers enrichment.title over the d1 row name", () => {
    const out = buildCatalogRecordFromLocal(row(), { title: "Polished Title" });
    expect(out.name).toBe("Polished Title");
  });

  test("prefers enrichment.description over the d1 row description", () => {
    const out = buildCatalogRecordFromLocal(row(), { description: "Polished description." });
    expect(out.description).toBe("Polished description.");
  });

  test("extracts authors from the object-keyed enrichment shape", () => {
    const out = buildCatalogRecordFromLocal(row(), {
      authors: { "Gan Huang": {}, "Zhenxing Hu": {} },
    });
    expect(out.authors).toBe("Gan Huang, Zhenxing Hu");
  });

  test("extracts license from enrichment_json", () => {
    const out = buildCatalogRecordFromLocal(row(), { license: "CC0" });
    expect(out.license).toBe("CC0");
  });

  test("defaults source to 'nemar.org' when null", () => {
    expect(buildCatalogRecordFromLocal(row({ source: null }), null).source).toBe("nemar.org");
  });

  test("preserves source='openneuro' + source_id for on* mirrors", () => {
    const out = buildCatalogRecordFromLocal(
      row({ dataset_id: "on002718", source: "openneuro", source_id: "ds002718" }),
      null,
    );
    expect(out.source).toBe("openneuro");
    expect(out.source_id).toBe("ds002718");
  });

  test("search_text is lowercase and includes id, source_id, name, authors, tasks, modalities", () => {
    const out = buildCatalogRecordFromLocal(
      row({
        dataset_id: "on002718",
        source: "openneuro",
        source_id: "ds002718",
        name: "Face Processing EEG",
        tasks: "FaceRecognition",
        modalities: "eeg,anat",
      }),
      { authors: { "Daniel G. Wakeman": {} } },
    );
    expect(out.search_text).toContain("on002718");
    expect(out.search_text).toContain("ds002718");
    expect(out.search_text).toContain("face processing eeg");
    expect(out.search_text).toContain("daniel g. wakeman");
    expect(out.search_text).toContain("facerecognition");
    expect(out.search_text).toContain("eeg,anat");
    // sanity: no leading/trailing nulls
    expect(out.search_text.trim()).toBe(out.search_text);
  });
});
