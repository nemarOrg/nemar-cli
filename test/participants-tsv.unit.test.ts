/**
 * Unit tests for the auto-participants.tsv helpers.
 *
 * The helpers are pure (no I/O) so this is the right test surface --
 * subject enumeration from a tree listing + the TSV formatter +
 * the "should we commit" decision rule. The commit step itself is
 * tested implicitly by the existing commitEnrichmentWithBidsignore
 * tests; what's new in this PR is whether the right inputs reach it.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPlaceholderParticipantsTsv,
  ensureParticipantsTsv,
  enumerateBidsSubjects,
} from "../backend/src/services/participants-tsv";

function tree(...paths: string[]): Array<{ path: string }> {
  return paths.map((path) => ({ path }));
}

describe("enumerateBidsSubjects", () => {
  test("finds sub-* directories from file paths under them", () => {
    expect(
      enumerateBidsSubjects(
        tree(
          "dataset_description.json",
          "sub-01/eeg/sub-01_task-rest_eeg.set",
          "sub-02/eeg/sub-02_task-rest_eeg.set",
          "sub-02/anat/sub-02_T1w.nii.gz",
        ),
      ),
    ).toEqual(["sub-01", "sub-02"]);
  });

  test("finds sub-* directory entries themselves (when tree lists dirs)", () => {
    // GitHub's recursive tree returns blob entries; some callers also pass
    // tree entries with the directory path. The regex matches both.
    expect(enumerateBidsSubjects(tree("sub-01", "sub-02"))).toEqual(["sub-01", "sub-02"]);
  });

  test("dedupes when the same subject has many files", () => {
    const t = tree(
      ...Array.from({ length: 50 }, (_, i) => `sub-01/eeg/sub-01_run-${i + 1}_eeg.set`),
    );
    expect(enumerateBidsSubjects(t)).toEqual(["sub-01"]);
  });

  test("sorts subjects naturally (lexicographic on the id including prefix)", () => {
    expect(
      enumerateBidsSubjects(
        tree(
          "sub-10/eeg/x",
          "sub-02/eeg/x",
          "sub-01/eeg/x",
          "sub-21/eeg/x",
        ),
      ),
    ).toEqual(["sub-01", "sub-02", "sub-10", "sub-21"]);
  });

  test("ignores derivatives/sourcedata/code paths that don't start with sub-", () => {
    expect(
      enumerateBidsSubjects(
        tree(
          "derivatives/sub-01/anat.nii",
          "sourcedata/raw.dat",
          "code/preprocess.py",
          "sub-01/eeg/x",
        ),
      ),
    ).toEqual(["sub-01"]);
  });

  test("returns empty array on a tree with no subjects", () => {
    expect(enumerateBidsSubjects(tree("README.md", "dataset_description.json"))).toEqual([]);
  });

  test("supports alphanumeric subject ids (BIDS allows them)", () => {
    expect(
      enumerateBidsSubjects(tree("sub-NDARAC462DZH/eeg/x", "sub-NDARAE866UVF/eeg/x")),
    ).toEqual(["sub-NDARAC462DZH", "sub-NDARAE866UVF"]);
  });

  test("rejects hyphenated-label subject ids (non-conformant per BIDS spec)", () => {
    // BIDS defines `<label>` as ^[0-9a-zA-Z]+$ -- no hyphens. We intentionally
    // skip such datasets rather than fabricate a partial participants.tsv;
    // if you're hitting this, the upstream is already non-conformant and
    // needs to fix labels first. Pinning the behavior so a future regex
    // tweak can't silently start matching them.
    expect(
      enumerateBidsSubjects(tree("sub-PD-01/eeg/x", "sub-PD-02/eeg/x")),
    ).toEqual([]);
  });
});

describe("buildPlaceholderParticipantsTsv", () => {
  test("emits header + one row per subject with n/a placeholders", () => {
    expect(buildPlaceholderParticipantsTsv(["sub-01", "sub-02"])).toBe(
      "participant_id\tage\tsex\nsub-01\tn/a\tn/a\nsub-02\tn/a\tn/a\n",
    );
  });

  test("preserves caller-supplied subject order", () => {
    expect(buildPlaceholderParticipantsTsv(["sub-Z", "sub-A"])).toBe(
      "participant_id\tage\tsex\nsub-Z\tn/a\tn/a\nsub-A\tn/a\tn/a\n",
    );
  });

  test("refuses to emit a header-only TSV", () => {
    // A header-only file would surface as subject_count=0 in the catalog,
    // which is more misleading than null.
    expect(() => buildPlaceholderParticipantsTsv([])).toThrow(/header-only/);
  });
});

describe("ensureParticipantsTsv", () => {
  test("returns null content when participants.tsv already exists", () => {
    const out = ensureParticipantsTsv(
      tree("participants.tsv", "sub-01/eeg/x", "sub-02/eeg/x"),
    );
    expect(out.alreadyPresent).toBe(true);
    expect(out.contentToCommit).toBeNull();
    expect(out.subjects).toEqual(["sub-01", "sub-02"]);
  });

  test("generates a placeholder when missing AND subjects exist", () => {
    const out = ensureParticipantsTsv(
      tree("dataset_description.json", "sub-01/eeg/x", "sub-02/eeg/x"),
    );
    expect(out.alreadyPresent).toBe(false);
    expect(out.subjects).toEqual(["sub-01", "sub-02"]);
    expect(out.contentToCommit).toBe(
      "participant_id\tage\tsex\nsub-01\tn/a\tn/a\nsub-02\tn/a\tn/a\n",
    );
  });

  test("returns null content when no subjects exist (not a fix-up case)", () => {
    const out = ensureParticipantsTsv(tree("README.md", "dataset_description.json"));
    expect(out.alreadyPresent).toBe(false);
    expect(out.subjects).toEqual([]);
    expect(out.contentToCommit).toBeNull();
  });

  test("on005262-shape (upstream lacks participants.tsv, has sub-0 .. sub-11)", () => {
    const paths = [
      "dataset_description.json",
      "README.md",
      ...Array.from({ length: 12 }, (_, i) => `sub-${i}/eeg/sub-${i}_task-x_eeg.set`),
    ];
    const out = ensureParticipantsTsv(tree(...paths));
    expect(out.alreadyPresent).toBe(false);
    expect(out.subjects.length).toBe(12);
    expect(out.contentToCommit).toContain("participant_id\tage\tsex");
    expect(out.contentToCommit).toContain("sub-0\tn/a\tn/a");
    expect(out.contentToCommit).toContain("sub-11\tn/a\tn/a");
  });
});
