/**
 * How the terminal prints the administrator's decision card (ADR 0142, decision 4) at the top of
 * `nemar admin dataset publish show`.
 *
 * NOTHING IS DECIDED HERE. The Worker builds the card (`backend/src/services/decision-card.ts`):
 * the cue and its reason, the next action and its command, each question's strongest finding. This
 * module owns colour and layout only, and prints the words as they arrived. Every string from the
 * network passes `plain()`; the dataset's fields, a model's note and a registry's license text are
 * printed under the labels the card carries.
 *
 * A card of a shape this CLI does not read (an older or newer Worker) costs the card, never the
 * rest of `show`: {@link decisionCardLines} returns no lines for it.
 */

import chalk from "chalk";
import type { CardLineage, DecisionCard } from "../../shared/contract/decision-card.js";
import { REGISTRY_TEXT_LABEL } from "../../shared/contract/decision-card.js";
import { plain } from "./terminal-text.js";

const CUE: Record<string, (s: string) => string> = {
  green: chalk.green,
  amber: chalk.yellow,
  red: chalk.red,
};

const ANSWER: Record<string, (s: string) => string> = {
  pass: chalk.green,
  fail: chalk.red,
  unknown: chalk.yellow,
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The card has the parts this module reads; anything else is not printed. */
function readsAsCard(c: unknown): c is DecisionCard {
  if (!isRecord(c) || c.v !== 1) return false;
  return (
    isRecord(c.metadata) &&
    isRecord(c.license) &&
    isRecord(c.authors) &&
    Array.isArray(c.questions) &&
    isRecord(c.identifier_screen) &&
    isRecord(c.next_action)
  );
}

const joined = (xs: unknown): string =>
  Array.isArray(xs)
    ? xs
        .map((x) => plain(x))
        .filter((x) => x !== "")
        .join("; ")
    : "";

function field(label: string, value: unknown, width = 12): string | null {
  const v = typeof value === "string" ? plain(value) : "";
  return v === "" ? null : `    ${label.padEnd(width)} ${v}`;
}

function lineageLine(which: string, l: CardLineage | null | undefined): string[] {
  if (!isRecord(l)) return [];
  const when = typeof l.resolved_at === "string" ? `, resolved ${plain(l.resolved_at)}` : "";
  const out = [
    `    Lineage (${which}${when}): ${plain(l.outcome)}${l.credited ? ", source credited" : ""}${
      l.permission_covers === true ? ", covered by the recorded permission" : ""
    }`,
  ];
  const d = isRecord(l.declared_licenses) ? l.declared_licenses : null;
  const declared = joined(d?.licenses);
  if (declared !== "") {
    const label = typeof d?.label === "string" ? plain(d.label) : REGISTRY_TEXT_LABEL;
    out.push(`      Declared (${label}): ${declared}`);
  }
  return out;
}

/** The card as the lines `show` prints first. Pure. */
export function decisionCardLines(card: unknown): string[] {
  if (!readsAsCard(card)) return [];
  const out: string[] = [chalk.bold("Decision card")];

  const next = card.next_action;
  out.push(`  Next: ${chalk.bold(plain(next.sentence))}`);
  if (typeof next.command === "string" && plain(next.command) !== "") {
    out.push(`        ${plain(next.command)}`);
  }

  // The license panel.
  const lic = card.license;
  const cue = plain(lic.cue);
  out.push(`  License: ${(CUE[cue] ?? chalk.yellow)(cue.toUpperCase())}  ${plain(lic.reason)}`);
  const fieldText =
    isRecord(lic.field) && typeof lic.field.text === "string" ? lic.field.text : null;
  const fieldLine = field("Field", fieldText ?? "(none)");
  if (fieldLine !== null) out.push(fieldLine);
  if (isRecord(lic.license_file)) {
    const f = lic.license_file;
    const spdx = typeof f.spdx === "string" ? ` ${plain(f.spdx)}` : "";
    const expr = typeof f.expression === "string" ? ` (${plain(f.expression)})` : "";
    const additions = f.additions === true ? ", with text beyond the license" : "";
    out.push(`    LICENSE      ${plain(f.state)}${spdx}${expr}${additions}`);
  }
  if (typeof lic.matcher === "string") out.push(`    Matcher      ${plain(lic.matcher)}`);
  out.push(...lineageLine("review", lic.lineage), ...lineageLine("now", lic.fresh_lineage));
  if (lic.permission_recorded === true) out.push("    A license permission is on record.");
  const others = Array.isArray(lic.reasons) ? lic.reasons.slice(1) : [];
  for (const r of others) out.push(`    Also: ${plain(r)}`);

  // The dataset's own words, side by side.
  const m = card.metadata;
  out.push(`  The dataset's own words (${plain(m.label)})${m.as_reviewed ? ", as reviewed" : ""}:`);
  if (typeof m.note === "string") out.push(`    ${chalk.yellow(plain(m.note))}`);
  const e = isRecord(m.enrichment) ? m.enrichment : null;
  const d = isRecord(m.dataset_description) ? m.dataset_description : null;
  out.push("   .nemar/metadata.json:");
  if (e === null) out.push("    (none on record)");
  else {
    const desc =
      typeof e.description === "string"
        ? `${plain(e.description)}${e.description_cut ? " (cut)" : ""}`
        : null;
    for (const l of [
      field("Title", e.title),
      field("Description", desc),
      field("License", e.license),
      field("Creators", joined(e.creators)),
      field("Keywords", joined(e.keywords)),
      field("Funding", joined(e.funding)),
    ]) {
      if (l !== null) out.push(l);
    }
  }
  out.push("   dataset_description.json:");
  if (d === null) out.push("    (not read)");
  else {
    for (const l of [
      field("Name", d.name),
      field("License", d.license),
      field("Authors", joined(d.authors)),
    ]) {
      if (l !== null) out.push(l);
    }
  }
  const version = field("Version", m.version);
  if (version !== null) out.push(version);
  if (m.anonymous === true) out.push("    Anonymous release: creators and Authors are withheld.");

  // Authors.
  const a = card.authors;
  if (typeof a.count === "number") {
    const ph = typeof a.placeholders === "number" ? a.placeholders : 0;
    const flagged = Array.isArray(a.names)
      ? a.names
          .filter((n) => isRecord(n) && n.placeholder === true)
          .map((n) => plain((n as { name: unknown }).name))
      : [];
    out.push(
      `  Authors: ${a.count}${ph > 0 ? chalk.red(`, ${ph} placeholder${ph === 1 ? "" : "s"}`) : ""}${
        flagged.length > 0 ? ` (flagged: ${flagged.join("; ")})` : ""
      }`,
    );
  }

  // Per question.
  if (card.questions.length > 0) {
    out.push("  Questions:");
    const width = Math.max(...card.questions.map((q) => plain(q.question).length));
    for (const q of card.questions) {
      const answer = plain(q.answer);
      let tail = "";
      const s = q.strongest;
      // The label only: a model's note is printed once, under its label, in the review's findings
      // below, so the terminal never shows the model's words twice.
      if (isRecord(s)) tail = `  [${plain(s.severity)}] ${plain(s.label)}`;
      const word = tail === "" ? answer : answer.padEnd(7);
      out.push(
        `    ${plain(q.question).padEnd(width)}  ${(ANSWER[answer] ?? chalk.yellow)(word)}${tail}`,
      );
    }
  }

  out.push(`  Identifier screen: ${plain(card.identifier_screen.headline)}`);
  const headLine = card.identifier_screen.head_line;
  if (typeof headLine === "string") out.push(`    ${chalk.yellow(plain(headLine))}`);
  if (isRecord(card.auto_deny)) out.push(`  Automatic denial: ${plain(card.auto_deny.line)}`);
  return out;
}
