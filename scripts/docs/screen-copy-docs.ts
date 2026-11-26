/**
 * Print the identifier-screen reference for docs.nemar.org from the copy tables (card A10, ADR 0045).
 *
 * `shared/identifier-screen-copy.ts` declares every sentence the screen says: a statement, what was
 * read, the remedy and the docs anchor of each state, finding kind, incomplete reason, read failure,
 * reader note and local-run line. This script writes those entries, as Markdown, between two markers
 * of the docs page, so the page cannot say anything the CLI and the mails do not.
 *
 * Nothing is listed by hand. {@link walkCopy} walks every export of the copy module and finds what
 * has the shape `{ statement, read, remedy, anchor }`: a table of such entries, a group of them one
 * level down (`LOCAL_COPY`, whose function members are probed), or a single one. Each is rendered
 * under a section declared in {@link SECTIONS}, in the order of the card. A new entry in a known
 * table reaches the page by running this script again, with no change here; an exported table the
 * script has no section for makes it throw (and the test fail), rather than be left out or
 * appended unseen. The formats the screen reads come from the reader registry in the same way.
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
import { READERS } from "../../shared/identifier-readers";
import { DIRECTORY_FORMATS, OTHER_RECORDING_EXTENSIONS } from "../../shared/identifier-scan";
import * as copyModule from "../../shared/identifier-screen-copy";

export const START_MARKER = "<!-- generated:identifier-screen:start -->";
export const END_MARKER = "<!-- generated:identifier-screen:end -->";

/** The command that reproduces a screen on a person's own machine (card A9). */
const REPRODUCE = "nemar dataset screen --committed";

/** What the walk reads: the copy module, or anything shaped like it (a test passes its own). */
export type Namespace = Record<string, unknown>;

/** Anything with the four fields of a copy entry (a state entry has two more). */
export interface CopyLike {
  statement: string;
  read: string;
  remedy: string;
  anchor: string;
  verdict?: string;
}

const isCopy = (value: unknown): value is CopyLike => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.statement === "string" &&
    typeof v.read === "string" &&
    typeof v.remedy === "string" &&
    typeof v.anchor === "string"
  );
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A named set of copy entries found in one export. */
export interface Found {
  /** The export's name. */
  name: string;
  /** `table`: every value is an entry. `group`: some members are, or return, an entry. */
  shape: "table" | "group";
  entries: [string, CopyLike][];
}

export interface Walk {
  found: Found[];
  /** Exports that are one entry on their own. */
  singles: [string, CopyLike][];
}

/** A function member of a group is called once with a count, to see whether it returns an entry. */
function probe(member: unknown): CopyLike | null {
  if (typeof member !== "function") return null;
  try {
    const result = (member as (n: number) => unknown)(2);
    return isCopy(result) ? result : null;
  } catch {
    return null;
  }
}

/** Walk every export of a copy module and find what has the shape of a copy entry. */
export function walkCopy(ns: Namespace = copyModule): Walk {
  const found: Found[] = [];
  const singles: [string, CopyLike][] = [];
  for (const [name, value] of Object.entries(ns)) {
    if (isCopy(value)) {
      singles.push([name, value]);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const members = Object.entries(value as Record<string, unknown>);
    if (members.length > 0 && members.every(([, member]) => isCopy(member))) {
      found.push({
        name,
        shape: "table",
        entries: members.map(([key, member]) => [key, member as CopyLike]),
      });
      continue;
    }
    const entries = members.flatMap(([key, member]): [string, CopyLike][] => {
      const entry = isCopy(member) ? member : probe(member);
      return entry === null ? [] : [[key, entry]];
    });
    if (entries.length > 0) found.push({ name, shape: "group", entries });
  }
  return { found, singles };
}

/** How one known export is printed. The order of {@link SECTIONS} is the order on the page. */
export interface SectionMeta {
  /** The page's heading for the section (its auto id must not clash with an anchor). */
  title: string;
  /** One sentence that says what the section lists. */
  intro: string;
  shape: "table" | "group";
}

export const SECTIONS: Record<string, SectionMeta> = {
  STATUS_COPY: {
    title: "Screen states, one by one",
    intro:
      "Every state a screen can end in, with the words each surface prints for it. A state is a verdict, or a request-time state that is not one.",
    shape: "table",
  },
  KIND_COPY: {
    title: "Finding kinds, one by one",
    intro:
      "Every kind of finding the scanner reports. A report names kinds and counts, never a value, a file name or a path.",
    shape: "table",
  },
  INCOMPLETE_COPY: {
    title: "Why a screen is incomplete",
    intro:
      "Every reason a screen can fall short of reading everything it should have. An incomplete screen is never clean.",
    shape: "table",
  },
  READ_FAILURE_COPY: {
    title: "Why a read failed",
    intro:
      "Every class of read failure. A file that failed to read is unread, and an unread file makes the screen incomplete.",
    shape: "table",
  },
  NOTE_COPY: {
    title: "Reader notes",
    intro:
      "Notes a reader makes that are neither findings nor gaps. They are counted and printed with a remedy, and never change a verdict.",
    shape: "table",
  },
  LOCAL_COPY: {
    title: "Reproducing a screen on your own machine",
    intro: "",
    shape: "group",
  },
};

/** What a local-run entry is called in the list, by its member name. Others use the member name. */
const LOCAL_LABELS: Record<string, string> = {
  committed: "the committed tree",
  workingTree: "the working tree",
  noHistory: "a directory with no history",
  supersededAbsent: "earlier recordings with no content here",
  server: "the server's own copy",
};

/**
 * The exports that hold copy entries and have no section here. Not an error of the walk, an
 * error of the script: a new table needs a section, a title and a place in the order.
 */
export function unrendered(walk: Walk): string[] {
  const names = [
    ...walk.found.filter((f) => !(f.name in SECTIONS)).map((f) => f.name),
    ...walk.singles.map(([name]) => name),
  ];
  // A section the module no longer exports is as wrong: its entries vanish from the page.
  for (const name of Object.keys(SECTIONS)) {
    if (!walk.found.some((f) => f.name === name))
      names.push(`${name} (declared here, not exported)`);
  }
  // A table that turned into a group (or back) would render under the wrong rules.
  for (const f of walk.found) {
    const declared = SECTIONS[f.name]?.shape;
    if (declared !== undefined && declared !== f.shape) {
      names.push(`${f.name} (is a ${f.shape}, declared as a ${declared})`);
    }
  }
  return names.sort(byName);
}

/** Every anchor the walk found, sorted and distinct. For the anchor test. */
export function allAnchors(ns: Namespace = copyModule): string[] {
  const walk = walkCopy(ns);
  const anchors = new Set<string>();
  for (const f of walk.found) for (const [, entry] of f.entries) anchors.add(entry.anchor);
  for (const [, entry] of walk.singles) anchors.add(entry.anchor);
  return [...anchors].sort(byName);
}

// ---------------------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------------------

/** HTML-escape text that goes into an element or an attribute of a raw heading. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An anchor is a fragment the code links to: lowercase letters, digits and hyphens only. */
export const ANCHOR_FORM = /^[a-z0-9-]+$/;

function assertAnchor(anchor: string): string {
  if (!ANCHOR_FORM.test(anchor))
    throw new Error(`anchor "${escapeHtml(anchor)}" is not [a-z0-9-]+`);
  return anchor;
}

interface Segment {
  code: boolean;
  text: string;
}

/**
 * The copy tables hold plain sentences with a few spans Markdown would read as syntax: a flag
 * (`--committed`, which the site's smart punctuation turns into a dash), a name with underscores
 * (`__pycache__`, `.DS_Store`, `acq_time`), a `<placeholder>`, a `[Section]` name and a quoted
 * command. Those, in this order, become code.
 */
const CODE_SPANS: { pattern: RegExp; group: number }[] = [
  { pattern: /'((?:nemar|git) [^']*)'/g, group: 1 },
  { pattern: /(?<![\w-])(--[a-z][a-z-]*)/g, group: 1 },
  { pattern: /(?<![\w.])(\.?\w*_\w*(?:\.\w+)*)/g, group: 1 },
  { pattern: /(\[[A-Za-z ]+\])/g, group: 1 },
  { pattern: /(<[a-z][a-z-]*>)/g, group: 1 },
];

/** Split the plain segments of a list on a pattern; its group becomes code, the rest stays. */
function splitCode(segments: Segment[], { pattern, group }: { pattern: RegExp; group: number }) {
  return segments.flatMap((segment): Segment[] => {
    if (segment.code) return [segment];
    const out: Segment[] = [];
    let last = 0;
    for (const match of segment.text.matchAll(pattern)) {
      const index = match.index as number;
      if (index > last) out.push({ code: false, text: segment.text.slice(last, index) });
      out.push({ code: true, text: match[group] as string });
      last = index + match[0].length;
    }
    if (last < segment.text.length) out.push({ code: false, text: segment.text.slice(last) });
    return out;
  });
}

/** Escape what Markdown or HTML would read as syntax in plain text. */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*|[\]]/g, (c) => `\\${c}`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^(\s*)([#+-]|\d+[.)])/, "$1\\$2");
}

/**
 * A copy sentence as Markdown: code spans where the sentence holds syntax-like words, and every
 * other character of Markdown or HTML that could change the page's structure escaped. Any
 * backtick in the input is plain text (nothing in the tables is meant as code), and a line break
 * becomes a space, so no input can open a heading, a list, a link, a tag or a table cell.
 */
export function md(text: string): string {
  let segments: Segment[] = [{ code: false, text: text.replace(/\s+/g, " ") }];
  for (const rule of CODE_SPANS) segments = splitCode(segments, rule);
  return segments
    .map((segment) =>
      segment.code ? `\`${segment.text.replace(/`/g, "")}\`` : escapeText(segment.text),
    )
    .join("");
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

/** A sentence that ends in a full stop. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

function renderTable(meta: SectionMeta, found: Found): string[] {
  const out = [`## ${meta.title}`, "", meta.intro, ""];
  for (const [name, entry] of [...found.entries].sort(([a], [b]) => byName(a, b))) {
    out.push(
      `<h3 id="${escapeHtml(assertAnchor(entry.anchor))}"><code>${escapeHtml(name)}</code></h3>`,
      "",
      md(entry.statement),
      "",
    );
    if (typeof entry.verdict === "string") out.push(`Printed as: ${md(entry.verdict)}.`, "");
    out.push(
      `- What was read: ${md(sentence(entry.read))}`,
      `- Remedy: ${md(sentence(entry.remedy))}`,
      `- Reproduce: \`${REPRODUCE}\``,
      "",
    );
  }
  return out;
}

function renderLocal(ns: Namespace, found: Found): string[] {
  const anchors = new Set(found.entries.map(([, entry]) => entry.anchor));
  if (anchors.size !== 1) {
    throw new Error(
      `${found.name} carries ${anchors.size} anchors; the page has one section for it`,
    );
  }
  const anchor = assertAnchor([...anchors][0] as string);
  const local = ns[found.name] as typeof copyModule.LOCAL_COPY;
  const out = [
    `<h2 id="${escapeHtml(anchor)}">${escapeHtml(SECTIONS[found.name]?.title ?? found.name)}</h2>`,
    "",
    "`nemar dataset screen` runs the same scan on a dataset directory on your machine and prints the same report.",
    "It sends nothing, needs no login and changes no file.",
    "`--committed` reads the tree of the last commit, which is what the publication screen reads.",
    "",
    "Its first line says which tree was read, and a second line says what kind of scanner id the run carries:",
    "",
    `- ${md(local.banner("committed", "<commit>", "<version>"))}`,
    `- ${md(local.banner("working-tree", "<commit>", "<version>"))}`,
    `- ${md(local.scannerKind("checkout", "<id>"))}`,
    `- ${md(local.scannerKind("release", "<id>"))}`,
    "",
    "What a local run says about itself:",
    "",
  ];
  const rank = (key: string) => {
    const index = Object.keys(LOCAL_LABELS).indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const members = [...found.entries].sort(([a], [b]) => rank(a) - rank(b) || byName(a, b));
  for (const [key, entry] of members) {
    out.push(
      `- **${md(LOCAL_LABELS[key] ?? key)}.** ${md(entry.statement)}`,
      `  - What was read: ${md(sentence(entry.read))}`,
      `  - Remedy: ${md(sentence(entry.remedy))}`,
    );
  }
  out.push("", "When no screen can be made, the command says why:", "");
  for (const [name, text] of Object.entries(local.errors)) {
    const said = typeof text === "function" ? text("a fixed word naming the failure") : text;
    out.push(`- \`${name.replace(/`/g, "")}\`: ${md(said)}`);
  }
  out.push(
    "",
    `Reproduce: \`${REPRODUCE}\`, or \`nemar dataset screen\` to read the files as they are now.`,
    "",
  );
  return out;
}

/** The formats with a reader and the formats without, from the reader registry. */
function renderFormats(ns: Namespace): string[] {
  const labels = (ns.READER_LABEL ?? {}) as Record<string, string>;
  const withReader = new Set(READERS.flatMap((reader) => reader.extensions));
  const without = [
    ...OTHER_RECORDING_EXTENSIONS.filter((extension) => !withReader.has(extension)),
    ...DIRECTORY_FORMATS.map((extension) => `${extension}/`),
  ].sort(byName);
  return [
    "## Formats the screen reads",
    "",
    "A format is read when a reader is registered for its extension.",
    "A reader reads headers and metadata, and a signal is skipped by size and never read.",
    "",
    "| Reader | Extensions |",
    "| --- | --- |",
    ...READERS.map(
      (reader) =>
        `| ${md(labels[reader.id] ?? reader.id)} | ${[...reader.extensions].map((e) => `\`${e}\``).join(", ")} |`,
    ),
    "",
    "## Formats with no reader",
    "",
    "A recording in one of these formats is counted by format and never opened.",
    "A dataset that holds one is not clean; its state says that recordings were not screened.",
    "The EEGLAB `.fdt` file is listed because it is never read: it holds a recording's signal, and its `.set` file is read.",
    "",
    without.map((extension) => `\`${extension}\``).join(", "),
    "",
  ];
}

/** The generated block's text, without the markers. Throws when an export has no section. */
export function renderScreenCopyDocs(ns: Namespace = copyModule): string {
  const walk = walkCopy(ns);
  const missing = unrendered(walk);
  if (missing.length > 0) {
    throw new Error(
      `exports of the copy module with no section in scripts/docs/screen-copy-docs.ts: ${missing.join(", ")}`,
    );
  }
  const lines = [
    "## Every statement the screen makes",
    "",
    "The sections below are generated from the one module that words the screen (`shared/identifier-screen-copy.ts` in `nemarOrg/nemar-cli`) and from its reader registry, so a sentence here is the sentence the command line, the report and the mails print.",
    "Each entry says what was found, what the scanner read to say it, what to do about it, and how to reproduce it.",
    "Entries are sorted by name, and each carries the anchor that links in the screen's output point to.",
    `The screen also says what it does not read, in these words: \`${(ns.LINES as typeof copyModule.LINES).notRead}\``,
    "The rest of what it does not cover is under [Honest limits](#honest-limits).",
    "See also: [Verdict words](#verdict-words), which says what each verdict means and what happens next.",
    "",
    ...renderFormats(ns),
  ];
  for (const name of Object.keys(SECTIONS)) {
    const found = walk.found.find((f) => f.name === name) as Found;
    const meta = SECTIONS[name] as SectionMeta;
    lines.push(...(meta.shape === "group" ? renderLocal(ns, found) : renderTable(meta, found)));
  }
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
  let generated: string;
  try {
    generated = renderScreenCopyDocs();
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
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
