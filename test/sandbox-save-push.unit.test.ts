/**
 * The sandbox command's save-and-push step, against a real repository.
 *
 * `saveDataset` and `pushToGitHub` report failure in their result rather than by
 * throwing, so the command must read both results: a save that failed closed, or a push
 * that was refused, may not end as "Pushed to GitHub".
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { saveAndPush } from "../src/commands/sandbox";
import { makeScratch, newDatasetRepo, run, writeFile } from "./helpers/annex-repo";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-sandbox-save-push");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

/** A dataset with one tracked-by-git file and a real bare repository as `origin`. */
async function withOrigin(name: string) {
  const dir = await newDatasetRepo(scratch.root, name);
  writeFile(dir, "dataset_description.json", '{"Name":"sandbox"}');
  const origin = join(scratch.root, `${name}-origin.git`);
  expect((await run(["git", "init", "-q", "--bare", origin])).exitCode).toBe(0);
  expect((await run(["git", "remote", "add", "origin", origin], dir)).exitCode).toBe(0);
  return { dir, origin };
}

describe("saveAndPush", () => {
  test("control: a dataset with an origin is saved and pushed", async () => {
    const { dir, origin } = await withOrigin("control");
    await saveAndPush(dir, "Initial sandbox training upload");
    const pushed = await run(["git", "ls-tree", "-r", "--name-only", "main"], origin);
    expect(pushed.stdout).toContain("dataset_description.json");
  });

  test("a push that is refused is reported, not printed as pushed", async () => {
    // Guards the check of pushToGitHub's result. No origin exists, so the push fails and
    // returns `{ success: false }`; awaiting it and moving on printed "Pushed to GitHub".
    const dir = await newDatasetRepo(scratch.root, "no-origin");
    writeFile(dir, "dataset_description.json", '{"Name":"sandbox"}');
    await expect(saveAndPush(dir, "Initial sandbox training upload")).rejects.toThrow(
      /Pushing to GitHub failed/,
    );
  });

  test("a save that fails closed is reported, and nothing is pushed after it", async () => {
    // Guards the check of saveDataset's result. A directory that is not a repository makes
    // the save fail; if the failure were ignored the push would run against whatever is there.
    const notARepo = join(scratch.root, "not-a-repo");
    writeFile(notARepo, "x.json", "{}");
    await expect(saveAndPush(notARepo, "Initial sandbox training upload")).rejects.toThrow(
      /Saving the dataset failed/,
    );
  });
});
