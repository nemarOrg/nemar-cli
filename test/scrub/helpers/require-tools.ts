/**
 * A suite that needs an external tool skips cleanly on a developer machine without it, and FAILS
 * in CI, where `NEMAR_REQUIRE_SCRUB_TOOLS=1`: a skipped suite reports green, and these suites
 * guard tools that delete locked objects and rewrite published history.
 */

export const REQUIRE_TOOLS = process.env.NEMAR_REQUIRE_SCRUB_TOOLS === "1";

/** `ok` as given, or a thrown error naming the missing tool when tools are required. */
export function toolOrFail(name: string, ok: boolean): boolean {
  if (!ok && REQUIRE_TOOLS) {
    throw new Error(`NEMAR_REQUIRE_SCRUB_TOOLS=1 and a required tool is missing: ${name}`);
  }
  return ok;
}
