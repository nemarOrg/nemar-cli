#!/usr/bin/env bun
/**
 * Publication-time identifier screen, run by `run-identifier-screen.yml` in `nemarDatasets/.github`
 * (ADR 0086). A thin CLI over `scripts/identifier-screen-ci-lib.ts`, which holds the logic and its
 * tests.
 *
 * Environment:
 *   DATASET_ID          nm or on id; an xx (sandbox) dataset is refused
 *   REF                 branch, tag or commit to screen (default main)
 *   REQUEST_ID          publication_requests.id echoed in the callback (default 0)
 *   CALLBACK_URL        where to POST the report; empty means a manual run, no callback
 *   CALLBACK_TOKEN      sent as X-Webhook-Token
 *   GH_TOKEN            token for the clone of the dataset repository
 *   S3_BUCKET           default nemar
 *   AWS_REGION          default us-east-2
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN   read access to the bucket
 *   WORKFLOW_RUN_ID     echoed in the callback (default GITHUB_RUN_ID, else 0)
 *   SCREEN_DEADLINE_MS  total time allowed, default 35 minutes
 *
 * Flags, for tests and local runs: --out <file> writes the report, --no-callback skips the
 * POST, and --clone-origin, --s3-endpoint, --concurrency, --callback-backoff-ms, --blob-limit
 * replace the GitHub repository, AWS, and three tuning values. The workflow sets none of them.
 *
 * Exit status: 0 when the report was delivered (or no callback was asked for), 1 when it could
 * not be delivered, 2 for a bad environment or command line.
 *
 * Output is counts and fixed words only. The workflow log is public; see the library header.
 */

import { ScreenUsageError, parseScreenConfig, runScreen } from "./identifier-screen-ci-lib";

let config: ReturnType<typeof parseScreenConfig>;
try {
  config = parseScreenConfig(process.argv.slice(2), process.env);
} catch (error) {
  // The code is a fixed word; the input is never echoed.
  const code = error instanceof ScreenUsageError ? error.code : "unknown";
  console.error(`identifier-screen: bad configuration (${code})`);
  process.exit(2);
}

const outcome = await runScreen(config, { log: (line) => console.log(line) });
process.exit(outcome.delivered === false ? 1 : 0);
