/**
 * Whether a suite that needs git-annex can run, and what happens when it cannot.
 *
 * Locally, a missing git-annex skips the suite with a loud warning. With `CI` set it throws
 * instead: CI installs git-annex, so its absence there is a broken runner, and a skipped suite
 * reports green while asserting nothing.
 */

export interface GateInputs {
  /** Whether `git annex version` ran; probed when omitted. */
  have?: boolean;
  /** The value of `CI`; the environment's when omitted. */
  ci?: string | undefined;
}

export function gitAnnexInstalled(): boolean {
  return (
    Bun.spawnSync(["git", "annex", "version", "--raw"], { stdout: "pipe", stderr: "pipe" })
      .exitCode === 0
  );
}

function ciIsSet(ci: string | undefined): boolean {
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/** True when the suite can run; false (after a warning) when it should skip; throws in CI. */
export function gitAnnexGate(suite: string, inputs: GateInputs = {}): boolean {
  const have = inputs.have ?? gitAnnexInstalled();
  if (have) return true;
  const ci = "ci" in inputs ? inputs.ci : process.env.CI;
  if (ciIsSet(ci)) {
    throw new Error(
      `${suite} needs git-annex and CI is set but it is not installed: refusing to skip.`,
    );
  }
  console.warn(`SKIPPING ${suite}: git-annex is not installed, so it is not exercised.`);
  return false;
}
