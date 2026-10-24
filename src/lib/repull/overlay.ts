/**
 * The per-path three-way decision of an upstream re-pull (ADR 0111, decision 1).
 *
 * Base is upstream at `from_tag`, theirs is upstream at `to_tag`, ours is NEMAR's `main`. Each
 * path's content is identified without a working copy, from `ls-tree -r -z` maps: absent, an annex
 * key (`A:<key>`, from a symlink or a pointer blob, which count as equal), or a git blob
 * (`G:<mode>:<oid>`, so a mode change is a difference). A gitlink refuses the plan. `.nemar/**` and
 * `.github/**` are NEMAR's and never compared.
 *
 * Upstream-changed means base differs from theirs. Explained means ours is base or theirs with the
 * standard edits applied (`edits.ts`). The class follows from the two (ADR 0111's table):
 *
 * | upstream-changed | explained | class       | N.0.0 takes                                  |
 * |------------------|-----------|-------------|----------------------------------------------|
 * | no               | yes       | keep-ours   | ours                                         |
 * | yes              | yes       | take-theirs | T(theirs); ours when ours already is theirs  |
 * | yes              | no        | conflict    | T(theirs)                                    |
 * | no               | no        | correction  | T(theirs), and N.0.1 replays ours            |
 *
 * The root README family and `dataset_description.json` are compared as units: the family as a
 * set of files the import's rename and the publish step's badge act on together, and the
 * description key by key (`description.ts`).
 */

import {
  README_FILENAME,
  buildDoiBadge,
  decideReadme,
  planReadmeBadgeCommit,
  readmeProvenanceStub,
  selectPublishReadmes,
} from "../../../shared/standard-edits/readme.js";
import { isNeverAnnexedMetadata, shouldAnnex } from "../git-annex/policy.js";
import { RECORDING_PATH } from "../import-scrub.js";
import { DESCRIPTION_PATH, type DescriptionMerge, mergeDescription } from "./description.js";
import {
  ABSENT,
  type EditName,
  type ExplainContext,
  type Side,
  type Target,
  annexKeyOfEntry,
  bareDoi,
  baseName,
  explainEdit,
  gitBlobOid,
  identity,
  isRootPath,
  keyDigest,
  keyMatchesBytes,
  splitChangesSentences,
  stripBom,
  targetEqualsOurs,
  targetOf,
} from "./edits.js";
import type { BlobStore, TreeEntry } from "./sources.js";

/** Paths NEMAR owns outright: taken from ours, never compared (ADR 0111, decision 1). */
export function isNemarOwnedPath(path: string): boolean {
  return path.startsWith(".nemar/") || path.startsWith(".github/");
}

/**
 * The four classes of ADR 0111's table, and `unchecked`: a path a check needed bytes for that the
 * plan could not read (refused by the fetch bound, or not delivered). An unchecked path is never
 * guessed to be a conflict or a correction, and its plan refuses (`fetch-bound`).
 */
export type PathClass = "keep-ours" | "take-theirs" | "conflict" | "correction" | "unchecked";

export interface PathDecision {
  path: string;
  group: "readme" | "description" | null;
  base: string;
  theirs: string;
  ours: string;
  upstreamChanged: boolean;
  /** The edit that explains ours from base, or from theirs; null when unexplained. */
  explainedBy: { base: string | null; theirs: string | null };
  class: PathClass;
  subtype: string | null;
  /** `ours` when N.0.0 keeps NEMAR's side as it is. */
  decision: "ours" | "theirs";
  target: Target | { kind: "ours" };
  /** The target is present and differs from ours. */
  delta: boolean;
  /** The target is absent and ours is present. */
  deleted: boolean;
}

export interface OverlayInput {
  base: Map<string, TreeEntry>;
  theirs: Map<string, TreeEntry>;
  ours: Map<string, TreeEntry>;
  upstream: BlobStore;
  nemar: BlobStore;
  /** NEMAR's git-annex branch says this key is dead. Filled before classification. */
  deadAtNemar: (key: string) => boolean;
  /** Called once with every annex key the classification may ask {@link deadAtNemar} about. */
  prepareDeadKeys: (keys: string[]) => Promise<void>;
  ds: string;
  toTag: string;
  nextVersion: string;
  /**
   * The dataset's concept DOI from its catalog row. The README badge NEMAR writes names it, so only
   * a badge naming it is an explained edit, and N.0.0's badge is built from it.
   */
  conceptDoi: string | null;
}

export interface OverlayResult {
  decisions: PathDecision[];
  description: DescriptionMerge;
  gitlinks: string[];
  /** Annex keys ours names anywhere in its tree. */
  oursKeys: Set<string>;
  /** Sides as read, by path, for the copy manifest and the forecast. */
  sides: Map<string, { base: Side; theirs: Side; ours: Side }>;
  /** Blobs a check needed and could not have (over the bound, or not delivered). */
  fetchRefused: number;
  /** ADR 0085 sentences NEMAR's `CHANGES` carries on top of upstream's. */
  changesSentences: string[];
}

const REGULAR = new Set(["100644", "100755"]);
const MIB = 1024 * 1024;

function rawId(e: TreeEntry | undefined): string {
  return e ? `${e.mode}:${e.oid}` : "absent";
}

/** A side as read: the key of an annex symlink or pointer, else the blob (bytes when loaded). */
function sideOf(e: TreeEntry | undefined, store: BlobStore): Side {
  if (!e) return ABSENT;
  const bytes = store.get(e.oid);
  if (bytes && (e.mode === "120000" || (REGULAR.has(e.mode) && bytes.length <= 32 * 1024))) {
    const key = annexKeyOfEntry(e.mode, bytes);
    if (key) return { kind: "annex", key, mode: e.mode, oid: e.oid };
  }
  return { kind: "git", mode: e.mode, oid: e.oid, size: bytes?.length ?? null, bytes };
}

function conflictSubtype(base: Side, theirs: Side, ours: Side): string {
  if (base.kind === "absent") return "both-added";
  if (theirs.kind === "absent") return "upstream-deleted/nemar-changed";
  if (ours.kind === "absent") return "nemar-deleted/upstream-changed";
  return "both-modified";
}

function correctionSubtype(base: Side, ours: Side): string {
  if (base.kind === "absent") return "nemar-added";
  if (ours.kind === "absent") return "nemar-deleted";
  return "nemar-modified";
}

function classify(changed: boolean, explained: boolean): PathClass {
  if (!changed) return explained ? "keep-ours" : "correction";
  return explained ? "take-theirs" : "conflict";
}

// ---------------------------------------------------------------------------------------
// The README family
// ---------------------------------------------------------------------------------------

/** One file of a README family: a side as read, or bytes the import writes (the stub). */
type FamilyFile = { side: Side } | { bytes: Buffer };

type Family = Map<string, FamilyFile>;

function contentBytes(f: FamilyFile | undefined): Buffer | null {
  if (!f) return null;
  if ("bytes" in f) return f.bytes;
  return f.side.kind === "git" ? f.side.bytes : null;
}

/** A family file and a NEMAR side hold the same content (an annexed one un-annexed counts). */
function sameContent(f: FamilyFile, ours: Side): boolean {
  if ("bytes" in f) return ours.kind === "git" && !!ours.bytes && ours.bytes.equals(f.bytes);
  const s = f.side;
  if (identity(s) === identity(ours)) return true;
  if (s.kind === "annex" && ours.kind === "git" && ours.bytes)
    return keyMatchesBytes(s.key, ours.bytes);
  return false;
}

/**
 * What the import does to a family (#642, `decideReadme`): root metadata upstream annexed is
 * un-annexed first (`ensureRootMetadataUnannexed` runs before the rename), so an annexed README is
 * a regular file by then; a bare README is renamed to `README.md`; with none, the stub is written.
 */
function importFamily(x: Map<string, Side>, stub: string): Family {
  const out: Family = new Map([...x].map(([p, side]) => [p, { side }]));
  const regular = [...x]
    .filter(([, s]) => s.kind === "annex" || (s.kind === "git" && REGULAR.has(s.mode)))
    .map(([p]) => p)
    .sort();
  const decision = decideReadme(regular);
  if (decision.kind === "renamed") {
    const from = out.get(decision.from);
    out.delete(decision.from);
    if (from) out.set("README.md", from);
  } else if (decision.kind === "created") {
    out.set("README.md", { bytes: Buffer.from(stub) });
  }
  return out;
}

/**
 * The README text with zero, one, two, ... leading DOI badges for `conceptDoi` removed. A badge is
 * rebuilt in each spelling NEMAR has written and compared byte for byte: the shields.io form
 * `buildDoiBadge` makes today, and the Zenodo form it made before #1182. A badge naming any other
 * DOI (a stale or a forged one) is not NEMAR's edit and is not removed; with no concept DOI, none is.
 */
export function badgeStrips(text: string, conceptDoi: string | null): string[] {
  const out = [text];
  const doi = bareDoi(conceptDoi);
  if (!doi) return out;
  const spellings = [
    buildDoiBadge(doi),
    `[![DOI](https://zenodo.org/badge/DOI/${doi}.svg)](https://doi.org/${doi})`,
  ].map((badge) => `${badge}\n\n`);
  let rest = text;
  for (;;) {
    const badge = spellings.find((b) => rest.startsWith(b));
    if (!badge) break;
    rest = rest.slice(badge.length);
    out.push(rest);
  }
  return out;
}

function sameFamily(a: Family, ours: Map<string, Side>): boolean {
  if (a.size !== ours.size) return false;
  for (const [p, f] of a) {
    const o = ours.get(p);
    if (!o || !sameContent(f, o)) return false;
  }
  return true;
}

/** Which README edit explains NEMAR's family from upstream's `x`, or null. */
function explainFamily(
  x: Map<string, Side>,
  ours: Map<string, Side>,
  stub: string,
  conceptDoi: string | null,
): string | null {
  const plain: Family = new Map([...x].map(([p, side]) => [p, { side }]));
  if (sameFamily(plain, ours)) return "identical";
  const imported = importFamily(x, stub);
  if (sameFamily(imported, ours)) return "readme-import";
  // The publish step: the content source becomes README.md under a badge, and every other
  // exact spelling it found is removed.
  const sel = selectPublishReadmes([...imported.keys()].map((path) => ({ path })));
  const expected = new Map(imported);
  for (const r of sel.remove) expected.delete(r.path);
  const source = sel.contentSource ? imported.get(sel.contentSource.path) : undefined;
  expected.delete("README.md");
  const oursReadme = ours.get("README.md");
  if (!oursReadme || oursReadme.kind !== "git" || !oursReadme.bytes) return null;
  if (ours.size !== expected.size + 1) return null;
  for (const [p, f] of expected) {
    const o = ours.get(p);
    if (!o || !sameContent(f, o)) return null;
  }
  const text = new TextDecoder().decode(oursReadme.bytes);
  for (const stripped of badgeStrips(text, conceptDoi).slice(1)) {
    const bytes = Buffer.from(stripped);
    if (!source) {
      if (bytes.length === 0) return "readme-badge";
      continue;
    }
    if ("bytes" in source) {
      if (source.bytes.equals(bytes)) return "readme-badge";
    } else if (source.side.kind === "annex") {
      if (keyMatchesBytes(source.side.key, bytes)) return "readme-badge";
    } else if (source.side.kind === "git" && source.side.bytes?.equals(bytes)) {
      return "readme-badge";
    }
  }
  return null;
}

/** The family N.0.0 holds: theirs, renamed and badged as import and publish would leave it. */
function targetFamily(
  theirs: Map<string, Side>,
  stub: string,
  conceptDoi: string | null,
): Map<string, Target> {
  const imported = importFamily(theirs, stub);
  const sel = selectPublishReadmes([...imported.keys()].map((path) => ({ path })));
  const out = new Map<string, Target>();
  for (const [p, f] of imported) {
    if (p === "README.md" || sel.remove.some((r) => r.path === p)) continue;
    const side = "bytes" in f ? null : f.side;
    out.set(
      p,
      side
        ? side.kind === "annex"
          ? { kind: "unannex", key: side.key }
          : side.kind === "git"
            ? { kind: "git", mode: side.mode, oid: side.oid }
            : { kind: "absent" }
        : { kind: "git", mode: "100644", oid: gitBlobOid((f as { bytes: Buffer }).bytes) },
    );
  }
  if (!conceptDoi) {
    out.set("README.md", { kind: "unknown", reason: "no-concept-doi" });
    return out;
  }
  const source = sel.contentSource ? imported.get(sel.contentSource.path) : undefined;
  const content = source ? contentBytes(source) : Buffer.alloc(0);
  if (content === null) {
    out.set("README.md", { kind: "unknown", reason: "readme-unread" });
    return out;
  }
  const doi = bareDoi(conceptDoi);
  if (!doi) {
    out.set("README.md", { kind: "unknown", reason: "no-concept-doi" });
    return out;
  }
  const plan = planReadmeBadgeCommit({
    readmeContent: content.toString("utf8"),
    doiBadge: buildDoiBadge(doi),
    conceptDoi: doi,
    contentSourcePath: sel.contentSource?.path,
  });
  const bytes = plan.commit ? Buffer.from(plan.content) : content;
  out.set("README.md", {
    kind: "git",
    mode: "100644",
    oid: gitBlobOid(bytes),
    computed: "readme-badge",
  });
  return out;
}

function familyEquals(t: Map<string, Target>, ours: Map<string, Side>): boolean {
  if (t.size !== ours.size) return false;
  for (const [p, target] of t) {
    const o = ours.get(p);
    if (!o || !targetEqualsOurs(target, o)) return false;
  }
  return true;
}

function openNeuroDoiOf(desc: Buffer | null): string | null {
  if (!desc) return null;
  try {
    const v = JSON.parse(stripBom(desc.toString("utf8")));
    return typeof v?.DatasetDOI === "string" ? v.DatasetDOI.replace(/^doi:/, "") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------------------

/** Run the three-way decision over every path. See the module comment. */
export async function overlay(input: OverlayInput): Promise<OverlayResult> {
  const { base, theirs, ours, upstream, nemar } = input;
  const all = new Set<string>([...base.keys(), ...theirs.keys(), ...ours.keys()]);
  const gitlinks: string[] = [];
  const examined: string[] = [];
  for (const path of [...all].sort()) {
    if (isNemarOwnedPath(path)) continue;
    const entries = [base.get(path), theirs.get(path), ours.get(path)];
    if (entries.some((e) => e?.type === "commit")) {
      gitlinks.push(path);
      continue;
    }
    if (rawId(entries[0]) === rawId(entries[1]) && rawId(entries[1]) === rawId(entries[2]))
      continue;
    examined.push(path);
  }
  const readmePaths = new Set(
    [...all].filter((p) => isRootPath(p) && README_FILENAME.test(p) && !isNemarOwnedPath(p)),
  );
  const familyExamined = examined.some((p) => readmePaths.has(p));
  const loadPaths = new Set([
    ...examined,
    DESCRIPTION_PATH,
    ...(familyExamined ? readmePaths : []),
  ]);

  await upstream.load(
    [...loadPaths]
      .flatMap((p) => [base.get(p)?.oid, theirs.get(p)?.oid])
      .filter((o): o is string => !!o),
  );
  await nemar.load([...loadPaths].map((p) => ours.get(p)?.oid).filter((o): o is string => !!o));
  // Every annex symlink of ours, so the copy manifest knows every key ours names.
  const oursSymlinks = [...ours].filter(([p, e]) => e.mode === "120000" && !isNemarOwnedPath(p));
  await nemar.load(oursSymlinks.map(([, e]) => e.oid));
  const oursKeys = new Set<string>();
  for (const [, e] of oursSymlinks) {
    const bytes = nemar.get(e.oid);
    const key = bytes ? annexKeyOfEntry(e.mode, bytes) : null;
    if (key) oursKeys.add(key);
  }

  const sides = new Map<string, { base: Side; theirs: Side; ours: Side }>();
  for (const p of loadPaths) {
    const s = {
      base: sideOf(base.get(p), upstream),
      theirs: sideOf(theirs.get(p), upstream),
      ours: sideOf(ours.get(p), nemar),
    };
    if (s.ours.kind === "annex") oursKeys.add(s.ours.key);
    sides.set(p, s);
  }

  // Fetch the blobs a hash check needs, and whose size an annex key states in advance.
  const upWants: Array<{ oid: string; expected: number }> = [];
  const ourWants: Array<{ oid: string; expected: number }> = [];
  for (const p of examined) {
    const s = sides.get(p) as { base: Side; theirs: Side; ours: Side };
    for (const x of [s.base, s.theirs]) {
      if (x.kind === "git" && !x.bytes && upstream.isMissing(x.oid) && s.ours.kind === "annex") {
        const size = keyDigest(s.ours.key)?.size ?? null;
        if (size !== null && (shouldAnnex(p, MIB) || RECORDING_PATH.test(p))) {
          upWants.push({ oid: x.oid, expected: size });
        }
      }
      if (
        x.kind === "annex" &&
        s.ours.kind === "git" &&
        !s.ours.bytes &&
        nemar.isMissing(s.ours.oid) &&
        isRootPath(p) &&
        isNeverAnnexedMetadata(baseName(p))
      ) {
        const size = keyDigest(x.key)?.size ?? null;
        if (size !== null) ourWants.push({ oid: s.ours.oid, expected: size });
      }
    }
  }
  await upstream.fetch(upWants);
  await nemar.fetch(ourWants);
  const refusedOids = new Set([...upstream.refused, ...nemar.refused]);
  if (upWants.length + ourWants.length > 0) {
    for (const p of examined) {
      sides.set(p, {
        base: sideOf(base.get(p), upstream),
        theirs: sideOf(theirs.get(p), upstream),
        ours: sideOf(ours.get(p), nemar),
      });
    }
  }

  // Dead marks for every upstream key a recognizer may ask about.
  const keys = new Set<string>();
  for (const p of examined) {
    const s = sides.get(p) as { base: Side; theirs: Side; ours: Side };
    if (s.base.kind === "annex") keys.add(s.base.key);
    if (s.theirs.kind === "annex") keys.add(s.theirs.key);
  }
  await input.prepareDeadKeys([...keys].sort());
  const ctx: ExplainContext = { isDeadAtNemar: input.deadAtNemar };

  const decisions: PathDecision[] = [];
  const descSides = sides.get(DESCRIPTION_PATH) as { base: Side; theirs: Side; ours: Side };

  // dataset_description.json, key by key. Its Version always becomes N.0.0, so it is always a
  // delta path.
  const description = mergeDescription({
    base: descBytes(descSides.base),
    theirs: descBytes(descSides.theirs),
    ours: descBytes(descSides.ours),
    ds: input.ds,
    toTag: input.toTag,
    nextVersion: input.nextVersion,
  });
  {
    const changed = description.upstreamChanged;
    // Corrections and conflicts are per key, so the file's class is its worst key's: a conflict
    // on any key, else a correction on any key, else upstream's change taken. A file that could not
    // be merged at all is unexplained as a whole.
    const keyClasses = new Set(description.keys.map((k) => k.class));
    const merged = description.status === "merged";
    const cls: PathClass = !merged
      ? classify(changed, false)
      : keyClasses.has("conflict")
        ? "conflict"
        : keyClasses.has("correction")
          ? "correction"
          : changed
            ? "take-theirs"
            : "keep-ours";
    decisions.push({
      path: DESCRIPTION_PATH,
      group: "description",
      base: identity(descSides.base),
      theirs: identity(descSides.theirs),
      ours: identity(descSides.ours),
      upstreamChanged: changed,
      explainedBy: {
        base: description.explainedBase ? "description" : null,
        theirs: description.explained ? "description" : null,
      },
      class: cls,
      subtype:
        cls !== "conflict" && cls !== "correction"
          ? null
          : merged
            ? "per-key"
            : cls === "conflict"
              ? conflictSubtype(descSides.base, descSides.theirs, descSides.ours)
              : correctionSubtype(descSides.base, descSides.ours),
      decision: "theirs",
      target: merged
        ? { kind: "description" }
        : { kind: "unknown", reason: `description-${description.status}` },
      delta: true,
      deleted: false,
    });
  }

  // CHANGES carries the ADR 0085 sentences forward onto upstream's text (a ledger edit).
  const changesOurs = sides.get("CHANGES")?.ours;
  const changesSentences =
    changesOurs?.kind === "git" && changesOurs.bytes
      ? splitChangesSentences(changesOurs.bytes.toString("utf8")).sentences
      : [];
  const bidsignoreOurs = ours.get(".bidsignore");
  const oursHasBidsignore = !!bidsignoreOurs;

  // The README family, as a unit.
  if (familyExamined) {
    const fam = (pick: "base" | "theirs" | "ours") =>
      new Map(
        [...readmePaths]
          .map((p) => [p, (sides.get(p) as Record<string, Side>)[pick] as Side] as const)
          .filter(([, s]) => s.kind !== "absent"),
      );
    const fb = fam("base");
    const ft = fam("theirs");
    const fo = fam("ours");
    const stubBase = readmeProvenanceStub(
      input.ds,
      openNeuroDoiOf(descBytes(descSides.base).bytes),
    );
    const stubTheirs = readmeProvenanceStub(
      input.ds,
      openNeuroDoiOf(descBytes(descSides.theirs).bytes),
    );
    const eBase = explainFamily(fb, fo, stubBase, input.conceptDoi);
    const eTheirs = explainFamily(ft, fo, stubTheirs, input.conceptDoi);
    const famId = (m: Map<string, Side>) =>
      [...m]
        .map(([p, s]) => `${p}=${identity(s)}`)
        .sort()
        .join("\n");
    const changed = famId(fb) !== famId(ft);
    const explained = eBase !== null || eTheirs !== null;
    const cls = classify(changed, explained);
    const keep = cls === "keep-ours" || (cls === "take-theirs" && eTheirs !== null);
    const targets = keep ? null : targetFamily(ft, stubTheirs, input.conceptDoi);
    const keepOurs = keep || (targets !== null && familyEquals(targets, fo));
    const first = (m: Map<string, Side>): Side =>
      m.size > 0 ? ([...m.values()][0] as Side) : ABSENT;
    const subtype =
      cls === "conflict"
        ? conflictSubtype(first(fb), first(ft), first(fo))
        : cls === "correction"
          ? correctionSubtype(first(fb), first(fo))
          : null;
    const members = new Set([...readmePaths, ...(targets ? targets.keys() : [])]);
    for (const p of [...members].sort()) {
      const s = sides.get(p) ?? { base: ABSENT, theirs: ABSENT, ours: ABSENT };
      const target: Target | { kind: "ours" } = keepOurs
        ? { kind: "ours" }
        : (targets?.get(p) ?? { kind: "absent" });
      const delta =
        target.kind !== "ours" && target.kind !== "absent" && !targetEqualsOurs(target, s.ours);
      const deleted = target.kind === "absent" && s.ours.kind !== "absent";
      if (
        identity(s.base) === identity(s.theirs) &&
        identity(s.theirs) === identity(s.ours) &&
        !delta &&
        !deleted
      ) {
        continue;
      }
      decisions.push({
        path: p,
        group: "readme",
        base: identity(s.base),
        theirs: identity(s.theirs),
        ours: identity(s.ours),
        upstreamChanged: changed,
        explainedBy: { base: eBase, theirs: eTheirs },
        class: cls,
        subtype,
        decision: keepOurs ? "ours" : "theirs",
        target,
        delta,
        deleted,
      });
    }
  }

  for (const p of examined) {
    if (p === DESCRIPTION_PATH || readmePaths.has(p)) continue;
    const s = sides.get(p) as { base: Side; theirs: Side; ours: Side };
    const eBase: EditName | null = explainEdit(p, s.base, s.ours, ctx);
    const eTheirs: EditName | null = explainEdit(p, s.theirs, s.ours, ctx);
    const changed = identity(s.base) !== identity(s.theirs);
    const explained = eBase !== null || eTheirs !== null;
    // A side whose bytes a check needed and could not have: not evidence of anything.
    const unread = [s.base, s.theirs, s.ours].some(
      (x) => x.kind === "git" && refusedOids.has(x.oid),
    );
    const cls: PathClass = !explained && unread ? "unchecked" : classify(changed, explained);
    const keep = cls === "keep-ours" || (cls === "take-theirs" && eTheirs !== null);
    const target: Target | { kind: "ours" } = keep
      ? { kind: "ours" }
      : targetOf(p, s.theirs, { sentences: changesSentences, oursHasBidsignore });
    const sameAsOurs = target.kind !== "ours" && targetEqualsOurs(target, s.ours);
    const delta = target.kind !== "ours" && target.kind !== "absent" && !sameAsOurs;
    const deleted = target.kind === "absent" && s.ours.kind !== "absent";
    decisions.push({
      path: p,
      group: null,
      base: identity(s.base),
      theirs: identity(s.theirs),
      ours: identity(s.ours),
      upstreamChanged: changed,
      explainedBy: { base: eBase, theirs: eTheirs },
      class: cls,
      subtype:
        cls === "conflict"
          ? conflictSubtype(s.base, s.theirs, s.ours)
          : cls === "correction"
            ? correctionSubtype(s.base, s.ours)
            : cls === "unchecked"
              ? "fetch-bound"
              : null,
      decision: keep || sameAsOurs ? "ours" : "theirs",
      target: sameAsOurs ? { kind: "ours" } : target,
      delta,
      deleted,
    });
  }

  decisions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    decisions,
    description,
    gitlinks,
    oursKeys,
    sides,
    fetchRefused: refusedOids.size,
    changesSentences,
  };
}

function descBytes(s: Side): { present: boolean; bytes: Buffer | null } {
  if (s.kind === "absent") return { present: false, bytes: null };
  return { present: true, bytes: s.kind === "git" ? s.bytes : null };
}
