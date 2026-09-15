/**
 * Deterministic submission minimums for native publication requests
 * (#1087, ADR 0026; policy: docs.nemar.org/policies/submission-standards/).
 *
 * Owner decision 2026-08-18: a descriptive Name of at least 25 characters,
 * named non-placeholder Authors, and an ethics approval statement are hard
 * requirements for native submissions. These are the mechanically checkable
 * checks; adequacy beyond them (is the name meaningful, is the README about
 * THIS dataset) stays LLM-judged and advisory per ADR 0014's surviving half.
 *
 * Pure evaluation over file contents so the decision is unit-testable without
 * GitHub; the route fetches the two files and passes them in. OpenNeuro
 * imports and exemplars are exempted by the caller, not here.
 */

export const SUBMISSION_POLICY_URL = "https://docs.nemar.org/policies/submission-standards/";

export const MIN_NAME_LENGTH = 25;

/**
 * Author entries that read as "nobody": empty, n/a-style sentinels, anonymous,
 * bracketed placeholders like "[Unspecified1]" (the MOABB failure mode from
 * #817), or strings containing "unspecified"/"placeholder".
 */
const PLACEHOLDER_AUTHOR =
  /^(n\/?a|none|tbd|todo|unknown|anonymous|-+)$|^\[.*\]$|unspecified|placeholder/i;

/**
 * Ethics statement detection in a README: any of the conventional phrasings.
 * Deliberately generous — the requirement is that SOME ethics statement
 * exists, not that it follows a template; false negatives here send a human
 * to docs, false positives are caught by admin review.
 */
const ETHICS_IN_README =
  /\b(ethic(s|al)?\s+(approval|committee|board|review|statement|clearance|exemption)|IRB|REB|HREC|institutional\s+review\s+board|informed\s+consent|research\s+ethics)\b/i;

/** How a caller narrows the check. */
export interface SubmissionMinimumsOptions {
  /**
   * Accept placeholder Authors (#1408).
   *
   * Set ONLY for an anonymous release, where placeholder Authors are the
   * intended state rather than an incomplete submission: the depositor has
   * blinded their own `dataset_description.json` so the dataset can be read
   * by a double-blind venue without naming them.
   *
   * The exemption is deliberately narrow. Every other minimum still applies --
   * a blinded deposit must still have a descriptive Name and an ethics
   * statement -- and the check runs again, unexempted, on the normal
   * publication request that ends anonymity. That second run is what makes
   * "you cannot publish for real while still blinded" an enforced ordering
   * rather than an instruction.
   */
  allowPlaceholderAuthors?: boolean;
}

/** Reasons are user-facing: each states the failure AND the fix. */
export function evaluateSubmissionMinimums(
  descriptionJson: string | null,
  readme: string | null,
  options: SubmissionMinimumsOptions = {},
): string[] {
  if (descriptionJson === null) {
    return ["dataset_description.json was not found at the dataset root."];
  }

  let desc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(descriptionJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return ["dataset_description.json is not a JSON object."];
    }
    desc = parsed as Record<string, unknown>;
  } catch {
    return ["dataset_description.json is not valid JSON."];
  }

  const reasons: string[] = [];

  const name = typeof desc.Name === "string" ? desc.Name.trim() : "";
  if (name.length < MIN_NAME_LENGTH) {
    reasons.push(
      `Dataset Name must be a descriptive title of at least ${MIN_NAME_LENGTH} characters (currently ${name.length}). If the study is known by a short acronym, expand it with a subtitle, e.g. "ACRO: auditory cortex recordings during natural speech".`,
    );
  }

  const authors = Array.isArray(desc.Authors)
    ? desc.Authors.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map(
        (a) => a.trim(),
      )
    : [];
  const realAuthors = authors.filter((a) => !PLACEHOLDER_AUTHOR.test(a));
  // An anonymous release still requires SOME Authors entry -- an empty array
  // is an incomplete file, not a blinded one -- but not a real name.
  const authorsAcceptable = options.allowPlaceholderAuthors
    ? authors.length > 0
    : realAuthors.length > 0;
  if (!authorsAcceptable) {
    reasons.push(
      options.allowPlaceholderAuthors
        ? "Authors in dataset_description.json must not be empty, even for an anonymous " +
            'release: use a placeholder such as "Anonymous" so the field states that ' +
            "attribution is withheld rather than missing."
        : "Authors in dataset_description.json must name the people responsible for the " +
            "dataset; anonymous submissions and placeholder entries are not accepted.",
    );
  }

  const ethicsApprovals = Array.isArray(desc.EthicsApprovals)
    ? desc.EthicsApprovals.filter((e) => typeof e === "string" && e.trim().length > 0)
    : [];
  const ethicsInReadme = readme !== null && ETHICS_IN_README.test(readme);
  if (ethicsApprovals.length === 0 && !ethicsInReadme) {
    reasons.push(
      "An ethics approval statement is required: fill the EthicsApprovals field of " +
        "dataset_description.json, or add an ethics/IRB statement to the README.",
    );
  }

  return reasons;
}
