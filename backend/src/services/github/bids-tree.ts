/**
 * BIDS-aware tree analysis on dataset repos: subject sampling, modality/task
 * detection, and the tree-stats probe (channel montage, HED) used at import
 * and reindex time.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import {
  classifyElectrodeSystem,
  parseChannelsTsv,
  parseEegChannelCount,
  parseEegReference,
  parsePlacementScheme,
  parsePowerLineFrequency,
  parseSamplingFrequency,
  resolveNChannels,
} from "../channel-montage";
import { BIDS_DATATYPES } from "../datacite";
import { eventsJsonHasHed, eventsTsvHasHed, parseHedVersion } from "../hed";
import { HttpError } from "../retry";
import { type TreeEntry, getBlobContent } from "./contents";
import { getRepoDefaultBranch } from "./repos";
import { GITHUB_API, ORG_NAME } from "./shared";
import { githubFetchWithRetry } from "./transport";

/** Max `sub-*` subjects sampled by getBidsTreeStats (bounds API calls). */
const MAX_SUBJECTS_FOR_MODALITY = 25;

/**
 * Evenly sample up to `max` items, always including the first and last. Used to
 * bound the per-subject tree fetches in getBidsTreeStats while still spreading
 * the sample across the subject list (so a modality/task present only in later
 * subjects is more likely to be seen than first-N sampling would).
 */
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return out;
}

/**
 * Datatypes found in ONE subject's subtree, where paths are RELATIVE to the
 * subject directory: a datatype dir sits directly under the subject
 * (`eeg/...`) or under a session (`ses-01/eeg/...`). Pure; unit-tested.
 */
export function modalitiesFromSubjectSubtree(relPaths: string[]): string[] {
  const found = new Set<string>();
  for (const p of relPaths) {
    const parts = p.split("/");
    if (BIDS_DATATYPES.has(parts[0])) {
      found.add(parts[0]);
    } else if (parts.length >= 2 && parts[0].startsWith("ses-") && BIDS_DATATYPES.has(parts[1])) {
      found.add(parts[1]);
    }
  }
  return [...found];
}

/**
 * BIDS task labels found in a subject's subtree filenames, matching
 * `extractTasks`'s `_task-<label>` regex in bids-tree.ts (kept in sync).
 * Pure; unit-tested.
 */
export function tasksFromSubjectSubtree(relPaths: string[]): string[] {
  const found = new Set<string>();
  for (const p of relPaths) {
    const m = p.match(/_task-([^_./]+)/);
    if (m) found.add(m[1]);
  }
  return [...found];
}

/** Truncation-immune BIDS metadata derived from the raw subject tree. */
export interface BidsTreeStats {
  /** Sorted raw datatype dirs (modalities). Sampled across subjects. */
  modalities: string[];
  /** COMPLETE count of root-level `sub-*` dirs (not sampled). */
  subjectCount: number;
  /** Sorted task labels. Sampled across subjects (union with tree paths upstream). */
  tasks: string[];
  /** Representative EEG channel count from an exemplar recording (#858).
   *  Sourced from the SAMPLED SUBJECT's own `*_channels.tsv` /
   *  `*_eeg.json` ONLY -- deliberately independent of the root-vs-subject
   *  preference below (#1153 review, I4): this is a single sampled
   *  recording's value (migration 0054's "exemplar" caveat -- see
   *  migration 0072 for the sibling caveat on the four signal_defaults
   *  fields), not a dataset default, so it must not inherit from a
   *  root-level sidecar the way signal_defaults correctly does. Undefined
   *  when no EEG `*_channels.tsv` / `*_eeg.json` was sampled. */
  nChannels?: number;
  /** Scalp montage class from the exemplar's channel labels (#858). */
  electrodeSystem?: string;
  /** `SamplingFrequency` (Hz) from the preferred `*_eeg.json` sidecar (epic
   *  #1144 Phase 2b, #1153) -- see `probeChannelMontage` for the
   *  root-vs-subject sidecar preference. Still one exemplar sidecar's
   *  declared value, not a verified per-dataset aggregate -- see migration
   *  0071's caveat. Undefined when no sidecar was sampled or the key was
   *  absent/invalid. */
  samplingFrequency?: number;
  /** `PowerLineFrequency` (Hz), coerced to exactly 50 or 60 -- see
   *  `parsePowerLineFrequency` for why anything else is dropped rather than
   *  clamped. Undefined (not 0) when absent/out-of-enum. */
  powerLineFrequency?: number;
  /** `EEGReference` from the preferred sidecar. Undefined when absent, an
   *  array, or the BIDS "n/a" placeholder. */
  eegReference?: string;
  /** `EEGPlacementScheme` from the preferred sidecar. Undefined when absent
   *  or the "n/a" placeholder. */
  placementScheme?: string;
  /** Whether this ref carries HED annotations: HEDVersion declared AND >=1 real
   *  HED key in an events sidecar (#869). Undefined when the probe couldn't run
   *  (no dataset_description.json) OR any fetch/parse failure inside probeHed ->
   *  column stays NULL (vs false -> 0 = checked, no HED). */
  hasHed?: boolean;
  /** The `HEDVersion` string (array form comma-joined), or undefined (#869). */
  hedVersion?: string;
  /** A TRANSPORT failure (network error, non-2xx blob fetch) that
   *  `probeChannelMontage` caught and swallowed internally so it doesn't
   *  abort the rest of this (more expensive, already-succeeded) walk --
   *  see that function's doc comment and ADR 0005. Present ONLY on a
   *  genuine fetch/parse-plumbing failure, never on authoritative absence
   *  (no matching file, or a key missing/invalid within one that WAS
   *  read) -- those simply leave the fields above undefined with no
   *  error. A caller that attaches permanent-convergence semantics to
   *  "fields undefined" (the signal-defaults sweep) MUST check this first
   *  and treat it like a throw, not like absence (#1162 review, C2). */
  channelMontageProbeError?: string;
}

/**
 * Truncation-immune BIDS stats (#820, #827). GitHub caps the recursive git tree
 * (~100k entries / 7MB) and a large `derivatives/` tree (which sorts before the
 * raw subject dirs) can fill the whole response, so `getTreeAtRef` silently
 * drops every raw `sub-<id>/<datatype>/` path -- on006110 came back `anat,func`
 * (from fmriprep derivatives) with `eeg` missing AND subject_count NULL. This
 * walks ONLY the raw BIDS structure: the root tree (non-recursive) gives the
 * COMPLETE `sub-*` list (subjectCount), then a bounded, evenly-spread sample of
 * those subjects' subtrees (each small, never truncated, since derivatives live
 * outside the subject dirs) gives modalities + tasks. Returns zeros/[] for a
 * non-BIDS layout (no root `sub-*`) so callers fall back to the path-list
 * detectors. All-or-nothing on subtree fetch failure (a partial sample would
 * silently under-report and then override the path-list result).
 */
export async function getBidsTreeStats(
  repo: string,
  ref: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<BidsTreeStats> {
  const ghHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
  let refResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${ref}`,
    { headers: ghHeaders },
    { retryOn404: true, refreshTokenOn401 },
  );
  // #880: the caller's ref (usually the hardcoded "main") may not exist -- some
  // NEMAR repos default to `master`/other. On a 404, resolve the repo's actual
  // default branch and retry once, so non-main repos still get probed (otherwise
  // HED / channel-montage / reindex silently skip them).
  if (refResponse.status === 404) {
    const defaultBranch = await getRepoDefaultBranch(repo, pat);
    if (defaultBranch !== ref) {
      refResponse = await githubFetchWithRetry(
        `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${defaultBranch}`,
        { headers: ghHeaders },
        { retryOn404: true, refreshTokenOn401 },
      );
    }
  }
  if (!refResponse.ok) {
    throw new HttpError(
      `Failed to resolve ref '${ref}' (or the repo default branch): HTTP ${refResponse.status}`,
      refResponse.status,
    );
  }
  const commit = await refResponse.json<{ commit: { tree: { sha: string } } }>();
  const rootSha = commit.commit.tree.sha;

  // Root tree, NON-recursive: cheap, never truncated, lists every top-level dir.
  const rootResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${rootSha}`,
    { headers: ghHeaders },
    { refreshTokenOn401 },
  );
  if (!rootResponse.ok) {
    throw new HttpError(
      `Failed to get root tree: HTTP ${rootResponse.status}`,
      rootResponse.status,
    );
  }
  const root = await rootResponse.json<{ tree: TreeEntry[] }>();
  // HED probe inputs from the root tree (#869): dataset_description.json
  // (HEDVersion) and the first root-level inherited `*_events.json` -- many HED
  // datasets annotate once at the top level rather than per subject.
  const descEntry = root.tree.find(
    (e) => e.type === "blob" && e.path === "dataset_description.json",
  );
  const rootEventsJson = root.tree.find(
    (e) => e.type === "blob" && /^[^/]*_events\.json$/.test(e.path),
  );
  // signal_defaults input (epic #1144 Phase 2b, #1153): a root-level
  // `*_eeg.json` (bare or `task-<label>_eeg.json`) IS the BIDS dataset-wide
  // default. A subject-level `*_eeg.json` is an override of it, not the
  // default -- preferring the override here would invert BIDS inheritance
  // and publish per-subject deviations as if they were the dataset norm.
  // Same shared `root.tree` fetch as rootEventsJson just above and
  // subjectDirs just below (one non-recursive GET, already paid for), so
  // finding this entry costs nothing extra.
  const rootEegJson = root.tree.find((e) => e.type === "blob" && /^[^/]*_eeg\.json$/.test(e.path));
  const subjectDirs = root.tree.filter((e) => e.type === "tree" && e.path.startsWith("sub-"));
  if (subjectDirs.length === 0) return { modalities: [], subjectCount: 0, tasks: [] };

  const mods = new Set<string>();
  const tasks = new Set<string>();
  // First EEG sidecars seen across the sampled subjects -> one exemplar probe for
  // channel count + montage (#858). Captured as blob entries; fetched after the
  // loop so the probe never adds latency to the modality/task walk.
  // exemplarEegJson serves TWO roles below, kept deliberately separate
  // (#1153 review, I4): it is ALWAYS the source for EEGChannelCount (a
  // single sampled recording's value must come from that recording, not a
  // dataset-wide root default), and it is ALSO the signal_defaults FALLBACK
  // when no rootEegJson exists.
  let exemplarChannelsTsv: TreeEntry | undefined;
  let exemplarEegJson: TreeEntry | undefined;
  // Subject-level events sidecars for HED detection (#869). Not eeg-scoped: HED
  // can annotate any datatype's events. First of each across sampled subjects.
  let exemplarEventsJson: TreeEntry | undefined;
  let exemplarEventsTsv: TreeEntry | undefined;
  for (const subj of sampleEvenly(subjectDirs, MAX_SUBJECTS_FOR_MODALITY)) {
    const subResponse = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${subj.sha}?recursive=1`,
      { headers: ghHeaders },
      { refreshTokenOn401 },
    );
    // All-or-nothing: a sampled subtree that still fails after retries makes the
    // result UNTRUSTWORTHY (a partial set would silently under-report and then
    // override the path-list detector). Throw so the caller falls back.
    if (!subResponse.ok) {
      throw new HttpError(
        `Failed to read subtree for ${repo} ${subj.path}: HTTP ${subResponse.status}`,
        subResponse.status,
      );
    }
    const sub = await subResponse.json<{ tree: TreeEntry[] }>();
    const paths = sub.tree.map((e) => e.path);
    for (const m of modalitiesFromSubjectSubtree(paths)) mods.add(m);
    for (const t of tasksFromSubjectSubtree(paths)) tasks.add(t);
    // Subtree paths are relative to the subject dir, so an EEG sidecar sits at
    // `eeg/...` or `ses-*/eeg/...`. Keep the first of each.
    for (const e of sub.tree) {
      if (e.type !== "blob") continue;
      if (!exemplarChannelsTsv && /(^|\/)eeg\/[^/]*_channels\.tsv$/.test(e.path)) {
        exemplarChannelsTsv = e;
      } else if (!exemplarEegJson && /(^|\/)eeg\/[^/]*_eeg\.json$/.test(e.path)) {
        exemplarEegJson = e;
      } else if (!exemplarEventsJson && /(^|\/)[^/]*_events\.json$/.test(e.path)) {
        exemplarEventsJson = e;
      } else if (!exemplarEventsTsv && /(^|\/)[^/]*_events\.tsv$/.test(e.path)) {
        exemplarEventsTsv = e;
      }
    }
  }

  const {
    nChannels,
    electrodeSystem,
    samplingFrequency,
    powerLineFrequency,
    eegReference,
    placementScheme,
    probeError: channelMontageProbeError,
  } = await probeChannelMontage(
    repo,
    exemplarChannelsTsv,
    // EEGChannelCount source: the SAMPLED SUBJECT's own sidecar, ALWAYS --
    // never the root default (#1153 review, I4). See nChannels's doc.
    exemplarEegJson,
    // signal_defaults source: root-level sidecar wins when present (#1153);
    // the subject exemplar is only the fallback. The two purposes above and
    // here are independent on purpose -- probeChannelMontage dedupes the
    // fetch when they resolve to the same blob (the common no-root-file
    // case), and only fetches twice when a genuine, distinct root default
    // exists alongside the subject's own override.
    rootEegJson ?? exemplarEegJson,
    pat,
    refreshTokenOn401,
  );
  const { hasHed, hedVersion } = await probeHed(
    repo,
    descEntry,
    [rootEventsJson, exemplarEventsJson],
    exemplarEventsTsv,
    pat,
    refreshTokenOn401,
  );

  return {
    modalities: [...mods].sort(),
    subjectCount: subjectDirs.length,
    tasks: [...tasks].sort(),
    nChannels,
    electrodeSystem,
    samplingFrequency,
    powerLineFrequency,
    eegReference,
    placementScheme,
    channelMontageProbeError,
    hasHed,
    hedVersion,
  };
}

/**
 * Best-effort channel-count + montage + signal-defaults probe for
 * getBidsTreeStats (#858; widened #1153). Fetches the exemplar EEG
 * `*_channels.tsv` and up to two `*_eeg.json` sidecar blobs and runs the
 * pure parsers/classifiers over them. This data is secondary to the
 * modality/subject walk, so a swallowed failure never aborts the rest of
 * that (more expensive, already-succeeded) walk -- but "swallowed" no
 * longer means "silent": a genuine transport failure is reported back via
 * `probeError` rather than collapsed into the same empty result as
 * authoritative absence (#1162 review, C2; ADR 0005 -- transport failures
 * stay fatal, only real absence is permanent). A caller that attaches
 * permanent-convergence semantics to an empty result (the signal-defaults
 * sweep) MUST check `probeError` first.
 *
 * `channelCountEegJson` and `signalDefaultsEegJson` are deliberately TWO
 * separate parameters, not one (#1153 review, I4): `EEGChannelCount` is a
 * single sampled recording's value and must come from the SUBJECT's own
 * sidecar; the four signal_defaults keys are a dataset default and must
 * prefer the ROOT sidecar. When the caller's two choices resolve to the
 * SAME blob (the common case -- no distinct root default exists) this
 * fetches it once and reuses the content for both purposes; it fetches
 * twice only when a genuine, distinct root default coexists with the
 * subject's own override.
 */
async function probeChannelMontage(
  repo: string,
  channelsTsv: TreeEntry | undefined,
  channelCountEegJson: TreeEntry | undefined,
  signalDefaultsEegJson: TreeEntry | undefined,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<{
  nChannels?: number;
  electrodeSystem?: string;
  samplingFrequency?: number;
  powerLineFrequency?: number;
  eegReference?: string;
  placementScheme?: string;
  probeError?: string;
}> {
  if (!channelsTsv && !channelCountEegJson && !signalDefaultsEegJson) return {};
  try {
    let tsv: ReturnType<typeof parseChannelsTsv> = null;
    let sidecar: number | null = null;
    let samplingFrequency: number | null = null;
    let powerLineFrequency: number | null = null;
    let eegReference: string | null = null;
    let placementScheme: string | null = null;

    if (channelsTsv) {
      tsv = parseChannelsTsv(await getBlobContent(repo, channelsTsv.sha, pat, refreshTokenOn401));
    }

    // EEGChannelCount: SUBJECT-scoped only, independent of the root
    // preference below -- see this function's doc comment (I4).
    let channelCountJsonContent: string | null = null;
    if (channelCountEegJson) {
      channelCountJsonContent = await getBlobContent(
        repo,
        channelCountEegJson.sha,
        pat,
        refreshTokenOn401,
      );
      sidecar = parseEegChannelCount(channelCountJsonContent);
    }

    // signal_defaults: root-preferred. Reuse the content already fetched
    // above when it is the SAME blob (no distinct root default exists);
    // fetch separately only when the two genuinely differ.
    if (signalDefaultsEegJson) {
      const signalDefaultsJsonContent =
        signalDefaultsEegJson.sha === channelCountEegJson?.sha
          ? channelCountJsonContent
          : await getBlobContent(repo, signalDefaultsEegJson.sha, pat, refreshTokenOn401);
      if (signalDefaultsJsonContent != null) {
        samplingFrequency = parseSamplingFrequency(signalDefaultsJsonContent);
        powerLineFrequency = parsePowerLineFrequency(signalDefaultsJsonContent);
        eegReference = parseEegReference(signalDefaultsJsonContent);
        placementScheme = parsePlacementScheme(signalDefaultsJsonContent);
      }
    }

    const n = resolveNChannels(sidecar, tsv);
    const sys = tsv ? classifyElectrodeSystem(tsv.labels) : null;
    return {
      nChannels: n ?? undefined,
      electrodeSystem: sys ?? undefined,
      samplingFrequency: samplingFrequency ?? undefined,
      powerLineFrequency: powerLineFrequency ?? undefined,
      eegReference: eegReference ?? undefined,
      placementScheme: placementScheme ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[getBidsTreeStats] channel/montage probe failed for ${repo}: ${message}`);
    return { probeError: message };
  }
}

/**
 * Best-effort HED probe for getBidsTreeStats (#869). Reads `HEDVersion` from
 * dataset_description.json and scans candidate events sidecars for a real HED
 * annotation; `hasHed` is true only when BOTH hold (migration 0056 rule). Like
 * probeChannelMontage this is secondary data -- any failure returns empty so the
 * columns stay NULL. Returns empty (not `hasHed:false`) when there's no
 * dataset_description.json to read, since "checked, no HED" can't be asserted.
 */
async function probeHed(
  repo: string,
  descEntry: TreeEntry | undefined,
  eventsJson: Array<TreeEntry | undefined>,
  eventsTsv: TreeEntry | undefined,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<{ hasHed?: boolean; hedVersion?: string }> {
  if (!descEntry) return {};
  try {
    const desc = JSON.parse(await getBlobContent(repo, descEntry.sha, pat, refreshTokenOn401));
    const hedVersion = parseHedVersion(desc);
    // No HEDVersion declared -> definitively not a HED dataset (checked => 0); no
    // need to fetch the events blobs.
    if (hedVersion == null) return { hasHed: false };
    let annotation = false;
    for (const entry of eventsJson) {
      if (!entry) continue;
      if (eventsJsonHasHed(await getBlobContent(repo, entry.sha, pat, refreshTokenOn401))) {
        annotation = true;
        break;
      }
    }
    if (!annotation && eventsTsv) {
      annotation = eventsTsvHasHed(
        await getBlobContent(repo, eventsTsv.sha, pat, refreshTokenOn401),
      );
    }
    return { hasHed: annotation, hedVersion };
  } catch (err) {
    console.warn(
      `[getBidsTreeStats] HED probe failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}
