/**
 * The re-pull plan's preflight checks (ADR 0111, decisions 2, 4 and 10, and #1320).
 *
 * Each check answers `ok`, `refused` or `unchecked`, and unknown is never ok (ADR 0053, ADR 0054):
 * a check that could not ask its question says `unchecked`, and a plan with an unchecked check is
 * not executable. The checks read; none writes.
 */

import {
  isOpenNeuroTag,
  normalizeUpstreamTag,
  sameUpstreamTag,
} from "../../../shared/openneuro-tag.js";
import { isSourceTag } from "../../../shared/source-snapshot.js";
import {
  type SnapshotOrder,
  type UpstreamRead,
  upstreamSnapshotOrder,
} from "../../../shared/upstream-staleness.js";
import { bumpVersion, parseVersion } from "../semver.js";
import { bareVersion } from "./from-tag.js";
import { readOnlyFetch } from "./read-only.js";
import { type MarkerRead, NEMAR_ORG } from "./sources.js";

export type CheckStatus = "ok" | "refused" | "unchecked";

export interface Check {
  name: "from-tag" | "to-tag" | "version" | "release-pr" | "annex-uuid" | "source";
  status: CheckStatus;
  code?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------------------

/**
 * The dataset is a mirror of an OpenNeuro dataset: an `on` id maps to its `ds`, and the dataset
 * row says it came from OpenNeuro under that `ds`. Outside the `on` prefix (an `xx` fixture,
 * which ADR 0111's amendment left open) the row's `source_id` is the only mapping there is.
 */
export function sourceCheck(args: {
  datasetId: string;
  mapped: string | null;
  row: { source?: string | null; source_id?: string | null } | null;
}): { ds: string | null; check: Check } {
  const { row, mapped } = args;
  if (!row) {
    return {
      ds: null,
      check: { name: "source", status: "refused", code: "not-found", detail: "no dataset row" },
    };
  }
  const rowDs =
    typeof row.source_id === "string" && /^ds\d{6}$/.test(row.source_id) ? row.source_id : null;
  if (row.source !== "openneuro") {
    return {
      ds: null,
      check: {
        name: "source",
        status: "refused",
        code: "not-a-mirror",
        detail: `the dataset row's source is ${row.source ?? "unset"}, not openneuro`,
      },
    };
  }
  if (mapped && rowDs && rowDs !== mapped) {
    return {
      ds: null,
      check: {
        name: "source",
        status: "refused",
        code: "source-disagrees",
        detail: `${args.datasetId} maps to ${mapped} but the row names ${rowDs}`,
      },
    };
  }
  const ds = mapped ?? rowDs;
  if (!ds) {
    return {
      ds: null,
      check: {
        name: "source",
        status: "refused",
        code: "no-source-id",
        detail: "no upstream ds id",
      },
    };
  }
  return { ds, check: { name: "source", status: "ok", detail: ds } };
}

// ---------------------------------------------------------------------------------------
// to-tag
// ---------------------------------------------------------------------------------------

/**
 * `to_tag` (ADR 0111, decision 10, and the Phase 4a amendment: upstream's creation order decides,
 * not the number). The default is OpenNeuro's own latest snapshot (`latestSnapshot.tag`, the field
 * Phase 3's import pins its tag to), read with the snapshot list in one answer (`upstream`). It
 * must have an OpenNeuro tag's shape, be a tag the Phase 2 parser can record (`isSourceTag`, so the
 * re-pull can be proved afterwards), and be on the GitHub mirror; equal to `from_tag` is nothing to
 * pull.
 *
 * It is `ok` only when it is OpenNeuro's latest AND OpenNeuro's own list shows it created after
 * `from_tag` (`upstreamSnapshotOrder`, the helper the staleness report's verdict uses). Every
 * other case is `unchecked` and the plan is not executable: a tag that is not OpenNeuro's latest,
 * a plan made while OpenNeuro could not answer, and an order the list cannot establish (a date
 * that does not read, a latest the list contradicts, a `from_tag` the list does not name, or a
 * latest created no later than it). The numbers are never compared: `00006` comes before `1.0.0`.
 */
export function toTagCheck(args: {
  flag: string | undefined;
  mirrorTags: string[];
  fromTag: string | null;
  upstream: UpstreamRead;
}): { tag: string | null; check: Check } {
  // The tag's shape is Phase 3's (shared/openneuro-tag.ts): one definition for every place a tag
  // crosses a boundary, and `v1.1.0` names the same snapshot as `1.1.0`.
  const raw = args.flag?.trim() || undefined;
  const refused = (code: string, detail: string, tag: string | null = null) => ({
    tag,
    check: { name: "to-tag" as const, status: "refused" as const, code, detail },
  });
  const unverified = (tag: string, detail: string) => ({
    tag,
    check: {
      name: "to-tag" as const,
      status: "unchecked" as const,
      code: "order-unverified",
      detail,
    },
  });
  if (raw !== undefined && !isOpenNeuroTag(raw)) {
    return refused("to-tag-malformed", `${raw} is not an OpenNeuro snapshot tag`);
  }
  const named = latestOf(args.upstream);
  const latest = named.tag === null ? null : normalizeUpstreamTag(named.tag);
  const tag = raw !== undefined ? normalizeUpstreamTag(raw) : latest;
  if (tag === null) {
    return refused(
      "latest-unknown",
      `${named.tag === null ? named.reason : "no tag"}; name one with --to-tag`,
    );
  }
  if (!isSourceTag(tag)) {
    return refused(
      "to-tag-unrecordable",
      `${tag} is not a tag the version rows can record, so a re-pull to it could never be proved`,
    );
  }
  if (!args.mirrorTags.includes(tag)) {
    return refused("mirror-lag", `${tag} is not on the GitHub mirror yet`);
  }
  if (args.fromTag !== null && sameUpstreamTag(tag, args.fromTag)) {
    return refused("nothing-to-pull", `${tag} is the mirrored tag`, tag);
  }
  const read = args.upstream;
  const mirrored = args.fromTag ?? "the mirrored tag (unknown)";
  if (named.tag === null || latest === null || read.kind !== "snapshot" || read.latest === null) {
    return unverified(
      tag,
      `OpenNeuro could not say which snapshot is latest (${named.tag === null ? named.reason : "no answer"}), so that ${tag} is newer than ${mirrored} is not proved`,
    );
  }
  if (!sameUpstreamTag(tag, latest)) {
    return unverified(
      tag,
      `${tag} is not OpenNeuro's latest snapshot (${latest}), so that it is newer than ${mirrored} is not proved`,
    );
  }
  if (args.fromTag === null) {
    return unverified(tag, `there is no from_tag to order ${tag} against`);
  }
  const order = upstreamSnapshotOrder(read.latest, read.snapshots, args.fromTag);
  if (order.kind === "newer") {
    return { tag, check: { name: "to-tag", status: "ok", detail: `${tag} (OpenNeuro's latest)` } };
  }
  return unverified(
    tag,
    `${orderGap(order, tag, args.fromTag)}, so OpenNeuro's creation order does not show ${tag} is newer; a re-pull to it is not executable`,
  );
}

/** Why an order that is not `newer` does not establish `tag` after `fromTag`, in one clause. */
function orderGap(
  order: Exclude<SnapshotOrder, { kind: "newer" }>,
  tag: string,
  fromTag: string,
): string {
  switch (order.kind) {
    case "same":
      return `OpenNeuro's list names ${tag} as the mirrored ${fromTag}`;
    case "latest_undated":
      return `the creation date of OpenNeuro's latest ${tag} is unreadable`;
    case "latest_inconsistent":
      return `OpenNeuro calls ${tag} its latest, but ${order.later} in its own list was created later`;
    case "recorded_absent":
      return `the mirrored ${fromTag} is not among OpenNeuro's snapshots`;
    case "recorded_undated":
      return `the creation date of the mirrored ${fromTag} is unreadable`;
    case "list_undated":
      return `the creation date of ${order.undated} in OpenNeuro's list is unreadable, and it could be newer`;
    case "not_after":
      return `OpenNeuro's latest ${tag} was not created after the mirrored ${fromTag}`;
  }
}

/** OpenNeuro's latest tag from its answer, or why there is none (the reasons the import gives). */
function latestOf(read: UpstreamRead): { tag: string } | { tag: null; reason: string } {
  if (read.kind === "error") return { tag: null, reason: read.reason };
  if (read.kind !== "snapshot") return { tag: null, reason: `OpenNeuro: ${read.reason}` };
  if (read.latest === null) {
    return { tag: null, reason: "OpenNeuro names no snapshot for this dataset yet" };
  }
  if (!isOpenNeuroTag(read.latest.tag)) {
    return { tag: null, reason: "OpenNeuro named a latest tag of an unexpected shape" };
  }
  return { tag: read.latest.tag };
}

// ---------------------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------------------

function highestVersion(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    const p = parseVersion(bareVersion(v));
    if (!p) continue;
    const bare = `${p.major}.${p.minor}.${p.patch}`;
    if (best === null || cmp(bare, best) > 0) best = bare;
  }
  return best;
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export interface VersionFacts {
  /** The current version all three sources agree on, or the highest known when they cannot be compared. */
  current: string | null;
  /** N.0.0. */
  next: string | null;
  check: Check;
}

/**
 * The highest `dataset_versions` row, the highest `v*` tag and `Version` on `main` must agree, and
 * N.0.0 is the next major after them (ADR 0111, decision 2). The API's `current_version` is not
 * read: it defaults to 1.0.0 when the description cannot be read, which would hide a disagreement.
 * Rows that cannot be read (the versions route answered 404, as a backend without it does) leave
 * the check `unchecked`.
 */
export function versionCheck(args: {
  rows: Array<{ version: string }> | null;
  tags: string[];
  mainVersion: string | null;
}): VersionFacts {
  const tag = highestVersion(args.tags);
  const main = args.mainVersion ? highestVersion([args.mainVersion]) : null;
  if (args.rows !== null && args.rows.length === 0) {
    return {
      current: null,
      next: null,
      check: {
        name: "version",
        status: "refused",
        code: "never-released",
        detail: "no version row",
      },
    };
  }
  const row = args.rows ? highestVersion(args.rows.map((r) => r.version)) : null;
  const known = [row, tag, main].filter((v): v is string => v !== null);
  const highest = highestVersion(known);
  const next = highest ? bumpVersion(highest, "major") : null;
  if (args.rows === null) {
    return {
      current: highest,
      next,
      check: {
        name: "version",
        status: "unchecked",
        code: "rows-unavailable",
        detail: `version rows could not be read; tag ${tag ?? "none"}, main ${main ?? "none"}`,
      },
    };
  }
  if (row === null || tag === null || main === null || row !== tag || tag !== main) {
    return {
      current: highest,
      next,
      check: {
        name: "version",
        status: "refused",
        code: "versions-disagree",
        detail: `row ${row ?? "none"}, tag ${tag ?? "none"}, main ${main ?? "none"}`,
      },
    };
  }
  return {
    current: row,
    next,
    check: { name: "version", status: "ok", detail: `${row} -> ${next}` },
  };
}

// ---------------------------------------------------------------------------------------
// release-pr
// ---------------------------------------------------------------------------------------

/**
 * No release pull request may be open (ADR 0111, decision 2): one REST call for the open pull
 * requests, refusing any whose head is `release/*`, and the `release/vN.0.0` branch from the
 * `ls-remote` already made. Without a token, or on any error, the REST half is `unchecked`.
 */
export async function releasePrCheck(args: {
  datasetId: string;
  nextVersion: string | null;
  branches: string[];
  token: string | null;
  apiBase: string;
}): Promise<Check> {
  const branch = args.nextVersion ? `refs/heads/release/v${args.nextVersion}` : null;
  if (branch && args.branches.includes(branch)) {
    return {
      name: "release-pr",
      status: "refused",
      code: "release-branch-exists",
      detail: `${branch.slice("refs/heads/".length)} exists`,
    };
  }
  if (!args.token) {
    return { name: "release-pr", status: "unchecked", code: "no-token", detail: "no GitHub token" };
  }
  let res: Response;
  try {
    res = await readOnlyFetch(
      `${args.apiBase}/repos/${NEMAR_ORG}/${args.datasetId}/pulls?state=open&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${args.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "nemar-cli-repull-plan",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (err) {
    return {
      name: "release-pr",
      status: "unchecked",
      code: "github-unreachable",
      detail: err instanceof Error ? err.name : "fetch failed",
    };
  }
  if (!res.ok) {
    return {
      name: "release-pr",
      status: "unchecked",
      code: "github-error",
      detail: `HTTP ${res.status}`,
    };
  }
  let pulls: Array<{ number?: number; head?: { ref?: string } }>;
  try {
    pulls = (await res.json()) as typeof pulls;
  } catch {
    return {
      name: "release-pr",
      status: "unchecked",
      code: "github-error",
      detail: "unreadable answer",
    };
  }
  if (!Array.isArray(pulls)) {
    return {
      name: "release-pr",
      status: "unchecked",
      code: "github-error",
      detail: "unreadable answer",
    };
  }
  if (pulls.length >= 100) {
    return {
      name: "release-pr",
      status: "unchecked",
      code: "too-many-open",
      detail: "100 or more open",
    };
  }
  const release = pulls.filter(
    (p) => typeof p.head?.ref === "string" && p.head.ref.startsWith("release/"),
  );
  if (release.length > 0) {
    return {
      name: "release-pr",
      status: "refused",
      code: "release-pr-open",
      detail: release.map((p) => `#${p.number} (${p.head?.ref})`).join(", "),
    };
  }
  return { name: "release-pr", status: "ok", detail: `${pulls.length} open, none a release` };
}

// ---------------------------------------------------------------------------------------
// annex-uuid (#1320)
// ---------------------------------------------------------------------------------------

/**
 * The bucket's `annex-uuid` marker must be the one `nemar-s3` UUID NEMAR's `remote.log` records, or
 * `enableremote nemar-s3` would reuse a UUID that belongs to another special remote (#1320). A
 * mismatch refuses and names both; more than one `nemar-s3` refuses; a 403 or 404 is unchecked.
 */
export function annexUuidCheck(args: { remoteUuids: string[]; marker: MarkerRead | null }): Check {
  if (args.remoteUuids.length === 0) {
    return {
      name: "annex-uuid",
      status: "refused",
      code: "no-nemar-s3-remote",
      detail: "remote.log names none",
    };
  }
  if (args.remoteUuids.length > 1) {
    return {
      name: "annex-uuid",
      status: "refused",
      code: "nemar-s3-ambiguous",
      detail: `remote.log names ${args.remoteUuids.length}: ${args.remoteUuids.join(", ")}`,
    };
  }
  const uuid = args.remoteUuids[0] as string;
  const marker = args.marker;
  if (!marker) {
    return {
      name: "annex-uuid",
      status: "unchecked",
      code: "no-bucket",
      detail: "nemar-s3 is not an S3 remote",
    };
  }
  if (marker.status !== "ok") {
    return {
      name: "annex-uuid",
      status: "unchecked",
      code: `marker-${marker.status}`,
      detail: marker.detail,
    };
  }
  if (marker.uuid !== uuid) {
    return {
      name: "annex-uuid",
      status: "refused",
      code: "annex-uuid-mismatch",
      detail: `bucket marker ${marker.uuid}, remote.log nemar-s3 ${uuid}`,
    };
  }
  return { name: "annex-uuid", status: "ok", detail: uuid };
}
