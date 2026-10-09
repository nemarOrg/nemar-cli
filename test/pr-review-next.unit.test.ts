/**
 * The rules of `nemar admin pr-reviews next` (ADR 0093) that need no terminal and no server:
 * what each typed answer means, when `y` may approve and merge, and the reader that keeps lines
 * typed ahead and reports an input that has ended.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { approvalGate } from "../src/lib/pr-review-approve";
import { approveAllowed, parseChoice } from "../src/lib/pr-review-next";
import { LineReader } from "../src/lib/prompt-lines";

describe("what a typed answer means", () => {
  test("y n c d s q, in either case and with spaces, and the words they stand for", () => {
    expect(["y", "Y", " yes "].map(parseChoice)).toEqual(["approve", "approve", "approve"]);
    expect(["n", "N", "no"].map(parseChoice)).toEqual(["close", "close", "close"]);
    expect(["c", "comment"].map(parseChoice)).toEqual(["comment", "comment"]);
    expect(["d", "Details"].map(parseChoice)).toEqual(["details", "details"]);
    expect(["s", "skip"].map(parseChoice)).toEqual(["skip", "skip"]);
    expect(["q", "Quit"].map(parseChoice)).toEqual(["quit", "quit"]);
  });

  test("anything else, including an empty line, is not an answer", () => {
    for (const raw of ["", "  ", "x", "yy", "ok", "approve", "y n"]) {
      expect(parseChoice(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("when y may approve and merge", () => {
  const pass = approvalGate({ verdict: "pass", staleVerdict: null });
  const green = { bids: "pass", version: "pass" };

  test("a pass with both required checks green", () => {
    expect(approveAllowed({ gate: pass, force: false, ...green })).toEqual({ ok: true });
  });

  test("a verdict that only asks first is allowed: the warning is on the screen", () => {
    for (const verdict of ["uncertain", "could_not_decide", "not_reviewed"] as const) {
      const gate = approvalGate({ verdict, staleVerdict: null });
      expect(approveAllowed({ gate, force: false, ...green })).toEqual({ ok: true });
    }
  });

  test("a required check that is not green is refused, whatever --force says, and names the check", () => {
    for (const [bids, version, word] of [
      ["fail", "pass", "BIDS failing"],
      ["pending", "pass", "BIDS pending"],
      ["missing", "pass", "BIDS missing"],
      ["unknown", "pass", "BIDS unknown"],
      ["pass", "fail", "version failing"],
      ["pass", "pending", "version pending"],
    ] as const) {
      for (const force of [false, true]) {
        const r = approveAllowed({ gate: pass, force, bids, version });
        expect(r.ok, `${bids}/${version}/${force}`).toBe(false);
        if (!r.ok) {
          expect(r.reason).toContain(word);
          expect(r.reason).toContain("GitHub would not let it merge");
        }
      }
    }
  });

  test("a failing, running or unreadable review needs --force, and the reason says so", () => {
    for (const gate of [
      approvalGate({ verdict: "fail", staleVerdict: null }),
      approvalGate({ verdict: "in_progress", staleVerdict: null }),
      approvalGate({ verdict: "pass", staleVerdict: null, unread: "the API is down" }),
    ]) {
      const refused = approveAllowed({ gate, force: false, ...green });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("--force");
      expect(approveAllowed({ gate, force: true, ...green })).toEqual({ ok: true });
    }
  });

  test("both reasons are given when both apply", () => {
    const gate = approvalGate({ verdict: "fail", staleVerdict: null });
    const r = approveAllowed({ gate, force: false, bids: "fail", version: "pass" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("BIDS failing");
      expect(r.reason).toContain("needs changes");
    }
  });
});

describe("the line reader", () => {
  function reader() {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (b) => written.push(String(b)));
    return { input, written, reader: new LineReader(input, output) };
  }

  test("lines typed ahead are kept for the questions that come later", async () => {
    const { input, reader: r } = reader();
    input.write("one\ntwo\nthree\n");
    // Let the lines arrive before anything asks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await r.ask("? ")).toBe("one");
    expect(await r.ask("? ")).toBe("two");
    expect(await r.ask("? ")).toBe("three");
    r.close();
  });

  test("a question waits for the next line", async () => {
    const { input, written, reader: r } = reader();
    const pending = r.ask("answer> ");
    input.write("later\n");
    expect(await pending).toBe("later");
    expect(written.join("")).toContain("answer> ");
    r.close();
  });

  test("an input that ends is an answer, for the question waiting and every one after", async () => {
    const { input, reader: r } = reader();
    const waiting = r.ask("? ");
    input.end();
    expect(await waiting).toBeNull();
    expect(await r.ask("? ")).toBeNull();
  });
});
