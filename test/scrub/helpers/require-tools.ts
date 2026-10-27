/**
 * A suite that needs an external tool skips cleanly on a developer machine without it, and FAILS
 * in CI: wherever `CI` is set (GitHub Actions sets `CI=true` in every job), or where
 * `NEMAR_REQUIRE_SCRUB_TOOLS=1`. A skipped suite reports green, and these suites guard tools that
 * delete locked objects and rewrite published history, so every CI job that runs one installs its
 * tools and names them in a "Tool versions" step before the tests.
 *
 * `CI` is read by the same rule as `gitAnnexGate`'s (test/helpers/git-annex-gate.ts).
 */

import { ciIsSet } from "../../helpers/git-annex-gate";

/** Why a missing tool is a failure in this process, or null where it is a clean skip. */
const REQUIRED_BECAUSE: string | null =
  process.env.NEMAR_REQUIRE_SCRUB_TOOLS === "1"
    ? "NEMAR_REQUIRE_SCRUB_TOOLS=1"
    : ciIsSet(process.env.CI)
      ? "CI is set"
      : null;

export const REQUIRE_TOOLS = REQUIRED_BECAUSE !== null;

/** `ok` as given, or a thrown error naming the missing tool when tools are required. */
export function toolOrFail(name: string, ok: boolean): boolean {
  if (!ok && REQUIRED_BECAUSE !== null) {
    throw new Error(`${REQUIRED_BECAUSE} and a required tool is missing: ${name}`);
  }
  return ok;
}
