// The real-catalog sample the search tests run against (test/fixtures/search-relevance/).
//
// 160 public datasets copied from api.nemar.org by scripts/search-eval/sample_fixture.py:
// real names, abstracts, keywords, authors and README heads. They are inserted through the
// production schema (`freshDb()` applies every migration), so the FTS triggers index them
// exactly as a production write does.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CatalogSampleRow {
  id: string;
  name: string;
  description: string;
  authors: string;
  tasks: string;
  modalities: string;
  readme: string;
  keywords: string[];
  subject_count: number | null;
}

export const FIXTURE_DIR = join(import.meta.dir, "../../../test/fixtures/search-relevance");

export const catalogSample: CatalogSampleRow[] = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "catalog-sample.json"), "utf8"),
);

export const sampleById = new Map(catalogSample.map((r) => [r.id, r]));

/** Insert the whole sample as public, active, managed datasets. */
export function seedCatalogSample(db: Database): void {
  seedCatalogRows(db, catalogSample);
}

/** Insert `rows` (the shape scripts/search-eval/fetch_corpus.py writes) as public, active, managed datasets. */
export function seedCatalogRows(db: Database, rows: CatalogSampleRow[]): void {
  const insert = db.query(
    `INSERT INTO datasets (dataset_id, name, description, authors, tasks, modalities, readme,
                           enrichment_json, subject_count, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, -1, 'active', 'public', 0)`,
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.name,
      r.description,
      r.authors,
      r.tasks,
      r.modalities,
      r.readme,
      JSON.stringify({ keywords: r.keywords.map((term) => ({ term })) }),
      r.subject_count,
    );
  }
}
