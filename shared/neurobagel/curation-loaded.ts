/**
 * Which curation entries came from the loader (epic #1586, phase 5; ADR 0083).
 *
 * An entry's terms are checked against the full pinned vocabulary in exactly one place,
 * `parseCuration` (curation.ts).
 * The transform and the binder must not take an entry that skipped that check, so the loader
 * registers what it returns here and they ask.
 * This module is small on purpose: the transform may import it, and it may not import the
 * vocabularies the loader does.
 * `markLoaded` is for the loader alone; anything else that calls it forges what the check proves.
 *
 * Pure: no I/O.
 */

import type { CurationEntry, CurationEntryData } from "./curation-types";

const LOADED = new WeakSet<object>();

/** Freeze an entry the loader has checked and register it. */
export function markLoaded(data: CurationEntryData): CurationEntry {
  Object.freeze(data.columns);
  for (const column of data.columns) Object.freeze(column);
  Object.freeze(data.evidence);
  Object.freeze(data.pins);
  Object.freeze(data);
  LOADED.add(data);
  return data as CurationEntry;
}

/** Whether `entry` is an object the loader made. */
export const isLoaded = (entry: unknown): entry is CurationEntry =>
  typeof entry === "object" && entry !== null && LOADED.has(entry);
