/**
 * Which OpenNeuro mirrors are behind upstream (epic #1046 phase 4, #1910; ADR 0111, decision 6
 * and the Phase 4 amendment).
 *
 * PURE. The Worker gathers the facts (D1 rows, OpenNeuro's snapshot lists, the GitHub mirror
 * probe) and this module classifies them, so that the route now, and the command, the weekly
 * section and the scheduler (all still to be built) will read the same verdict, and the rules can
 * be tested without a network.
 *
 * THE ORDER IS UPSTREAM'S CREATION ORDER, NOT THE NUMBER. `ds000001` has snapshots `00006`
 * (2018) and `1.0.0` (2020); numerically `1.0.0 < 00006`, so ordering by number would call a
 * mirror recorded at `00006` an anomaly while it is stale. A recorded tag is stale when it is
 * present in upstream's list and upstream's latest snapshot was created later. The latest tag must
 * also be a tag the Phase 2 parser could record ({@link isSourceTag}); otherwise a re-pull to it
 * could never be proved afterwards, and the row is an anomaly for an administrator to read.
 *
 * UNKNOWN IS NEVER A VERDICT (ADR 0053, ADR 0054). A mirror whose tag is unknown, a mirror
 * OpenNeuro could not be asked about, and a mirror the GitHub probe could not read each have
 * their own state; none is "current" and none is "not stale".
 */

import { annexKeyFieldSize } from "./annex-key.js";
import {
  type SourceVersionRow,
  isSourceTag,
  mirroredTagOf,
  openNeuroSourceId,
} from "./source-snapshot.js";

/** Every state a row can be in, in the order a report prints them. */
export const UPSTREAM_STATES = [
  "current",
  "stale_ready",
  "mirror_lag",
  "stale_unverified",
  "anomaly",
  "unknown",
  "not_examined",
  "unpublished",
  "in_progress",
  "parked",
  "unchecked",
] as const;
export type UpstreamState = (typeof UPSTREAM_STATES)[number];

/** The three states that mean "upstream has a newer snapshot": their sum is "stale". */
export const STALE_STATES = ["stale_ready", "mirror_lag", "stale_unverified"] as const;

export const ANOMALY_KINDS = [
  "source_id_mismatch",
  "upstream_deleted",
  "upstream_absent",
  "upstream_no_snapshot",
  "upstream_tag_unparsable",
  "recorded_tag_not_upstream",
  "upstream_older",
  "upstream_dates_unreadable",
  "upstream_latest_inconsistent",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface UpstreamSnapshot {
  tag: string;
  created: string | null;
}

/** What OpenNeuro said about one dataset. `error` is "could not ask", never a verdict. */
export type UpstreamRead =
  | { kind: "snapshot"; latest: UpstreamSnapshot | null; snapshots: UpstreamSnapshot[] }
  | { kind: "deleted"; reason: string }
  | { kind: "absent"; reason: string }
  | { kind: "error"; reason: string };

/** Whether the newer upstream tag has reached OpenNeuro's GitHub mirror. */
export type MirrorProbe =
  | { kind: "ready" }
  | { kind: "lag" }
  | { kind: "unverified"; reason: string };

/** What D1 knows about one mirror. */
export interface MirrorFacts {
  /** `on######`. */
  datasetId: string;
  /** `datasets.source_id`. */
  sourceId: string | null;
  visibility: string | null;
  /** `import_jobs.status`, null when the dataset has no row. */
  importStatus: string | null;
  /** `import_jobs.blocklisted = 1`. */
  blocklisted: boolean;
  blocklistReason: string | null;
  /** The status of the mirror's one open re-pull (`upstream_repulls`), null when none is open. */
  repullStatus?: string | null;
  /** The upstream tag that open re-pull is pulling. */
  repullToTag?: string | null;
  versions: Array<SourceVersionRow & { created_at: string | null }>;
}

/** One row on the wire (the route and the CLI share it). */
export interface UpstreamStatusRow {
  dataset_id: string;
  ds: string | null;
  visibility: string | null;
  state: UpstreamState;
  anomaly: AnomalyKind | null;
  /** One plain sentence naming both tags where there are two. */
  reason: string;
  recorded: { version: string; tag: string | null; basis: string | null } | null;
  upstream: {
    latest_tag: string | null;
    latest_created: string | null;
    snapshots: UpstreamSnapshot[];
  } | null;
  import_status: string | null;
  /**
   * For an `unknown` row only: upstream's latest snapshot was created after the mirror's latest
   * NEMAR version row. Display only, never recorded and never added to the stale count (ADR 0111,
   * decision 4). Null for every other state, and for an unknown row that could not be compared.
   */
  probably_stale: boolean | null;
}

export type ClassifiedMirror = UpstreamStatusRow & {
  /** True when the row is stale and has not been probed yet; stripped before the wire. */
  needs_probe: boolean;
};

export interface UpstreamStateCounts {
  states: Record<UpstreamState, number>;
  anomalies: Record<AnomalyKind, number>;
  /** The sum of {@link STALE_STATES}. */
  stale: number;
  probably_stale: number;
}

/** One page of the route's answer (also what the CLI aggregates). */
export interface UpstreamStatusPage {
  /**
   * False only when at least one row on the page needed an OpenNeuro verdict (a known tag) and
   * EVERY such row ended `unchecked`. A page of only unknown-tag rows with OpenNeuro down is
   * `ok: true` with those rows `unknown`, their reasons naming the failure. A partial failure is
   * also `ok: true`: a caller must read `errors[]` and the `unchecked` count, not only the status.
   */
  ok: boolean;
  rows: UpstreamStatusRow[];
  /** Counts for THIS page only; summing pages (or recounting the rows) is the caller's job. */
  counts: UpstreamStateCounts;
  next_cursor: string | null;
  /** Mirrors after this page's last row. */
  remaining: number;
  /** The whole fleet, read in this call. */
  population_total: number;
  /** Withdrawn mirrors: excluded from the pass and counted on their own. */
  withdrawn: number;
  /**
   * `on######` rows that are NOT managed OpenNeuro mirrors (another `source`, or owned by the
   * system user): left out of the report and counted here, so what was left out is said.
   */
  excluded_unmanaged: number;
  upstream_requests: number;
  probes: { attempted: number; budget: number };
  /** Batch-level problems, at most ten. */
  errors: string[];
  error?: string;
}

/**
 * The whole fleet in counts, for the weekly report: no row and no dataset id, because the report
 * is filed on a public-facing repository. `counts` is recounted from the deduped rows of every
 * page, never added from the pages' own `counts`.
 */
export interface UpstreamFleetSummary {
  /** Managed mirrors in the population (withdrawn ones are not in it). */
  population: number;
  /** Distinct mirrors the pass reached. */
  examined: number;
  withdrawn: number;
  excluded_unmanaged: number;
  counts: UpstreamStateCounts;
  /** The pass did not reach every mirror: it stopped early, or the population changed under it. */
  truncated: boolean;
  /** Batch-level problems, without dataset ids, at most ten. */
  errors: string[];
}

const IN_PROGRESS = new Set(["preparing", "copying", "finalizing"]);
const PARKED_STATUS = new Set(["quarantined", "rolled_back"]);

/**
 * A timestamp as milliseconds, or NaN. D1's `datetime('now')` is UTC without a zone
 * (`2026-01-01 00:00:00`), which `Date.parse` would read as local time, so a bare one is read as
 * UTC here. OpenNeuro's own stamps carry a `Z`.
 */
function parseMs(value: string | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  const bare = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  return Date.parse(bare ? `${value.replace(" ", "T")}Z` : value);
}

function base(m: MirrorFacts): ClassifiedMirror {
  const mt = mirroredTagOf(m.versions);
  return {
    dataset_id: m.datasetId,
    ds: openNeuroSourceId(m.datasetId),
    visibility: m.visibility,
    state: "unchecked",
    anomaly: null,
    reason: "",
    recorded:
      mt.state === "none"
        ? null
        : {
            version: mt.version,
            tag: mt.tag,
            basis: mt.state === "known" ? mt.basis : mt.state === "unknown" ? "unknown" : null,
          },
    upstream: null,
    import_status: m.importStatus,
    probably_stale: null,
    needs_probe: false,
  };
}

function settle(
  row: ClassifiedMirror,
  state: UpstreamState,
  reason: string,
  anomaly: AnomalyKind | null = null,
): ClassifiedMirror {
  row.state = state;
  row.reason = reason;
  row.anomaly = anomaly;
  return row;
}

/**
 * Steps 1 to 5 of {@link classifyMirror}: the verdicts that need nothing from OpenNeuro. Returns
 * the settled row, or null when the row has a tag to compare (or an unknown one to describe).
 */
function withoutUpstream(m: MirrorFacts, row: ClassifiedMirror): ClassifiedMirror | null {
  // 1. An import is running; its tree is not settled, so nothing is said about its version.
  if (m.importStatus !== null && IN_PROGRESS.has(m.importStatus) && !m.blocklisted) {
    return settle(row, "in_progress", `an import is ${m.importStatus}; not compared`);
  }
  // 1b. A re-pull of this mirror is under way (a non-terminal `upstream_repulls` row); its tree is
  //     no more settled than an import's, and a second re-pull cannot start beside it.
  if (m.repullStatus != null) {
    const to = m.repullToTag ? ` to ${m.repullToTag}` : "";
    return settle(row, "in_progress", `a re-pull${to} is ${m.repullStatus}; not compared`);
  }
  // 2. Parked by the retry engine or an administrator; a re-pull is not this row's next step.
  if (m.blocklisted || (m.importStatus !== null && PARKED_STATUS.has(m.importStatus))) {
    const why = m.blocklisted
      ? `blocklisted${m.blocklistReason ? `: ${m.blocklistReason}` : ""}`
      : `import ${m.importStatus}`;
    return settle(row, "parked", `parked (${why}); not compared`);
  }
  // 3. The row does not name the upstream dataset its id implies, so no question to OpenNeuro
  //    would be about this mirror.
  const expected = openNeuroSourceId(m.datasetId);
  if (expected === null || (m.sourceId !== null && m.sourceId !== expected)) {
    return settle(
      row,
      "anomaly",
      expected === null
        ? `${m.datasetId} is not an on###### id, so it names no upstream dataset`
        : `source_id is ${m.sourceId}, but ${m.datasetId} mirrors ${expected}`,
      "source_id_mismatch",
    );
  }
  const mt = mirroredTagOf(m.versions);
  // 4. No NEMAR version yet.
  if (mt.state === "none") {
    return settle(row, "unpublished", "no NEMAR version exists yet; nothing to compare");
  }
  // 5. A version exists and was never looked at.
  if (mt.state === "unexamined") {
    return settle(
      row,
      "not_examined",
      `version ${mt.version} has not been examined for its upstream tag; run nemar admin upstream-backfill`,
    );
  }
  return null;
}

/**
 * Does this row need OpenNeuro's snapshot list? True exactly when steps 1 to 5 of
 * {@link classifyMirror} do not settle it, so `unpublished`, `not_examined`, `in_progress`,
 * `parked` and `source_id_mismatch` rows are never sent to OpenNeuro.
 */
export function needsUpstream(m: MirrorFacts): boolean {
  return withoutUpstream(m, base(m)) === null;
}

function snapshotOf(list: readonly UpstreamSnapshot[], tag: string): UpstreamSnapshot | undefined {
  return list.find((s) => s.tag === tag);
}

/**
 * One mirror's verdict. The first matching step wins; each is commented where it happens.
 * `up` is what OpenNeuro said and `probe` whether the newer tag has reached the GitHub mirror;
 * both may be absent, which is never read as a verdict.
 */
export function classifyMirror(
  m: MirrorFacts,
  up?: UpstreamRead,
  probe?: MirrorProbe,
): ClassifiedMirror {
  const row = base(m);
  const early = withoutUpstream(m, row);
  if (early) return early;

  const mt = mirroredTagOf(m.versions);
  const snapshot = up?.kind === "snapshot" ? up : null;
  if (snapshot) {
    row.upstream = {
      latest_tag: snapshot.latest?.tag ?? null,
      latest_created: snapshot.latest?.created ?? null,
      snapshots: snapshot.snapshots,
    };
  }

  // 6. The tag is unknown: never current, never stale. Say "probably stale" by date, for display.
  if (mt.state === "unknown") {
    const latestCreated = parseMs(snapshot?.latest?.created);
    const versionCreated = parseMs(m.versions.find((v) => v.version === mt.version)?.created_at);
    if (!Number.isNaN(latestCreated) && !Number.isNaN(versionCreated)) {
      row.probably_stale = latestCreated > versionCreated;
    }
    const base = `version ${mt.version} names no single upstream tag`;
    let why: string;
    if (up?.kind === "error") why = `OpenNeuro could not be read for ${row.ds}: ${up.reason}`;
    else if (!up) why = `OpenNeuro was not asked about ${row.ds}`;
    else if (row.probably_stale === true) {
      why = "upstream has a snapshot created after it, so it is probably stale";
    } else why = "it cannot be compared";
    return settle(row, "unknown", `${base}; ${why}`);
  }
  if (mt.state !== "known") {
    // withoutUpstream settled every other state; this keeps the type honest.
    return settle(row, "unchecked", "the recorded tag could not be read");
  }
  const recorded = mt.tag;

  // 7. The tag is known, but OpenNeuro was not asked or could not answer.
  if (!up || up.kind === "error") {
    return settle(
      row,
      "unchecked",
      up
        ? `OpenNeuro could not be read for ${row.ds}: ${up.reason}`
        : `OpenNeuro was not asked about ${row.ds}`,
    );
  }
  // 8. Upstream no longer has the dataset.
  if (up.kind === "deleted") {
    return settle(
      row,
      "anomaly",
      `upstream ${row.ds} has been deleted: ${up.reason}`,
      "upstream_deleted",
    );
  }
  if (up.kind === "absent") {
    return settle(
      row,
      "anomaly",
      `upstream ${row.ds} does not exist: ${up.reason}`,
      "upstream_absent",
    );
  }
  // 9. Upstream has no snapshot at all.
  const latest = up.latest;
  if (latest === null) {
    return settle(row, "anomaly", `upstream ${row.ds} has no snapshot`, "upstream_no_snapshot");
  }
  // 9b. The latest's creation date: its own, or when that is unreadable its entry in the list. If
  //     neither reads, nothing below can be trusted (a row would read `current` beside a later
  //     snapshot), so that is an anomaly rather than a fall-through.
  const entryCreated = snapshotOf(up.snapshots, latest.tag)?.created ?? null;
  const latestCreated = [latest.created, entryCreated].find(
    (c): c is string => c !== null && !Number.isNaN(parseMs(c)),
  );
  if (latestCreated === undefined) {
    return settle(
      row,
      "anomaly",
      `the creation date of upstream's latest ${latest.tag} is unreadable, so the order cannot be established`,
      "upstream_dates_unreadable",
    );
  }
  //     And the latest must not disagree with the list: a snapshot created after it.
  const latestMs = parseMs(latestCreated);
  const later = up.snapshots.find((s) => parseMs(s.created) > latestMs);
  if (later) {
    return settle(
      row,
      "anomaly",
      `upstream says its latest is ${latest.tag}, but ${later.tag} in its own list was created later`,
      "upstream_latest_inconsistent",
    );
  }
  // 10. The same tag: current.
  if (latest.tag === recorded) {
    return settle(row, "current", `at upstream's latest snapshot, ${recorded}`);
  }
  // 11. A latest tag the parser could never record cannot be the target of a provable re-pull.
  if (!isSourceTag(latest.tag)) {
    return settle(
      row,
      "anomaly",
      `upstream's latest tag ${latest.tag} is not a numeric tag, so a re-pull to it could not be recorded`,
      "upstream_tag_unparsable",
    );
  }
  // 12. The recorded tag is not one of upstream's snapshots, so its place in the history is unknown.
  const mine = snapshotOf(up.snapshots, recorded);
  if (!mine) {
    return settle(
      row,
      "anomaly",
      `the recorded tag ${recorded} is not among upstream's snapshots (latest ${latest.tag})`,
      "recorded_tag_not_upstream",
    );
  }
  // 13. Compare creation times, never the numbers (see the module comment).
  const theirs = latestCreated;
  const mineMs = parseMs(mine.created);
  const theirsMs = latestMs;
  if (Number.isNaN(mineMs)) {
    return settle(
      row,
      "anomaly",
      `the creation date of ${recorded} is unreadable, so the order cannot be established`,
      "upstream_dates_unreadable",
    );
  }
  if (theirsMs <= mineMs) {
    return settle(
      row,
      "anomaly",
      `upstream's latest ${latest.tag} was not created after the recorded ${recorded}`,
      "upstream_older",
    );
  }
  // 14. Upstream is newer. Has the tag reached the GitHub mirror?
  const newer = `upstream ${latest.tag} (${theirs.slice(0, 10)}) is newer than the recorded ${recorded}`;
  if (!probe) {
    row.needs_probe = true;
    return settle(row, "stale_unverified", `${newer}; the GitHub mirror was not checked`);
  }
  if (probe.kind === "ready") {
    return settle(row, "stale_ready", `${newer}; the tag is on the GitHub mirror`);
  }
  if (probe.kind === "lag") {
    return settle(row, "mirror_lag", `${newer}; the tag is not on the GitHub mirror yet`);
  }
  return settle(
    row,
    "stale_unverified",
    `${newer}; the GitHub mirror could not be checked: ${probe.reason}`,
  );
}

/**
 * Classify every mirror. `upstream` and `probes` are keyed by `ds` (`openNeuroSourceId`). A
 * second call with the probes gives the final verdicts; rows flagged `needs_probe` in the first
 * are the ones to probe.
 */
export function diffStaleMirrors(
  mirrors: readonly MirrorFacts[],
  upstream: ReadonlyMap<string, UpstreamRead>,
  probes?: ReadonlyMap<string, MirrorProbe>,
): ClassifiedMirror[] {
  return mirrors.map((m) => {
    const ds = openNeuroSourceId(m.datasetId);
    return classifyMirror(
      m,
      ds === null ? undefined : upstream.get(ds),
      ds === null ? undefined : probes?.get(ds),
    );
  });
}

/** A row as it goes on the wire: without the internal `needs_probe` flag. */
export function toWireRow(row: ClassifiedMirror): UpstreamStatusRow {
  const { needs_probe: _needsProbe, ...wire } = row;
  return wire;
}

/**
 * Counts by state and by anomaly kind, zero-filled: a state at zero prints as 0, so a missing key
 * can never read as zero.
 */
export function countUpstreamStates(rows: readonly UpstreamStatusRow[]): UpstreamStateCounts {
  const states = Object.fromEntries(UPSTREAM_STATES.map((s) => [s, 0])) as Record<
    UpstreamState,
    number
  >;
  const anomalies = Object.fromEntries(ANOMALY_KINDS.map((k) => [k, 0])) as Record<
    AnomalyKind,
    number
  >;
  let probablyStale = 0;
  for (const row of rows) {
    states[row.state]++;
    if (row.anomaly !== null) anomalies[row.anomaly]++;
    if (row.probably_stale === true) probablyStale++;
  }
  const stale = STALE_STATES.reduce((sum, s) => sum + states[s], 0);
  return { states, anomalies, stale, probably_stale: probablyStale };
}

// ----------------------------------------------------------------------------
// The measurement (Phase 4c): what a re-pull would carry
// ----------------------------------------------------------------------------

/** One entry of an OpenNeuro snapshot's recursive file listing (`DatasetFile`). */
export interface SnapshotFile {
  filename: string;
  /** The git-annex key for an annexed file, the blob SHA for a git file. */
  id: string;
  size: number | null;
  annexed: boolean;
  directory?: boolean;
}

/**
 * What changed between two snapshots of one dataset, as OpenNeuro lists them. It is UPSTREAM'S
 * delta between the two tags, not NEMAR's tree: NEMAR's corrections, its scrubs and its annex
 * policy are not in it (ADR 0111, Phase 4c amendment).
 */
export interface SnapshotDelta {
  added: number;
  changed: number;
  deleted: number;
  annexed_added: number;
  annexed_changed: number;
  annexed_deleted: number;
  /** Any annexed file was added, changed or deleted. */
  data_changing: boolean;
  /** Distinct annex keys the target snapshot has and the source snapshot does not. */
  new_keys: number;
  /**
   * Bytes of the new keys, from the size each key declares in its fields, falling back to the
   * listing's size. Null when any new key has neither: an unknown size is never a zero.
   */
  bytes_to_copy: number | null;
}

/**
 * Summarize the change from the `from` listing to the `to` listing.
 *
 * Directory entries are skipped. Files match by `filename`; `changed` means a different `id`
 * (a content change, whatever the size). An annexed count follows the side that holds the file:
 * the `to` entry for an addition, the `from` entry for a deletion, and EITHER side for a change,
 * so a file moving between git and the annex counts as annexed.
 */
export function summarizeSnapshotDelta(
  from: readonly SnapshotFile[],
  to: readonly SnapshotFile[],
): SnapshotDelta {
  const before = new Map<string, SnapshotFile>();
  for (const f of from) if (!f.directory) before.set(f.filename, f);
  const after = new Map<string, SnapshotFile>();
  for (const f of to) if (!f.directory) after.set(f.filename, f);

  let added = 0;
  let changed = 0;
  let deleted = 0;
  let annexedAdded = 0;
  let annexedChanged = 0;
  let annexedDeleted = 0;
  for (const [name, f] of after) {
    const old = before.get(name);
    if (old === undefined) {
      added++;
      if (f.annexed) annexedAdded++;
    } else if (old.id !== f.id) {
      changed++;
      if (f.annexed || old.annexed) annexedChanged++;
    }
  }
  for (const [name, f] of before) {
    if (!after.has(name)) {
      deleted++;
      if (f.annexed) annexedDeleted++;
    }
  }

  const known = new Set<string>();
  for (const f of before.values()) known.add(f.id);
  const newKeys = new Map<string, SnapshotFile>();
  for (const f of after.values()) {
    if (f.annexed && !known.has(f.id) && !newKeys.has(f.id)) newKeys.set(f.id, f);
  }
  let bytes: number | null = 0;
  for (const [key, f] of newKeys) {
    // The strict field parser: a free-text name such as `WORM-s5-m17--a-s9--b` must not be read as
    // 9 bytes (the looser `annexKeyDeclaredSize` does). Without a size field, the listing's size.
    const size = annexKeyFieldSize(key) ?? f.size;
    if (size === null) {
      bytes = null;
      break;
    }
    bytes += size;
  }

  return {
    added,
    changed,
    deleted,
    annexed_added: annexedAdded,
    annexed_changed: annexedChanged,
    annexed_deleted: annexedDeleted,
    data_changing: annexedAdded + annexedChanged + annexedDeleted > 0,
    new_keys: newKeys.size,
    bytes_to_copy: bytes,
  };
}

const DAY_MS = 86_400_000;

/** How many re-pulls (and so DOIs) the fleet would mint, under three readings of upstream churn. */
export interface DoiVolume {
  window_days: number;
  /** Mirrors in `current` or a `stale_*` state: a known tag and a snapshot list were read. */
  mirrors_counted: number;
  /**
   * Mirrors left out, by state, zero-filled. A mirror in a state with no snapshot comparison
   * (unknown, not_examined, unchecked, anomaly, and so on) is left out under its own state. A
   * `current` or stale row that somehow carries no upstream data would also land here under its
   * state; the classifier always sets it, so those two stay 0 in practice.
   */
  excluded: Record<UpstreamState, number>;
  /** One re-pull straight to the latest tag for each stale mirror. */
  catch_up: number;
  /** Upstream snapshots created in the window, every dataset's first excluded: one re-pull each. */
  per_snapshot: number;
  /** The same snapshots, at most one counted per dataset per `minGapDays`. */
  at_most_every_30_days: number;
  /** The most of those snapshots created on one UTC date. */
  busiest_day: number;
  /** Each figure doubled: a re-pull with corrections also mints an N.0.1 DOI. */
  upper_bound_with_patches: {
    catch_up: number;
    per_snapshot: number;
    at_most_every_30_days: number;
  };
  /** Snapshots whose `created` did not parse: left out of the figures above, never read as old. */
  snapshots_with_unreadable_dates: number;
  /** Snapshots dated after `now`: left out of the figures above, counted so they cannot vanish. */
  snapshots_dated_in_the_future: number;
}

/** A snapshot's creation time in ms, NaN when absent or unparsable. */
function createdMs(created: string | null): number {
  return created === null ? Number.NaN : Date.parse(created);
}

const COUNTED_STATES: readonly UpstreamState[] = ["current", ...STALE_STATES];

/**
 * Estimate the DOI volume of re-pulling (ADR 0111). Whether a re-pull carries corrections, and so
 * a second DOI, is known only from a plan (`nemar admin repull plan`), so the figure is a range:
 * the base and its doubling. The first snapshot of a dataset (the earliest by creation date) was
 * the import, not a re-pull, so it is not counted. When any snapshot of a dataset has an
 * unreadable date the earliest cannot be identified, so none is excluded for that dataset and its
 * figures can be high by one: the estimate errs high rather than guess which one was the import.
 */
export function estimateRepullDoiVolume(
  rows: readonly UpstreamStatusRow[],
  nowMs: number,
  opts: { windowDays?: number; minGapDays?: number } = {},
): DoiVolume {
  const windowDays = opts.windowDays ?? 365;
  const minGapMs = (opts.minGapDays ?? 30) * DAY_MS;
  const since = nowMs - windowDays * DAY_MS;

  const excluded = Object.fromEntries(UPSTREAM_STATES.map((s) => [s, 0])) as Record<
    UpstreamState,
    number
  >;
  let counted = 0;
  let catchUp = 0;
  let perSnapshot = 0;
  let spaced = 0;
  let unreadable = 0;
  let future = 0;
  const perDay = new Map<string, number>();

  for (const row of rows) {
    if (!COUNTED_STATES.includes(row.state) || row.upstream === null) {
      excluded[row.state]++;
      continue;
    }
    counted++;
    if ((STALE_STATES as readonly string[]).includes(row.state)) catchUp++;

    const times = row.upstream.snapshots.map((s) => createdMs(s.created));
    const stamped = times.filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    const unreadableHere = times.length - stamped.length;
    unreadable += unreadableHere;
    // Drop the import (the earliest by date); keep everything when a date is unreadable, because
    // the unreadable one could be the earliest.
    const candidates = unreadableHere === 0 ? stamped.slice(1) : stamped;
    let lastCounted = Number.NEGATIVE_INFINITY;
    for (const t of candidates) {
      if (t > nowMs) {
        future++;
        continue;
      }
      if (t <= since) continue;
      perSnapshot++;
      const day = new Date(t).toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      if (t - lastCounted >= minGapMs) {
        spaced++;
        lastCounted = t;
      }
    }
  }

  return {
    window_days: windowDays,
    mirrors_counted: counted,
    excluded,
    catch_up: catchUp,
    per_snapshot: perSnapshot,
    at_most_every_30_days: spaced,
    busiest_day: Math.max(0, ...perDay.values()),
    upper_bound_with_patches: {
      catch_up: catchUp * 2,
      per_snapshot: perSnapshot * 2,
      at_most_every_30_days: spaced * 2,
    },
    snapshots_with_unreadable_dates: unreadable,
    snapshots_dated_in_the_future: future,
  };
}
