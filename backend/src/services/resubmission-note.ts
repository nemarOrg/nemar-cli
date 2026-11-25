/**
 * Reading the resubmission note of a publication request (ADR 0139, decision 5).
 *
 * The note is written by the request route and shown to administrators: in the publication
 * request mail, in `GET /admin/publish/requests` (the row carries the column) and in the
 * review detail. It is read here by request id, so the mail does not depend on which of its
 * callers happened to have the row in hand. A note is never sent to the depositor.
 */

/**
 * The note of a request, or null when it has none. Never throws: a request mail is sent whether
 * or not its note could be read, and a read that fails is logged (the request id and a fixed word,
 * never the error text, which can carry SQL) so a mail that went without its note leaves a trace.
 */
export async function readResubmissionNoteOf(
  db: D1Database,
  requestId: number | null,
): Promise<string | null> {
  if (requestId === null) return null;
  try {
    const row = await db
      .prepare("SELECT resubmission_note FROM publication_requests WHERE id = ?")
      .bind(requestId)
      .first<{ resubmission_note: string | null }>();
    return typeof row?.resubmission_note === "string" && row.resubmission_note !== ""
      ? row.resubmission_note
      : null;
  } catch {
    console.error(
      `[resubmission-note] could not read the note of request ${requestId}; the mail goes without it`,
    );
    return null;
  }
}
