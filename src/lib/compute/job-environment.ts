/**
 * What a running compute job sees, in one place (issue #2092).
 *
 * The CLI help for `submit`, `results` and `logs`, the dry-run summary and the public page
 * `docs.nemar.org/cli/guides/compute-job-environment` all say the same paths, so they are
 * declared here once and the help text is built from them.
 *
 * These are the paths the launcher uses (`/work`, `/work/outputs`, `/code`, `/data/<id>`) and the
 * one variable it sets (`NEMAR_OUT`). Anything listed in `JOB_ENVIRONMENT_NOT_PROMISED` is not
 * known yet, because no job has run on a real node; the docs page is marked as under development
 * and is revised after the first one.
 */

import { JOB_ENV_ALLOWLIST, LAUNCHER_ENV } from "../../../shared/contract/compute.js";

export const JOB_PATHS = {
  /** The working directory; writable, and only `outputs` under it is returned. */
  work: "/work",
  /** The unpacked code; read-only. */
  code: "/code",
  /** The root of staged datasets; each is read-only at `/data/<dataset id>`. */
  data: "/data",
  /** Where results must be written; the same directory as `$NEMAR_OUT`. */
  outputs: "/work/outputs",
} as const;

/** The variable the job reads to find the output directory. */
export const JOB_OUT_ENV = LAUNCHER_ENV.OUT;

/** Variables a person may set with `--env`: the contract's own allowlist, never a copy. */
export const JOB_SETTABLE_ENV = JOB_ENV_ALLOWLIST;

/** What the docs page and the help deliberately do not promise yet. */
export const JOB_ENVIRONMENT_NOT_PROMISED = [
  "network access from the job",
  "HOME, PATH and LANG",
  "free disk space in /work or /tmp",
  "more than one node",
] as const;

export const JOB_ENVIRONMENT_DOCS_URL =
  "https://docs.nemar.org/cli/guides/compute-job-environment/";

/** One line for the dry-run summary. */
export const JOB_PATHS_SUMMARY = `code ${JOB_PATHS.code} (read-only), datasets ${JOB_PATHS.data}/<id> (read-only), results ${JOB_PATHS.outputs} (\$${JOB_OUT_ENV})`;

/** The block `nemar compute submit --help-all` prints; the same facts as the docs page. */
export const JOB_ENVIRONMENT_HELP = `Job environment (under development; see ${JOB_ENVIRONMENT_DOCS_URL}):
  Your job runs in ${JOB_PATHS.work}, which is writable. Your code is at ${JOB_PATHS.code}, read-only. Each dataset
  you name is at ${JOB_PATHS.data}/<id>, read-only, with no version in the path and its files at their dataset paths.
  Results: only regular files under \$${JOB_OUT_ENV} (${JOB_PATHS.outputs}, created before your code starts) come back.
  Anything else in ${JOB_PATHS.work} or /tmp is discarded when the job ends, and a symbolic link or special file
  under ${JOB_PATHS.work} is deleted, so write results to ${JOB_PATHS.outputs} and not to a relative path. A job whose
  results pass the limits (currently 5,000 files and 20 GiB per job) ends as result_upload_failed.
  Environment: the job sees only \$${JOB_OUT_ENV} and what you set with --env, which accepts only
  ${JOB_SETTABLE_ENV.join(", ")}.
  Not promised yet: ${JOB_ENVIRONMENT_NOT_PROMISED.join("; ")}.`;
