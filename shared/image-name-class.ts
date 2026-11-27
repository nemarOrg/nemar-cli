/**
 * The name classes of image and document files: one rule for the publication-queue measurement
 * (`scripts/dev/measure-queue-blockers.ts`, card D2) and the batch acknowledgment route (card D3),
 * which keeps a request whose screened tree holds a photo, face or questionnaire file out of every
 * batch. Pure: paths in, classes out.
 */

import { scanPaths } from "./identifier-scan";

export const NAME_CLASSES = [
  "consent",
  "questionnaire",
  "form",
  "photo-face",
  "figure",
  "logo",
  "manual",
  "montage-layout-cap",
  "screenshot",
  "other",
] as const;
export type NameClass = (typeof NAME_CLASSES)[number];

/** Whole-word tokens of a basename: camelCase and every non-alphanumeric run are boundaries. */
export function nameTokens(path: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

const NAME_CLASS_WORDS: ReadonlyArray<readonly [NameClass, readonly string[]]> = [
  ["consent", ["consent"]],
  ["questionnaire", ["questionnaire"]],
  ["form", ["form"]],
  ["photo-face", ["photo", "face"]],
  ["figure", ["figure", "fig"]],
  ["logo", ["logo"]],
  ["manual", ["manual"]],
  ["montage-layout-cap", ["montage", "layout", "cap"]],
  ["screenshot", ["screenshot"]],
];

/** First class, in the card's order, with a whole-word token (an optional plural `s` is allowed). */
export function nameClass(path: string): NameClass {
  const tokens = nameTokens(path);
  for (const [cls, words] of NAME_CLASS_WORDS) {
    if (tokens.some((t) => words.some((w) => t === w || t === `${w}s`))) return cls;
  }
  return "other";
}

/** The name classes that keep a request out of every batch acknowledgment (owner, 2026-11-25). */
export const EXCLUDED_NAME_CLASSES: readonly NameClass[] = ["photo-face", "questionnaire"];

/**
 * How many of `paths` are image or document files (the screen's own `image-or-document-file`
 * finding) whose name class is in {@link EXCLUDED_NAME_CLASSES}.
 */
export function excludedImageCount(paths: readonly string[]): number {
  let n = 0;
  for (const path of paths) {
    if (!EXCLUDED_NAME_CLASSES.includes(nameClass(path))) continue;
    if (scanPaths([path]).some((f) => f.kind === "image-or-document-file")) n++;
  }
  return n;
}
