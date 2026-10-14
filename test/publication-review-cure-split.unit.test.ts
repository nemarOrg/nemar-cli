/**
 * The cure of a reason, as a terminal prints it, pinned reason by reason (ADR 0102, section 5).
 *
 * Phase 4 splits each cure into text a page can print and the command a terminal runs. The
 * split must not move one byte of what the CLI, the email and the gate's refusal message print,
 * so this block holds the composed cures as test-local literals captured from the tree BEFORE
 * the split, and imports no constant that the split touches. It is never edited by a later
 * commit: that is the proof that the CLI's text did not move.
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 */

import { describe, expect, test } from "bun:test";
import {
  REASONS,
  REASON_CODES,
  type ReasonCode,
  cureOf,
  reasonLine,
} from "../shared/publication-review";

const ID = "nm000123";

const TERM_OVERRIDE =
  "An administrator may approve over it; the approval records the override (--force).";
const TERM_NOT_STARTABLE = `A review starts only for a request that is waiting for its decision. ${TERM_OVERRIDE}`;

/** `notStartable` is absent where it equals `startable`. */
const GOLDEN: Record<string, { startable: string; notStartable?: string }> = {
  request_blocked: {
    startable: "The depositor fixes what blocked it and requests publication again.",
  },
  submission_minimum_failed: {
    startable:
      "The depositor fixes the dataset and requests publication again; a request still waiting for its decision is moved to blocked.",
  },
  identifier_screen_blocks: {
    startable:
      "The depositor removes it and requests publication again, which runs the screen again.",
  },
  identifier_screen_not_run: {
    startable: "An administrator runs the screen again: nemar admin publish screen nm000123.",
  },
  identifier_screen_pending: {
    startable: "Wait for it to report; the review starts when it does.",
  },
  identifier_screen_stale: {
    startable: "An administrator runs the screen again: nemar admin publish screen nm000123.",
  },
  version_kept_after_anonymous_release: {
    startable:
      "The depositor raises Version in dataset_description.json and requests publication again.",
  },
  identifier_screen_needs_acknowledgment: {
    startable:
      'An administrator reads what the screen reported and approves with a recorded reason: nemar admin publish approve nm000123 --acknowledge-identifier-screen "<reason>".',
  },
  question_failed: { startable: `Read any findings and the dataset's text. ${TERM_OVERRIDE}` },
  steering_attempt: {
    startable: `Read the dataset's text yourself; the review's answers cannot be relied on. ${TERM_OVERRIDE}`,
  },
  bids_failed_at_review: {
    startable: `The depositor fixes the validation errors and requests publication again. ${TERM_OVERRIDE}`,
  },
  version_already_released: {
    startable: `The depositor raises Version in dataset_description.json. ${TERM_OVERRIDE}`,
  },
  version_malformed: { startable: `The depositor corrects Version. ${TERM_OVERRIDE}` },
  stored_verdict_fail: {
    startable: `Read the review's record: nemar admin publish show nm000123. ${TERM_OVERRIDE}`,
  },
  review_not_started: {
    startable: `Start it: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_running: {
    startable: `Wait for it to report; it usually takes minutes. ${TERM_OVERRIDE}`,
  },
  review_did_not_report: {
    startable: `Start it again: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_limit_reached: {
    startable: `Start it later: nemar admin publish start nm000123; an administrator's start is held by the platform's limit only. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  review_could_not_run: {
    startable: `Once the cause is fixed, start it again: nemar admin publish start nm000123. ${TERM_OVERRIDE}`,
    notStartable: TERM_NOT_STARTABLE,
  },
  text_withheld: { startable: `Read the withheld documents yourself. ${TERM_OVERRIDE}` },
  question_unknown: { startable: `Answer it yourself from the dataset. ${TERM_OVERRIDE}` },
  bids_unconcluded_at_review: {
    startable: `Check the validation run of that commit. ${TERM_OVERRIDE}`,
  },
  version_missing: {
    startable: `Confirm that 1.0.0 is right, or have the depositor set Version. ${TERM_OVERRIDE}`,
  },
  doi_state_unexpected: { startable: `Check the DOI record before approving. ${TERM_OVERRIDE}` },
};

/** The terminal's cure for a code, for the stated standing of the request. */
function expected(code: string, startable: boolean): string {
  const g = GOLDEN[code];
  if (g === undefined) throw new Error(`no golden entry for ${code}`);
  return startable ? g.startable : (g.notStartable ?? g.startable);
}

describe("the terminal's cure is pinned for every reason code", () => {
  test("the golden names exactly the reason codes, so a new code needs an entry", () => {
    expect(Object.keys(GOLDEN)).toEqual([...REASON_CODES]);
  });

  test("cureOf returns the pinned text for every code, startable or not", () => {
    let visited = 0;
    for (const code of REASON_CODES) {
      for (const startable of [true, false]) {
        expect(cureOf(code, ID, startable)).toBe(expected(code, startable));
        visited++;
      }
    }
    expect(visited).toBe(REASON_CODES.length * 2);
  });

  test("reasonLine is the sentence, a space and the pinned cure", () => {
    for (const code of REASON_CODES) {
      for (const startable of [true, false]) {
        const line = reasonLine({ code, detail: null }, ID, null, startable);
        expect(line).toBe(`${REASONS[code].sentence} ${expected(code, startable)}`);
      }
    }
  });

  test("a malformed id keeps the placeholder and is never quoted, for every code", () => {
    for (const code of REASON_CODES as readonly ReasonCode[]) {
      for (const bad of ["x y", "", "nm00012"]) {
        for (const startable of [true, false]) {
          const text = cureOf(code, bad, startable);
          const want = expected(code, startable).replaceAll(ID, "<dataset>");
          expect(text).toBe(want);
          if (bad !== "") expect(text).not.toContain(bad);
        }
      }
    }
  });
});
