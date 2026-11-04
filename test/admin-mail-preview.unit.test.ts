/**
 * The reply confirmation preview (epic #1893 phase 4): what a person reads before a reply goes out
 * is made safe, because the ticket's subject and address come from outside. The confirmation
 * prompt itself needs a terminal and is not driven here. CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { replyPreview } from "../src/commands/admin-mail";

describe("replyPreview", () => {
  test("shows recipient, subject and text", () => {
    expect(
      replyPreview({ requester_email: "person@example.org", subject: "Help" }, "Hello\n\tthere"),
    ).toBe("To:       person@example.org\nSubject:  Re: Help\n\nHello\n\tthere\n");
  });

  test("escapes control and bidirectional characters in every part", () => {
    const out = replyPreview(
      { requester_email: "a\u001b[2J@example.org", subject: "x\u202ey\nz" },
      "body\u001b]0;t\u0007 \u200f",
    );
    for (const raw of ["\u001b", "\u0007", "\u202e", "\u200f"]) expect(out).not.toContain(raw);
    expect(out).toContain("a\\x1b[2J@example.org");
    expect(out).toContain("Re: x\\u202ey\\nz");
    expect(out).toContain("body\\x1b]0;t\\x07 \\u200f");
  });
});
