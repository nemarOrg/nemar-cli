/**
 * A suite that needs an external tool skips cleanly on a machine without it, and FAILS where
 * `NEMAR_REQUIRE_SCRUB_TOOLS=1`: a skipped suite reports green, and these suites guard tools that
 * delete locked objects and rewrite published history.
 *
 * The variable is set at job level by every CI job that installs the tools: test.yml's
 * unit-pure-shard, integration-dev and scrub-tools-shard, and deploy-backend.yml's test-gate. It
 * is not keyed on `CI`, because nightly-tests.yml and bump-validator.yml run dev's tests with the
 * workflow files on main, which do not install every tool until a release carries them there.
 */

export const REQUIRE_TOOLS = process.env.NEMAR_REQUIRE_SCRUB_TOOLS === "1";

/** `ok` as given, or a thrown error naming the missing tool when tools are required. */
export function toolOrFail(name: string, ok: boolean): boolean {
  if (!ok && REQUIRE_TOOLS) {
    throw new Error(`NEMAR_REQUIRE_SCRUB_TOOLS=1 and a required tool is missing: ${name}`);
  }
  return ok;
}
