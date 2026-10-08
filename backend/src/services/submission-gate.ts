/**
 * The submission-minimums gate (ADR 0026) and the anonymity blind check
 * (ADR 0065), read from the repository: ONE function for the two callers that
 * decide whether a publication request may move forward, so they cannot
 * disagree.
 *
 * The callers are `POST /datasets/:id/publish/request` and the blocked-request
 * sweep (`sweepBlockedBidsValidationRequests`). A request made before BIDS
 * validation has finished is recorded as blocked and the sweep moves it on once
 * CI passes. If only the route ran this gate, that path would be a way round
 * it: a named depositor could be released under the blind label (ADR 0065:
 * irreversible) and the hard minimums of ADR 0026 would not apply to the
 * requests that matter most, the ones made right after an upload.
 *
 * Pure evaluation stays in `submission-minimums.ts`; this module only fetches
 * the files and decides what a failure to fetch means.
 */

import { getFileContent } from "./github";
import { describesEthicsApproval, evaluateSubmissionMinimums } from "./submission-minimums";

const README_CANDIDATES = ["README.md", "README", "README.txt", "README.rst"];

/** Why a gate could not reach a verdict. */
const UNREADABLE_REASON =
  "NEMAR could not read dataset_description.json from your repository, so it could not confirm that the Authors field is blinded. An anonymous release is not granted on an unverified blind. This is usually a transient GitHub error; request it again.";
const NO_REPOSITORY_REASON =
  "An anonymous release requires NEMAR to read dataset_description.json and confirm that the Authors field names nobody, and this dataset has no readable repository yet. Upload the dataset first, then request the release.";

export type SubmissionGateOutcome =
  /** Exempt, or the files were read and every minimum is met. */
  | { kind: "clear" }
  /** A stated minimum is missing, or the blind is not in place: block as `min_requirements_failed`. */
  | { kind: "blocked"; reasons: string[] }
  /**
   * No verdict: there was nothing to read, or `dataset_description.json` could
   * not be. Nothing is known about the data, so what to do is the caller's
   * policy. The request route blocks an anonymous release (a blind nobody
   * verified is never granted) and lets a native submission through to the
   * admin review, as ADR 0026 does; the `reasons` are for the first of those.
   */
  | { kind: "unverified"; reasons: string[] };

/**
 * Does the gate apply to this dataset?
 *
 * OpenNeuro imports and exemplars passed an upstream review and are exempt, but
 * #1408 inverts that for an anonymous release: for it this gate is the blind
 * check, not a quality check, and an upstream review says a dataset was
 * curated, never that it was blinded.
 */
export function submissionGateApplies(
  dataset: { source: string | null; is_exemplar: number | boolean | null },
  anonymous: boolean,
): boolean {
  return anonymous || (dataset.source !== "openneuro" && !dataset.is_exemplar);
}

export async function checkSubmissionGate(args: {
  datasetId: string;
  /** The repository name inside nemarDatasets, or undefined when the dataset has none. */
  repoName: string | undefined;
  /** The installation token, or null when none could be resolved. */
  pat: string | null;
  dataset: { source: string | null; is_exemplar: number | boolean | null };
  anonymous: boolean;
  /** Which caller is asking, for the log line only. */
  caller: "publish-request" | "publish-sweep";
}): Promise<SubmissionGateOutcome> {
  const { datasetId, repoName, pat, anonymous, caller } = args;
  if (!submissionGateApplies(args.dataset, anonymous)) return { kind: "clear" };
  if (!repoName || !pat) return { kind: "unverified", reasons: [NO_REPOSITORY_REASON] };

  let descriptionJson: string | null;
  try {
    descriptionJson = await getFileContent(repoName, "dataset_description.json", pat);
  } catch (err) {
    console.error(
      `[${caller}] submission-minimums check failed for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
    return { kind: "unverified", reasons: [UNREADABLE_REASON] };
  }

  // The README matters for one rule only: an ethics statement, when
  // `EthicsApprovals` lists none. It is read for that and for nothing else, and
  // a README that cannot be read counts as one with no statement. It never
  // takes the Name and Authors rules with it: they are decided by the
  // description alone, and an unreadable README must not be a way past them.
  let readme: string | null = null;
  if (!describesEthicsApproval(descriptionJson)) {
    for (const candidate of README_CANDIDATES) {
      try {
        readme = await getFileContent(repoName, candidate, pat);
      } catch (err) {
        console.error(
          `[${caller}] README read failed for ${datasetId} (${candidate}):`,
          err instanceof Error ? err.message : err,
        );
        readme = null;
        break;
      }
      if (readme !== null) break;
    }
  }

  const reasons = evaluateSubmissionMinimums(descriptionJson, readme, {
    // A blinded deposit must NOT name anybody in Authors; a publication must.
    // The two rules are complements, checked by the same gate, and the second
    // is what orders de-anonymization before publication.
    anonymousRelease: anonymous,
  });
  return reasons.length > 0 ? { kind: "blocked", reasons } : { kind: "clear" };
}
