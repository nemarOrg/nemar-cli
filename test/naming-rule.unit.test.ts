/**
 * The naming rule (`shared/naming-rule.ts`, ADR 0107): one pure function the CLI, the review job and
 * the Worker all ask, so a title or a dataset name is refused the same way wherever it is checked.
 * The rule's cases are tested in depth through the CLI's own refusals (`pr-text.unit.test.ts`);
 * this file checks that there is ONE copy of it and that the review's question gives the same
 * answers.
 */

import { describe, expect, test } from "bun:test";
import { namingFactsFor } from "../backend/src/services/pr-review-naming";
import type { Bindings } from "../backend/src/types/bindings";
import { textFactsOf } from "../scripts/ci/pr-review";
import type { Listing } from "../scripts/ci/pr-review-evidence";
import {
  AUTHOR_YEAR_PREFIX,
  NAMING_PROBLEMS,
  TEMPLATE_FIELDS,
  findAuthorYearPrefix,
  findTemplateField,
  namingProblemOf,
} from "../shared/naming-rule";
import * as cli from "../src/lib/pr-text";

describe("there is one copy of the rule", () => {
  test("the CLI's exports are the shared rule's own functions and pattern, not copies", () => {
    expect(cli.findAuthorYearPrefix).toBe(findAuthorYearPrefix);
    expect(cli.AUTHOR_YEAR_PREFIX).toBe(AUTHOR_YEAR_PREFIX);
  });

  test("the review job's facts are the rule's answers, on the title and on a changed name", () => {
    const listing = (nameBefore: string | null, nameAfter: string | null) =>
      ({ nameBefore, nameAfter }) as Listing;
    for (const title of ["Lee2019 EEG dataset", "Fix {{title}}", "Add three EEG recordings"]) {
      expect(textFactsOf({ title, body: "x" }, listing("A", "A")).titleProblem, title).toBe(
        namingProblemOf(title),
      );
    }
    expect(textFactsOf({ title: "t", body: "x" }, listing("A", "Lee2019 X")).nameProblem).toBe(
      "author_year",
    );
    // The name is the pull request's problem only when it changes the name.
    expect(
      textFactsOf({ title: "t", body: "x" }, listing("Lee2019 X", "Lee2019 X")).nameProblem,
    ).toBeNull();
    // An empty description, in each form GitHub sends one: null (never written), an empty string,
    // and blanks only. Anything with a word in it is not empty.
    for (const body of [null, undefined, "", "  \n\t "]) {
      expect(
        textFactsOf({ title: "t", body }, listing(null, null)).descriptionEmpty,
        `${body}`,
      ).toBe(true);
    }
    expect(
      textFactsOf({ title: "t", body: "Adds sub-03." }, listing(null, null)).descriptionEmpty,
    ).toBe(false);
  });
});

describe("the Worker asks the same rule of an exempt pull request", () => {
  test("its title fact is the rule's answer; a name it cannot compare is unchecked, never fine", async () => {
    const subject = { datasetId: "nm000460", prNumber: 7, headSha: "a".repeat(40), baseSha: null };
    for (const title of ["Lee2019 EEG dataset", "Fix ${TITLE}", "Add three EEG recordings"]) {
      const facts = await namingFactsFor({} as Bindings, { ...subject, title });
      expect(facts.title, title).toBe(namingProblemOf(title));
      expect(facts.name, title).toBe("unchecked");
    }
  });
});

describe("namingProblemOf", () => {
  test("a name and a year at the start is author_year", () => {
    for (const text of ["Lee2019 EEG dataset", "Lee-2019-EEG", "BNCI2014_001", "lee2019 eeg"]) {
      expect(namingProblemOf(text), text).toBe("author_year");
    }
  });

  test("a naming-template token or an unfilled template field anywhere is template_field", () => {
    for (const text of [
      "Rename dataset to FirstAuthorSurname-year-keyword-paperDOI",
      "Add the paperDOI to the README",
      "Fix {{title}}",
      "Fix ${TITLE}",
      "<your title here>",
      "Update [describe the change]",
    ]) {
      expect(namingProblemOf(text), text).toBe("template_field");
    }
  });

  test("an ordinary title or name is not refused", () => {
    for (const text of [
      "Add three EEG recordings",
      "Release 2019 recordings",
      "2019 release notes",
      "Motor imagery EEG of 52 volunteers",
      "Rename the dataset to Lee-2019-EEG",
      "Fix sub-<label>_task-<label>_eeg.edf naming",
      "",
    ]) {
      expect(namingProblemOf(text), text).toBeNull();
    }
  });

  test("a text that breaks both is author_year, the first of the two the rule asks", () => {
    expect(namingProblemOf("Lee2019 FirstAuthorSurname")).toBe("author_year");
  });

  test("its words are the closed list the report carries", () => {
    expect(NAMING_PROBLEMS).toEqual(["author_year", "template_field"]);
    expect(findTemplateField("Fix {{a}} and ${b}")).toBe("{{a}}");
    expect(findTemplateField("Nothing to fill")).toBeNull();
    expect(TEMPLATE_FIELDS.length).toBe(4);
  });
});
