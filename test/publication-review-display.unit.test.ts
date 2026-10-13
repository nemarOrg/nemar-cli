/**
 * What `nemar admin publish` decides from a list row and prints for a review, as the pure
 * functions it is made of (ADR 0102, section 8).
 *
 * The queue predicates (`needsAdministrator`, `startAllCandidates`) are the two places the CLI
 * could decide something the Worker did not say: which requests are an administrator's to act on,
 * and which `start --all` would spend a model call on. They are tested over every status and every
 * reason code, because a rule that holds for the cases somebody thought of is the failure mode.
 * The rendering functions are tested with hostile text fed straight in: the spawned-CLI suite goes
 * through the real Worker, which has already reduced the model's words to plain ones, so it would
 * pass with every `plain()` call of the CLI deleted.
 */

import { describe, expect, test } from "bun:test";
import { REASON_CODES, type ReasonCode } from "../shared/publication-review";
import type { PublicationReviewSummary, PublishRequestsResponse } from "../src/lib/api/publish";
import {
  byOldestFirst,
  needsAdministrator,
  startAllCandidates,
} from "../src/lib/publication-review-queue";

type Row = PublishRequestsResponse["requests"][number];

/** The reasons that mean "wait for the platform"; nothing an administrator can do about them. */
const WAITS: readonly ReasonCode[] = ["review_running", "identifier_screen_pending"];

function summary(over: Partial<PublicationReviewSummary> = {}): PublicationReviewSummary {
  return {
    kind: "decided",
    enabled: true,
    gate: "enforced",
    outcome: "action_required",
    headline: "Publication review: action required",
    tone: "warn",
    reasons: ["review_not_started"],
    start_offered: false,
    review_id: null,
    head_sha: null,
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 1,
    dataset_id: "nm000480",
    status: "requested",
    requested_at: "2026-10-12 09:14:03",
    requested_by_username: "alice",
    requested_by_email: "alice@example.org",
    steps_completed: [],
    current_step: null,
    last_error: null,
    approval_in_flight: false,
    publication_review: summary(),
    ...over,
  };
}

describe("needsAdministrator", () => {
  test("a requested request is the administrator's, whatever the outcome", () => {
    expect(needsAdministrator(row())).toBe(true);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ outcome: "pass", reasons: [], tone: "ok" }) }),
      ),
    ).toBe(true);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ outcome: "fail", reasons: ["question_failed"] }) }),
      ),
    ).toBe(true);
  });

  test("blocked, published and denied are not: the depositor acts, or nothing is left to do", () => {
    for (const status of ["blocked", "published", "denied"]) {
      expect(needsAdministrator(row({ status }))).toBe(false);
    }
  });

  test("an approving request is the administrator's unless an approval is running", () => {
    expect(needsAdministrator(row({ status: "approving" }))).toBe(true);
    expect(needsAdministrator(row({ status: "approving", approval_in_flight: true }))).toBe(false);
  });

  test("a request with an approval in flight is not, whatever its review says", () => {
    expect(needsAdministrator(row({ approval_in_flight: true }))).toBe(false);
    expect(
      needsAdministrator(
        row({
          approval_in_flight: true,
          publication_review: summary({ outcome: "pass", reasons: [], tone: "ok" }),
        }),
      ),
    ).toBe(false);
  });

  test("a request that is only waiting is not: every reason a wait", () => {
    expect(
      needsAdministrator(row({ publication_review: summary({ reasons: ["review_running"] }) })),
    ).toBe(false);
    expect(
      needsAdministrator(
        row({ publication_review: summary({ reasons: ["identifier_screen_pending"] }) }),
      ),
    ).toBe(false);
    expect(
      needsAdministrator(
        row({
          publication_review: summary({ reasons: ["identifier_screen_pending", "review_running"] }),
        }),
      ),
    ).toBe(false);
  });

  test("a wait next to anything else is still the administrator's", () => {
    expect(
      needsAdministrator(
        row({ publication_review: summary({ reasons: ["review_running", "question_failed"] }) }),
      ),
    ).toBe(true);
  });

  // Walks the whole vocabulary: a reason a later phase adds is the administrator's unless someone
  // adds it to the waits on purpose, which this test then says out loud.
  test("over every reason code, exactly the two waits keep a requested request from the queue", () => {
    for (const code of REASON_CODES) {
      const row1 = row({ publication_review: summary({ reasons: [code] }) });
      expect(needsAdministrator(row1)).toBe(!WAITS.includes(code));
    }
  });

  test("a row with no reasons is assessed by its status alone, so a pass and an unreadable review count", () => {
    // `unreadable` is action_required with no reason: nobody can say it is only waiting.
    expect(
      needsAdministrator(row({ publication_review: summary({ kind: "unreadable", reasons: [] }) })),
    ).toBe(true);
    // Not assessed (the review is off): no reasons, the request still waits for a person.
    expect(
      needsAdministrator(
        row({
          publication_review: summary({ kind: "off", enabled: false, outcome: null, reasons: [] }),
        }),
      ),
    ).toBe(true);
  });

  test("a row from an older backend, with no summary and no in-flight field, is by its status", () => {
    const old = row();
    old.publication_review = undefined;
    old.approval_in_flight = undefined;
    expect(needsAdministrator(old)).toBe(true);
    expect(needsAdministrator({ ...old, status: "blocked" })).toBe(false);
    expect(needsAdministrator({ ...old, status: "approving" })).toBe(true);
    expect(needsAdministrator({ ...old, approval_in_flight: true })).toBe(false);
  });
});

describe("startAllCandidates", () => {
  test("is the requested rows whose summary offers a start", () => {
    const offered = row({ id: 1, publication_review: summary({ start_offered: true }) });
    const notOffered = row({ id: 2, publication_review: summary({ start_offered: false }) });
    expect(startAllCandidates([notOffered, offered]).map((r) => r.id)).toEqual([1]);
  });

  test("never decides from the reason codes: the summary's start_offered is the rule", () => {
    // Reasons whose cure is "start it", and the server says no (a reported review whose report no
    // longer parses reads review_could_not_run and the route refuses has_result).
    const notOffered = row({
      id: 1,
      publication_review: summary({ reasons: ["review_not_started"], start_offered: false }),
    });
    // No reason at all, and the server says yes.
    const offered = row({
      id: 2,
      publication_review: summary({ reasons: [], outcome: "pass", start_offered: true }),
    });
    expect(startAllCandidates([notOffered, offered]).map((r) => r.id)).toEqual([2]);
  });

  test("a row that is not requested is never a candidate, whatever its summary says", () => {
    for (const status of ["approving", "blocked", "published", "denied"]) {
      expect(
        startAllCandidates([row({ status, publication_review: summary({ start_offered: true }) })]),
      ).toEqual([]);
    }
  });

  test("a row from an older backend has no offer and is not a candidate", () => {
    const old = row();
    old.publication_review = undefined;
    expect(startAllCandidates([old])).toEqual([]);
  });

  test("answers oldest first, which is not the order the Worker lists them in", () => {
    const offered = summary({ start_offered: true });
    const newest = row({ id: 3, requested_at: "2026-10-12 09:14:03", publication_review: offered });
    const middle = row({ id: 2, requested_at: "2026-10-11 16:02:10", publication_review: offered });
    const oldest = row({ id: 1, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    expect(startAllCandidates([newest, middle, oldest]).map((r) => r.id)).toEqual([1, 2, 3]);
    // The same second: the request that came first.
    const a = row({ id: 5, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    const b = row({ id: 4, requested_at: "2026-10-10 08:00:00", publication_review: offered });
    expect(startAllCandidates([a, b]).map((r) => r.id)).toEqual([4, 5]);
  });
});

describe("byOldestFirst", () => {
  test("orders by request time then id, and leaves its input alone", () => {
    const rows = [
      row({ id: 3, requested_at: "2026-10-12 09:14:03" }),
      row({ id: 1, requested_at: "2026-10-10 08:00:00" }),
    ];
    expect(byOldestFirst(rows).map((r) => r.id)).toEqual([1, 3]);
    expect(rows.map((r) => r.id)).toEqual([3, 1]);
  });
});
