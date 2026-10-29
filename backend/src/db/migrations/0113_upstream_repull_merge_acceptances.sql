-- An administrator's acceptance of a re-pull's squash merge made without its trailers (epic #1046;
-- ADR 0111, the amendment of 2026-10-29; issue #1996).
--
-- WHAT THIS IS FOR. NEMAR's merge gate writes a re-pull's squash message so that its last paragraph
-- is the re-pull commit's trailers, because the privacy ledger's fresh-clone proof (ADR 0085) reads
-- the merge as the re-pull's own commit only then. A merge made outside the gate (GitHub's merge
-- button) has no trailers, and the release refuses it (`merge-trailers`). `nemar admin repull
-- resume --accept-merge-trailers "<reason>"` accepts such a merge once the Worker has read, on
-- GitHub, that it is the squash merge of the record's own pull request, that its tree is the
-- record's commit outside `.nemar/` and `.github/`, and that its parent is the record's base or a
-- descendant enrichment moved; then the Worker appends one ledger line to `main` naming the merge
-- (the attestation), so a fresh clone can tell the accepted commit without this database. One row
-- here is one acceptance, of one of the record's two pull requests, recorded once.
--
-- WHAT A ROW HOLDS.
--   * `merge_sha`: the accepted merge commit, the record's own `merge_sha` (`n0`) or
--     `patch_merge_sha` (`n1`).
--   * `reason`: the administrator's words, under the publication path's text rule (10 to 500
--     characters, ADR 0086). Free text, so it stays here and in the audit row, never in the ledger,
--     which refuses free text by design (ADR 0085, ADR 0036).
--   * `accepted_by`, `accepted_at`: who, and when by D1's own clock; the ledger line's time is this.
--   * `attestation_needed`: 1 when the merge appends a `repull-scrubbed` line beside other files,
--     the one shape the proof needs the attestation for; 0 when it does not touch the ledger that
--     way (the proof then needs nothing, and no line is written: a line naming a commit the proof
--     does not need it for fails the proof on its own).
--   * `scanner`: the `scanner` of the `repull-scrubbed` line the merge appended, which the
--     attestation carries, so the line is the same bytes every time it is written; set exactly when
--     the attestation is needed.
--   * `attested_at`: when the Worker saw the attestation on `main`; `attestation_sha` the commit
--     that wrote it, when the Worker made it (a retry that finds the line already there records the
--     time with no commit). The release is refused while an attestation is needed and not seen.
--
-- Every CHECK term is TRUE or FALSE, never NULL (a CHECK passes on NULL). The foreign key cascades
-- on D1, which enforces foreign keys; `deleteDatasetCascade` also deletes these rows explicitly,
-- before the re-pull rows, rather than trusting the pragma, as it does for the screens (0106).
-- `datasets` and `upstream_repulls` gain nothing.

CREATE TABLE upstream_repull_merge_acceptances (
  repull_id INTEGER NOT NULL REFERENCES upstream_repulls(id) ON DELETE CASCADE,
  pr TEXT NOT NULL CHECK (pr IN ('n0', 'n1')),
  merge_sha TEXT NOT NULL CHECK (length(merge_sha) = 40 AND merge_sha NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  accepted_by INTEGER NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  attestation_needed INTEGER NOT NULL CHECK (attestation_needed IN (0, 1)),
  scanner TEXT CHECK (scanner IS NULL OR scanner GLOB 'identifier-scan@[0-9a-f]*'),
  attestation_sha TEXT CHECK (attestation_sha IS NULL OR
    (length(attestation_sha) = 40 AND attestation_sha NOT GLOB '*[^0-9a-f]*')),
  attested_at TEXT,
  PRIMARY KEY (repull_id, pr),
  CHECK ((attestation_needed = 1) = (scanner IS NOT NULL)),
  CHECK (attestation_needed = 1 OR attested_at IS NULL),
  CHECK (attestation_sha IS NULL OR attested_at IS NOT NULL)
);
