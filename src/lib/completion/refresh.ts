/**
 * Fills the shell-completion cache (src/lib/completion/cache.ts) from the
 * live facets endpoint (epic #1144 phase 5b, issue #1149, D3). `__complete`
 * itself never reaches this file -- only `nemar completion refresh`
 * (explicit, src/commands/completion.ts) and the opportunistic refresh fired
 * after a successful `dataset list`/`dataset search` (src/commands/dataset.ts)
 * do.
 */

import { getFacets } from "../api/datasets.js";
import { writeCompletionCache } from "./cache.js";

/**
 * Fetch the facets endpoint and overwrite the cache. Throws on failure --
 * `nemar completion refresh` wants to report that to the user, so it awaits
 * this directly. The opportunistic caller below does not want that and
 * swallows the rejection instead.
 */
export async function refreshCompletionCache(): Promise<void> {
  const facets = await getFacets();
  writeCompletionCache(facets);
}

/**
 * Fire-and-forget refresh for a successful `dataset list`/`dataset search`
 * (D3): those commands just proved the API is reachable, so this costs one
 * extra request on a path that already made one. Never awaited by the
 * caller and never lets a rejection escape -- a facets-endpoint failure here
 * must not change the calling command's output or exit code (verification
 * case 7), and must not surface as an unhandled promise rejection either.
 */
export function triggerOpportunisticRefresh(): void {
  refreshCompletionCache().catch((err) => {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[completion] opportunistic refresh failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  });
}
