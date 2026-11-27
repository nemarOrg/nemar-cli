/**
 * The web-button approval calls `admin dataset publish approve` directly.
 *
 * nemarDatasets/.github `.github/workflows/approve-publication.yml` (the workflow is not in this
 * repository) runs `nemar admin dataset publish approve "$DATASET_ID" --yes`, adding `--resume`
 * on a resumed run. Until #2348 it probed `nemar admin repo --help` and fell back to `admin
 * publish approve` for a CLI older than 0.10.34; both install tags carry the new path now, so the
 * probe and the fallback are gone. If the path or either flag ever moves, every web-button
 * approval fails, and this test is where that shows.
 *
 * The workflow's argument line is copied verbatim below. If the workflow changes, copy the new
 * line here.
 *
 * CI TIER: unit-pure. Hermetic: the CLI is spawned with an environment built from nothing;
 * `--help` makes no request, and the account's apiUrl is a recording stand-in that would show one.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

/** approve-publication.yml, the argument line, verbatim. */
const WORKFLOW_ARGS = 'args=(admin dataset publish approve "$DATASET_ID" --yes)';

/** The command path the workflow calls, read from its argument line. */
const workflowPath = (): string[] => {
  const m = WORKFLOW_ARGS.match(/^args=\(([^"]+) "\$DATASET_ID"/);
  if (!m) throw new Error(`unreadable argument line: ${WORKFLOW_ARGS}`);
  return m[1].trim().split(/\s+/);
};

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

describe("approve-publication.yml's approve path", () => {
  test("the path it calls is the live command, and takes --yes and --resume", async () => {
    const path = workflowPath();
    expect(path).toEqual(["admin", "dataset", "publish", "approve"]);
    const live = await cli.run([...path, "--help"]);
    expect(live.exitCode).toBe(0);
    // Commander answers --help under an unknown word with the parent's help and exit 0, so the
    // exit code alone cannot tell; the usage line names the command that answered.
    expect(live.stdout).toContain(
      "Usage: nemar admin dataset publish approve [options] <dataset-id>",
    );
    expect(live.stdout).toContain("--yes");
    expect(live.stdout).toContain("--resume");
    expect(cli.requests).toEqual([]);
  });

  test("the fallback the workflow no longer has is a stub that exits 1", async () => {
    // Why the fallback was dead and must not come back: the old path runs nothing.
    const dead = await cli.run(["admin", "publish", "approve", "nm000999", "--yes"]);
    expect(dead.exitCode).toBe(1);
    expect(dead.stderr).toContain("moved to 'nemar admin dataset publish'");
    expect(cli.requests).toEqual([]);
  });
});
