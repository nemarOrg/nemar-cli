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

  test("a naming-template token is refused beside a letter, a digit or an underscore, in any case", () => {
    // `_` and digits are word characters, so a pattern bounded by `\b` passes every one of these:
    // a template is filled in by joining its parts, not by spacing them out.
    for (const text of [
      "FirstAuthorSurname_year_keyword_paperDOI",
      "Rename to Lee_paperDOI",
      "paperDOI10.1234",
      "xFirstAuthorSurnamex",
      "Rename to firstauthorsurname-2019",
      "Add the PAPERDOI",
      "PaperDoi",
    ]) {
      expect(namingProblemOf(text), text).toBe("template_field");
    }
    // The field is reported as it appears, whatever its case and whatever it is joined to.
    expect(findTemplateField("Lee_firstAuthorSURNAME_2019")).toBe("firstAuthorSURNAME");
    expect(findTemplateField("paperDOI10.1234")).toBe("paperDOI");
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

  test("what no reader sees before the text does not hide a name and a year", () => {
    // The review's models read these as spaces and a person sees nothing, so a title that opens
    // with one is a title that opens with the name. `String.prototype.trimStart` skips only the
    // first two of them.
    const invisible: Array<[string, string]> = [
      ["a zero-width space", "\u200b"],
      ["a soft hyphen", "\u00ad"],
      ["a byte-order mark", "\ufeff"],
      ["a word joiner", "\u2060"],
      ["a left-to-right mark", "\u200e"],
      ["a bell, a control character", "\u0007"],
      ["a tag space, a format character outside the basic plane", "\u{e0020}"],
      ["a mix of blanks and invisible characters", " \u200b\u00ad\t\ufeff "],
    ];
    for (const [what, lead] of invisible) {
      expect(namingProblemOf(`${lead}Lee2019 EEG dataset`), what).toBe("author_year");
      expect(findAuthorYearPrefix(`${lead}Lee-2019-EEG`), what).toBe("Lee-2019");
      // The same lead before an ordinary title changes nothing about it.
      expect(namingProblemOf(`${lead}Add three EEG recordings`), what).toBeNull();
      expect(namingProblemOf(`${lead}2019 release notes`), what).toBeNull();
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
