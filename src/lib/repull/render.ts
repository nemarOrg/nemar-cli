/**
 * What `nemar admin repull plan` prints (ADR 0111, epic #1046 phase 5).
 *
 * The default output is counts, the preflight table, the refusals, the digest and the plan file's
 * path; it never prints a path or a key, because a path can itself be an identifier and the
 * output may be pasted somewhere public. `--counts` prints the same counts as Markdown for an
 * issue comment (#1046). `--json` prints the plan itself, which does hold paths, to the
 * administrator's own terminal.
 */

import type { PlanFile } from "./digest.js";
import type { Check } from "./preflight.js";

type Counts = Record<string, number | boolean | Record<string, number>>;

function countsOf(file: PlanFile): Counts {
  return file.body.counts as unknown as Counts;
}

function upstreamOf(file: PlanFile): Record<string, string | null> {
  return file.body.upstream as unknown as Record<string, string | null>;
}

function versionsOf(file: PlanFile): Record<string, string | null> {
  return file.body.versions as unknown as Record<string, string | null>;
}

function subtypes(value: unknown): string {
  const entries = Object.entries((value ?? {}) as Record<string, number>);
  return entries.length === 0 ? "" : ` (${entries.map(([k, v]) => `${k} ${v}`).join(", ")})`;
}

/**
 * A byte count that may be partly unknown, never rendered as complete when it is not (ADR 0053,
 * ADR 0054): `N bytes`, or `N bytes known, plus M of unknown size`.
 */
export function bytesPhrase(bytes: unknown, unknown: unknown): string {
  const n = Number(unknown ?? 0);
  return n > 0 ? `${bytes} bytes known, plus ${n} of unknown size` : `${bytes} bytes`;
}

/**
 * The orphan bound: `at most N bytes` when every size is known, and otherwise the known part with
 * the count of unknown sizes and the plain statement that there is then no upper bound.
 */
export function orphanPhrase(bytes: unknown, unknown: unknown): string {
  const n = Number(unknown ?? 0);
  return n > 0
    ? `${bytes} bytes known, plus ${n} of unknown size, no upper bound`
    : `at most ${bytes} bytes`;
}

type OwnedEdit = { path: string; status: string; error: string | null };

/** One line per NEMAR-owned edit the plan could not read, so `from: null` is never silent. */
function ownedEditLines(file: PlanFile): string[] {
  const edits = (file.body.nemar_owned_edits ?? []) as unknown as OwnedEdit[];
  return edits
    .filter((e) => e.status !== "ok")
    .map((e) => `  ${e.path}: ${e.status}${e.error ? ` (${e.error})` : ""}`);
}

/** One line per preflight check. */
export function preflightLines(checks: Check[]): string[] {
  return checks.map(
    (c) =>
      `  ${c.name.padEnd(11)} ${c.status.padEnd(9)} ${c.code ? `${c.code}` : ""}${c.detail ? `${c.code ? ": " : ""}${c.detail}` : ""}`,
  );
}

/** The default human summary. */
export function summaryLines(file: PlanFile, path: string | null): string[] {
  const c = countsOf(file);
  const up = upstreamOf(file);
  const v = versionsOf(file);
  const refusals = file.body.refusals as unknown as Array<{ code: string; detail: string }>;
  const lines = [
    `Re-pull plan for ${file.body.dataset}: ${up.ds} ${up.from_tag} -> ${up.to_tag} (from ${up.from_tag_source})`,
    `Versions: ${v.current} -> ${v.n0}${v.n1 ? `, then ${v.n1} for the corrections` : ""}`,
    "",
    "Paths:",
    `  delta ${c.delta_paths}: added ${c.added}, changed ${c.changed}, renamed ${c.renamed}; deleted ${c.deleted}`,
    `  upstream-changed ${c.upstream_changed}, unexplained ${c.unexplained}`,
    `  conflicts ${c.conflicts}${subtypes(c.conflicts_by_subtype)}`,
    `  corrections ${c.corrections}${subtypes(c.corrections_by_subtype)}`,
    `  unchecked ${c.unchecked} (bytes a check needed could not be read)`,
    `  description keys: ${c.description_conflicts} conflict(s), ${c.description_corrections} correction(s)`,
    "Data:",
    `  copy ${c.copy_items} key(s), ${bytesPhrase(c.copy_bytes, c.copy_bytes_unknown)}, unpinned ${c.copy_unpinned}, already held ${c.copy_already_held}; un-annexed from upstream ${c.unannex_items}`,
    `  local uploads ${c.local_uploads}, ${bytesPhrase(c.local_bytes, c.local_bytes_unknown)}`,
    `  orphan bytes if abandoned: ${orphanPhrase(c.orphan_bytes_max, c.orphan_bytes_unknown)}; ${c.data_changing ? "data-changing" : "metadata-only"}; DOIs ${c.doi_count}`,
    `  fetched ${c.fetched_bytes} bytes of large blobs; ${c.fetch_refused} needed and not fetched`,
    "",
    "Preflight:",
    ...preflightLines(file.preflight),
  ];
  const owned = ownedEditLines(file);
  if (owned.length > 0) lines.push("", "NEMAR-owned edits that could not be read:", ...owned);
  if (refusals.length > 0) {
    lines.push("", "Refusals:", ...refusals.map((r) => `  ${r.code}: ${r.detail}`));
  }
  lines.push(
    "",
    `Digest: ${file.digest}`,
    `Executable: ${file.executable ? "yes" : "no"}`,
    ...(path ? [`Plan file: ${path}`] : []),
  );
  return lines;
}

/** The counts as Markdown for an issue comment: no path, no key, no value. */
export function countsMarkdown(file: PlanFile): string {
  const c = countsOf(file);
  const up = upstreamOf(file);
  const v = versionsOf(file);
  const row = (name: string, value: unknown) => `| ${name} | ${value} |`;
  const refusals = file.body.refusals as unknown as Array<{ code: string }>;
  return [
    `**Re-pull plan, ${file.body.dataset}** (${up.ds} ${up.from_tag} to ${up.to_tag}, ${v.current} to ${v.n0}${v.n1 ? ` and ${v.n1}` : ""})`,
    "",
    "| Count | Value |",
    "|---|---|",
    row("delta paths", c.delta_paths),
    row(
      "added / changed / renamed / deleted",
      `${c.added} / ${c.changed} / ${c.renamed} / ${c.deleted}`,
    ),
    row("upstream-changed", c.upstream_changed),
    row("unexplained", c.unexplained),
    row("conflicts", `${c.conflicts}${subtypes(c.conflicts_by_subtype)}`),
    row("corrections", `${c.corrections}${subtypes(c.corrections_by_subtype)}`),
    row("unchecked", c.unchecked),
    row(
      "copy keys / bytes",
      `${c.copy_items} / ${bytesPhrase(c.copy_bytes, c.copy_bytes_unknown)}`,
    ),
    row("copy keys unpinned", c.copy_unpinned),
    row(
      "local uploads / bytes",
      `${c.local_uploads} / ${bytesPhrase(c.local_bytes, c.local_bytes_unknown)}`,
    ),
    row("orphan bytes if abandoned", orphanPhrase(c.orphan_bytes_max, c.orphan_bytes_unknown)),
    row("data-changing", c.data_changing ? "yes" : "no"),
    row("DOIs", c.doi_count),
    "",
    `Preflight: ${file.preflight.map((p) => `${p.name} ${p.status}${p.code ? ` (${p.code})` : ""}`).join(", ")}.`,
    `Refusals: ${refusals.length === 0 ? "none" : refusals.map((r) => r.code).join(", ")}. Executable: ${file.executable ? "yes" : "no"}. Digest \`${file.digest.slice(0, 19)}\`.`,
    "",
  ].join("\n");
}
