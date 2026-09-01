/**
 * Read-only cache for shell-completion candidates (epic #1144 phase 5b,
 * issue #1149, D3). `__complete` (src/lib/completion/run.ts, via
 * candidates.ts) never writes this file and never performs network I/O
 * itself (D1) -- something else has to fill it: the explicit `nemar
 * completion refresh`, or the opportunistic refresh fired after a
 * successful `dataset list`/`dataset search` (src/lib/completion/refresh.ts).
 * Both go through writeCompletionCache below.
 *
 * Every failure mode on the read side -- missing file, unreadable file,
 * malformed JSON, a JSON value of the wrong shape, an expired entry --
 * degrades to `null` (no cached candidates), never to a thrown error:
 * `__complete` still has to print the static candidates and exit 0 even
 * when this file is garbage.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type DatasetFacetsEnvelope,
  datasetFacetsEnvelopeSchema,
} from "../../../shared/contract/index.js";

// Resolved lazily on each call, not captured at module load, so a test that
// sets NEMAR_CONFIG_DIR in beforeEach always wins regardless of which test
// file imports this module first -- the same test-ordering hazard
// src/lib/config.ts's getConfigDir() documents (issue #489), re-guarded here
// rather than shared because that module's getConfigDir() is not exported.
function getConfigDir(): string {
  return process.env.NEMAR_CONFIG_DIR || join(homedir(), ".config", "nemar");
}

function getCacheFile(): string {
  return join(getConfigDir(), "completion-cache.json");
}

/** One hour (D3). */
const CACHE_TTL_MS = 60 * 60 * 1000;

const cacheFileSchema = z.object({
  cachedAt: z.number(),
  data: datasetFacetsEnvelopeSchema,
});

/**
 * Read the cache if present, well-formed, and fresh. Returns null on ANY
 * problem -- see the module doc comment for the full degrade list -- so
 * every caller gets the same "no dynamic candidates yet" behaviour whether
 * the file is missing, corrupt, of the wrong shape, or just old.
 */
export function readCompletionCache(): DatasetFacetsEnvelope | null {
  try {
    const raw = readFileSync(getCacheFile(), "utf-8");
    const parsed = cacheFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (Date.now() - parsed.data.cachedAt >= CACHE_TTL_MS) return null;
    return parsed.data.data;
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[completion] cache read failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    return null;
  }
}

/**
 * Overwrite the cache with a freshly fetched facets envelope. Used by both
 * `nemar completion refresh` (explicit) and the opportunistic refresh after
 * a successful list/search (src/lib/completion/refresh.ts) -- neither the
 * `__complete` path nor this function makes the network call itself; the
 * caller already has the envelope in hand.
 */
export function writeCompletionCache(data: DatasetFacetsEnvelope): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(getCacheFile(), JSON.stringify({ cachedAt: Date.now(), data }));
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[completion] cache write failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
}

/** Test-only: the resolved cache file path, so tests can write/corrupt it
 *  directly without duplicating the join/dir logic above. */
export function __getCompletionCachePathForTesting(): string {
  return getCacheFile();
}
