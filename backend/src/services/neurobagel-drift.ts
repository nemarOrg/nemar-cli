/**
 * Upstream drift (epic #1586, phase 6; ADR 0067's amendment, ADR 0053, ADR 0054).
 *
 * The question: has Neurobagel moved since the versions this repository was built and
 * tested against? A same-day breaking release across two of its services (2026-09-14)
 * is the reason to ask every day. Two kinds of evidence, both from plain public GETs:
 *
 *   - the latest release tag of the node API, the federation API and the query tool,
 *     against the tags pinned in `deploy/neurobagel/pins.env` (copied below; a test
 *     compares the two so they cannot drift apart);
 *   - the git blob hash of each pinned vocabulary file of the communities repository on
 *     its main branch, against the hash the transform's vocabulary snapshot pinned.
 *
 * It costs five outbound calls: three release lookups and one directory listing per
 * vocabulary directory (two). It READS ONLY. The one network primitive here is a GET with
 * no method option and no body, no credential is sent, and a source scan fails if that
 * changes: nothing in this repository writes to a `neurobagel/*` repository.
 *
 * VERDICTS. Drift is `alarm`: the pins are a decision, a moved upstream is a decision
 * somebody has to make (adopt it in a pull request, or not), and that is outstanding work.
 * A read that failed (a rate limit on a shared egress address, a network error, an
 * unexpected body) is `unknown`, never an alarm and never "no drift": a check that could
 * not look says so (ADR 0054). If some reads succeeded and found drift while others
 * failed, the verdict is `alarm` and the reason says how many reads failed.
 */

import type { NeurobagelCheckResult } from "../../../shared/contract/neurobagel-admin.js";
import { VOCAB } from "../../../shared/neurobagel/vocab.js";

/** The public API the drift reads. */
export const UPSTREAM_API_BASE = "https://api.github.com";

/**
 * The address to read, which a TEST may redirect to a local server through
 * `globalThis.NEMAR_NEUROBAGEL_UPSTREAM_URL`, the way `GITHUB_API()` honours
 * `NEMAR_GITHUB_API_URL`: a Worker has no `process.env`, and the admin route and the cron
 * wrapper take no address of their own, so a test that drives them through the real entry
 * point needs this one place to say "not the real internet". Nothing in production sets it.
 */
export function upstreamApiBase(): string {
  const override = (globalThis as { NEMAR_NEUROBAGEL_UPSTREAM_URL?: string })
    .NEMAR_NEUROBAGEL_UPSTREAM_URL;
  return override ?? UPSTREAM_API_BASE;
}

/** A descriptive agent, as GitHub's API terms ask of an automated client. */
export const UPSTREAM_USER_AGENT = "nemar-neurobagel-verify/1.0 (+https://nemar.org)";

/** The branch the vocabulary snapshot tracks. */
export const UPSTREAM_VOCAB_REF = "main";

export interface TagPin {
  /** A short name for reports. */
  name: string;
  /** `owner/repo`. */
  repo: string;
  /** The tag `deploy/neurobagel/pins.env` pins (the part before any digest). */
  tag: string;
}

/**
 * The pinned release tags. These MIRROR `NB_NAPI_TAG`, `NB_FAPI_TAG` and `NB_QUERY_TAG` in
 * `deploy/neurobagel/pins.env`, which a Worker cannot read; `neurobagel-verify-checks.test.ts`
 * parses that file and fails if a value here differs. Change both in the same pull request.
 */
export const TAG_PINS: readonly TagPin[] = [
  { name: "node API", repo: "neurobagel/api", tag: "v0.11.0" },
  { name: "federation API", repo: "neurobagel/federation-api", tag: "v0.10.0" },
  { name: "query tool", repo: "neurobagel/query-tool", tag: "v0.17.0" },
];

/** The pinned vocabulary files, from the transform's snapshot: path to blob hash, and the repository. */
export function vocabularyPins(): { repo: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const [path, pinned] of Object.entries(VOCAB.pins.communities.files)) {
    files[path] = pinned.blob_sha;
  }
  return { repo: VOCAB.pins.communities.repo, files };
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

async function getJson(url: string, timeoutMs: number): Promise<Read<unknown>> {
  try {
    // A plain GET: no method, no body, no credential. The scan in neurobagel-source-scan
    // holds this call to exactly that shape.
    const res = await fetch(url, {
      headers: { "User-Agent": UPSTREAM_USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const limited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      return { ok: false, reason: limited ? "rate limited" : `HTTP ${res.status}` };
    }
    return { ok: true, value: await res.json() };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      reason: name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error",
    };
  }
}

interface DriftTally {
  checked: number;
  drifted: string[];
  failed: string[];
}

async function checkTag(
  pin: TagPin,
  base: string,
  timeoutMs: number,
  tally: DriftTally,
): Promise<void> {
  const read = await getJson(`${base}/repos/${pin.repo}/releases/latest`, timeoutMs);
  if (!read.ok) {
    tally.failed.push(`${pin.name} release (${read.reason})`);
    return;
  }
  const tag = (read.value as { tag_name?: unknown } | null)?.tag_name;
  if (typeof tag !== "string" || tag === "") {
    tally.failed.push(`${pin.name} release (no tag in the answer)`);
    return;
  }
  tally.checked++;
  if (tag !== pin.tag) tally.drifted.push(`${pin.name} ${pin.tag} -> ${tag}`);
}

async function checkVocabularyDirectory(
  repo: string,
  dir: string,
  pinned: Record<string, string>,
  base: string,
  timeoutMs: number,
  tally: DriftTally,
): Promise<void> {
  const read = await getJson(
    `${base}/repos/${repo}/contents/${dir}?ref=${UPSTREAM_VOCAB_REF}`,
    timeoutMs,
  );
  if (!read.ok) {
    tally.failed.push(`vocabulary ${dir} (${read.reason})`);
    return;
  }
  if (!Array.isArray(read.value)) {
    tally.failed.push(`vocabulary ${dir} (not a directory listing)`);
    return;
  }
  const upstream = new Map<string, string>();
  for (const entry of read.value as { path?: unknown; sha?: unknown }[]) {
    if (typeof entry?.path === "string" && typeof entry.sha === "string") {
      upstream.set(entry.path, entry.sha);
    }
  }
  for (const [path, sha] of Object.entries(pinned)) {
    tally.checked++;
    const now = upstream.get(path);
    if (now === undefined) tally.drifted.push(`vocabulary ${path} is gone upstream`);
    else if (now !== sha) tally.drifted.push(`vocabulary ${path} changed`);
  }
}

/**
 * Compare upstream with the pins. Never throws: every failure is a read that did not
 * answer, which makes the verdict `unknown`.
 */
export async function checkUpstreamDrift(
  opts: { apiBase?: string; timeoutMs?: number } = {},
): Promise<NeurobagelCheckResult> {
  const base = (opts.apiBase ?? upstreamApiBase()).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;
  const tally: DriftTally = { checked: 0, drifted: [], failed: [] };
  const vocab = vocabularyPins();
  // One listing per directory, and the pinned files grouped under it.
  const byDir = new Map<string, Record<string, string>>();
  for (const [path, sha] of Object.entries(vocab.files)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    byDir.set(dir, { ...byDir.get(dir), [path]: sha });
  }
  await Promise.all([
    ...TAG_PINS.map((pin) => checkTag(pin, base, timeoutMs, tally)),
    ...[...byDir].map(([dir, pinned]) =>
      checkVocabularyDirectory(vocab.repo, dir, pinned, base, timeoutMs, tally),
    ),
  ]);

  const counts = {
    checked: tally.checked,
    drifted: tally.drifted.length,
    reads_failed: tally.failed.length,
  };
  const failedNote =
    tally.failed.length > 0
      ? ` ${tally.failed.length} read(s) failed: ${tally.failed.join("; ")}.`
      : "";
  if (tally.drifted.length > 0) {
    return {
      verdict: "alarm",
      reason: `Upstream has moved from the pins: ${tally.drifted.join("; ")}.${failedNote}`,
      counts,
    };
  }
  if (tally.failed.length > 0) {
    return {
      verdict: "unknown",
      reason: `Upstream could not be compared with the pins, so this is not "no drift".${failedNote}`,
      counts,
    };
  }
  return {
    verdict: "healthy",
    reason: `${tally.checked} pinned release tags and vocabulary files match upstream.`,
    counts,
  };
}
