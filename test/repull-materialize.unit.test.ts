/**
 * The paths a re-pull's materialization may write (ADR 0111, decision 1; epic #1046 phase 6):
 * `isWritablePath`, which refuses a plan path before anything is written. A plan's paths come from
 * git trees, which hold none of these; the check is what makes a plan file that does no harm by
 * construction, rather than by trust.
 */

import { describe, expect, test } from "bun:test";
import { isWritablePath } from "../src/lib/repull/execute/materialize";

describe("isWritablePath", () => {
  test("a relative path inside the tree is writable", () => {
    for (const p of [
      "README.md",
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      "code/run.sh",
      "sub-03/.gitattributes",
      ".bidsignore",
      "a.git/b",
      ".gitignore",
    ]) {
      expect(isWritablePath(p)).toBe(true);
    }
  });

  test("a path outside the tree, into git's own, NEMAR's own, or not one path is refused", () => {
    for (const p of [
      "",
      "/abs/path",
      "../x",
      "a/../../x",
      "a/..",
      "./a",
      "a/./b",
      "a//b",
      "a/",
      ".git/config",
      ".GIT/config",
      "sub/.Git/hooks/post-checkout",
      ".nemar/metadata.json",
      ".github/workflows/x.yml",
      "a\nb",
      "a\rb",
      "a\0b",
    ]) {
      expect(isWritablePath(p)).toBe(false);
    }
  });
});
