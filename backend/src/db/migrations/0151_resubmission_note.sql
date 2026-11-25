-- The resubmission note of a publication request (ADR 0139, decision 5, epic #2182).
--
-- `resubmission_note` is the depositor's own text to the reviewer, asked for when the dataset's
-- previous request was denied: at most 2,000 characters, trimmed, no control character other than a
-- line break, and NULL when there is none (the Worker turns an empty note into NULL, so a column
-- that is not NULL always holds words). It is shown to administrators and to nobody else, and a
-- model reads it only after the pre-send scan, inside the untrusted fence (card B4).
--
-- `previous_request_id` is the id of the request this one answers: the dataset's most recent
-- earlier request, when that one was denied by an administrator or an agent. A request its
-- depositor withdrew is stored as denied too (migration 0097) but is not a denial, so it is never
-- linked. It is NULL for a first request and for one that follows a withdrawal, so a reader can
-- walk from a resubmission to the denial it answers. It is a plain INTEGER, not a foreign key,
-- so the link never blocks the removal of an old request; a reader treats a missing target as none.
--
-- Additive and nullable; `publication_requests` is not FTS-backed.
ALTER TABLE publication_requests ADD COLUMN resubmission_note TEXT;
ALTER TABLE publication_requests ADD COLUMN previous_request_id INTEGER;
