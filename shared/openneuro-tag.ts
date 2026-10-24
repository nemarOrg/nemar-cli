/**
 * The shape of an OpenNeuro snapshot tag, and when two of them name the same snapshot (epic #1046,
 * ADR 0111 decision 10).
 *
 * One definition for the three places a tag crosses a boundary: the Worker before it puts one in a
 * `repository_dispatch` payload, the onboard workflow's `parse-ids`, and the CLI's `--tag`. The
 * workflow repeats the pattern in bash; it will be pinned to this one by the workflow pull request's
 * test/onboard-workflow.test.ts, which runs `parse-ids` over the same accepted and refused tags.
 */

/**
 * What an OpenNeuro snapshot tag may look like: `1.0.0`, `00001`, `2.1.0-rc1`. Deliberately narrow,
 * because a tag ends up in a git ref, a shell argument and a DOI. It allows no `/`, so no ref
 * namespace can be named, no space or shell metacharacter, and it starts with a letter or digit, so
 * it is never read as an option and is a legal ref component. `..` is refused separately
 * ({@link isOpenNeuroTag}): git reads it as a range.
 */
export const OPENNEURO_TAG_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

/** True when `tag` has the shape of an OpenNeuro snapshot tag. */
export function isOpenNeuroTag(tag: unknown): tag is string {
  return typeof tag === "string" && OPENNEURO_TAG_PATTERN.test(tag) && !tag.includes("..");
}

/** A tag without the `v` some records put in front of it (`v1.0.0` is `1.0.0`). */
export function normalizeUpstreamTag(tag: string): string {
  return /^v\d/.test(tag) ? tag.slice(1) : tag;
}

/**
 * Whether two tags name the same snapshot. Exact after the leading `v` is dropped, and nothing
 * looser: a comparison that called `1.0` and `1.0.0` equal would take the re-import path that keeps
 * the old tree while copying the new tag's data, which is the #993 mismatch this guard exists for.
 * Treating them as different only ever refuses or re-prepares, which is the safe direction.
 */
export function sameUpstreamTag(a: string, b: string): boolean {
  return normalizeUpstreamTag(a) === normalizeUpstreamTag(b);
}

/**
 * What a DOI says about an OpenNeuro snapshot: the dataset (`ds004362` for
 * `doi:10.18112/openneuro.ds004362.v1.0.0`) and, when the DOI names a version, the tag without its
 * `v` (`1.0.0`; null for the concept DOI). `doi:` and resolver prefixes and letter case are
 * presentation. Null for any DOI that is not OpenNeuro's.
 */
export function openNeuroDoiParts(doi: string): { ds: string; tag: string | null } | null {
  const bare = doi.trim().replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
  const m = /^10\.18112\/openneuro\.(ds\d{6})(?:\.(v[^/\s]+))?$/i.exec(bare);
  if (!m) return null;
  return { ds: (m[1] as string).toLowerCase(), tag: m[2] ? normalizeUpstreamTag(m[2]) : null };
}

/** The OpenNeuro dataset a DOI belongs to, or null for any other DOI (see {@link openNeuroDoiParts}). */
export function openNeuroDatasetOfDoi(doi: string): string | null {
  return openNeuroDoiParts(doi)?.ds ?? null;
}

/**
 * What a URL says about an OpenNeuro snapshot, read only from the two places that name one:
 * OpenNeuro's own pages (`https://openneuro.org/datasets/<ds>`, and `/versions/<tag>` under it) and
 * OpenNeuro's GitHub mirror (`https://github.com/OpenNeuroDatasets/<ds>`, with `.git`, `/tree/<tag>`
 * or `/releases/tag/<tag>`). Any other host, however its path reads, names no OpenNeuro dataset.
 */
export function openNeuroUrlParts(url: string): { ds: string; tag: string | null } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);
  let ds: string | undefined;
  let tag: string | undefined;
  if (host === "openneuro.org" || host === "www.openneuro.org") {
    if (segments[0] !== "datasets") return null;
    ds = segments[1];
    if (segments[2] === "versions") tag = segments[3];
  } else if (host === "github.com" || host === "www.github.com") {
    if (segments[0]?.toLowerCase() !== "openneurodatasets") return null;
    ds = segments[1]?.replace(/\.git$/i, "");
    if (segments[2] === "tree") tag = segments[3];
    else if (segments[2] === "releases" && segments[3] === "tag") tag = segments[4];
  } else {
    return null;
  }
  if (ds === undefined || !/^ds\d{6}$/i.test(ds)) return null;
  return {
    ds: ds.toLowerCase(),
    tag: tag !== undefined ? normalizeUpstreamTag(tag) : null,
  };
}
