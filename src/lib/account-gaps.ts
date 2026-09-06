/**
 * How the terminal prints what an account is still missing (#1268, ADR 0045).
 *
 * Every sentence here comes out of `shared/contract/account-copy.ts` through
 * `shared/contract/profile-gaps.ts`, the pair the website transcribes — so
 * `nemar auth status`, `nemar auth profile`, the upload preflight, a refused
 * upload-access request and the dashboard all say one thing about a missing
 * GitHub handle rather than five near-misses. This module owns only the
 * terminal's part: indentation, colour, and which list goes under which
 * heading.
 *
 * NOTHING IS DERIVED HERE. The list of gaps is the backend's (`profile_gaps` on
 * `/users/me`), because the rule that decides it is the same rule an
 * upload-access request is refused by, and a CLI that recomputed it locally
 * would be the second implementation phase 8 exists to delete. What the CLI
 * adds is the one gap the backend has no business knowing about: sandbox
 * training, which exists in this program and nowhere else.
 */

import chalk from "chalk";
import { ACCOUNT_COPY } from "../../shared/contract/account-copy.js";
import {
  type ProfileGapWireEntry,
  type ResolvedProfileGap,
  describeProfileGap,
  describeSandboxGap,
  profileGapTail,
  resolveWireProfileGaps,
} from "../../shared/contract/profile-gaps.js";

/** The heading both `auth status` and `auth profile` put the list under. */
export const PROFILE_SECTION_TITLE = ACCOUNT_COPY["cli.gaps.section.title"];

/**
 * What the CLI knows about this account's gaps.
 *
 * `undefined` gaps and an EMPTY list are different answers and are printed
 * differently: an absent list means nobody has asked the backend yet (or the
 * backend predates phase 8), while an empty one is the backend saying nothing
 * is missing. Collapsing them would tell someone their profile is complete on
 * the strength of never having looked.
 */
export interface ProfileGapView {
  /** The wire entries, or undefined when the list could not be read.
   *
   *  Typed loosely on purpose, and typed loosely ONCE: the same view is built
   *  from a live `profile_gaps` and from the config cache, where the arrays
   *  round-trip through JSON and a vocabulary this build predates must survive
   *  rather than fail to parse. `ProfileGapWireEntry` is that shape's single
   *  declaration and `resolveWireProfileGaps` does the narrowing. */
  gaps: readonly ProfileGapWireEntry[] | undefined;
  /** Moves the two name halves' "set it in" to the ORCID record. */
  orcidVerified?: boolean;
  /**
   * Sandbox training, the CLI-only step. `undefined` leaves it out entirely
   * rather than assuming it is outstanding — an account that has never been
   * refreshed has no cached answer, and inventing one would print a hard gate
   * at somebody who has already passed it.
   */
  sandboxCompleted?: boolean;
  /** Printed instead of the list when `gaps` is undefined. */
  unknownReason?: string;
}

/** Every line the block prints, without the heading — exported so a test can
 *  assert the sentences without parsing terminal output. */
export function profileGapLines(view: ProfileGapView): string[] {
  if (view.gaps === undefined) {
    return [view.unknownReason ?? ACCOUNT_COPY["cli.gaps.unknown"]];
  }
  const lines = resolveWireProfileGaps(view.gaps, { orcidVerified: view.orcidVerified }).map(
    describeProfileGap,
  );
  // Last, and deliberately so: everything above also blocks the person on the
  // website, and this one is a step they take here. Nothing they can fix
  // elsewhere goes below something only a terminal can finish.
  if (view.sandboxCompleted === false) lines.push(describeSandboxGap());
  return lines.length > 0 ? lines : [ACCOUNT_COPY["gaps.none"]];
}

/** True when the view has an answer and the answer is "nothing outstanding". */
function nothingOutstanding(view: ProfileGapView): boolean {
  const lines = profileGapLines(view);
  return lines.length === 1 && lines[0] === ACCOUNT_COPY["gaps.none"];
}

/**
 * Print the "Profile" block: a heading, then one line per gap.
 *
 * `nemar auth status` and `nemar auth profile` call this with the same view and
 * get the same block; the only difference between them is where the list came
 * from — a cached refresh, versus the fetch `profile` always does.
 *
 * Only actual gaps are highlighted. "Nothing outstanding" and "not checked" are
 * statements about the absence of work and are dimmed, because a yellow line
 * saying nothing is wrong is how a person learns to stop reading yellow lines.
 */
export function printProfileGaps(view: ProfileGapView): void {
  const quiet = view.gaps === undefined || nothingOutstanding(view);
  console.log();
  console.log(chalk.bold(PROFILE_SECTION_TITLE));
  for (const line of profileGapLines(view)) {
    console.log(`  ${quiet ? chalk.dim(line) : chalk.yellow(line)}`);
  }
}

/**
 * Print a bare gap list under a caller-supplied heading — a refused
 * upload-access request, or the upload preflight.
 *
 * The heading is one of `gaps.request.title` / `gaps.upload.title`, and the
 * lines are the same sentences the block above prints, with the label picked
 * out so a list of six is scannable. That is what makes a refusal and a status
 * nudge read alike rather than merely mean alike.
 */
export function printGapList(
  title: string,
  gaps: readonly ResolvedProfileGap[],
  options: { indent?: string } = {},
): void {
  const indent = options.indent ?? "  ";
  console.log();
  console.log(`${indent}${title}`);
  for (const gap of gaps) {
    console.log(`${indent}  ${chalk.yellow(gap.label)} ${profileGapTail(gap)}`);
  }
}
