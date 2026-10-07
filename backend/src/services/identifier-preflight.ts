/**
 * The uploader's identifier preflight, as the Worker takes it in and stores it (epic #1610
 * phase 3, ADR 0087).
 *
 * `nemar dataset upload` screens a dataset on the uploader's machine before it sends anything,
 * and sends the result with the deposit attestation. It is stored INSIDE the `datasets.attestation`
 * JSON, under `identifier_preflight`: it describes the deposit the depositor attested to, and a
 * key in that document costs no column (ADR 0034).
 *
 * **Never trusted.** A modified client can send anything, so nothing gates on this record; the
 * publication screen (ADR 0086) is the check that holds. What the record is for is reading: an
 * administrator or the scheduled sweep can see what the uploader's own screen found and how the
 * uploader acknowledged it.
 *
 * **Parsed at the door, and never a reason to refuse an upload.** Everything passes through
 * `parseUploaderPreflight` (`shared/identifier-screen-report.ts`), so what is stored is counts and
 * fixed words. A record the parser refuses is not stored, and the response says so with the
 * parser's fixed word; the create itself goes on, because failing an upload over a bookkeeping
 * field would invent a refusal the screen never made, and a CLI newer than this Worker (one whose
 * scanner knows a finding kind this parser does not) must still be able to upload.
 *
 * **Absent is not clean.** A row whose attestation carries no preflight (an older CLI, a
 * server-side import, a refused record) reads as `absent`, and a stored value that no longer
 * parses reads as `unreadable`; neither is ever described as a clean preflight.
 */

import {
  ReportError,
  type UploaderPreflight,
  parseUploaderPreflight,
} from "../../../shared/identifier-screen-report.js";

/** What a request's `identifier_preflight` field came to. */
export type PreflightIntake =
  /** A record that parsed, to be stored with the attestation. */
  | { preflight: UploaderPreflight; refused: null }
  /** None was sent (`refused` null), or one was sent and not stored (the fixed word why). */
  | { preflight: null; refused: string | null };

/** A preflight belongs to an attestation; one sent without it has nowhere to be recorded. */
export const PREFLIGHT_WITHOUT_ATTESTATION = "preflight-without-attestation";

/** Read a request's `identifier_preflight`. Never throws, and never quotes the input. */
export function takePreflight(raw: unknown, hasAttestation: boolean): PreflightIntake {
  if (raw === undefined) return { preflight: null, refused: null };
  if (!hasAttestation) return { preflight: null, refused: PREFLIGHT_WITHOUT_ATTESTATION };
  try {
    return { preflight: parseUploaderPreflight(raw), refused: null };
  } catch (error) {
    // The parser throws only its own fixed words; anything else is folded into one, so no
    // message built from the input can reach the response. That one is a bug in the parser, so
    // it is logged, by class only (a message can quote the input).
    if (!(error instanceof ReportError)) {
      console.error(
        `[identifier-preflight] the parser threw ${error instanceof Error ? error.name : "a non-error"}; refused as preflight-shape`,
      );
    }
    return {
      preflight: null,
      refused: error instanceof ReportError ? error.message : "preflight-shape",
    };
  }
}

/** What the response says about the preflight it was sent. */
export function preflightRecording(
  intake: PreflightIntake,
  stored: boolean,
): { identifier_preflight_recorded: boolean; identifier_preflight_refused?: string } {
  return {
    identifier_preflight_recorded: stored && intake.preflight !== null,
    ...(intake.refused ? { identifier_preflight_refused: intake.refused } : {}),
  };
}

/** A stored preflight, read without trusting the column. */
export type RecordedPreflight =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "recorded"; preflight: UploaderPreflight };

/**
 * The preflight stored in a `datasets.attestation` value, re-validated on the way out. The Worker
 * only ever writes a parsed record, so `unreadable` means the row was edited by hand or the
 * contract changed under it; every reader treats it as no preflight, never as a clean one.
 */
export function readRecordedPreflight(attestationColumn: unknown): RecordedPreflight {
  if (attestationColumn === null || attestationColumn === undefined) return { state: "absent" };
  let doc: unknown;
  try {
    doc = typeof attestationColumn === "string" ? JSON.parse(attestationColumn) : attestationColumn;
  } catch {
    return { state: "unreadable" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { state: "unreadable" };
  const stored = (doc as Record<string, unknown>).identifier_preflight;
  if (stored === undefined) return { state: "absent" };
  try {
    return { state: "recorded", preflight: parseUploaderPreflight(stored) };
  } catch {
    return { state: "unreadable" };
  }
}
