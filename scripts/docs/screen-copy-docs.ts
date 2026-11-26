/**
 * Print the identifier-screen reference for docs.nemar.org from the copy tables (card A10, ADR 0045).
 *
 * `shared/identifier-screen-copy.ts` declares every sentence the screen says: a statement, what was
 * read, the remedy and the docs anchor of each state, finding kind, incomplete reason, read failure,
 * reader note and local-run line. This script writes those entries, as Markdown, between two markers
 * of the docs page, so the page cannot say anything the CLI and the mails do not. A new entry in a
 * table reaches the page by running this script again, with no change here.
 *
 * Usage:
 *   bun run scripts/docs/screen-copy-docs.ts --out <docs checkout>/src/content/docs/platform/identifier-screening.md
 *   bun run scripts/docs/screen-copy-docs.ts            (prints the generated block)
 *
 * The output is deterministic: sorted within each section, no timestamp, no environment. It refuses
 * to write when the page lacks either marker, so a page edit cannot make it append at the end.
 *
 * Anchors. The docs site (Astro Starlight) has no `{#id}` heading syntax, so each entry is a raw
 * HTML heading with an explicit `id`; the id is the anchor the code links to (`docsLink`). Raw HTML
 * is kept as written by the Markdown mirror (`<path>.md`), where the id stays visible too.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Copy,
  INCOMPLETE_COPY,
  KIND_COPY,
  LINES,
  LOCAL_ANCHOR,
  LOCAL_COPY,
  NOTE_COPY,
  READ_FAILURE_COPY,
  STATUS_COPY,
  type StateCopy,
} from "../../shared/identifier-screen-copy";

export const START_MARKER = "<!-- generated:identifier-screen:start -->";
export const END_MARKER = "<!-- generated:identifier-screen:end -->";

/** The command that reproduces a screen on a person's own machine (card A9). */
const REPRODUCE = "nemar dataset screen --committed";

/** Every table with anchored entries, in the order the page prints them. */
export interface Section {
  /** The page's heading for the section. Its own auto-generated id must not clash with an anchor. */
  title: string;
  /** One sentence that says what the section lists. */
  intro: string;
  /** The tables's entries as [name, copy] pairs, sorted by name. */
  entries: [string, Copy][];
  /** What a heading shows for an entry. */
  label: (name: string, copy: Copy) => string;
  /** One extra line under the statement, if the section has one. */
  extra?: (name: string, copy: Copy) => string | null;
}

const sorted = <T extends Copy>(table: Record<string, T>): [string, T][] =>
  Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export const SECTIONS: Section[] = [
  {
    title: "Screen states, one by one",
    intro:
      "Every state a screen can end in, with the words each surface prints for it. A state is a verdict, or a request-time state that is not one.",
    entries: sorted(STATUS_COPY),
    label: (name) => name,
    extra: (_, copy) => `Printed as: ${(copy as StateCopy).verdict}.`,
  },
  {
    title: "Finding kinds, one by one",
    intro:
      "Every kind of finding the scanner reports. A report names kinds and counts, never a value, a file name or a path.",
    entries: sorted(KIND_COPY),
    label: (name) => name,
  },
  {
    title: "Why a screen is incomplete",
    intro:
      "Every reason a screen can fall short of reading everything it should have. An incomplete screen is never clean.",
    entries: sorted(INCOMPLETE_COPY),
    label: (name) => name,
  },
  {
    title: "Why a read failed",
    intro:
      "Every class of read failure. A file that failed to read is unread, and an unread file makes the screen incomplete.",
    entries: sorted(READ_FAILURE_COPY),
    label: (name) => name,
  },
  {
    title: "Reader notes",
    intro:
      "Notes a reader makes that are neither findings nor gaps. They are counted and printed with a remedy, and never change a verdict.",
    entries: sorted(NOTE_COPY),
    label: (name) => name,
  },
];

/** The anchor every entry of every section carries, plus the local run's. For the anchor test. */
export function allAnchors(): string[] {
  const out = new Set<string>([LOCAL_ANCHOR]);
  for (const section of SECTIONS) for (const [, copy] of section.entries) out.add(copy.anchor);
  return [...out].sort();
}

/**
 * Make a copy sentence safe to put in Markdown. The tables hold plain sentences with a few
 * characters Markdown reads as syntax: a flag (`--committed`, which the site's smart punctuation
 * would turn into a dash), a name with underscores, a `<placeholder>`, a `[Section]` name and a
 * quoted command. Each of those becomes code; nothing else is changed.
 */
export function md(text: string): string {
  const quoted = text.replace(
    /'((?:nemar|git) [^'`]*)'/g,
    (_, command: string) => `\`${command}\``,
  );
  return quoted
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/(?<![\w-])(--[a-z][a-z-]*)/g, "`$1`")
            .replace(/(?<![\w])(\w*_\w*)(?![\w])/g, "`$1`")
            .replace(/(\[[A-Za-z ]+\])/g, "`$1`")
            .replace(/(<[a-z][a-z-]*>)/g, "`$1`"),
    )
    .join("");
}

/** A sentence that ends in a full stop. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The statement, what was read and the remedy of one entry, as Markdown. */
function body(copy: Copy, extra: string | null, reproduce: string): string[] {
  return [
    md(copy.statement),
    "",
    ...(extra === null ? [] : [md(extra), ""]),
    `- What was read: ${md(sentence(copy.read))}`,
    `- Remedy: ${md(sentence(copy.remedy))}`,
    `- Reproduce: \`${reproduce}\``,
    "",
  ];
}

function renderSection(section: Section): string[] {
  const out = [`## ${section.title}`, "", section.intro, ""];
  for (const [name, copy] of section.entries) {
    out.push(
      `<h3 id="${copy.anchor}"><code>${section.label(name, copy)}</code></h3>`,
      "",
      ...body(copy, section.extra?.(name, copy) ?? null, REPRODUCE),
    );
  }
  return out;
}

/** The sentence of a local-run entry, with its count made plural for the page. */
function renderLocal(): string[] {
  const entries: [string, Copy][] = [
    ["the committed tree", LOCAL_COPY.committed],
    ["the working tree", LOCAL_COPY.workingTree],
    ["a directory with no history", LOCAL_COPY.noHistory],
    ["earlier recordings with no content here", LOCAL_COPY.supersededAbsent(2)],
    ["the server's own copy", LOCAL_COPY.server],
  ];
  const errors = Object.entries(LOCAL_COPY.errors).map(([name, text]) => [
    name,
    typeof text === "function" ? text("a fixed word naming the failure") : text,
  ]);
  const out = [
    `<h2 id="${LOCAL_ANCHOR}">Reproducing a screen on your own machine</h2>`,
    "",
    "`nemar dataset screen` runs the same scan on a dataset directory on your machine and prints the same report. It sends nothing, needs no login and changes no file.",
    "`--committed` reads the tree of the last commit, which is what the publication screen reads.",
    "",
    "Its first line says which tree was read, and a second line says what kind of scanner id the run carries:",
    "",
    `- ${md(LOCAL_COPY.banner("committed", "<commit>", "<version>"))}`,
    `- ${md(LOCAL_COPY.banner("working-tree", "<commit>", "<version>"))}`,
    `- ${md(LOCAL_COPY.scannerKind("checkout", "<id>"))}`,
    `- ${md(LOCAL_COPY.scannerKind("release", "<id>"))}`,
    "",
    "What a local run says about itself:",
    "",
  ];
  for (const [label, copy] of entries) {
    out.push(
      `- **${label}.** ${md(copy.statement)}`,
      `  - What was read: ${md(sentence(copy.read))}`,
      `  - Remedy: ${md(sentence(copy.remedy))}`,
    );
  }
  out.push("", "When no screen can be made, the command says why:", "");
  for (const [name, text] of errors) {
    out.push(`- \`${name}\`: ${md(String(text))}`);
  }
  out.push(
    "",
    `Reproduce: \`${REPRODUCE}\`, or \`nemar dataset screen\` to read the files as they are now.`,
    "",
  );
  return out;
}

/** The generated block's text, without the markers. */
export function renderScreenCopyDocs(): string {
  const lines = [
    "## Every statement the screen makes",
    "",
    "The sections below are generated from the one module that words the screen (`shared/identifier-screen-copy.ts` in `nemarOrg/nemar-cli`), so a sentence here is the sentence the command line, the report and the mails print.",
    "Each entry says what was found, what the scanner read to say it, what to do about it, and how to reproduce it.",
    "Entries are sorted by name, and each carries the anchor that links in the screen's output point to.",
    `The screen also says what it does not read, in these words: \`${LINES.notRead}\``,
    "The rest of what it does not cover is under [Honest limits](#honest-limits).",
    "",
  ];
  for (const section of SECTIONS) lines.push(...renderSection(section));
  lines.push(...renderLocal());
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** Replace what sits between the markers of a page. Throws when either marker is missing or repeated. */
export function spliceGenerated(page: string, generated: string): string {
  const count = (marker: string) => page.split(marker).length - 1;
  if (count(START_MARKER) !== 1 || count(END_MARKER) !== 1) {
    throw new Error(
      `the page must hold the markers ${START_MARKER} and ${END_MARKER} exactly once each`,
    );
  }
  const start = page.indexOf(START_MARKER);
  const end = page.indexOf(END_MARKER);
  if (end < start) throw new Error("the end marker comes before the start marker");
  return `${page.slice(0, start + START_MARKER.length)}\n\n${generated}\n${page.slice(end)}`;
}

function main(argv: string[]): number {
  const outIndex = argv.indexOf("--out");
  const generated = renderScreenCopyDocs();
  if (outIndex === -1) {
    process.stdout.write(generated);
    return 0;
  }
  const out = argv[outIndex + 1];
  if (!out || out.startsWith("--")) {
    console.error("--out needs the path of the docs page");
    return 2;
  }
  if (!existsSync(out)) {
    console.error(`no such file: ${out}`);
    return 2;
  }
  const before = readFileSync(out, "utf8");
  let after: string;
  try {
    after = spliceGenerated(before, generated);
  } catch (error) {
    console.error(`${out}: ${(error as Error).message}`);
    return 1;
  }
  if (after === before) {
    console.log(`${out}: up to date`);
    return 0;
  }
  writeFileSync(out, after);
  console.log(`${out}: regenerated`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
