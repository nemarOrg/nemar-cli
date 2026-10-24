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

/** The three words `dataset_versions.source_version_basis` can hold (migration 0104). */
export const SOURCE_VERSION_BASES = ["doi", "lineage", "unknown"] as const;
export type SourceVersionBasis = (typeof SOURCE_VERSION_BASES)[number];

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
 */
export type MirroredTag =
  | { state: "known"; tag: string; version: string; basis: "doi" | "lineage" }
  | { state: "unknown" | "unexamined"; tag: null; version: string }
  | { state: "none"; tag: null; version: null };

const NEMAR_VERSION_RE = /^\d+\.\d+\.\d+$/;

function versionParts(version: string): number[] {
  return version.split(".").map((p) => Number.parseInt(p, 10));
}

/** Numeric order on `N.N.N`, so `10.0.0` is newer than `9.0.0`. */
function compareNemarVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The dataset's mirrored tag, derived from its highest NEMAR version row (ADR 0111, decision 4).
 * Only that row speaks: an older row that knows its tag never stands in for a newer one that was
 * not examined or is unknown, because the newest version is the one a re-pull would start from.
 * Rows whose version is not `N.N.N` are ignored.
 */
export function mirroredTagOf(rows: readonly SourceVersionRow[]): MirroredTag {
  let top: SourceVersionRow | null = null;
  for (const row of rows) {
    if (!NEMAR_VERSION_RE.test(row.version)) continue;
    if (top === null || compareNemarVersions(row.version, top.version) > 0) top = row;
  }
  if (top === null) return { state: "none", tag: null, version: null };
  const basis = top.source_version_basis;
  if (top.source_version !== null && (basis === "doi" || basis === "lineage")) {
    return { state: "known", tag: top.source_version, version: top.version, basis };
  }
  if (basis === "unknown") return { state: "unknown", tag: null, version: top.version };
  return { state: "unexamined", tag: null, version: top.version };
}
