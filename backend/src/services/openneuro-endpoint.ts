/**
 * OpenNeuro's GraphQL endpoint, in a module of its own.
 *
 * Two readers of OpenNeuro share it: discovery (`openneuro-discovery.ts`, the auto-import's
 * candidate scan, which stays id-only) and the staleness report's snapshot reader
 * (`openneuro-snapshots.ts`), which the automatic re-pull's scheduler calls. Neither may load the
 * other: the auto-import never sees a stale mirror, and the scheduler never reaches discovery's
 * set-diff (ADR 0111, decision 6). This leaf imports nothing, so sharing the constant joins
 * nothing; `repull-discovery-separation.test.ts` pins the separation.
 */

export const OPENNEURO_GRAPHQL_URL = "https://openneuro.org/crn/graphql";
