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
 * The `audit_log.action` of an automatic denial (written by the automatic deny, B5; ADR 0139, decision 2), whose `details` JSON names
 * the denied request as `request_id`. The status answer says "an automated agent" for a denied
 * request that has such a row and "an administrator" for one that has none, so the denial that
 * writes the row and the answer that reads it must use this one word.
 */
export const AUTO_DENY_AUDIT_ACTION = "auto_deny";

/**
 * The question the CLI asks at a terminal after a denial that was not a withdrawal (ADR 0139,
 * decision 5). `date` is the day of the denial. `by` is who denied it, or null when the status
 * answer did not say (an older backend, or a read that failed): an unknown author is never worded
 * as "an administrator", so the question then carries no ", by ..." at all.
 */
export function resubmissionPrompt(date: string, by: PreviousDenialBy | null): string {
  const who =
    by === "agent" ? ", by an automated agent" : by === null ? "" : ", by an administrator";
  return `This dataset's last request was denied on ${date}${who}. Tell the reviewer what changed, or why the decision was wrong (optional, Enter to skip)`;
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

/** What the CLI says when `--note` and `--note-file` are both given. */
export const RESUBMISSION_NOTE_FLAGS_EXCLUSIVE = "Give either --note or --note-file, not both.";

/** What the CLI says when the note file cannot be read; `file` is the path as typed, clipped. */
export function resubmissionNoteFileUnreadable(file: string): string {
  return `Could not read the note file ${file}.`;
}

/** What follows a refusal of what was typed for the note: nothing was sent. */
export const RESUBMISSION_NOTE_NOT_REQUESTED = "Nothing was requested.";

/** What the CLI says when the server did not confirm that the note was recorded. */
export const RESUBMISSION_NOTE_NOT_CONFIRMED =
  "WARNING: the server did not confirm that your note was recorded. Run the request again, or tell an administrator.";

/** What the CLI says when the question was cancelled with Ctrl+C. */
export const RESUBMISSION_NOTE_CANCELLED = "Canceled. Nothing was requested.";

/**
 * What the administrators' mail says when the request's note could not be read for the mail (a
 * failed read, which is not the same as no note): the mail still goes, and points at the command
 * that reads the request itself. `datasetId` is a validated dataset id.
 */
export function resubmissionNoteUnreadable(datasetId: string): string {
  return `A note was recorded but could not be read here; open \`nemar admin dataset publish show ${datasetId}\`.`;
}

/**
 * The note as the plain-text part of a mail: a label line, the note quoted line by line with its
 * line breaks kept, and a blank line after.
 */
export function resubmissionNoteText(note: string): string {
  const quoted = note.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  return [`${RESUBMISSION_NOTE_LABEL} (${RESUBMISSION_NOTE_PROVENANCE})`, ...quoted, ""].join("\n");
}
