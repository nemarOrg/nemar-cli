/**
 * The placeholder `participants.tsv` the enrichment commits for a dataset that has none. The rule
 * lives in `shared/standard-edits/participants.ts`, so the upstream re-pull's planner (ADR 0111)
 * recognizes the same edit; the enrichment keeps reaching it through this module.
 */
export {
  type EnsureParticipantsTsvResult,
  type TreeEntry,
  buildPlaceholderParticipantsTsv,
  ensureParticipantsTsv,
  enumerateBidsSubjects,
} from "../../../shared/standard-edits/participants.js";
