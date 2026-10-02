/**
 * Version of the transform's OUTPUT, not of the code.
 *
 * Bump it in the PR that changes any byte a dataset's artifacts would carry for
 * the same input: a mapping rule, a term, an identifier name, the dictionary
 * layout.
 * It is stamped into every report, and the regeneration step (a later phase)
 * treats a different value as "every dataset is stale", so a bump costs one
 * full regeneration and an unbumped change leaves stale files in the store.
 * The vocabulary pin moves independently (shared/neurobagel/vocab/snapshot.json)
 * and a pin change that alters output bumps this too.
 */
export const NEUROBAGEL_TRANSFORM_VERSION = 1;
