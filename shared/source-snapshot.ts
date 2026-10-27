/**
 * Which upstream snapshot a version of a mirrored dataset came from (epic #1046 phase 2, #1908;
 * ADR 0111, decision 4).
 *
 * ONE parser, shared by the Worker (which records the answer when a version row is inserted and
 * in the backfill) and the CLI (which reads a clone's tagged `dataset_description.json` in a
 * re-pull plan). Pure, with no imports, so both sides bundle it the way they bundle
 * `readme-candidates.ts`.
 *
 * THE RULE. The tag is what the dataset's OWN entry in `SourceDatasets` says, and only that
 * entry. The top-level `Version` and `DatasetDOI` are NEMAR's (ADR 0111, decision 1): reading
 * the top-level `Version` would record NEMAR's own version number as upstream's. An entry is
 * the dataset's own when its DOI or URL names the dataset's `ds`; an entry that names no `ds`
 * at all is ignored, `Version` included, because a bare version number says nothing about whose
 * it is.
 *
 * Three signals in an own entry can carry the tag: its `Version`, its DOI
 * (`10.18112/openneuro.<ds>.v<tag>`, with a `doi:` or `https://doi.org/` prefix or none), and its
 * URL (`openneuro.org/datasets/<ds>/versions/<tag>` or the GitHub mirror's tree or release URL).
 * They are never ranked against each other: any disagreement, between signals or between two own
 * entries, is `unknown`. A tag is never guessed and never normalized (`00001` and `1` are
 * different tags), so it is stored as upstream wrote it.
 *
 * The basis word for a tag found this way is `doi`, the name ADR 0111 fixed. It means the tag is
 * DECLARED by the description, not that the tree was compared with upstream's.
 */

/** What the parser answers: a known tag with basis `doi`, or no tag with basis `unknown`. */
export type SourceSnapshot =
  | { source_version: string; source_version_basis: "doi" }
  | { source_version: null; source_version_basis: "unknown" };

const UNKNOWN: SourceSnapshot = { source_version: null, source_version_basis: "unknown" };

/** `ds` followed by six digits, the form of an OpenNeuro dataset id. */
const DS_ID_RE = /^ds\d{6}$/;

/**
 * An upstream tag: one to four dot-separated numeric components of at most nine digits. Covers
 * `2.0.2`, `1.0.0` and the legacy `00001`; anything else (`v2.0.2.`, `2.0.x`) is not a tag.
 */
const TAG_RE = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;

/**
 * True when `tag` is an upstream tag the parser can record (see {@link TAG_RE}). A tag that
 * fails this (a legacy hex snapshot id, `v2.0.2.`) could never be written to
 * `dataset_versions.source_version`, so a re-pull to it could never be proved afterwards.
 */
export function isSourceTag(tag: unknown): tag is string {
  return typeof tag === "string" && TAG_RE.test(tag);
}

/** The `ds` an NEMAR `on######` id mirrors, or null for any other id. */
export function openNeuroSourceId(datasetId: string): string | null {
  const m = /^on(\d{6})$/.exec(datasetId);
  return m ? `ds${m[1]}` : null;
}

/** A tag in a `Version` string: one leading `v` is allowed, and the rest must be a tag. */
function tagFromVersionField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  return TAG_RE.test(bare) ? bare : null;
}

/** What one string (a DOI or a URL field) says about which `ds` it names and which tag. */
interface Named {
  ds: string;
  /** null when the string names a dataset without a readable tag. */
  tag: string | null;
}

const DOI_PREFIX_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const OPENNEURO_DOI_RE = /^10\.18112\/openneuro\.(ds\d{6})(?:\.v(.*))?$/i;
const OPENNEURO_URL_RE =
  /^https?:\/\/(?:www\.)?openneuro\.org\/datasets\/(ds\d{6})(?:\/versions\/([^/?#]*))?(?:[/?#].*)?$/i;
const GITHUB_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/OpenNeuroDatasets\/(ds\d{6})(?:\/(?:tree|releases\/tag)\/([^/?#]*))?(?:[/?#].*)?$/i;

function namedByString(value: unknown): Named | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const doi = OPENNEURO_DOI_RE.exec(text.replace(DOI_PREFIX_RE, ""));
  if (doi) {
    return { ds: (doi[1] as string).toLowerCase(), tag: tagOrNull(doi[2]) };
  }
  const url = OPENNEURO_URL_RE.exec(text) ?? GITHUB_URL_RE.exec(text);
  if (url) {
    return { ds: (url[1] as string).toLowerCase(), tag: tagOrNull(url[2]) };
  }
  return null;
}

function tagOrNull(candidate: string | undefined): string | null {
  return candidate !== undefined && TAG_RE.test(candidate) ? candidate : null;
}

/** An entry's reading: the `ds` values it names and the tags its three signals give. */
function readEntry(entry: unknown): { names: Set<string>; tags: string[] } | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const names = new Set<string>();
  const tags: string[] = [];
  for (const named of [namedByString(e.DOI), namedByString(e.URL)]) {
    if (!named) continue;
    names.add(named.ds);
    if (named.tag !== null) tags.push(named.tag);
  }
  const fromVersion = tagFromVersionField(e.Version);
  if (fromVersion !== null) tags.push(fromVersion);
  return { names, tags };
}

/**
 * Is this `SourceDatasets` entry the one that names the dataset's own upstream `ds`? Its DOI or
 * URL has to name `sourceId`; a `Version` alone never makes an entry the dataset's own. An entry
 * that names `sourceId` and another dataset as well still counts as own here (a re-pull must find
 * it to rewrite it); {@link sourceSnapshotOf} is the one that refuses to read a tag from it.
 */
export function isOwnSourceEntry(entry: unknown, sourceId: string): boolean {
  const read = readEntry(entry);
  return read?.names.has(sourceId.toLowerCase()) === true;
}

/** The entries of `SourceDatasets`: an array, or the single object some descriptions hold. */
function sourceEntries(desc: unknown): unknown[] | null {
  if (!desc || typeof desc !== "object" || Array.isArray(desc)) return null;
  const sd = (desc as Record<string, unknown>).SourceDatasets;
  if (Array.isArray(sd)) return sd;
  if (sd && typeof sd === "object") return [sd];
  return null;
}

/**
 * The upstream tag a `dataset_description.json` declares for `sourceId` (an OpenNeuro `ds` id),
 * or `unknown`. See the module comment for the rule; in short, one tag from the dataset's own
 * `SourceDatasets` entry or entries, and any disagreement, any absence, and any input that is
 * not a description at all is `unknown`.
 */
export function sourceSnapshotOf(desc: unknown, sourceId: string): SourceSnapshot {
  const own = sourceId.toLowerCase();
  if (!DS_ID_RE.test(own)) return UNKNOWN;
  const entries = sourceEntries(desc);
  if (!entries) return UNKNOWN;

  const tags = new Set<string>();
  for (const entry of entries) {
    const read = readEntry(entry);
    if (!read || !read.names.has(own)) continue;
    // One entry naming two datasets cannot say which one its tag belongs to.
    if (read.names.size > 1) return UNKNOWN;
    for (const tag of read.tags) tags.add(tag);
  }
  if (tags.size !== 1) return UNKNOWN;
  return { source_version: [...tags][0] as string, source_version_basis: "doi" };
}

/** A tag as numbers, padded to four components, or null when it is not a tag. */
function tagParts(tag: string): number[] | null {
  if (!TAG_RE.test(tag)) return null;
  const parts = tag.split(".").map((p) => Number.parseInt(p, 10));
  while (parts.length < 4) parts.push(0);
  return parts;
}

/**
 * Compare two upstream tags numerically, component by component, so `00001` equals `1` and
 * `2.0.10` is newer than `2.0.9`; a missing component counts as 0. Negative when `a` is older,
 * positive when newer, 0 when equal, and null when either is not a tag: an unparsable tag is
 * never ordered, because ordering it would be a guess.
 */
export function compareSourceTags(a: string, b: string): number | null {
  const pa = tagParts(a);
  const pb = tagParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** The slice of a `dataset_versions` row the mirrored tag is derived from. */
export interface SourceVersionRow {
  version: string;
  source_version: string | null;
  source_version_basis: string | null;
}

/**
 * What is known about the tag a dataset mirrors: `known` (with the tag), `unknown` (examined, no
 * tag), `unexamined` (the row was never looked at), or `none` (no NEMAR-numbered version yet).
 * `version` is the highest NEMAR version, bare (`2.0.0`), whichever spelling its rows are stored in.
 */
export type MirroredTag =
  | { state: "known"; tag: string; version: string; basis: "doi" | "lineage" }
  | { state: "unknown" | "unexamined"; tag: null; version: string }
  | { state: "none"; tag: null; version: null };

/**
 * A NEMAR version as `dataset_versions.version` stores it: `N.N.N`, or the tag's spelling `vN.N.N`
 * with one lowercase `v`. D1 holds both (`shared/contract/version.ts`): the version-DOI callback
 * strips the `v` before it writes, but older rows and other writers (the admin manifest route writes
 * the version as its path names it) can carry it. Both spellings of one version name the same tag,
 * `v<N.N.N>`.
 *
 * Wider than `NEMAR_VERSION_RE` in `repull-state.ts` on purpose, so the two are not one constant:
 * that one checks a version a re-pull record or request carries, which is always bare, because the
 * record's statements find a version row in either spelling by prefixing the `v` themselves
 * (`version IN (?, 'v' || ?)`), and a `v` already there would miss the bare row.
 */
const STORED_NEMAR_VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;

/** The bare `N.N.N` of a stored NEMAR version, `v1.0.0` and `1.0.0` alike; null for anything else. */
export function bareNemarVersion(version: string): string | null {
  return STORED_NEMAR_VERSION_RE.exec(version)?.[1] ?? null;
}

function versionParts(version: string): number[] {
  return version.split(".").map((p) => Number.parseInt(p, 10));
}

/**
 * Numeric order on two bare `N.N.N` versions, so `10.0.0` is newer than `9.0.0`. Equal numbers
 * written differently (`01.0.0`) fall back to the text, so the order is total and 0 means the same
 * version, which names one tag.
 */
function compareNemarVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What one version row says of its tag. */
type RowReading =
  | { state: "known"; tag: string; basis: "doi" | "lineage" }
  | { state: "unknown" | "unexamined" };

function readingOf(row: SourceVersionRow): RowReading {
  const basis = row.source_version_basis;
  // One definition of a known tag, shared with `mirrorFlagOf`: only a tag the parser could have
  // recorded. A stored value it could not (an empty string, a hex snapshot id) is not known.
  if (isSourceTag(row.source_version) && (basis === "doi" || basis === "lineage")) {
    return { state: "known", tag: row.source_version, basis };
  }
  // Examined, and no tag the parser could record: unknown, which includes a stored basis whose tag
  // is not a recordable one.
  if (basis === "unknown" || basis === "doi" || basis === "lineage") return { state: "unknown" };
  return { state: "unexamined" };
}

/**
 * The dataset's mirrored tag, derived from its highest NEMAR version (ADR 0111, decision 4), read in
 * both spellings D1 stores (`1.0.0` and `v1.0.0`) and ordered by number. Only that version speaks:
 * an older row that knows its tag never stands in for a newer one that was not examined or is
 * unknown, because the newest version is the one a re-pull would start from. Rows whose version is
 * neither spelling of `N.N.N` are ignored.
 *
 * The highest version can have a row in each spelling, and their order in `rows` decides nothing.
 * Both name the same tag, so a row never examined says nothing against one that was: the tag is
 * known when every row that was examined names it, with `lineage` only when each of them says
 * `lineage`. Two rows that name different tags, or one that names a tag beside one recorded
 * unknown, disagree, and a disagreement is unknown: neither is picked.
 */
export function mirroredTagOf(rows: readonly SourceVersionRow[]): MirroredTag {
  let version: string | null = null;
  let top: SourceVersionRow[] = [];
  for (const row of rows) {
    const bare = bareNemarVersion(row.version);
    if (bare === null) continue;
    const order = version === null ? 1 : compareNemarVersions(bare, version);
    if (order > 0) {
      version = bare;
      top = [row];
    } else if (order === 0) {
      top.push(row);
    }
  }
  if (version === null) return { state: "none", tag: null, version: null };
  const readings = top.map(readingOf);
  const tags = new Set<string>();
  let lineage = true;
  for (const r of readings) {
    if (r.state !== "known") continue;
    tags.add(r.tag);
    if (r.basis !== "lineage") lineage = false;
  }
  const unknown = readings.some((r) => r.state === "unknown");
  if (tags.size === 1 && !unknown) {
    return {
      state: "known",
      tag: [...tags][0] as string,
      version,
      basis: lineage ? "lineage" : "doi",
    };
  }
  if (tags.size > 0 || unknown) return { state: "unknown", tag: null, version };
  return { state: "unexamined", tag: null, version };
}

/** A NEMAR version of the form N.0.0, with the `v` some stored rows and tags carry. */
const MIRROR_VERSION_RE = /^v?\d+\.0\.0$/;

/**
 * Is this version a mirror (ADR 0111, decision 5)? `true`: a version N.0.0 of an `on######`
 * mirror whose upstream tag is known (basis `doi` or `lineage`). `false`: any other dataset, or a
 * version that is not N.0.0 (NEMAR's own corrections are N.x.y). `null`: an N.0.0 version of a
 * mirror whose tag is unknown, or was never examined; unknown is never "no" (ADR 0054), and the
 * website must not show a mirror chip for it. Derived at read time and never stored. Per row: it
 * reads the row's own tag, not the dataset's highest version. An absent column counts as NULL.
 */
export function mirrorFlagOf(
  datasetId: string,
  row: {
    version: string;
    source_version?: string | null;
    source_version_basis?: string | null;
  },
): boolean | null {
  if (openNeuroSourceId(datasetId) === null) return false;
  if (!MIRROR_VERSION_RE.test(row.version)) return false;
  const basis = row.source_version_basis ?? null;
  const tag = row.source_version ?? null;
  // The read side agrees with the write side: only a tag the parser could have recorded is known.
  return isSourceTag(tag) && (basis === "doi" || basis === "lineage") ? true : null;
}
