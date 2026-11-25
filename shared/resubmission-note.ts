/**
 * The resubmission note of a publication request (ADR 0139, decision 5): the depositor's own words
 * to the reviewer, asked for when the dataset's last request was denied.
 *
 * One definition of the limit, the rule that reads a note and every sentence that mentions one, so
 * the CLI's early refusal, the Worker's refusal, the administrator's views and the mail cannot
 * disagree. No call site words any of this itself.
 *
 * The note is the depositor's text and is never trusted: it is shown to administrators as
 * quoted text under a label that says who wrote it, and it is never put in a mail to the depositor.
 */

/** The most characters of a note, counted after trimming (a character is a Unicode code point). */
export const RESUBMISSION_NOTE_MAX_LENGTH = 2000;

/** The label every view of a note carries: it names the author, so nobody reads it as NEMAR's. */
export const RESUBMISSION_NOTE_LABEL = "Depositor's note";

/** Why a note was refused: a closed list, each with its sentence below. */
export const RESUBMISSION_NOTE_REFUSALS = ["not_text", "too_long", "control_character"] as const;
export type ResubmissionNoteRefusal = (typeof RESUBMISSION_NOTE_REFUSALS)[number];

/** The sentence of each refusal. The server's `error` and the CLI's early refusal are these. */
export const RESUBMISSION_NOTE_REFUSAL_SENTENCES: Record<ResubmissionNoteRefusal, string> = {
  not_text: "The resubmission note must be text.",
  too_long: `The resubmission note is longer than ${RESUBMISSION_NOTE_MAX_LENGTH} characters.`,
  control_character:
    "The resubmission note holds a control character other than a line break. Remove it and send the note again.",
};

export type ResubmissionNoteReading =
  | { ok: true; note: string | null }
  | { ok: false; refusal: ResubmissionNoteRefusal };

/**
 * Read a note as the Worker keeps it: trimmed, empty as null (no note), at most
 * {@link RESUBMISSION_NOTE_MAX_LENGTH} characters after trimming, and no control character other
 * than a line break. A Windows line end is one line break, so a note read from a file written on
 * Windows is not refused for its carriage returns; a lone carriage return is refused with the
 * other control characters. Anything that is not a string is refused, never coerced.
 */
export function readResubmissionNote(raw: unknown): ResubmissionNoteReading {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, refusal: "not_text" };
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") return { ok: true, note: null };
  if (/[\p{Cc}]/u.test(text.replace(/\n/g, ""))) return { ok: false, refusal: "control_character" };
  if ([...text].length > RESUBMISSION_NOTE_MAX_LENGTH) return { ok: false, refusal: "too_long" };
  return { ok: true, note: text };
}

/** Who ended the previous request, as the status answer words it. */
export type PreviousDenialBy = "agent" | "administrator";

/**
 * The `audit_log.action` of an automatic denial (ADR 0139, decision 2), whose `details` JSON names
 * the denied request as `request_id`. The status answer says "an automated agent" for a denied
 * request that has such a row and "an administrator" for one that has none, so the denial that
 * writes the row and the answer that reads it must use this one word.
 */
export const AUTO_DENY_AUDIT_ACTION = "auto_deny";

/**
 * The question the CLI asks at a terminal after a denial that was not a withdrawal (ADR 0139,
 * decision 5). `date` is the day of the denial.
 */
export function resubmissionPrompt(date: string, by: PreviousDenialBy): string {
  const who = by === "agent" ? "an automated agent" : "an administrator";
  return `This dataset's last request was denied on ${date}, by ${who}. Tell the reviewer what changed, or why the decision was wrong (optional, Enter to skip)`;
}

/** What a session with no terminal is told, once, before the request goes on without a note. */
export const RESUBMISSION_NOTE_OFFER =
  "This dataset's last request was denied. A note to the reviewer can say what changed, or why the decision was wrong: add --note <text> or --note-file <path> to the request.";

/** What the request confirms when a note was recorded. */
export const RESUBMISSION_NOTE_RECORDED =
  "Your note is recorded with the request and shown to the administrators.";

/** The sentence under the label in the administrator's views, saying what the text is. */
export const RESUBMISSION_NOTE_PROVENANCE =
  "Written by the depositor. It is not verified and it is not NEMAR's.";
