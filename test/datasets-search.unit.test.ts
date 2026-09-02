/**
 * Unit tests for the dataset list endpoint's search WHERE-clause builder.
 *
 * Deterministic (no DB): verifies which columns the search pattern is matched
 * against on the single-table `datasets` read (#646). The contract: dataset_id
 * (and source_id for openneuro mirrors) MUST appear in the LIKE clause, and
 * free-text routes through the FTS5 index, regardless of any precomputed state.
 */

import { describe, expect, test } from "bun:test";
import {
  buildDatasetFilterClauses,
  escapeLikePattern,
} from "../backend/src/routes/datasets/catalog";

describe("buildDatasetFilterClauses search clause", () => {
  test("search includes dataset_id + source_id LIKE and routes free-text through FTS5", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { search: "nm000166" });
    expect(clauses).toContain("LOWER(d.dataset_id) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain("LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain(
      "d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)",
    );
    // pattern (dataset_id), pattern (source_id), FTS match expression
    expect(params).toEqual(["%nm000166%", "%nm000166%", '"nm000166"*']);
  });

  test("punctuation-only search (no FTS tokens) falls back to id/name/description LIKE", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { search: "!!" });
    expect(clauses).toContain("LOWER(d.name) LIKE ? ESCAPE '\\'");
    expect(clauses).toContain("LOWER(COALESCE(d.description, '')) LIKE ? ESCAPE '\\'");
    expect(clauses).not.toContain("datasets_fts");
    expect(params).toEqual(["%!!%", "%!!%", "%!!%", "%!!%"]);
  });

  test("modality/author/task/hasDoi/recent filter on d.* columns", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, {
      modality: "EEG",
      author: "Ada",
      task: "rest",
      hasDoi: true,
      recent: 30,
    });
    expect(clauses).toContain("LOWER(COALESCE(d.modalities, '')) LIKE ?");
    expect(clauses).toContain("LOWER(COALESCE(d.authors, '')) LIKE ?");
    expect(clauses).toContain("LOWER(COALESCE(d.tasks, '')) LIKE ?");
    expect(clauses).toContain("d.concept_doi IS NOT NULL");
    expect(clauses).toContain("COALESCE(d.publish_date, d.created_at) > datetime('now', ?)");
    expect(params).toEqual(["%eeg%", "%ada%", "%rest%", "-30 days"]);
  });

  test("hasHed adds `d.has_hed = 1` with no bind param (#869)", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { hasHed: true });
    expect(clauses).toContain("d.has_hed = 1");
    expect(params).toEqual([]); // literal clause, no placeholder
  });

  test("hasHed coexists with a modality filter without consuming its param", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { modality: "EEG", hasHed: true });
    expect(clauses).toContain("LOWER(COALESCE(d.modalities, '')) LIKE ?");
    expect(clauses).toContain("d.has_hed = 1");
    expect(params).toEqual(["%eeg%"]); // only modality pushed a param
  });

  test("no filters returns empty clauses (nothing pushed)", () => {
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, {});
    expect(clauses).toBe("");
    expect(params).toEqual([]);
  });
});

describe("escapeLikePattern", () => {
  test("escapes % so a literal-percent search doesn't match every row", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a%b%c")).toBe("a\\%b\\%c");
  });

  test("escapes _ so a literal-underscore search doesn't match any single char", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
  });

  test("escapes backslash so the escape-char itself can be matched literally", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  test("leaves ordinary input untouched", () => {
    expect(escapeLikePattern("nm000166")).toBe("nm000166");
    expect(escapeLikePattern("ds002718.v1.0.0")).toBe("ds002718.v1.0.0");
  });
});
