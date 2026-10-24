/**
 * The shape of an OpenNeuro snapshot tag, and when two of them name the same snapshot (epic #1046,
 * ADR 0111 decision 10).
 *
 * One definition for the three places a tag crosses a boundary: the Worker before it puts one in a
 * `repository_dispatch` payload, the onboard workflow's `parse-ids` (which repeats the pattern in
 * bash, pinned to this one by test/onboard-workflow.test.ts), and the CLI's `--tag`.
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
