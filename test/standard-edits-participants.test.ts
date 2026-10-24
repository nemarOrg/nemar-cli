/**
 * The generated `participants.tsv` at its shared home (`shared/standard-edits/participants.ts`).
 *
 * `test/participants-tsv.unit.test.ts` still imports the rule from
 * `backend/src/services/participants-tsv.ts`, the path the enrichment uses, and passes unedited.
 * This file proves the two paths are one function, so the upstream re-pull's planner (ADR 0111),
 * which recognizes the enrichment's placeholder by calling it, reads the same edit the enrichment
 * commits.
 */

import { describe, expect, test } from "bun:test";
import * as viaBackend from "../backend/src/services/participants-tsv";
import * as shared from "../shared/standard-edits/participants";
import { generatedParticipants } from "../src/lib/repull/edits";

describe("the generated participants.tsv, at its shared path", () => {
  test("is the very functions the enrichment imports", () => {
    expect(viaBackend.enumerateBidsSubjects).toBe(shared.enumerateBidsSubjects);
    expect(viaBackend.buildPlaceholderParticipantsTsv).toBe(shared.buildPlaceholderParticipantsTsv);
    expect(viaBackend.ensureParticipantsTsv).toBe(shared.ensureParticipantsTsv);
  });

  test("the planner's placeholder is what the enrichment would commit for the same tree", () => {
    const paths = ["dataset_description.json", "sub-02/eeg/a.edf", "sub-01/anat/b.nii.gz"];
    const committed = shared.ensureParticipantsTsv(paths.map((path) => ({ path }))).contentToCommit;
    expect(generatedParticipants(paths)?.toString("utf8")).toBe(committed as string);
    // No subject, no file: the enrichment writes none, and the planner explains none.
    expect(shared.ensureParticipantsTsv([{ path: "README" }]).contentToCommit).toBeNull();
    expect(generatedParticipants(["README"])).toBeNull();
  });
});
