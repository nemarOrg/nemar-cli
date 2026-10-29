/**
 * Print the text each sample dataset is embedded and reranked as, built by the
 * production code (buildDatasetSummaryText over the production SQL and schema)
 * and not by a second implementation:
 *
 *   bun scripts/search-eval/dump-texts.ts > texts.json
 *   bun scripts/search-eval/dump-texts.ts --corpus corpus.json > texts-full.json   # the whole catalog
 *
 * Also prints, for the queries named on the command line, what the production
 * query analysis makes of each: the words the lexical leg and the reranker are
 * given.
 *
 *   bun scripts/search-eval/dump-texts.ts --analyze "bilingual performance study" "arnaud delorme"
 */

import { readFileSync } from "node:fs";
import {
  DATASET_SUMMARY_SELECT_SQL,
  buildDatasetSummaryText,
} from "../../backend/src/services/dataset-summary-text";
import { analyzeQuery } from "../../backend/src/services/search-query";
import { freshDb, realD1 } from "../../backend/test/helpers/d1";
import {
  type CatalogSampleRow,
  seedCatalogRows,
  seedCatalogSample,
} from "../../backend/test/helpers/search-catalog";

const db = freshDb();
const corpusFlag = process.argv.indexOf("--corpus");
if (corpusFlag > 0) {
  seedCatalogRows(
    db,
    JSON.parse(readFileSync(process.argv[corpusFlag + 1] as string, "utf8")) as CatalogSampleRow[],
  );
} else {
  seedCatalogSample(db);
}

if (process.argv[2] === "--analyze") {
  const d1 = realD1(db);
  for (const query of process.argv.slice(3)) {
    const a = await analyzeQuery(d1, query);
    console.log(
      JSON.stringify({
        query,
        semantic: a.semanticQuery,
        rerank: a.rerankQuery,
        informative: a.informative,
      }),
    );
  }
} else {
  const rows = db
    .query(
      `SELECT d.dataset_id AS id, ${DATASET_SUMMARY_SELECT_SQL} FROM datasets d ORDER BY d.dataset_id`,
    )
    .all() as Array<Parameters<typeof buildDatasetSummaryText>[0] & { id: string }>;
  console.log(
    JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, buildDatasetSummaryText(r)]))),
  );
}
