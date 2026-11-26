/**
 * The pipeline stamp id pattern, declared once in a leaf with no imports, so a consumer that needs only
 * the pattern (the quality route's contract and the website's proxy, epic #2324 phase B3b) pulls in
 * nothing else. `compute-admin.ts` re-exports it.
 */

/** A pipeline stamp id in a path or an argument: a whole number of up to 16 digits (and a safe integer). */
export const COMPUTE_PIPELINE_STAMP_ID_RE = /^[1-9][0-9]{0,15}$/;
