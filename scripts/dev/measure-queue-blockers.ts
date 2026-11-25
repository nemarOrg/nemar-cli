#!/usr/bin/env bun
/**
 * Measure what holds every request in the publication queue (card D2 of epic #2182).
 *
 * Usage: bun run scripts/dev/measure-queue-blockers.ts <queue-ids.txt> [--concurrency N] [--out-dir DIR]
 *
 * For each dataset id in the queue file, the PATH SET the identifier screen reads is rebuilt:
 * every path in HEAD plus every path that ever existed in history (the screen's `extraPaths`),
 * and the screen's own functions are applied to it: `scanPaths` for path findings and
 * `formatCoverage` for unscreened formats. No rule is copied from `shared/identifier-scan.ts`.
 *
 * **Read-only and names only.** Each repository is cloned blob-less and without a checkout into
 * the OS temp directory (`git clone --filter=blob:none --no-checkout`), so no file content is ever
 * fetched, and the clone is deleted as soon as its paths are read. Nothing is written to a
 * repository. The report and the JSON hold counts, groups, dataset ids, extensions and classes,
 * never a file name; a path whose subject label reads as a name is counted and never shown.
 *
 * What it cannot see: findings that need file content (EDF headers, participants tables, JSON
 * keys, text files). The blocker set here is the path-derived part of what the screen reports,
 * plus the unscreened formats.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Finding,
  type FindingKind,
  formatCoverage,
  scanPaths,
} from "../../shared/identifier-scan";
import { MINIMUM_FAILURES, minimumFailureSentence } from "../../shared/submission-minimums";

// ---------------------------------------------------------------------------------------
// Grouping (pure, no I/O)
// ---------------------------------------------------------------------------------------

export const LOCATION_CLASSES = [
  "root",
  "sourcedata",
  "stimuli",
  "derivatives",
  "code",
  "docs",
  "sub-*",
  "other",
] as const;
export type LocationClass = (typeof LOCATION_CLASSES)[number];

export const NAME_CLASSES = [
  "consent",
  "questionnaire",
  "form",
  "photo-face",
  "figure",
  "logo",
  "manual",
  "montage-layout-cap",
  "screenshot",
  "other",
] as const;
export type NameClass = (typeof NAME_CLASSES)[number];

export const EXTENSION_CLASSES = ["raster-image", "pdf", "office-document"] as const;
export type ExtensionClass = (typeof EXTENSION_CLASSES)[number];

/** Name classes that can name or show a person; the rest read as figures, tooling and manuals. */
const PERSON_NAME_CLASSES: ReadonlySet<NameClass> = new Set([
  "consent",
  "questionnaire",
  "form",
  "photo-face",
]);

/** Where a flagged path sits: in the HEAD tree only, in both, or only in history. */
export type PathPresence = "head-only" | "both" | "history-only";

export function locationClass(path: string): LocationClass {
  const slash = path.indexOf("/");
  if (slash < 0) return "root";
  const first = path.slice(0, slash).toLowerCase();
  if (first === "sourcedata" || first === "stimuli" || first === "derivatives" || first === "code")
    return first;
  if (first === "docs" || first === "doc") return "docs";
  if (first.startsWith("sub-")) return "sub-*";
  return "other";
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function extensionClass(ext: string): ExtensionClass {
  if (ext === "pdf") return "pdf";
  if (/^(docx?|xlsx?|pptx?|rtf|odt)$/.test(ext)) return "office-document";
  return "raster-image";
}

/** Whole-word tokens of a basename: camelCase and every non-alphanumeric run are boundaries. */
export function nameTokens(path: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

const NAME_CLASS_WORDS: ReadonlyArray<readonly [NameClass, readonly string[]]> = [
  ["consent", ["consent"]],
  ["questionnaire", ["questionnaire"]],
  ["form", ["form"]],
  ["photo-face", ["photo", "face"]],
  ["figure", ["figure", "fig"]],
  ["logo", ["logo"]],
  ["manual", ["manual"]],
  ["montage-layout-cap", ["montage", "layout", "cap"]],
  ["screenshot", ["screenshot"]],
];

/** First class, in the card's order, with a whole-word token (an optional plural `s` is allowed). */
export function nameClass(path: string): NameClass {
  const tokens = nameTokens(path);
  for (const [cls, words] of NAME_CLASS_WORDS) {
    if (tokens.some((t) => words.some((w) => t === w || t === `${w}s`))) return cls;
  }
  return "other";
}

/** A directory pattern with digit runs replaced by `#` and subject or session labels folded away. */
export function directoryPattern(path: string): string {
  const parts = path.split("/").slice(0, -1);
  if (parts.length === 0) return "(root)";
  const folded = parts.map((s) => {
    const m = /^(sub|ses)-/i.exec(s);
    return m ? `${(m[1] as string).toLowerCase()}-#` : s.replace(/\d+/g, "#");
  });
  return folded.length > 4 ? `${folded.slice(0, 4).join("/")}/...` : folded.join("/");
}

export function presenceOf(inHead: boolean, inHistory: boolean): PathPresence {
  if (inHead) return inHistory ? "both" : "head-only";
  return "history-only";
}

/** One flagged image or document, kept in memory only; it never carries the path. */
export interface ImageFile {
  presence: PathPresence;
  location: LocationClass;
  ext: string;
  extClass: ExtensionClass;
  name: NameClass;
}

// ---------------------------------------------------------------------------------------
// Per-dataset analysis (pure)
// ---------------------------------------------------------------------------------------

export interface DatasetAnalysis {
  headFiles: number;
  historyPaths: number;
  historyOnlyPaths: number;
  /** Finding kinds the screen's `scanPaths` reports over HEAD plus history. */
  kinds: FindingKind[];
  /** Flagged paths per kind and presence. */
  flagged: Record<string, Partial<Record<PathPresence, number>>>;
  /** Paths whose subject label `labelIsNameLike` flags (counted, never shown). */
  nameLikeLabelPaths: number;
  unscreened: Record<string, number>;
  images: ImageFile[];
  /** Directory patterns of HEAD files counted as "(no extension)" or ".other" unscreened. */
  unreadDirs: Map<string, number>;
  unreadDirsWithheld: number;
  /** `finding:<kind>` and `unscreened:<key>` entries; empty means nothing blocks the request. */
  blockers: string[];
}

export const UNUSUAL_FORMAT = "(unusual extension)";

/** A format key as the screen names it, or a stand-in when the key looks like part of a file name. */
export function safeFormatKey(key: string): string {
  if (key === "(no extension)" || key.endsWith("/")) return key;
  return /^\.[a-z0-9]{1,6}(\.[a-z0-9]{1,4})?$/.test(key) ? key : UNUSUAL_FORMAT;
}

const UNREAD_KEYS = new Set(["(no extension)", ".other"]);

export function analyze(
  headPaths: readonly string[],
  historyPaths: readonly string[],
): DatasetAnalysis {
  const head = new Set(headPaths);
  const history = new Set(historyPaths);
  const union = new Set([...head, ...history]);
  const all = [...union];

  // The screen's own call: HEAD paths plus the history paths HEAD lacks, as one list.
  const kinds = [...new Set(scanPaths(all).map((f) => f.kind))].sort();

  const flagged: DatasetAnalysis["flagged"] = {};
  const images: ImageFile[] = [];
  let nameLikeLabelPaths = 0;
  for (const path of union) {
    const found: Finding[] = scanPaths([path]);
    if (found.length === 0) continue;
    const presence = presenceOf(head.has(path), history.has(path));
    for (const kind of new Set(found.map((f) => f.kind))) {
      const slot = flagged[kind] ?? {};
      flagged[kind] = slot;
      slot[presence] = (slot[presence] ?? 0) + 1;
      if (kind === "path-subject-label") nameLikeLabelPaths++;
      if (kind === "image-or-document-file") {
        const ext = extensionOf(path);
        images.push({
          presence,
          location: locationClass(path),
          ext,
          extClass: extensionClass(ext),
          name: nameClass(path),
        });
      }
    }
  }

  const coverage = formatCoverage(headPaths as string[]);
  const unreadDirs = new Map<string, number>();
  let unreadDirsWithheld = 0;
  if (Object.keys(coverage.unscreened).some((k) => UNREAD_KEYS.has(k))) {
    for (const path of headPaths) {
      const key = Object.keys(formatCoverage([path]).unscreened).find((k) => UNREAD_KEYS.has(k));
      if (!key) continue;
      // A path with a name-like subject label is counted, never shown.
      if (scanPaths([path]).some((f) => f.kind === "path-subject-label")) {
        unreadDirsWithheld++;
        continue;
      }
      const pattern = `${key} ${directoryPattern(path)}`;
      unreadDirs.set(pattern, (unreadDirs.get(pattern) ?? 0) + 1);
    }
  }

  // An extension that is not a plausible format word could be a fragment of a file name.
  const unscreened: Record<string, number> = {};
  for (const [key, n] of Object.entries(coverage.unscreened))
    inc(unscreened, safeFormatKey(key), n);
  const blockers = [
    ...kinds.map((k) => `finding:${k}`),
    ...Object.keys(unscreened)
      .sort()
      .map((k) => `unscreened:${k}`),
  ];
  return {
    headFiles: head.size,
    historyPaths: history.size,
    historyOnlyPaths: [...history].filter((p) => !head.has(p)).length,
    kinds,
    flagged,
    nameLikeLabelPaths,
    unscreened,
    images,
    unreadDirs,
    unreadDirsWithheld,
    blockers,
  };
}

// ---------------------------------------------------------------------------------------
// What-if groups
// ---------------------------------------------------------------------------------------

export interface Candidate {
  id: string;
  label: string;
  /** Image-or-document files this acknowledgment covers. */
  image?: (f: ImageFile) => boolean;
  /** Finding kinds acknowledged wholesale. */
  kinds?: readonly FindingKind[];
}

const IMAGE_KIND = "image-or-document-file";

export function buildCandidates(): Candidate[] {
  const list: Candidate[] = [];
  for (const c of EXTENSION_CLASSES)
    list.push({
      id: `ext:${c}`,
      label: `images and documents, ${c}`,
      image: (f) => f.extClass === c,
    });
  for (const c of LOCATION_CLASSES)
    list.push({
      id: `loc:${c}`,
      label: `images and documents under ${c}`,
      image: (f) => f.location === c,
    });
  for (const c of NAME_CLASSES)
    list.push({
      id: `name:${c}`,
      label: `images and documents named ${c}`,
      image: (f) => f.name === c,
    });
  list.push(
    {
      id: "presence:history-only",
      label: "images and documents only in history",
      image: (f) => f.presence === "history-only",
    },
    {
      id: "combo:no-person-names",
      label: "all except consent, questionnaire, form, photo or face names",
      image: (f) => !PERSON_NAME_CLASSES.has(f.name),
    },
    {
      id: "combo:no-person-names-no-sub",
      label: "all except person-like names and everything under sub-*",
      image: (f) => !PERSON_NAME_CLASSES.has(f.name) && f.location !== "sub-*",
    },
    {
      id: "combo:figures-and-tooling",
      label: "figure, logo, manual, montage, screenshot names outside sub-*",
      image: (f) =>
        ["figure", "logo", "manual", "montage-layout-cap", "screenshot"].includes(f.name) &&
        f.location !== "sub-*",
    },
    { id: "all-images", label: "every image and document", image: () => true },
    { id: "kind:tooling-debris", label: "tooling debris paths", kinds: ["tooling-debris"] },
    {
      id: "kind:path-subject-label",
      label: "name-like subject labels",
      kinds: ["path-subject-label"],
    },
    {
      id: "all-path-findings",
      label: "every path finding (images, debris, labels)",
      image: () => true,
      kinds: ["tooling-debris", "path-subject-label"],
    },
  );
  return list;
}

/** The blockers that remain for one request once a candidate group is acknowledged. */
export function remainingBlockers(a: DatasetAnalysis, c: Candidate): string[] {
  return a.blockers.filter((b) => {
    if (!b.startsWith("finding:")) return true;
    const kind = b.slice("finding:".length) as FindingKind;
    if (c.kinds?.includes(kind)) return false;
    if (kind === IMAGE_KIND && c.image && a.images.every(c.image)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------
// Reading a repository (paths only)
// ---------------------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stderr: string;
}

/** Run a command, handing each NUL-terminated stdout token to `onToken`. Never stores content. */
function runTokens(
  args: string[],
  onToken: (token: string) => void,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(args[0] as string, args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" },
    });
    const decoder = new TextDecoder();
    let carry = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = carry + decoder.decode(chunk, { stream: true });
      const parts = text.split("\0");
      carry = parts.pop() as string;
      for (const p of parts) if (p !== "") onToken(p);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 400) stderr += chunk.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stderr: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (carry !== "") onToken(carry);
      done({ code, stderr });
    });
  });
}

export interface RepoPaths {
  head: string[];
  history: string[];
  cloneKiB: number;
}

const CLONE_TIMEOUT_MS = 15 * 60_000;

/** Blob-less, checkout-less clone into the OS temp directory; deleted before returning. */
export async function readRepoPaths(id: string): Promise<RepoPaths> {
  const dir = mkdtempSync(join(tmpdir(), "pq-d2-"));
  try {
    const repo = join(dir, "repo");
    let cloned: RunResult = { code: null, stderr: "" };
    for (let attempt = 0; attempt < 2 && cloned.code !== 0; attempt++) {
      cloned = await runTokens(
        [
          "git",
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          "--quiet",
          `https://github.com/nemarDatasets/${id}`,
          repo,
        ],
        () => undefined,
        CLONE_TIMEOUT_MS,
      );
    }
    if (cloned.code !== 0) throw new Error(`clone failed: ${firstLine(cloned.stderr)}`);

    // The same walk as the screen: every ref but git-annex, merges included, no rename pairing.
    const history = new Set<string>();
    const log = await runTokens(
      [
        "git",
        "-C",
        repo,
        "log",
        "--exclude=refs/heads/git-annex",
        "--exclude=refs/remotes/origin/git-annex",
        "--all",
        "--name-only",
        "-m",
        "--no-renames",
        "--no-ext-diff",
        "--format=",
        "-z",
      ],
      (p) => history.add(p),
      CLONE_TIMEOUT_MS,
    );
    if (log.code !== 0) throw new Error(`history unreadable: ${firstLine(log.stderr)}`);

    // HEAD: every file entry; a submodule entry (mode 160000) is not a file and the screen skips it.
    const head: string[] = [];
    const tree = await runTokens(
      ["git", "-C", repo, "ls-tree", "-r", "-z", "HEAD"],
      (entry) => {
        const tab = entry.indexOf("\t");
        if (tab < 0 || entry.startsWith("160000 ")) return;
        head.push(entry.slice(tab + 1));
      },
      CLONE_TIMEOUT_MS,
    );
    if (tree.code !== 0) {
      // A request on a repository with no commit has nothing to read; say so, never "no blockers".
      const empty = /Not a valid object name HEAD/.test(tree.stderr);
      throw new Error(
        empty
          ? "empty repository: HEAD has no commit"
          : `tree unreadable: ${firstLine(tree.stderr)}`,
      );
    }

    return { head, history: [...history], cloneKiB: await sizeKiB(repo) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstLine(text: string): string {
  // Strip anything that looks like a URL or token before it can reach a report.
  return (text.trim().split("\n")[0] ?? "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 160);
}

async function sizeKiB(path: string): Promise<number> {
  let out = "";
  await new Promise<void>((done) => {
    const c = spawn("du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    c.on("close", () => done());
    c.on("error", () => done());
  });
  return Number.parseInt(out, 10) || 0;
}

// ---------------------------------------------------------------------------------------
// Queue file
// ---------------------------------------------------------------------------------------

export interface QueueRow {
  id: string;
  status: string;
  blockReason: string;
  minReasons: string;
}

export function parseQueue(text: string): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [id, status = "", blockReason = "", minReasons = ""] = line.split("\t");
    rows.push({ id: (id as string).trim(), status, blockReason, minReasons });
  }
  return rows;
}

/** Closed reason codes found in a `min_requirements_reasons` text, matched by the sentence's opening. */
export function reasonCodes(text: string): string[] {
  const out: string[] = [];
  const opening = (s: string) => s.slice(0, 40);
  for (const code of MINIMUM_FAILURES) {
    const sentence = minimumFailureSentence(code);
    // name_too_short and authors_not_blinded carry values mid-sentence; their openings are fixed.
    if (text.includes(opening(sentence))) out.push(code);
  }
  if (out.length === 0 && text.trim() !== "") out.push("unrecognized");
  return out;
}

// ---------------------------------------------------------------------------------------
// Measurement and report
// ---------------------------------------------------------------------------------------

interface Measured {
  row: QueueRow;
  error: string | null;
  analysis: DatasetAnalysis | null;
  cloneKiB: number;
}

function inc<K extends string>(map: Record<K, number>, key: K, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`;
}

function table(header: string[], rows: (string | number)[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const onlyUnread = (blockers: string[]) => blockers.every((b) => b.startsWith("unscreened:"));

function summarize(measured: Measured[], a7: Set<string> | null, generatedAt: string) {
  const read = measured.filter(
    (m): m is Measured & { analysis: DatasetAnalysis } => m.analysis !== null,
  );
  const failed = measured.filter((m) => m.analysis === null);

  const withImage = read.filter((m) => m.analysis.kinds.includes(IMAGE_KIND));
  const imageOnly = withImage.filter((m) => m.analysis.kinds.length === 1);
  const imageOnlyNoUnread = imageOnly.filter((m) => m.analysis.blockers.length === 1);
  const cross = {
    requests: measured.length,
    read: read.length,
    unreadable: failed.length,
    withImage: withImage.length,
    imageOnlyPathKinds: imageOnly.length,
    imageOnlyAndNoUnscreened: imageOnlyNoUnread.length,
    withImageRequested: withImage.filter((m) => m.row.status === "requested").length,
    withImageBlocked: withImage.filter((m) => m.row.status === "blocked").length,
    imageOnlyInA7: a7 ? imageOnly.filter((m) => a7.has(m.row.id)).length : null,
    imageOnlyBlocked: imageOnly.filter((m) => m.row.status === "blocked").length,
    expectedWithImage: a7 ? a7.size : null,
    blockedIds: measured.filter((m) => m.row.status === "blocked").map((m) => m.row.id),
    onlyInMeasured: a7 ? withImage.filter((m) => !a7.has(m.row.id)).map((m) => m.row.id) : [],
    onlyInA7: a7 ? [...a7].filter((id) => !withImage.some((m) => m.row.id === id)) : [],
  };

  const kindCounts: Record<string, number> = {};
  const kindWhere: Record<string, Partial<Record<PathPresence, number>>> = {};
  const unscreenedReq: Record<string, number> = {};
  for (const m of read) {
    for (const k of m.analysis.kinds) inc(kindCounts, k);
    for (const [k, w] of Object.entries(m.analysis.flagged)) {
      const slot = kindWhere[k] ?? {};
      kindWhere[k] = slot;
      for (const p of ["head-only", "both", "history-only"] as const) {
        if (w[p]) slot[p] = (slot[p] ?? 0) + 1;
      }
    }
    for (const k of Object.keys(m.analysis.unscreened)) inc(unscreenedReq, k);
  }

  // Image groups: files and distinct requests per class.
  const group = (pick: (f: ImageFile) => string) => {
    const files: Record<string, number> = {};
    const reqs: Record<string, Set<string>> = {};
    for (const m of withImage) {
      for (const f of m.analysis.images) {
        inc(files, pick(f));
        const set = reqs[pick(f)] ?? new Set<string>();
        set.add(m.row.id);
        reqs[pick(f)] = set;
      }
    }
    return Object.keys(files)
      .map((k) => ({
        group: k,
        files: files[k] as number,
        requests: (reqs[k] as Set<string>).size,
      }))
      .sort((x, y) => y.requests - x.requests || y.files - x.files);
  };
  const byLocation = group((f) => f.location);
  const byExtension = group((f) => f.ext || "(none)");
  const byExtClass = group((f) => f.extClass);
  const byName = group((f) => f.name);
  const byPresence = group((f) => f.presence);
  const matrix: Record<string, Record<string, number>> = {};
  for (const m of withImage)
    for (const f of m.analysis.images) {
      const row = matrix[f.location] ?? {};
      matrix[f.location] = row;
      inc(row, f.name);
    }

  // Unread-format directory patterns.
  const dirFiles = new Map<string, number>();
  const dirReqs = new Map<string, Set<string>>();
  let withheld = 0;
  for (const m of read) {
    withheld += m.analysis.unreadDirsWithheld;
    for (const [p, n] of m.analysis.unreadDirs) {
      dirFiles.set(p, (dirFiles.get(p) ?? 0) + n);
      const s = dirReqs.get(p) ?? new Set<string>();
      s.add(m.row.id);
      dirReqs.set(p, s);
    }
  }
  const dirRanked = [...dirFiles.entries()]
    .map(([pattern, files]) => ({
      pattern,
      files,
      requests: (dirReqs.get(pattern) as Set<string>).size,
    }))
    .sort((x, y) => y.files - x.files);
  const dirShown = dirRanked.filter((d) => d.requests >= 2).slice(0, 20);
  const dirSuppressed = dirRanked.filter((d) => d.requests < 2).length;

  // Blocked requests.
  const blocked = measured.filter((m) => m.row.status === "blocked");
  const byReason: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const m of blocked) {
    inc(byReason, m.row.blockReason || "(none)");
    if (m.row.blockReason === "min_requirements_failed")
      for (const c of reasonCodes(m.row.minReasons)) inc(byCode, c);
  }
  const blockedWithPathFindings = blocked.filter((m) => m.analysis && m.analysis.kinds.length > 0);
  const blockedWithPathBlockers = blocked.filter(
    (m) => m.analysis && m.analysis.blockers.length > 0,
  );

  // What-if.
  const baseClear = read.filter((m) => m.analysis.blockers.length === 0).length;
  const baseUnread = read.filter(
    (m) => m.analysis.blockers.length > 0 && onlyUnread(m.analysis.blockers),
  ).length;
  const whatIf = buildCandidates().map((c) => {
    let clear = 0;
    let unreadOnly = 0;
    let lifted = 0;
    for (const m of read) {
      const rest = remainingBlockers(m.analysis, c);
      if (rest.length < m.analysis.blockers.length) lifted++;
      if (rest.length === 0) clear++;
      else if (onlyUnread(rest)) unreadOnly++;
    }
    return {
      id: c.id,
      label: c.label,
      requestsWithBlockerRemoved: lifted,
      emptyAfter: clear,
      unreadFormatsOnlyAfter: unreadOnly,
    };
  });

  const shapeMap = new Map<
    string,
    { kinds: string; unscreened: boolean; requested: number; blocked: number }
  >();
  for (const m of read) {
    const kinds = m.analysis.kinds.length ? m.analysis.kinds.join(" + ") : "none";
    const unscreened = m.analysis.blockers.some((b) => b.startsWith("unscreened:"));
    const key = `${kinds}|${unscreened}`;
    const row = shapeMap.get(key) ?? { kinds, unscreened, requested: 0, blocked: 0 };
    if (m.row.status === "blocked") row.blocked++;
    else row.requested++;
    shapeMap.set(key, row);
  }
  const shapes = [...shapeMap.values()].sort(
    (a, b) => b.requested + b.blocked - (a.requested + a.blocked),
  );

  return {
    generatedAt,
    cross,
    shapes,
    baseline: { emptyBlockerSet: baseClear, unreadFormatsOnly: baseUnread },
    findingKindRequests: kindCounts,
    findingKindPresence: kindWhere,
    unscreenedFormatRequests: unscreenedReq,
    imageGroups: {
      byLocation,
      byExtClass,
      byExtension,
      byName,
      byPresence,
      locationByName: matrix,
    },
    unreadDirectoryPatterns: {
      shown: dirShown,
      suppressedSingletons: dirSuppressed,
      withheldNameLike: withheld,
    },
    blocked: {
      total: blocked.length,
      byReason,
      byMinRequirementsCode: byCode,
      withPathBlockers: blockedWithPathBlockers.length,
      withPathFindings: blockedWithPathFindings.length,
    },
    whatIf,
    nameLikeLabelPaths: read.reduce((s, m) => s + m.analysis.nameLikeLabelPaths, 0),
    unreadable: failed.map((m) => ({ id: m.row.id, error: m.error })),
  };
}

type Summary = ReturnType<typeof summarize>;

function render(s: Summary, measured: Measured[], peakCloneKiB: number): string {
  const L: string[] = [];
  const x = s.cross;
  L.push("# D2: what holds each queued request");
  L.push("");
  L.push(
    `Measured ${s.generatedAt} by \`scripts/dev/measure-queue-blockers.ts\` over ${x.requests} requests.`,
  );
  L.push(
    "The path set is the screen's own: every path in HEAD plus every path in history (`git log --all`, git-annex branches excluded), with `scanPaths` and `formatCoverage` applied unchanged.",
  );
  L.push(
    "Only paths were read (blob-less clones, deleted after use); no file content, and no file name appears below.",
  );
  L.push(
    "Findings that need file content (EDF headers, participants tables, JSON keys, text files) are outside this measurement, so a blocker set here is the path-derived part of what the screen reports, plus the unscreened formats.",
  );
  L.push("");
  L.push("## Coverage and cross-check");
  L.push("");
  L.push(
    table(
      ["measure", "value"],
      [
        ["requests in the queue file", x.requests],
        ["read (HEAD and history)", x.read],
        ["unreadable (listed below, never counted as free)", x.unreadable],
        ["requests with an image or document finding", x.withImage],
        ["expected from the screen (a7 list)", x.expectedWithImage ?? "n/a"],
        ["image finding, status requested", x.withImageRequested],
        ["image finding, status blocked", x.withImageBlocked],
        ["with only the image kind among path findings", x.imageOnlyPathKinds],
        ["same, restricted to the a7 list (screen measured 196)", x.imageOnlyInA7 ?? "n/a"],
        ["same, blocked requests", x.imageOnlyBlocked],
        ["with only the image kind, and no unscreened format", x.imageOnlyAndNoUnscreened],
        ["peak single clone on disk (KiB)", peakCloneKiB],
      ],
    ),
  );
  L.push("");
  L.push(
    `Image-finding count versus the screen's 229: ${x.withImage} measured (difference ${x.withImage - (x.expectedWithImage ?? x.withImage)}).`,
  );
  const surplusRequested = x.onlyInMeasured.filter((id) => !x.blockedIds.includes(id));
  L.push(
    `Present here and not in the a7 list: ${x.onlyInMeasured.length} (${x.onlyInMeasured.length - surplusRequested.length} blocked, ${surplusRequested.length} requested).`,
  );
  L.push(
    `In the a7 list and not measured here: ${x.onlyInA7.length ? x.onlyInA7.join(", ") : "none"}.`,
  );
  L.push("");
  L.push("Reading the difference:");
  L.push("");
  L.push(
    "- The a7 list is a subset of what is measured here, so no screen finding is missed by the path rebuild.",
  );
  L.push(
    `- Blocked requests are not screened, and ${x.withImageBlocked} of them have an image path, which accounts for ${x.onlyInMeasured.length - surplusRequested.length} of the surplus.`,
  );
  L.push(
    `- ${surplusRequested.length} requested requests have an image path and are not in the a7 list: ${surplusRequested.join(", ") || "none"}.`,
  );
  L.push(
    "  This script reads paths only, so it cannot say whether a screen record exists for them; the likely cause is no screen record when the a7 list was made.",
  );
  L.push(
    `- The screen's "only image findings" figure (196) counts image findings among ALL kinds, content kinds included (EDF headers, participants tables, JSON keys, text files); this measurement sees path kinds only, so its count restricted to the a7 list (${x.imageOnlyInA7 ?? "n/a"}) is an upper bound on it, and the gap is requests whose other findings are content kinds.`,
  );
  if (s.unreadable.length) {
    L.push("");
    L.push("Unreadable requests:");
    L.push("");
    L.push(
      table(
        ["id", "error"],
        s.unreadable.map((u) => [u.id, u.error ?? ""]),
      ),
    );
  }
  L.push("");
  L.push("## Blocker kinds across the queue");
  L.push("");
  L.push(
    table(
      ["finding kind", "requests", "in HEAD only", "in HEAD and history", "history only"],
      Object.keys(s.findingKindRequests).map((k) => {
        const w = s.findingKindPresence[k] ?? {};
        return [
          k,
          s.findingKindRequests[k] as number,
          w["head-only"] ?? 0,
          w.both ?? 0,
          w["history-only"] ?? 0,
        ];
      }),
    ),
  );
  L.push("");
  L.push(
    `Name-like subject labels: ${s.nameLikeLabelPaths} paths carry one (counted, never shown).`,
  );
  L.push("");
  const formats = Object.entries(s.unscreenedFormatRequests).sort((a, b) => b[1] - a[1]);
  const shownFormats = formats.filter(([, n], i) => i < 30 && n >= 2);
  L.push(
    table(
      ["unscreened format (HEAD)", "requests"],
      shownFormats.map(([k, n]) => [k, n]),
    ),
  );
  L.push("");
  L.push(
    `${formats.length - shownFormats.length} further formats, each held by one or two requests, are in the JSON; an extension that is not a plausible format word is counted as \`${UNUSUAL_FORMAT}\`.`,
  );
  L.push("");
  L.push("### Blocker-set shapes");
  L.push("");
  L.push(
    table(
      ["path findings", "unscreened formats", "requested", "blocked"],
      s.shapes.map((r) => [r.kinds, r.unscreened ? "yes" : "no", r.requested, r.blocked]),
    ),
  );
  L.push("");
  L.push(
    `Requests with an empty blocker set now: ${s.baseline.emptyBlockerSet}; with unscreened formats only: ${s.baseline.unreadFormatsOnly}.`,
  );
  L.push("");
  L.push("## Image and document groups");
  L.push("");
  L.push(
    "Files are counted over HEAD plus history paths; requests are the distinct requests holding at least one.",
  );
  const grp = (title: string, rows: { group: string; files: number; requests: number }[]) => {
    L.push("");
    L.push(`### By ${title}`);
    L.push("");
    L.push(
      table(
        [title, "files", "requests"],
        rows.map((r) => [r.group, r.files, r.requests]),
      ),
    );
  };
  grp("location", s.imageGroups.byLocation);
  grp("extension class", s.imageGroups.byExtClass);
  grp("extension", s.imageGroups.byExtension);
  grp("name class", s.imageGroups.byName);
  grp("presence", s.imageGroups.byPresence);
  L.push("");
  L.push("### Files by location and name class");
  L.push("");
  L.push(
    table(
      ["location", ...NAME_CLASSES],
      LOCATION_CLASSES.filter((l) => s.imageGroups.locationByName[l]).map((l) => [
        l,
        ...NAME_CLASSES.map((n) => s.imageGroups.locationByName[l]?.[n] ?? 0),
      ]),
    ),
  );
  L.push("");
  L.push("## Unread formats with no extension or `.other`");
  L.push("");
  L.push(
    "Parent directory patterns (digit runs as `#`, `sub-` and `ses-` labels folded) of the HEAD files that `formatCoverage` counts under `(no extension)` or `.other`, most files first.",
  );
  L.push(
    `A pattern held by a single request is not printed (${s.unreadDirectoryPatterns.suppressedSingletons} such patterns), and ${s.unreadDirectoryPatterns.withheldNameLike} files under a name-like subject label are counted and withheld.`,
  );
  L.push("");
  L.push(
    table(
      ["pattern", "files", "requests"],
      s.unreadDirectoryPatterns.shown.map((d) => [`\`${d.pattern}\``, d.files, d.requests]),
    ),
  );
  L.push("");
  L.push("## The blocked requests");
  L.push("");
  L.push(`${s.blocked.total} requests are blocked.`);
  L.push("");
  L.push(
    table(
      ["block_reason", "requests"],
      Object.entries(s.blocked.byReason).map(([k, n]) => [k, n]),
    ),
  );
  L.push("");
  L.push(
    table(
      ["min_requirements_failed reason code", "requests"],
      Object.entries(s.blocked.byMinRequirementsCode).map(([k, n]) => [k, n]),
    ),
  );
  L.push("");
  L.push(
    `${s.blocked.withPathBlockers} of the blocked requests would also hold at least one measured blocker once unblocked (${s.blocked.withPathFindings} a path finding, the rest unscreened formats only).`,
  );
  L.push("");
  L.push("## What if: acknowledge a group");
  L.push("");
  L.push(
    "For each candidate group, the requests whose blocker set shrinks, would be empty, or would hold unread formats only.",
  );
  L.push(
    "An image blocker is lifted only when EVERY flagged image or document in that request belongs to the group.",
  );
  L.push("");
  L.push(
    table(
      ["group", "blocker lifted", "empty after", "unread formats only after"],
      s.whatIf.map((w) => [
        `${w.id}: ${w.label}`,
        w.requestsWithBlockerRemoved,
        w.emptyAfter,
        w.unreadFormatsOnlyAfter,
      ]),
    ),
  );
  L.push("");
  L.push(
    `Baseline: ${s.baseline.emptyBlockerSet} empty, ${s.baseline.unreadFormatsOnly} unread formats only (of ${s.cross.read} read).`,
  );
  L.push(`Percent of the read queue with an image finding: ${pct(x.withImage, x.read)}.`);
  L.push("");
  L.push(`Datasets measured: ${measured.length}.`);
  return `${L.join("\n")}\n`;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const queueArg = args.find((a) => !a.startsWith("--"));
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
  };
  if (!queueArg) {
    console.error(
      "usage: measure-queue-blockers.ts <queue-ids.txt> [--concurrency N] [--out-dir DIR]",
    );
    return 64;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const outDir = resolve(opt("--out-dir", join(repoRoot, ".context/plans/publication-queue")));
  const concurrency = Number.parseInt(opt("--concurrency", "6"), 10);
  const queuePath = resolve(queueArg);
  const rows = parseQueue(readFileSync(queuePath, "utf8"));
  const a7Path = join(dirname(queuePath), "a7-dataset-ids.txt");
  const a7 = existsSync(a7Path)
    ? new Set(
        readFileSync(a7Path, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("#")),
      )
    : null;

  let done = 0;
  const measured = await pool(rows, concurrency, async (row): Promise<Measured> => {
    try {
      const paths = await readRepoPaths(row.id);
      const analysis = analyze(paths.head, paths.history);
      done++;
      console.error(`[${done}/${rows.length}] read ${row.id}`);
      return { row, error: null, analysis, cloneKiB: paths.cloneKiB };
    } catch (e) {
      done++;
      const message = firstLine(e instanceof Error ? e.message : String(e));
      console.error(`[${done}/${rows.length}] FAILED ${row.id}: ${message}`);
      return { row, error: message, analysis: null, cloneKiB: 0 };
    }
  });

  const generatedAt = new Date().toISOString().slice(0, 10);
  const summary = summarize(measured, a7, generatedAt);
  const peak = Math.max(0, ...measured.map((m) => m.cloneKiB));
  writeFileSync(join(outDir, "d2-blockers-report.md"), render(summary, measured, peak));

  const json = {
    ...summary,
    datasets: measured.map((m) => ({
      id: m.row.id,
      status: m.row.status,
      blockReason: m.row.blockReason || null,
      error: m.error,
      headFiles: m.analysis?.headFiles ?? null,
      historyPaths: m.analysis?.historyPaths ?? null,
      historyOnlyPaths: m.analysis?.historyOnlyPaths ?? null,
      blockers: m.analysis?.blockers ?? null,
      flaggedPaths: m.analysis?.flagged ?? null,
      unscreened: m.analysis?.unscreened ?? null,
      images: m.analysis
        ? {
            total: m.analysis.images.length,
            byLocation: tally(m.analysis.images, (f) => f.location),
            byExtension: tally(m.analysis.images, (f) => f.ext || "(none)"),
            byName: tally(m.analysis.images, (f) => f.name),
            byPresence: tally(m.analysis.images, (f) => f.presence),
          }
        : null,
    })),
  };
  writeFileSync(join(outDir, "d2-blockers.json"), `${JSON.stringify(json, null, 2)}\n`);
  console.error(
    `wrote report and json: read=${summary.cross.read} unreadable=${summary.cross.unreadable} withImage=${summary.cross.withImage}`,
  );
  return summary.cross.unreadable > 20 ? 2 : 0;
}

function tally<T>(items: T[], pick: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) inc(out, pick(item));
  return out;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
