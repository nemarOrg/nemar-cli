#!/usr/bin/env bun
/**
 * Fleet identifier screening: apply `shared/identifier-scan.ts` to every public dataset.
 *
 * A thin CLI over `scripts/identifier-fleet-lib.ts`, which holds the logic and its tests.
 *
 * **Read-only against NEMAR, anonymous by default.** It lists the public catalog and reads
 * each dataset's latest manifest through the data plane, then reads only the first 256 bytes
 * of every EDF/BDF from the URL the manifest names. Nothing is written to NEMAR, S3 or
 * GitHub.
 *
 * **Request cost.** The Worker serves one `manifest.json` per dataset PLUS every
 * git-tracked file read (participants.tsv, a scans table, the small JSON and text files),
 * since those URLs name the data plane; annexed content (nearly every recording) is read
 * straight from public S3. Every Worker request, across all datasets, shares one low
 * concurrency bound (`--worker-concurrency`, default 6), separate from the direct S3 reads
 * (`--concurrency`, default 24). A dataset the data plane refuses as too large (HTTP 413)
 * falls back, and each fallback routes its reads through the Worker: at most 300 EDF/BDF
 * headers are sampled, evenly across subjects, and the dataset is then marked incomplete.
 *
 * **Optional fallbacks use ambient credentials.** Only for a manifest above the data
 * plane's bound: the raw version manifest through the `aws` CLI (the caller's AWS
 * credentials) and the git tree through the GitHub API (`GITHUB_TOKEN`, else `gh auth
 * token`). A caller without them gets `unchecked` for such a dataset, never a guess.
 *
 * **Tri-state, never fail-open.** A dataset is `clean` only when every EDF/BDF header was
 * read, nothing was flagged, no sampling cap was hit and no recording is in a format the
 * scanner cannot parse; see `classifyDataset`. `incomplete` and its reasons are written to
 * each dataset file and to `_summary.json`.
 *
 * **Output carries no values.** Per-dataset JSON holds kinds, counts, field names and
 * distinct-value COUNTS. A raw header value never leaves memory.
 *
 *   bun run scripts/identifier-fleet-scan.ts --out <dir> [--only nm000348,nm000246]
 *        [--concurrency 24] [--worker-concurrency 6] [--datasets 4] [--force]
 *
 * An existing per-dataset file is kept unless it is `unchecked` or incomplete, so an
 * interrupted or failed run resumes where it stopped; `--force` rescans everything.
 */

import { USAGE, UsageError, createContext, parseCliArgs, runFleet } from "./identifier-fleet-lib";

try {
  const options = parseCliArgs(process.argv.slice(2));
  const ctx = createContext({
    fileConcurrency: options.fileConcurrency,
    workerConcurrency: options.workerConcurrency,
  });
  const summary = await runFleet(ctx, {
    outDir: options.out,
    only: options.only,
    force: options.force,
    datasetConcurrency: options.datasetConcurrency,
    log: (line) => console.error(line),
  });
  console.error(
    [
      ...Object.entries(summary.by_status).map(([status, v]) => `${status}=${v.count}`),
      `incomplete=${summary.incomplete.count}`,
    ].join("  "),
  );
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  throw error;
}
