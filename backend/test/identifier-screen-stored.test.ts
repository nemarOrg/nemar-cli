/**
 * What moved out of `identifier-screen.ts` so the publication review's view can read the screen
 * without importing it (ADR 0102, Phase 2): `screenView` and its two companions into
 * `identifier-screen-stored.ts`, and `hasStartedPublishing` with the steps it reads into
 * `shared/publication-steps.ts`.
 *
 * A move is only safe if every importer still gets the very same function, and if the function
 * still does exactly what it did. So this file pins the identity of each re-export, and the
 * behavior of each moved function over the inputs a stored row can hold.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATASET_STATUSES,
  describeScreen,
  parseScreenReport,
} from "../../shared/identifier-screen-report";
import * as steps from "../../shared/publication-steps";
import * as screen from "../src/services/identifier-screen";
import * as stored from "../src/services/identifier-screen-stored";
import { screenReportBodyFor } from "./helpers/publication-review";

describe("the re-exports are the same functions, not copies", () => {
  test("identifier-screen.ts hands every importer the stored module's functions", () => {
    expect(screen.screenView).toBe(stored.screenView);
    expect(screen.EXEMPT_SCREEN_DESCRIPTION).toBe(stored.EXEMPT_SCREEN_DESCRIPTION);
    expect(screen.isScreenExempt).toBe(stored.isScreenExempt);
    expect(screen.readStoredReport).toBe(stored.readStoredReport);
    expect(screen.readStoredState).toBe(stored.readStoredState);
  });

  test("and the shared module's: whether an approval has started publishing, and the steps before it", () => {
    expect(screen.hasStartedPublishing).toBe(steps.hasStartedPublishing);
    expect(screen.PRE_PUBLICATION_STEPS).toBe(steps.PRE_PUBLICATION_STEPS);
  });

  test("the review's view imports the moved code from where it now lives, never from the screen", () => {
    const view = readFileSync(
      join(import.meta.dir, "../src/services/publication-review-view.ts"),
      "utf8",
    );
    // `identifier-screen.ts` imports the view; an import back would be a cycle.
    expect(view).not.toMatch(/from "\.\/identifier-screen(\.js)?"/);
    expect(view).toContain('from "./identifier-screen-stored.js"');
    expect(view).toContain('from "../../../shared/publication-steps.js"');
  });
});

describe("hasStartedPublishing", () => {
  test("is true once a step outside the validation-only ones has completed", () => {
    // The two steps before the first mutation, written out here.
    expect([...steps.PRE_PUBLICATION_STEPS]).toEqual(["ci_check", "enrichment_check"]);
    expect(steps.PUBLICATION_STEPS.indexOf("s3_public_read")).toBe(2);
    for (const step of steps.PUBLICATION_STEPS) {
      expect({ step, started: steps.hasStartedPublishing(JSON.stringify([step])) }).toEqual({
        step,
        started: step !== "ci_check" && step !== "enrichment_check",
      });
    }
    expect(steps.hasStartedPublishing('["ci_check","enrichment_check"]')).toBe(false);
    expect(steps.hasStartedPublishing('["ci_check","enrichment_check","s3_public_read"]')).toBe(
      true,
    );
    // A step this code has never heard of is a step that changed something: unknown is not quiet.
    expect(steps.hasStartedPublishing('["a_step_from_a_newer_worker"]')).toBe(true);
  });

  test("is false for anything a row could hold that is not a list of step names", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "[]",
      "not json",
      "{}",
      "null",
      "[1, 2]",
      '"s3_lock"',
    ]) {
      expect({ raw, started: steps.hasStartedPublishing(raw) }).toEqual({ raw, started: false });
    }
    // A number among the names is not a name.
    expect(steps.hasStartedPublishing('[1, "ci_check"]')).toBe(false);
    expect(steps.hasStartedPublishing('[1, "s3_lock"]')).toBe(true);
  });
});

describe("publishingStanding", () => {
  const QUIET = '["ci_check","enrichment_check"]';
  const STARTED = '["ci_check","enrichment_check","s3_public_read"]';
  const STANDING = steps.publishingStanding;

  test("an approving request stands by its steps: started is publishing, anything else stopped", () => {
    expect(STANDING({ status: "approving", steps_completed: STARTED, block_reason: null })).toBe(
      "publishing",
    );
    for (const raw of [QUIET, "[]", null, "", "not json", "{}"]) {
      expect({
        raw,
        standing: STANDING({ status: "approving", steps_completed: raw, block_reason: null }),
      }).toEqual({
        raw,
        standing: "stopped",
      });
    }
    // A reason on an approving row is not read: only a blocked row's reason decides anything.
    expect(
      STANDING({ status: "approving", steps_completed: STARTED, block_reason: "anything" }),
    ).toBe("publishing");
  });

  test("a blocked request is publishing only for the owner-name walk-back, and only once it started", () => {
    const blocked = (steps_completed: string | null, block_reason: string | null) =>
      STANDING({ status: "blocked", steps_completed, block_reason });
    expect(blocked(STARTED, steps.OWNER_NAME_MISSING_REASON)).toBe("publishing");
    expect(steps.OWNER_NAME_MISSING_REASON).toBe("owner_name_missing");
    // The walk-back before a step changed anything is not a run that started.
    expect(blocked(QUIET, steps.OWNER_NAME_MISSING_REASON)).toBe("none");
    expect(blocked(null, steps.OWNER_NAME_MISSING_REASON)).toBe("none");
    // Any other reason, however stale its steps, is a blocked request and no run: the gates apply.
    for (const reason of [
      "identifier_screen_blocks",
      "min_requirements_failed",
      "OWNER_NAME_MISSING",
      "",
      null,
    ]) {
      expect({ reason, standing: blocked(STARTED, reason) }).toEqual({ reason, standing: "none" });
    }
  });

  test("every other status is none, whatever its steps and reason say", () => {
    for (const status of ["requested", "published", "denied", "cancelled", "", "approved"]) {
      for (const reason of [null, steps.OWNER_NAME_MISSING_REASON]) {
        expect({
          status,
          reason,
          standing: STANDING({ status, steps_completed: STARTED, block_reason: reason }),
        }).toEqual({ status, reason, standing: "none" });
      }
    }
  });
});

describe("screenView", () => {
  const report = (status: string) =>
    JSON.stringify(parseScreenReport(screenReportBodyFor("nm000123", status)));

  test("a sandbox dataset is exempt, whatever its row says", () => {
    for (const id of ["xx000001", "xx099999"]) {
      for (const [status, rep] of [
        [null, null],
        ["clean", report("clean")],
        ["pending", null],
        ["not a state", "not json"],
      ] as const) {
        expect(stored.screenView(id, status, rep)).toEqual({
          state: "exempt",
          ...stored.EXEMPT_SCREEN_DESCRIPTION,
        });
      }
    }
    expect(stored.EXEMPT_SCREEN_DESCRIPTION).toEqual({
      headline: "Identifier screen: not applicable (sandbox)",
      tone: "note",
      lines: ["Sandbox (xx) datasets never publish real data, so they are not screened."],
    });
  });

  test("any other dataset is read through the shared words: the stored state, and its report when it parses", () => {
    expect(stored.screenView("nm000123", null, null)).toEqual({
      state: null,
      ...describeScreen(null, null),
    });
    for (const status of DATASET_STATUSES) {
      const rep = report(status);
      const view = stored.screenView("nm000123", status, rep);
      const d = describeScreen(status, parseScreenReport(JSON.parse(rep)));
      expect({ status, view }).toEqual({
        status,
        view: { state: status, headline: d.headline, tone: d.tone, lines: d.lines },
      });
    }
    // A state with no report, or a report that does not read back, is described without one.
    for (const state of ["pending", "error", "unreported"] as const) {
      const d = describeScreen(state, null);
      expect(stored.screenView("nm000123", state, null)).toEqual({
        state,
        headline: d.headline,
        tone: d.tone,
        lines: d.lines,
      });
    }
    expect(stored.screenView("nm000123", "clean", "{not json").state).toBe("clean");
    // A value that is not a state is no state: the column is TEXT and is not trusted.
    expect(stored.screenView("nm000123", "bogus", report("clean"))).toEqual({
      state: null,
      ...describeScreen(null, null),
    });
  });

  test("an id that only looks like a sandbox id is screened, never waved through", () => {
    for (const id of ["xx12345", "xx1234567", "xxabcdef", "XX000001", "nm000001", "on000001"]) {
      expect({ id, state: stored.screenView(id, "clean", report("clean")).state }).toEqual({
        id,
        state: "clean",
      });
    }
  });
});
