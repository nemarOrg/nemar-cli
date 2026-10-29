// The two network calls of the relevance path, answered from recorded model output.
//
// `scripts/search-eval/model_outputs.py` ran the open BAAI weights that Workers AI serves
// (`bge-small-en-v1.5` for embeddings, `bge-reranker-base` for relevance) over the exact
// texts the production builder produces for the fixture catalog, and recorded what they said.
// These bindings replay it. They stand in for two external services at the network edge, the
// same category .rules/testing.md allows for HTTP response fixtures; everything between them --
// query analysis, fusion, the relevance cutoff, hydration, counting, filters -- is the real
// code against the real schema.
//
// A text the fixture has no hash for, or a query it has no record of, throws instead of
// guessing: a silently wrong replay would make a relevance test pass for the wrong reason.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RERANK_MODEL } from "../../src/services/search-rerank";
import { FIXTURE_DIR } from "./search-catalog";

interface ModelOutputs {
  text_sha256: Record<string, string>;
  semantic: Record<string, Array<[string, number]>>;
  rerank: Record<string, Record<string, number>>;
}

const outputs: ModelOutputs = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "model-outputs.json"), "utf8"),
);
const idByTextHash = new Map(Object.entries(outputs.text_sha256).map(([id, h]) => [h, id]));
const semanticQueries = Object.keys(outputs.semantic);
const REGENERATE =
  "regenerate with scripts/search-eval/model_outputs.py (see its docstring) after adding the query to test/fixtures/search-relevance/cases.json";

export interface RecordedModels {
  ai: Ai;
  vectorize: VectorizeIndex;
  /** Every embedding and rerank call, in order, as the code under test made it. */
  calls: { embed: string[]; rerank: Array<{ query: string; candidates: number; texts: string[] }> };
}

export interface RecordedModelOptions {
  /** The embedding call throws, as when Workers AI is down. */
  embeddingFails?: boolean;
  /** The rerank call throws. */
  rerankFails?: boolean;
}

export function recordedModels(options: RecordedModelOptions = {}): RecordedModels {
  const calls: RecordedModels["calls"] = { embed: [], rerank: [] };
  const ai = {
    async run(model: string, input: Record<string, unknown>) {
      if (model === RERANK_MODEL) {
        const { query, contexts } = input as { query: string; contexts: Array<{ text: string }> };
        calls.rerank.push({
          query,
          candidates: contexts.length,
          texts: contexts.map((c) => c.text),
        });
        if (options.rerankFails) throw new Error("Workers AI unavailable");
        const logits = outputs.rerank[query];
        if (!logits)
          throw new Error(`no recorded rerank scores for ${JSON.stringify(query)}; ${REGENERATE}`);
        const response = contexts.map((context, id) => {
          const datasetId = idByTextHash.get(
            createHash("sha256").update(context.text).digest("hex"),
          );
          if (!datasetId) {
            throw new Error(
              `candidate text is not in the fixture (builder changed?): ${context.text.slice(0, 60)}; ${REGENERATE}`,
            );
          }
          return { id, score: logits[datasetId] as number };
        });
        // The binding answers best-first; the code must go by `id`, not by position.
        return { response: response.sort((a, b) => b.score - a.score) };
      }
      // The embedding call: the "vector" is the index of the recorded query, nothing more.
      const text = (input as { text: string[] }).text[0] as string;
      calls.embed.push(text);
      if (options.embeddingFails) throw new Error("Workers AI unavailable");
      const index = semanticQueries.indexOf(text);
      if (index < 0)
        throw new Error(`no recorded embedding for ${JSON.stringify(text)}; ${REGENERATE}`);
      return { data: [[index]] };
    },
  } as unknown as Ai;

  const vectorize = {
    async query(vector: number[], opts: { topK: number }) {
      const nearest = outputs.semantic[semanticQueries[vector[0] as number] as string] ?? [];
      return { matches: nearest.slice(0, opts.topK).map(([id, score]) => ({ id, score })) };
    },
  } as unknown as VectorizeIndex;

  return { ai, vectorize, calls };
}
