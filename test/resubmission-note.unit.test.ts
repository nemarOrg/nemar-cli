/**
 * The wording of the question asked after a denial (ADR 0139, decision 5), in its three cases.
 *
 * CI TIER: unit-pure. Pure functions only.
 */

import { describe, expect, test } from "bun:test";
import { resubmissionNoteText, resubmissionPrompt } from "../shared/resubmission-note";

describe("resubmissionPrompt", () => {
  const tail =
    "Tell the reviewer what changed, or why the decision was wrong (optional, Enter to skip)";

  test("an administrator's denial", () => {
    expect(resubmissionPrompt("2026-11-21", "administrator")).toBe(
      `This dataset's last request was denied on 2026-11-21, by an administrator. ${tail}`,
    );
  });

  test("an agent's denial", () => {
    expect(resubmissionPrompt("2026-11-21", "agent")).toBe(
      `This dataset's last request was denied on 2026-11-21, by an automated agent. ${tail}`,
    );
  });

  test("an unknown author is named nobody, never an administrator", () => {
    const asked = resubmissionPrompt("2026-11-21", null);
    expect(asked).toBe(`This dataset's last request was denied on 2026-11-21. ${tail}`);
    expect(asked).not.toContain(", by ");
  });
});

describe("resubmissionNoteText", () => {
  test("quotes each line, an empty one as a bare marker, and ends with a blank line", () => {
    expect(resubmissionNoteText("a\n\nb")).toBe(
      "Depositor's note (Written by the depositor. It is not verified and it is not NEMAR's.)\n> a\n>\n> b\n",
    );
  });
});
