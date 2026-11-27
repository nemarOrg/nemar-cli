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
  ANCHOR_FORM,
  END_MARKER,
  type Namespace,
  SECTIONS,
  START_MARKER,
  allAnchors,
  escapeHtml,
  md,
  renderScreenCopyDocs,
  spliceGenerated,
  unrendered,
  walkCopy,
} from "../scripts/docs/screen-copy-docs";
import * as copy from "../shared/identifier-screen-copy";
import { MAT_LIMITS } from "../shared/mat-meta";
import { MARKER_FILE_MAX_BYTES, TEXT_HEADER_MAX_BYTES } from "../shared/readers/text-header";
import { ZIP_ENTRY_MAX_BYTES } from "../shared/readers/zip";

const REPO_ROOT = join(import.meta.dir, "..");
const GENERATOR = join(REPO_ROOT, "scripts", "docs", "screen-copy-docs.ts");
const PAGE_PATH = join("src", "content", "docs", "platform", "identifier-screening.md");

/** Every anchor the copy module declares, from the same walk the generator renders from, with the
 *  export that holds it. */
function tableAnchors(): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const found of walkCopy().found) {
    for (const [, entry] of found.entries) anchors.set(entry.anchor, found.name);
  }
  return anchors;
}

/** An entry as the tables write it. */
const entry = (anchor: string, statement = "A statement.") => ({
  statement,
  read: "what was read",
  remedy: "Do this.",
  anchor,
});

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

describe("the walk of the copy module", () => {
  const walk = walkCopy();

  test("finds every section the generator renders, and nothing it cannot", () => {
    expect(walk.found.map((f) => f.name).sort()).toEqual(Object.keys(SECTIONS).sort());
    // Each is the shape its section expects: a table of entries, or a group probed one level down.
    for (const f of walk.found)
      expect({ name: f.name, shape: f.shape }).toEqual({
        name: f.name,
        shape: SECTIONS[f.name]?.shape,
      });
    expect(unrendered(walk)).toEqual([]);
    expect(allAnchors().length).toBeGreaterThan(100);
  });

  test("agrees with the tables it was written for", () => {
    const entries = (name: string) =>
      walk.found.find((f) => f.name === name)?.entries.map(([k]) => k);
    expect(entries("KIND_COPY")?.sort()).toEqual(Object.keys(copy.KIND_COPY).sort());
    expect(entries("STATUS_COPY")?.sort()).toEqual(Object.keys(copy.STATUS_COPY).sort());
    expect(entries("INCOMPLETE_COPY")?.sort()).toEqual(Object.keys(copy.INCOMPLETE_COPY).sort());
    expect(entries("READ_FAILURE_COPY")?.sort()).toEqual(
      Object.keys(copy.READ_FAILURE_COPY).sort(),
    );
    expect(entries("NOTE_COPY")?.sort()).toEqual(Object.keys(copy.NOTE_COPY).sort());
    // A group, one level down, with its function member probed.
    expect(entries("LOCAL_COPY")?.sort()).toEqual(
      ["committed", "noHistory", "server", "supersededAbsent", "workingTree"].sort(),
    );
  });

  test("every anchor is lowercase letters, digits and hyphens", () => {
    for (const anchor of tableAnchors().keys()) {
      expect({ anchor, ok: ANCHOR_FORM.test(anchor) }).toEqual({ anchor, ok: true });
    }
  });

  test("an exported table with no section fails the render, and is never appended", () => {
    const ns: Namespace = { ...copy, NEW_COPY: { fresh: entry("kind-fresh") } };
    expect(unrendered(walkCopy(ns))).toEqual(["NEW_COPY"]);
    expect(() => renderScreenCopyDocs(ns)).toThrow(/NEW_COPY/);
  });

  test("an exported group or single entry with no section fails the render too", () => {
    const group: Namespace = { ...copy, OTHER_GROUP: { one: entry("kind-one"), count: () => 1 } };
    expect(() => renderScreenCopyDocs(group)).toThrow(/OTHER_GROUP/);
    const single: Namespace = { ...copy, LONE_COPY: entry("kind-lone") };
    expect(() => renderScreenCopyDocs(single)).toThrow(/LONE_COPY/);
  });

  test("a section whose table the module stopped exporting fails the render", () => {
    const { NOTE_COPY: _gone, ...rest } = copy;
    expect(() => renderScreenCopyDocs(rest)).toThrow(/NOTE_COPY/);
  });

  test("a new entry in a known table is rendered with no change to the script", () => {
    const ns: Namespace = {
      ...copy,
      KIND_COPY: {
        ...copy.KIND_COPY,
        "brand-new-kind": entry("kind-brand-new-kind", "Fresh words."),
      },
    };
    const out = renderScreenCopyDocs(ns);
    expect(headingIds(out)).toContain("kind-brand-new-kind");
    expect(out).toContain("Fresh words.");
  });

  test("an anchor outside [a-z0-9-] fails the render", () => {
    const ns: Namespace = {
      ...copy,
      KIND_COPY: { ...copy.KIND_COPY, bad: entry('kind-x"><script>') },
    };
    expect(() => renderScreenCopyDocs(ns)).toThrow(/anchor/);
  });
});

describe("the limits the copy and the page state are the readers' constants", () => {
  const MiB = 1024 * 1024;
  const mib = (bytes: number) => `${bytes / MiB} MiB`;

  test("the BrainVision copy names the header and marker file limits", () => {
    const text = copy.KIND_COPY["brainvision-comment-name"].read;
    expect(text).toContain(`.vhdr) files, up to ${mib(TEXT_HEADER_MAX_BYTES)}`);
    expect(text).toContain(`.vmrk) files, up to ${mib(MARKER_FILE_MAX_BYTES)}`);
  });

  test("the NIRx copy names the header limit", () => {
    expect(copy.KIND_COPY["nirx-header-date"].read).toContain(
      `up to ${mib(TEXT_HEADER_MAX_BYTES)} each`,
    );
  });

  test("the page prose says the ZIP member and MATLAB array limits the code has", () => {
    // The prose is hand-written; these are the numbers it states (docs #143).
    expect(ZIP_ENTRY_MAX_BYTES).toBe(64 * MiB);
    expect(MAT_LIMITS.numericElements).toBe(64);
  });
});

describe("the generated reference", () => {
  const generated = renderScreenCopyDocs();
  const walk = walkCopy();

  test("every walked entry is rendered: its anchor is a heading id, once, with its words", () => {
    const ids = headingIds(generated);
    const missing: string[] = [];
    for (const found of walk.found) {
      for (const [, e] of found.entries) {
        const count = ids.filter((id) => id === e.anchor).length;
        // A group shares one anchor, held by its section heading.
        if (count !== 1) missing.push(`${found.name}: ${e.anchor} x${count}`);
        for (const part of [e.statement, e.read, e.remedy]) {
          if (!generated.includes(md(part))) missing.push(`${found.name}: ${e.anchor}: ${part}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("sections come in the card's order", () => {
    const at = (title: string) => generated.indexOf(`## ${title}`);
    const order = Object.values(SECTIONS)
      .filter((meta) => meta.shape === "table")
      .map((meta) => at(meta.title));
    expect(order.every((position) => position > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(generated.indexOf('<h2 id="local-run">')).toBeGreaterThan(Math.max(...order));
  });

  test("every table entry says how to reproduce it", () => {
    const bad: string[] = [];
    for (const found of walk.found.filter((f) => f.shape === "table")) {
      for (const [, e] of found.entries) {
        const start = generated.indexOf(`id="${e.anchor}"`);
        const next = generated.slice(start + 1).search(/<h[23]\b/);
        const section = generated.slice(start, next === -1 ? undefined : start + 1 + next);
        if (!section.includes("Reproduce: `nemar dataset screen --committed`")) bad.push(e.anchor);
      }
    }
    expect(bad).toEqual([]);
  });

  test("it names the formats with and without a reader, from the registry", () => {
    expect(generated).toContain("## Formats the screen reads");
    expect(generated).toContain("| MATLAB | `.mat` |");
    expect(generated).toContain("## Formats with no reader");
    expect(generated).toMatch(/`\.nwb`/);
    expect(generated).toContain("See also: [Verdict words](#verdict-words)");
  });

  test("the output is deterministic and has no timestamp", () => {
    expect(renderScreenCopyDocs()).toBe(generated);
    expect(generated).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  test("entries are sorted within each section", () => {
    const sections = generated.split(/^## /m).slice(1);
    for (const section of sections) {
      const own = headingIds(section.replace(/^[^\n]*\n/, "")).filter((id) =>
        /^(status|kind|incomplete|failure|note)-/.test(id),
      );
      expect(own).toEqual([...own].sort());
    }
  });

  test("a heading label and an anchor are HTML-escaped", () => {
    expect(escapeHtml('<img src=x onerror="1">&')).toBe(
      "&lt;img src=x onerror=&quot;1&quot;&gt;&amp;",
    );
    const ns: Namespace = {
      ...copy,
      NOTE_COPY: { "<img src=x onerror=1>": entry("note-hostile") },
    };
    const out = renderScreenCopyDocs(ns);
    expect(out).toContain('<h3 id="note-hostile"><code>&lt;img src=x onerror=1&gt;</code></h3>');
    expect(out).not.toContain("<img");
  });
});

describe("md() on hostile strings", () => {
  /** The text outside code spans, which is where Markdown and HTML act. */
  const outside = (text: string) =>
    text
      .split(/(`[^`]*`)/)
      .filter((_, i) => i % 2 === 0)
      .join("");
  const hostile = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "a | b | c",
    "*bold* and **more**",
    "a `code` and a lone ` tick",
    "[link](javascript:alert(1)) and ![img](x)",
    "[a1](https://example.com)",
    "tom & jerry &lt; &#60;",
    "line one\n# heading\n- item",
    "# heading at the start",
    "- list at the start",
    "1. numbered at the start",
    "back\\slash \\*not bold\\*",
    "<!-- comment --> text",
  ];

  test("nothing outside a code span can be Markdown or HTML syntax", () => {
    for (const text of hostile) {
      const out = outside(md(text));
      expect({ text, bad: out.match(/(?<!\\)[<>*|`[\]]/)?.[0] ?? null }).toEqual({
        text,
        bad: null,
      });
      expect({ text, bad: out.match(/&(?!amp;|lt;|gt;)/)?.[0] ?? null }).toEqual({
        text,
        bad: null,
      });
      expect(md(text)).not.toContain("\n");
      expect(md(text)).not.toMatch(/^(\s*)(#|-|\+|\d+[.)])/);
    }
  });

  test("escapes the characters it names", () => {
    expect(md("a & b < c > d * e | f ` g")).toBe("a &amp; b &lt; c &gt; d \\* e \\| f \\` g");
  });

  test("copy words that are syntax are kept as code", () => {
    expect(md("Run with --committed to read it.")).toBe("Run with `--committed` to read it.");
    expect(md("or run 'nemar dataset publish status <id>', to see")).toBe(
      "or run `nemar dataset publish status <id>`, to see",
    );
    expect(md("the [Comment] section")).toBe("the `[Comment]` section");
    expect(md("plain words, a-b and sub-01")).toBe("plain words, a-b and sub-01");
  });

  test("a dotfile or a name with underscores is one code span", () => {
    expect(
      md("Remove them (.idea, .vscode, __pycache__, .DS_Store and the like) and upload."),
    ).toBe("Remove them (.idea, .vscode, `__pycache__`, `.DS_Store` and the like) and upload.");
    expect(md("the acq_time column.")).toBe("the `acq_time` column.");
    expect(md("ends with .DS_Store.")).toBe("ends with `.DS_Store`.");
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
