/**
 * A synthetic version manifest shaped like nm000281's (#1502).
 *
 * Why synthetic: the manifest that broke production is 42,849,468 bytes, far
 * too large to commit and not something a test run should pull from the
 * production bucket. What matters about it for these tests is its SHAPE and
 * its SIZE, and both are copied from the real object, measured with three
 * ranged GETs on 2026-09-24 (head, middle and tail of
 * `nm000281/version/v1.0.3.json`):
 *
 *  - pretty-printed with a two-space indent, the header fields first and
 *    `files` last, exactly as `JSON.stringify(manifest, null, 2)` writes it;
 *  - each entry has `key`, `size`, `checksum` and `bytes_url`, git-tracked
 *    sidecars (`git:<sha>`) beside annexed recordings (`SHA256E-s<n>--<hash>`);
 *  - paths are `sub-<n>/ses-<n>/emg/sub-<n>_ses-<n>_task-emg2pose_run-<n>_
 *    recording-<side>_<suffix>` plus per-session scans files and root files;
 *  - keys are in ascending order, as git tree order writes them.
 *
 * The real nm000132 manifest (`fixtures/manifest-nm000132-v1.1.1.json`) is the
 * committed real-data fixture; this one exists because no real manifest small
 * enough to commit reaches the size where a whole parse stops fitting.
 *
 * Entries are produced lazily, so a test can stream tens of megabytes without
 * the generator itself holding them.
 */

export interface LargeManifestOptions {
  subjects: number;
  runsPerSession: number;
  datasetId?: string;
  version?: string;
}

const SIDES = ["left", "right"] as const;
const SUFFIXES = ["channels.tsv", "emg.bdf", "emg.json", "events.tsv"] as const;
const ROOT_BEFORE = [".bidsignore", "README.md", "dataset_description.json", "participants.tsv"];
const ROOT_AFTER = ["task-emg2pose_events.json"];

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** A deterministic 40-hex-digit pseudo-SHA for entry `i`. */
function fakeSha(i: number, width = 40): string {
  let out = "";
  let x = (i + 1) * 2654435761;
  while (out.length < width) {
    x = (x ^ (x >>> 13)) * 1274126177;
    out += (x >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, width);
}

/** Every path, in the order the manifest lists them (ascending). */
export function* largeManifestPaths(opts: LargeManifestOptions): Generator<string> {
  yield* ROOT_BEFORE;
  for (let s = 0; s < opts.subjects; s++) {
    const sub = `sub-${pad(s, 3)}`;
    const ses = "ses-01";
    for (let r = 0; r < opts.runsPerSession; r++) {
      for (const side of SIDES) {
        for (const suffix of SUFFIXES) {
          yield `${sub}/${ses}/emg/${sub}_${ses}_task-emg2pose_run-${pad(r, 2)}_recording-${side}_${suffix}`;
        }
      }
    }
    yield `${sub}/${ses}/${sub}_${ses}_scans.tsv`;
  }
  yield* ROOT_AFTER;
}

export function largeManifestEntryCount(opts: LargeManifestOptions): number {
  return (
    ROOT_BEFORE.length +
    opts.subjects * (opts.runsPerSession * SIDES.length * SUFFIXES.length + 1) +
    ROOT_AFTER.length
  );
}

/** The document as a sequence of text pieces, one entry per piece. */
export function* largeManifestPieces(opts: LargeManifestOptions): Generator<string> {
  const datasetId = opts.datasetId ?? "nm000281";
  const version = opts.version ?? "1.0.3";
  yield `{\n  "dataset_id": "${datasetId}",\n  "version": "${version}",\n  "doi": "10.82901/nemar.${datasetId}.v${version}",\n  "concept_doi": "10.82901/nemar.${datasetId}",\n  "created": "2026-08-31T00:21:32.972Z",\n  "files": {`;
  let i = 0;
  for (const path of largeManifestPaths(opts)) {
    const annex = path.endsWith(".bdf");
    const sha = fakeSha(i);
    const size = annex ? 9_000_000 + (i % 5_000_000) : 100 + (i % 5000);
    const key = annex ? `SHA256E-s${size}--${fakeSha(i, 64)}.bdf` : `git:${sha}`;
    const checksum = annex ? `sha256:${fakeSha(i, 64)}` : key;
    const bytesUrl = annex
      ? `https://data.nemar.org/${datasetId}/v${version}/${path}`
      : `https://raw.githubusercontent.com/nemarDatasets/${datasetId}/v${version}/${path}`;
    yield `${i === 0 ? "" : ","}\n    ${JSON.stringify(path)}: {\n      "key": "${key}",\n      "size": ${size},\n      "checksum": "${checksum}",\n      "bytes_url": "${bytesUrl}"\n    }`;
    i++;
  }
  yield "\n  }\n}\n";
}

export function largeManifestText(opts: LargeManifestOptions): string {
  return [...largeManifestPieces(opts)].join("");
}

/**
 * The document as a byte stream produced on demand: nothing is generated
 * until the reader pulls it, so the stream holds one chunk at a time.
 */
export function largeManifestStream(
  opts: LargeManifestOptions,
  chunkBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  const pieces = largeManifestPieces(opts);
  const encoder = new TextEncoder();
  let pending = "";
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      while (pending.length < chunkBytes) {
        const next = pieces.next();
        if (next.done) break;
        pending += next.value;
      }
      if (pending.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(pending));
      pending = "";
    },
  });
}
