/**
 * The docs anchors the identifier screen links to must exist (card A10, ADR 0045).
 *
 * Every entry of every screen copy table carries an `anchor`, and the terminal, the report and the
 * mails print `docsLink(copy)` for it. A link whose heading is missing lands on the top of the page
 * and the person never finds the explanation, so the page and the tables are checked against each
 * other: every anchor must be the id of a heading in the docs page `platform/identifier-screening`.
 *
 * The page's reference sections are generated from the tables by `scripts/docs/screen-copy-docs.ts`.
 * The first half of this file tests that generator on its own (it needs no docs checkout). The
 * second half reads the docs checkout (`NEMAR_DOCS_CHECKOUT`, or a sibling `docs` checkout, as
 * `docs-links.unit.test.ts` does) and skips with a message when there is none.
 *
 * Unlike `docs-links`, this reads the page from the WORKING TREE of the checkout, not from a git
 * ref: the page under test is the one a docs branch is about to publish. In CI the checkout is
 * `main`, so a docs change that adds anchors must merge before the nemar-cli change that links to
 * them. Real files, real spawned process, no mocks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  END_MARKER,
  START_MARKER,
  allAnchors,
  md,
  renderScreenCopyDocs,
  spliceGenerated,
} from "../scripts/docs/screen-copy-docs";
import {
  type Copy,
  INCOMPLETE_COPY,
  KIND_COPY,
  LOCAL_ANCHOR,
  LOCAL_COPY,
  NOTE_COPY,
  READ_FAILURE_COPY,
  STATUS_COPY,
} from "../shared/identifier-screen-copy";

const REPO_ROOT = join(import.meta.dir, "..");
const GENERATOR = join(REPO_ROOT, "scripts", "docs", "screen-copy-docs.ts");
const PAGE_PATH = join("src", "content", "docs", "platform", "identifier-screening.md");

/** Every anchor, read straight from the tables (not from the generator, so a table the generator
 *  forgot still has its anchors checked). */
function tableAnchors(): Map<string, string> {
  const anchors = new Map<string, string>();
  const add = (table: string, copy: Copy) => anchors.set(copy.anchor, table);
  for (const copy of Object.values(KIND_COPY)) add("KIND_COPY", copy);
  for (const copy of Object.values(STATUS_COPY)) add("STATUS_COPY", copy);
  for (const copy of Object.values(INCOMPLETE_COPY)) add("INCOMPLETE_COPY", copy);
  for (const copy of Object.values(READ_FAILURE_COPY)) add("READ_FAILURE_COPY", copy);
  for (const copy of Object.values(NOTE_COPY)) add("NOTE_COPY", copy);
  for (const copy of [
    LOCAL_COPY.server,
    LOCAL_COPY.workingTree,
    LOCAL_COPY.committed,
    LOCAL_COPY.noHistory,
    LOCAL_COPY.supersededAbsent(1),
  ]) {
    add("LOCAL_COPY", copy);
  }
  return anchors;
}

/** The ids of the headings of a Markdown page: an explicit `id` on a raw HTML heading, or the slug
 *  the site derives from a `#` heading's text. Fenced code is not read. */
function headingIds(markdown: string): string[] {
  const ids: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const html = line.match(/^<h[1-6]\b[^>]*\sid="([^"]+)"/);
    if (html) {
      ids.push(html[1]);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      ids.push(
        heading[1]
          .replace(/<[^>]*>/g, "")
          .replace(/[`*_]/g, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .trim()
          .replace(/\s/g, "-"),
      );
    }
  }
  return ids;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "docs-anchors-"));
  scratch.push(dir);
  return dir;
}

describe("the heading id extractor", () => {
  test("reads an explicit id, a slug and nothing inside a fence", () => {
    const page = [
      "# Title here",
      '<h3 id="kind-a"><code>a</code></h3>',
      "## Verdict words",
      "```",
      '<h3 id="in-a-fence">x</h3>',
      "## Also in a fence",
      "```",
      'text with `<h3 id="in-text">` in it',
    ].join("\n");
    expect(headingIds(page)).toEqual(["title-here", "kind-a", "verdict-words"]);
  });
});

describe("the generated reference", () => {
  const generated = renderScreenCopyDocs();
  const anchors = tableAnchors();

  test("every anchor of every table is a heading id, once", () => {
    const ids = headingIds(generated);
    for (const anchor of anchors.keys()) {
      expect({ anchor, count: ids.filter((id) => id === anchor).length }).toEqual({
        anchor,
        count: 1,
      });
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the generator lists exactly the anchors the tables declare", () => {
    expect(allAnchors()).toEqual([...anchors.keys()].sort());
  });

  test("anchors keep their forms", () => {
    const prefix: Record<string, RegExp> = {
      KIND_COPY: /^kind-/,
      STATUS_COPY: /^status-/,
      INCOMPLETE_COPY: /^incomplete-/,
      READ_FAILURE_COPY: /^failure-/,
      NOTE_COPY: /^note-/,
      LOCAL_COPY: new RegExp(`^${LOCAL_ANCHOR}$`),
    };
    for (const [anchor, table] of anchors)
      expect({ anchor, ok: prefix[table].test(anchor) }).toEqual({ anchor, ok: true });
  });

  test("every entry's statement, what was read and remedy are on the page", () => {
    const missing: string[] = [];
    const tables: [string, Record<string, Copy>][] = [
      ["kind", KIND_COPY],
      ["status", STATUS_COPY],
      ["incomplete", INCOMPLETE_COPY],
      ["failure", READ_FAILURE_COPY],
      ["note", NOTE_COPY],
    ];
    for (const [, table] of tables) {
      for (const copy of Object.values(table)) {
        const start = generated.indexOf(`id="${copy.anchor}"`);
        const next = generated.indexOf("<h", start + 1);
        const section = generated.slice(start, next === -1 ? undefined : next);
        for (const part of [copy.statement, copy.read, copy.remedy]) {
          if (!section.includes(md(part))) missing.push(`${copy.anchor}: ${part}`);
        }
        if (!section.includes("Reproduce: `nemar dataset screen --committed`")) {
          missing.push(`${copy.anchor}: reproduce line`);
        }
      }
    }
    for (const copy of [
      LOCAL_COPY.server,
      LOCAL_COPY.workingTree,
      LOCAL_COPY.committed,
      LOCAL_COPY.noHistory,
    ]) {
      for (const part of [copy.statement, copy.read, copy.remedy]) {
        if (!generated.includes(md(part))) missing.push(`${LOCAL_ANCHOR}: ${part}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the output is deterministic and has no timestamp", () => {
    expect(renderScreenCopyDocs()).toBe(generated);
    expect(generated).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  test("entries are sorted within each section", () => {
    const sections = generated.split(/^## /m).slice(1);
    for (const section of sections) {
      const ids = headingIds(section.replace(/^[^\n]*\n/, "")).filter((id) => id.includes("-"));
      const own = ids.filter((id) => /^(status|kind|incomplete|failure|note)-/.test(id));
      expect(own).toEqual([...own].sort());
    }
  });

  test("copy characters Markdown reads as syntax are kept as code", () => {
    expect(md("Run with --committed to read it.")).toBe("Run with `--committed` to read it.");
    expect(md("Remove .idea, __pycache__ and .DS_Store.")).toBe(
      "Remove .idea, `__pycache__` and .`DS_Store`.",
    );
    expect(md("or run 'nemar dataset publish status <id>', to see")).toBe(
      "or run `nemar dataset publish status <id>`, to see",
    );
    expect(md("the [Comment] section")).toBe("the `[Comment]` section");
    expect(md("plain words, a-b and sub-01")).toBe("plain words, a-b and sub-01");
  });
});

describe("splicing the generated block into a page", () => {
  const page = `before\n${START_MARKER}\nold\n${END_MARKER}\nafter\n`;

  test("replaces what sits between the markers and nothing else", () => {
    const next = spliceGenerated(page, "new\n");
    expect(next.startsWith(`before\n${START_MARKER}\n`)).toBe(true);
    expect(next.endsWith(`${END_MARKER}\nafter\n`)).toBe(true);
    expect(next).toContain("\nnew\n");
    expect(next).not.toContain("old");
  });

  test("a second splice changes nothing", () => {
    const once = spliceGenerated(page, renderScreenCopyDocs());
    expect(spliceGenerated(once, renderScreenCopyDocs())).toBe(once);
  });

  test("refuses a page with a missing, repeated or reversed marker", () => {
    for (const bad of [
      "no markers\n",
      `${START_MARKER}\nonly start\n`,
      `only end\n${END_MARKER}\n`,
      `${page}${page}`,
      `${END_MARKER}\n${START_MARKER}\n`,
    ]) {
      expect(() => spliceGenerated(bad, "new\n")).toThrow();
    }
  });
});

describe("the command", () => {
  /** An environment built from nothing: the command reads a file and writes it back. */
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["run", GENERATOR, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });

  test("writes the block, and a second run is a no-op", () => {
    const file = join(scratchDir(), "page.md");
    writeFileSync(file, `intro\n${START_MARKER}\n${END_MARKER}\n\nrest\n`);
    const first = run(["--out", file]);
    expect(first.status).toBe(0);
    const written = readFileSync(file, "utf8");
    expect(written).toContain('<h3 id="kind-edf-patient-name">');
    expect(written.startsWith("intro\n")).toBe(true);
    expect(written.endsWith(`${END_MARKER}\n\nrest\n`)).toBe(true);
    const second = run(["--out", file]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("up to date");
    expect(readFileSync(file, "utf8")).toBe(written);
  });

  test("refuses a page without the markers and leaves it as it was", () => {
    const file = join(scratchDir(), "page.md");
    writeFileSync(file, "# A page\n\nNo markers here.\n");
    const result = run(["--out", file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("markers");
    expect(readFileSync(file, "utf8")).toBe("# A page\n\nNo markers here.\n");
  });
});

// --------------------------------------------------------------------------
// The docs checkout.
// --------------------------------------------------------------------------

const DOCS_ENV_VAR = "NEMAR_DOCS_CHECKOUT";
const declaredRaw = process.env[DOCS_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;
const DOCS_CANDIDATES = [join(REPO_ROOT, "..", "docs"), join(REPO_ROOT, "..", "..", "docs")];
const DOCS_ROOT = DECLARED_PATH ?? DOCS_CANDIDATES.find((path) => existsSync(path)) ?? null;
const PAGE = DOCS_ROOT === null ? null : join(DOCS_ROOT, PAGE_PATH);
const NO_PAGE = PAGE === null || !existsSync(PAGE);

if (NO_PAGE && DECLARED_PATH === null) {
  console.info(
    `[docs anchors] skipping: no docs checkout with ${PAGE_PATH} at ${DOCS_CANDIDATES.join(" or ")}, and ${DOCS_ENV_VAR} is unset.`,
  );
}

describe("a declared docs checkout must hold the page", () => {
  // A checkout named by CI that lacks the page means the checkout broke, or the page moved: a skip
  // would hand the check back to nobody (the same rule as docs-links).
  test.skipIf(DECLARED_PATH === null)(`${DOCS_ENV_VAR} holds ${PAGE_PATH}`, () => {
    expect({ page: PAGE, exists: PAGE !== null && existsSync(PAGE) }).toEqual({
      page: PAGE,
      exists: true,
    });
  });
});

describe.skipIf(NO_PAGE)("the docs page carries every anchor the screen links to", () => {
  const page = NO_PAGE ? "" : readFileSync(PAGE as string, "utf8");
  const ids = new Set(headingIds(page));

  test("the page has the generated block's markers", () => {
    expect(page).toContain(START_MARKER);
    expect(page).toContain(END_MARKER);
  });

  test("every anchor of every copy table is a heading id on the page", () => {
    const missing = [...tableAnchors()].filter(([anchor]) => !ids.has(anchor));
    expect(missing.map(([anchor, table]) => `${table}: ${anchor}`)).toEqual([]);
  });
});
