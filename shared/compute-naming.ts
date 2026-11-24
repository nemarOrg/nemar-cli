/**
 * The names of a recipe product's files (epic #2324 N1b, ADR 0137): a port of nemar-process
 * `recipes/nemar_process/common/naming.py` (`label`, `product_stem`, `product_path`, `dataset_path`), so the
 * backend and the website name a recording's view files exactly as the recipe that wrote them.
 *
 * A recording `sub-01/eeg/sub-01_task-rest_eeg.edf` of recipe `nemar-floor` has its product beside it:
 * `sub-01/eeg/sub-01_task-rest_desc-nemarfloor_channels.tsv` and so on, the suffix naming the nature of the
 * file. `desc` is the last entity of a BIDS name; the label is the recipe id without its hyphens; a source
 * that already has a `desc-<x>` entity gets `desc-<x><label>` in its place. A dataset-level file sits at
 * the product's root as `desc-<label>_<suffix>.<extension>`.
 *
 * `shared/contract/compute-naming-vectors.json` holds this module's answers for nemar-process to replay
 * against `naming.py` (`test/compute-naming.unit.test.ts` writes it under `NEMAR_WRITE_NAMING_VECTORS=1`).
 * The port is literal, including Python's `posixpath.dirname` on repeated and leading slashes, so the two
 * agree on every string, not only on well-formed BIDS paths.
 *
 * Nothing here reads a clock, a database or a network, and nothing is imported.
 */

/** What a path that is not a recording's raises, as `naming.py` raises `ValueError("not a recording ...")`. */
export class NotARecordingError extends Error {
  constructor(relativePath: string) {
    super(`not a recording (no _eeg suffix): ${JSON.stringify(relativePath)}`);
    this.name = "NotARecordingError";
  }
}

/** A recording's file name: `<stem>_eeg.<extension>`, with no slash in either part. */
const RECORDING_RE = /^(?<stem>[^/]+)_eeg\.(?<extension>[^/]+)$/;

/** A `desc` entity, matched against one `_`-separated part. */
const DESC_RE = /^desc-(?<value>[^_]*)$/;

/** The label a recipe puts in its product file names: its id without hyphens (`nemarfloor`). */
export function label(recipeId: string): string {
  return recipeId.replaceAll("-", "");
}

/** The `stem` (without `_eeg`) and `extension` of a file name that is a recording's, or null. */
export function matchRecording(name: string): { stem: string; extension: string } | null {
  const m = RECORDING_RE.exec(name);
  if (m?.groups === undefined) return null;
  return { stem: m.groups.stem as string, extension: m.groups.extension as string };
}

/** Python's `posixpath.split`: the head without its trailing slashes (unless it is all slashes), and the tail. */
function posixSplit(path: string): [string, string] {
  const i = path.lastIndexOf("/") + 1;
  let head = path.slice(0, i);
  const tail = path.slice(i);
  if (head !== "" && head !== "/".repeat(head.length)) head = head.replace(/\/+$/, "");
  return [head, tail];
}

function split(relativePath: string): [string, string] {
  const [directory, name] = posixSplit(relativePath);
  const match = matchRecording(name);
  if (match === null) throw new NotARecordingError(relativePath);
  return [directory, match.stem];
}

/** The file name of a recording without `_eeg` and its extension, `desc` carrying the label. */
export function productStem(relativePath: string, recipeLabel: string): string {
  const [, stem] = split(relativePath);
  const parts = stem.split("_");
  for (let position = 0; position < parts.length; position++) {
    const found = DESC_RE.exec(parts[position] as string);
    if (found?.groups !== undefined) {
      parts[position] = `desc-${found.groups.value}${recipeLabel}`;
      return parts.join("_");
    }
  }
  return [...parts, `desc-${recipeLabel}`].join("_");
}

/** The product file of one recording, in the recording's directory. */
export function productPath(
  relativePath: string,
  recipeLabel: string,
  suffix: string,
  extension: string,
): string {
  const [directory] = posixSplit(relativePath);
  const name = `${productStem(relativePath, recipeLabel)}_${suffix}.${extension}`;
  if (directory === "") return name;
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** A dataset-level file, at the root of the product. */
export function datasetPath(recipeLabel: string, suffix: string, extension: string): string {
  return `desc-${recipeLabel}_${suffix}.${extension}`;
}
