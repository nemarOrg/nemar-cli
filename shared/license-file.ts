/**
 * The identification of a dataset's root LICENSE file by a pinned matcher (ADR 0142, section 1).
 *
 * The review job runs ScanCode toolkit over LICENSE in a sandbox, and
 * `scripts/ci/license-file-fact.ts` turns its output into one closed fact, {@link LicenseFileFact}.
 * This file holds the vocabulary and the pins that more than one place needs: the job's script, the
 * workflow (`run-publication-review.yml`, whose scan command must equal {@link SCANCODE_ARGS}), the
 * hashed requirements file (`scripts/ci/scancode-requirements.txt`, compiled for
 * {@link SCANCODE_PYTHON}), and `nemar dataset license-check`, which prints the commands a
 * depositor runs to reproduce the scan ({@link reproduceCommands}). A change to any pin is a
 * reviewed change here and a refresh of the requirements file. This file has no Node or Worker
 * imports.
 */

/**
 * What the job concluded about LICENSE.
 * - `matches`: a conclusive identification that equals the `License` field.
 * - `matches_other`: a conclusive identification of another license than the field's.
 * - `unrecognized`: no conclusive identification, a compound result, or a field that cannot be
 *   compared.
 * - `absent`: no LICENSE file.
 * - `annexed`: LICENSE is an annexed link or pointer, not text in git; it is never scanned.
 * - `unreadable`: it could not be read in full, is not UTF-8, the scan failed, or the matcher is
 *   unavailable.
 */
export const LICENSE_FILE_STATES = [
  "matches",
  "matches_other",
  "unrecognized",
  "absent",
  "annexed",
  "unreadable",
] as const;
export type LicenseFileState = (typeof LICENSE_FILE_STATES)[number];

/** The closed fact a review records about LICENSE. */
export interface LicenseFileFact {
  state: LicenseFileState;
  /** The SPDX identifier of the longest match, or null. */
  spdx: string | null;
  /** Text beyond the license itself; false unless the state is `matches` or `matches_other`. */
  additions: boolean;
  /** ScanCode's file expression when the result was compound, else null. ScanCode's words only. */
  expression: string | null;
}

/** The ScanCode toolkit release the job installs; it also versions its license database. */
export const SCANCODE_TOOLKIT_VERSION = "32.5.0";
/** The SPDX license list version that release maps to (`scancode --version`). */
export const SPDX_LICENSE_LIST_VERSION = "3.27";

/** The matcher version a review records (ADR 0142; ADR 0139 decision 9's record). */
export const LICENSE_MATCHER_VERSION =
  `scancode-${SCANCODE_TOOLKIT_VERSION}+spdx-${SPDX_LICENSE_LIST_VERSION}` as const;

/** The matcher word: the version when the matcher ran as pinned, `unavailable` when it did not. */
export const MATCHER_WORDS = [LICENSE_MATCHER_VERSION, "unavailable"] as const;
export type MatcherWord = (typeof MATCHER_WORDS)[number];

/** The exact CPython the requirements file is compiled for and the job runs ScanCode on. */
export const SCANCODE_PYTHON = "3.12.16";

/** Each scan's own deadline, in seconds, passed to ScanCode. */
export const SCANCODE_TIMEOUT_SECONDS = 120;

/**
 * The scan's options, before `--json <out> <file>`. The workflow runs exactly these, and the
 * depositor's reproduction prints exactly these.
 */
export const SCANCODE_ARGS = [
  "--license",
  "--license-text",
  "--license-text-diagnostics",
  "--copyright",
  "--processes",
  "1",
  "--timeout",
  String(SCANCODE_TIMEOUT_SECONDS),
] as const;

/**
 * The longest match is conclusive only at or above both: its `score` and its `match_coverage`.
 * The lowest real full text measured scores 98.8 (ADR 0142). A change is a reviewed code change.
 */
export const MIN_MATCH_SCORE = 95;
export const MIN_MATCH_COVERAGE = 95;

/** The repository path of the hashed requirements file. */
export const SCANCODE_REQUIREMENTS_PATH = "scripts/ci/scancode-requirements.txt";

/** The published requirements file at a nemar-cli release tag. */
export function scancodeRequirementsUrl(cliVersion: string): string {
  return `https://raw.githubusercontent.com/nemarOrg/nemar-cli/v${cliVersion}/${SCANCODE_REQUIREMENTS_PATH}`;
}

/** One POSIX shell word, single-quoted. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The environment directory the reproduction creates, relative to where it is run. */
export const REPRODUCE_ENV_DIR = "scancode-env";

/**
 * The commands a depositor runs to scan their LICENSE as the review does: the same interpreter,
 * the same hashed package set (at the release tag of the CLI that printed them), and the same
 * options, with the result on standard output.
 */
export function reproduceCommands(licensePath: string, cliVersion: string): string[] {
  return [
    `uv venv --python ${SCANCODE_PYTHON} ${REPRODUCE_ENV_DIR}`,
    `uv pip install --python ${REPRODUCE_ENV_DIR} --require-hashes --no-build -r ${scancodeRequirementsUrl(cliVersion)}`,
    `${REPRODUCE_ENV_DIR}/bin/scancode ${SCANCODE_ARGS.join(" ")} --json - ${shellQuote(licensePath)}`,
  ];
}
