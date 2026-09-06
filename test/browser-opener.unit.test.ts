/**
 * The platform table behind `openInBrowser` (#1266, ADR 0044).
 *
 * A supplement to the CLI tests, not their replacement: those run the real
 * `nemar auth profile orcid link` with `NEMAR_NO_BROWSER=1`, which is the only
 * honest way to drive that command in a test suite (spawning a real browser is
 * not a thing a test may do). What is left uncovered by that is the table
 * itself, which is exactly where a silent regression would live -- an opener
 * that never runs looks identical to one that runs and fails.
 */

import { describe, expect, test } from "bun:test";
import { browserOpenerFor } from "../src/lib/browser.js";

describe("browserOpenerFor", () => {
  test("uses each platform's own opener", () => {
    expect(browserOpenerFor("darwin", "https://example.org")).toEqual({
      command: "open",
      args: ["https://example.org"],
    });
    expect(browserOpenerFor("linux", "https://example.org")).toEqual({
      command: "xdg-open",
      args: ["https://example.org"],
    });
  });

  test("windows keeps the empty title argument", () => {
    // `start` reads a first quoted argument as the window TITLE, so dropping
    // the empty string breaks every URL that needs quoting -- and it breaks it
    // by opening a window called "https://..." rather than by erroring.
    expect(browserOpenerFor("win32", "https://example.org?a=1&b=2")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "https://example.org?a=1&b=2"],
    });
  });

  test("an unknown platform has no opener, rather than a wrong one", () => {
    // The caller prints the URL and moves on; guessing `open` on AIX would
    // spawn something unrelated.
    expect(browserOpenerFor("aix", "https://example.org")).toBeNull();
  });
});
