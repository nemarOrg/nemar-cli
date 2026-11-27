/**
 * The decision card as `nemar admin dataset publish show` prints it (ADR 0142, decision 4): a
 * golden capture of the lines for a fixture card built by the Worker's real builder, the card's
 * place at the top of `show`, hostile text reduced by `plain()`, and a card this CLI does not read
 * costing only the card.
 *
 * Mutation check (applied, run, restored from a copy): drop `plain()` from `field()`, which prints
 * every field of the dataset's own words ("hostile text in the dataset's fields is printed plain"),
 * turns red.
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { buildDecisionCard } from "../backend/src/services/decision-card";
import { decisionCardLines } from "../src/lib/decision-card-display";
import { GATE_CLEAR, ID, SNAPSHOT, detailOf, reasonView } from "./helpers/decision-card-fixtures";

const ESC = String.fromCharCode(0x1b);
/** The right-to-left override, spelled by code point so the source holds no bidirectional character. */
const RLO = String.fromCharCode(0x202e);

let colors: typeof chalk.level;
beforeAll(() => {
  colors = chalk.level;
  chalk.level = 0;
});
afterAll(() => {
  chalk.level = colors;
});

/** A card with something in every part: a red license, a model finding, a fresher lineage. */
function fixtureCard() {
  const detail = detailOf(
    { reasons: [reasonView("question_unknown"), reasonView("license_lineage_unconfirmed")] },
    {
      license_file: {
        state: "matches_other",
        spdx: "CC-BY-NC-4.0",
        additions: true,
        expression: null,
      },
      lineage: { outcome: "unresolved", credited: false, resolved_at: "2026-11-20 09:00:00" },
      placeholder_authors: 1,
    },
    {
      questions: {
        complete_and_honest: "pass",
        meets_standards: "pass",
        authors_and_license: "unknown",
        name_adequate: "pass",
      },
      fact_notes: [
        {
          question: "authors_and_license",
          fact: "license_file_differs",
          result: "unknown",
          text: "The LICENSE file names another license than the License field.",
        },
      ],
      findings: [
        {
          question: "complete_and_honest",
          severity: "note",
          code: "other",
          label: "other",
          document: "readme",
          document_label: "README",
          note: "The README could say more about the montage.",
        },
      ],
    },
  );
  return buildDecisionCard({
    detail,
    freshCovered: false,
    gate: GATE_CLEAR,
    autoDenyState: "disagreed",
    snapshot: SNAPSHOT,
    current: null,
    freshLineage: {
      outcome: "compatible",
      credited: false,
      resolved_at: "2026-11-27T13:00:00.000Z",
      declared_licenses: ["10.5281/zenodo.123456: Creative Commons Attribution 4.0 International"],
    },
  });
}

const GOLDEN = `Decision card
  Next: Review the request again: the upstream data's license resolves now, and the review read it unresolved.
        nemar admin dataset publish start ${ID} --again
  License: RED  The LICENSE file names another license than the License field.
    Field        CC-BY-4.0
    LICENSE      matches_other CC-BY-NC-4.0, with text beyond the license
    Matcher      scancode-32.5.0+spdx-3.27
    Lineage (review, resolved 2026-11-20 09:00:00): unresolved
    Lineage (now, resolved 2026-11-27T13:00:00.000Z): compatible
      Declared (as the source's registry declares it): 10.5281/zenodo.123456: Creative Commons Attribution 4.0 International
    Also: The upstream data's license could not be read.
  The dataset's own words (written by the depositor), as reviewed:
   .nemar/metadata.json:
    Title        Resting EEG in sixty adults
    Description  Eyes-open and eyes-closed resting EEG.
    License      CC-BY-4.0
    Creators     Ada Lovelace
    Keywords     EEG; resting state
    Funding      NIH (R01-1)
   dataset_description.json:
    Name         Resting EEG
    License      CC-BY-4.0
    Authors      Ada Lovelace; TBD
    Version      1.0.0
  Authors: 2, 1 placeholder (flagged: TBD)
  Questions:
    complete_and_honest  pass     [note] other
    meets_standards      pass
    authors_and_license  unknown  [fact] The LICENSE file names another license than the License field.
    name_adequate        pass
  Identifier screen: Identifier screen: clear
  Automatic denial: Automated review disagreed: the confirming run did not confirm the first run's fail, so a person decides.`;

describe("the decision card in show", () => {
  test("prints the fixture card exactly (golden)", () => {
    expect(decisionCardLines(fixtureCard()).join("\n")).toBe(GOLDEN);
  });

  test("a card that is not as reviewed says so under the heading", () => {
    const card = buildDecisionCard({
      detail: detailOf({ review: null, screen_gate: "clear" }),
      freshCovered: false,
      gate: GATE_CLEAR,
      autoDenyState: null,
      snapshot: null,
      current: null,
      freshLineage: null,
    });
    const lines = decisionCardLines(card);
    expect(lines).toContain("  The dataset's own words (written by the depositor):");
    expect(lines).toContain(
      "    Not as reviewed: no review has read these fields yet, so these are the fields NEMAR holds now.",
    );
    expect(lines).toContain("    (none on record)");
    expect(lines).toContain("    (not read)");
  });

  test("hostile text in the dataset's fields is printed plain", () => {
    const card = fixtureCard();
    const hostile = {
      ...card,
      metadata: {
        ...card.metadata,
        enrichment: card.metadata.enrichment && {
          ...card.metadata.enrichment,
          title: `Evil${ESC}[2J${RLO} title`,
        },
      },
    };
    const text = decisionCardLines(hostile).join("\n");
    expect(text).toContain("    Title        Evil[2J title");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(RLO);
  });

  test("a model's note is not printed in the card: the review's findings print it once", () => {
    const text = decisionCardLines(fixtureCard()).join("\n");
    expect(text).not.toContain("The README could say more about the montage.");
  });

  test("a card this CLI does not read costs only the card", () => {
    for (const odd of [undefined, null, {}, { v: 2 }, "card", { ...fixtureCard(), questions: 3 }]) {
      expect(decisionCardLines(odd)).toEqual([]);
    }
  });
});
