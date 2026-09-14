/**
 * `toMirrorPath`, the pure half of `nemar admin docs` (epic #1336 phase 3).
 *
 * SPLIT OUT OF test/docs-fetch.unit.test.ts SO IT RUNS IN THE REQUIRED TIER.
 * That file drives the real CLI as a subprocess, which CI's classifier detects
 * and routes to the live tier -- required on `main` but not on `dev`. The
 * subprocess tests belong there; this parsing logic does not, and a pull request
 * that broke it would have merged green.
 *
 * KEEP THIS FILE FREE OF THE TOKENS THAT CLASSIFIER MATCHES ON (see the file
 * selection in `.github/workflows/test.yml`), including inside comments. Naming
 * one here would move this file back to the tier it was split out of, which is
 * a trap this repository has fallen into before. Everything below is pure
 * string handling: no server, no subprocess, no environment.
 */

import { describe, expect, test } from "bun:test";
import { toMirrorPath } from "../src/lib/docs-fetch.js";

describe("toMirrorPath", () => {
  test("adds .md to a bare path", () => {
    expect(toMirrorPath("admin/operations/zarr-serving")).toBe("/admin/operations/zarr-serving.md");
  });

  test("accepts a leading slash", () => {
    expect(toMirrorPath("/cli/commands")).toBe("/cli/commands.md");
  });

  test("drops the trailing slash the HTML spelling carries", () => {
    // `build.format` is 'directory' on this site, so every page's browser URL
    // ends in a slash. `.../commands/.md` is not a page, so the slash has to go
    // before the extension is added -- this is the spelling someone copying
    // from the address bar will paste.
    expect(toMirrorPath("/cli/commands/")).toBe("/cli/commands.md");
  });

  test("leaves an existing .md alone", () => {
    expect(toMirrorPath("cli/commands.md")).toBe("/cli/commands.md");
  });

  test("leaves other real extensions alone", () => {
    // llms.txt is the index an agent starts from, and sitemap.xml is how the
    // completeness check reads the site; both must stay reachable through the
    // same command rather than being rewritten to llms.txt.md.
    expect(toMirrorPath("llms.txt")).toBe("/llms.txt");
    expect(toMirrorPath("sitemap.xml")).toBe("/sitemap.xml");
  });

  test("strips a fragment or query before adding the extension", () => {
    // `/admin/commands#section.md` asks for the HTML page, which the command
    // would then print as though it were documentation. An anchored URL copied
    // from the address bar is the obvious way to hit this.
    expect(toMirrorPath("admin/commands#section")).toBe("/admin/commands.md");
    expect(toMirrorPath("https://docs.nemar.org/cli/commands/#nemar-auth-login")).toBe(
      "/cli/commands.md",
    );
    expect(toMirrorPath("/cli/commands/?q=1")).toBe("/cli/commands.md");
  });

  test("maps the site root to /index.md", () => {
    // The root entry's id is literally `index`, so this needs no special case
    // on the serving side either; leaving `slug` undefined there would emit
    // `/.md`, a dotfile at the site root.
    expect(toMirrorPath("/")).toBe("/index.md");
    expect(toMirrorPath("")).toBe("/index.md");
  });

  test("accepts a full docs URL, taking only the path", () => {
    expect(toMirrorPath("https://docs.nemar.org/admin/commands/")).toBe("/admin/commands.md");
  });

  test("refuses a URL for another host rather than re-pointing it", () => {
    // Silently rewriting the host would answer a different question than the
    // one asked, with a page that looks like the answer.
    expect(() => toMirrorPath("https://example.com/admin/commands/")).toThrow(/docs\.nemar\.org/);
  });
});
