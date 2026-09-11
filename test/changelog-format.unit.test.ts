/**
 * Keeps `CHANGELOG.md` parseable and in step with the version CI owns.
 *
 * The file exists because the generated GitHub Release notes are a list of pull
 * request titles, which collapses an epic into one bullet and gives a fix found
 * mid-epic no bullet at all. A hand-written summary is the only thing that closes
 * that gap, and a hand-written anything rots: an entry claiming a version that was
 * never tagged, two entries for one version after a bad merge, or a heading
 * shuffled out of order all read as fact to whoever is trying to explain a
 * behavior change.
 *
 * What this does NOT check is whether an entry is complete or true; nothing can.
 * It checks the properties a reader relies on to navigate: newest first, one entry
 * per version, dated, and never ahead of what has actually been released.
 *
 * Real filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version as string;

/** Every `## ` heading, in file order. */
function headings(): string[] {
  return [...CHANGELOG.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

/** The versioned headings only, parsed. `Unreleased` is not one. */
function releases(): { version: string; date: string; parts: number[] }[] {
  const out: { version: string; date: string; parts: number[] }[] = [];
  for (const heading of headings()) {
    if (heading === "Unreleased") continue;
    const m = heading.match(/^(\d+)\.(\d+)\.(\d+) - (\d{4}-\d{2}-\d{2})$/);
    // A heading that is neither `Unreleased` nor `X.Y.Z - YYYY-MM-DD` is the
    // failure this asserts; collect it as an obviously-invalid entry rather than
    // skipping it, so the test names it.
    if (!m) {
      out.push({ version: heading, date: "", parts: [] });
      continue;
    }
    out.push({
      version: `${m[1]}.${m[2]}.${m[3]}`,
      date: m[4],
      parts: [Number(m[1]), Number(m[2]), Number(m[3])],
    });
  }
  return out;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

describe("CHANGELOG.md", () => {
  test("every heading is `Unreleased` or `X.Y.Z - YYYY-MM-DD`", () => {
    for (const entry of releases()) {
      expect(entry.parts.length, `bad heading: ## ${entry.version}`).toBe(3);
    }
  });

  test("`Unreleased`, when present, comes first", () => {
    // Anywhere else and a reader takes shipped behavior for pending behavior, or
    // the reverse.
    const all = headings();
    const at = all.indexOf("Unreleased");
    if (at !== -1) expect(at).toBe(0);
  });

  test("versions are strictly descending, newest first", () => {
    const parts = releases().map((r) => r.parts);
    for (let i = 1; i < parts.length; i++) {
      expect(
        compare(parts[i - 1], parts[i]),
        `${parts[i - 1].join(".")} must sort above ${parts[i].join(".")}`,
      ).toBeGreaterThan(0);
    }
  });

  test("no version appears twice", () => {
    const versions = releases().map((r) => r.version);
    expect(versions).toEqual([...new Set(versions)]);
  });

  test("the newest entry is not ahead of the version CI is carrying", () => {
    // `dev` carries `X.Y.Z-devN` and `main` carries `X.Y.Z`, so the stripped
    // version is the release this checkout is heading for. An entry above it
    // describes a release that does not exist yet, which is how a changelog
    // starts lying: the release notes are written, the release is not cut, and the
    // entry outlives whatever the content turned into.
    const stripped = PKG_VERSION.split("-")[0].split(".").map(Number);
    const newest = releases()[0];
    if (!newest) return;
    expect(
      compare(newest.parts, stripped),
      `CHANGELOG's newest entry ${newest.version} is ahead of package.json ${PKG_VERSION}`,
    ).toBeLessThanOrEqual(0);
  });

  test("it says what it is for, so nobody replaces it with the generated list", () => {
    // The one content assertion, and it earns its place: the file's whole reason
    // for existing is that `--generate-notes` is not a changelog. Someone who does
    // not know that will eventually delete this file as a duplicate.
    expect(CHANGELOG).toContain("--generate-notes");
  });
});
