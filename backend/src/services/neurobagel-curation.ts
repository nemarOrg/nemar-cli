/**
 * The ONE adapter point between the writer and curated annotations (epic #1586:
 * phase 4 here; phase 5, ADR 0083, supplies `shared/neurobagel/curation.json`, the
 * loader and the transform's `curation` input).
 *
 * The contract, which the lead set, ADR 0083 records, and the writer enforces:
 *
 *   A dataset id that HAS a curation entry is NEVER converted without it.
 *   If the file cannot be loaded, conversion STOPS for EVERY dataset (a broken file
 *   cannot say which datasets it names): nothing is written, whatever artifact exists
 *   is left as it is, and a needs-review finding is reported. There is no fallback to
 *   converting with `curation: null`, because an entry can exist precisely to WITHDRAW
 *   a mechanical mapping (a "control" arm read as a healthy control): converting
 *   without it would publish a claim the curators removed (on004166 and on006801 would
 *   publish 20 and 7 false healthy controls).
 *
 * A resolver answers one of three things, and there is no fourth:
 *   none    the file loads and has no entry for this id (convert, un-curated);
 *   entry   an entry exists and loaded (its hash joins the fingerprint);
 *   failed  the file does not load, or an entry the file names cannot be had (stop).
 *
 * The answer comes from `lookupCuration` (shared/neurobagel/curation.ts), the helper
 * phase 5 wrote for exactly this. The loader brings roughly 850 KB of vocabulary, so it
 * is imported LAZILY, here and on the writer path only: no request hot path pulls it,
 * and an isolate that never runs the writer never evaluates it.
 *
 * One file load and one validation serve a whole run: the lookup is memoized per
 * (day, id), because `lookupCuration` validates the whole file on every call and a
 * reconcile asks about every dataset. The day is part of the key because the loader
 * rejects a review dated after "today" (the loader has no clock of its own).
 *
 * `applyCuration` is where an entry meets the transform's input.
 */

import type { CurationEntry, NeurobagelInput } from "../../../shared/neurobagel/index.js";
import { canonicalJson } from "../../../shared/neurobagel/index.js";
import { sha256Hex } from "./neurobagel-fingerprint.js";

export type CurationResolution =
  | { kind: "none" }
  | { kind: "entry"; hash: string; entry: CurationEntry }
  | { kind: "failed"; reason: string };

export type CurationResolver = (datasetId: string) => Promise<CurationResolution>;

type LookupResult =
  | { status: "none" }
  | { status: "entry"; entry: CurationEntry }
  | { status: "stop"; problems: string[] };

/** What a resolver needs from the loader module and the committed file. */
export interface CurationSource {
  /** The parsed `curation.json`: its `datasets` keys say which ids have an entry. */
  file: { datasets?: Record<string, unknown> };
  lookupCuration: (text: string, datasetId: string, options?: { today?: string }) => LookupResult;
}

/**
 * The committed file and its loader, imported lazily. A dynamic `import()` with a
 * static specifier is bundled as a lazy chunk by the Worker build, so none of it is
 * evaluated until a resolver first runs.
 */
async function loadCommittedSource(): Promise<CurationSource> {
  const [loader, file] = await Promise.all([
    import("../../../shared/neurobagel/curation.js"),
    import("../../../shared/neurobagel/curation.json"),
  ]);
  return {
    file: (file as { default: CurationSource["file"] }).default,
    lookupCuration: loader.lookupCuration,
  };
}

const UTC_DAY = (now: Date): string => now.toISOString().slice(0, 10);

/** An id no entry can have: asking for it answers `none` exactly when the file loads. */
const PROBE_ID = "nm000000";

interface Loaded {
  day: string;
  stop: string | null;
  source: CurationSource;
  text: string;
  ids: ReadonlySet<string>;
  answers: Map<string, Promise<CurationResolution>>;
}

/**
 * Build a resolver. `load` and `clock` default to the committed file and the real
 * clock; a test hands in a file it wrote (including a broken one) and a fixed day.
 */
export function createCurationResolver(
  deps: { load?: () => Promise<CurationSource>; clock?: () => Date } = {},
): CurationResolver {
  const load = deps.load ?? loadCommittedSource;
  const clock = deps.clock ?? (() => new Date());
  let state: Promise<Loaded> | null = null;
  let stateDay = "";

  async function loaded(): Promise<Loaded> {
    const day = UTC_DAY(clock());
    if (state === null || stateDay !== day) {
      stateDay = day;
      state = (async (): Promise<Loaded> => {
        const source = await load();
        const text = JSON.stringify(source.file);
        const probe = source.lookupCuration(text, PROBE_ID, { today: day });
        return {
          day,
          stop: probe.status === "stop" ? probe.problems.join("; ") : null,
          source,
          text,
          ids: new Set(Object.keys(source.file.datasets ?? {})),
          answers: new Map(),
        };
      })();
      // A failed load is not cached: the next call tries again.
      state.catch(() => {
        state = null;
      });
    }
    return state;
  }

  return async (datasetId) => {
    let l: Loaded;
    try {
      l = await loaded();
    } catch (err) {
      return {
        kind: "failed",
        reason: `the curation file could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (l.stop !== null) {
      return { kind: "failed", reason: `curation.json does not load: ${l.stop}` };
    }
    // The file loads. An id it does not name has nothing to apply.
    if (!l.ids.has(datasetId)) return { kind: "none" };
    let answer = l.answers.get(datasetId);
    if (!answer) {
      answer = (async (): Promise<CurationResolution> => {
        const found = l.source.lookupCuration(l.text, datasetId, { today: l.day });
        if (found.status === "entry") {
          const raw = l.source.file.datasets?.[datasetId];
          const hash = await sha256Hex(canonicalJson(raw as Parameters<typeof canonicalJson>[0]));
          return { kind: "entry", hash, entry: found.entry };
        }
        // The file names this id and the loader will not hand its entry over: the
        // one answer that must never become "none".
        return {
          kind: "failed",
          reason:
            found.status === "stop"
              ? `curation.json does not load: ${found.problems.join("; ")}`
              : "curation.json names this dataset but the loader returned no entry for it",
        };
      })();
      l.answers.set(datasetId, answer);
    }
    return answer;
  };
}

/** The committed file, resolved once per isolate per UTC day. */
export const defaultCurationResolver: CurationResolver = createCurationResolver();

/**
 * Pass a resolved entry to the transform's input. An absent entry leaves the input
 * exactly as it was, so a dataset with no entry produces byte-identical output to one
 * converted before curation existed (ADR 0083). The only function that knows how an
 * entry reaches the transform.
 */
export function applyCuration(
  input: NeurobagelInput,
  resolution: Extract<CurationResolution, { kind: "none" | "entry" }>,
): NeurobagelInput {
  if (resolution.kind === "none") return input;
  return { ...input, curation: resolution.entry };
}
