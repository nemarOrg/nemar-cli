# ADR 0024: Deposit attestation is recorded, not assumed

**Status:** accepted
**Date:** 2026-08-17
**Owner:** Seyed Yahya Shirazi

## Context

The Data Contributor Terms (docs.nemar.org/policies/contributor-terms/) make every deposit
carry legal warranties: de-identification, the status of the re-identification key
(destroyed, or retained by the depositing institution and never sent to NEMAR),
and, for non-owner deposits of licensed data,
that the dataset is not already archived on NEMAR or upstream in BIDS form.
Before this ADR the CLI asked a redistribution-rights question during provenance collection
but persisted nothing, so NEMAR could not show which datasets were deposited under which terms.
OpenNeuro requires key destruction universally; NEMAR deliberately accepts both key outcomes
(owner decision, 2026-08-17) to support longitudinal studies,
which makes the per-dataset declaration itself the load-bearing record.

## Decision

The attestation is recorded as columns on `datasets` (migration 0067, per ADR 0003)
at create time, sent by the CLI with the create-dataset request.
All three warranties are persisted: deposit type, key status,
and the de-identification confirmation (`attestation_deidentified`,
rejected server-side unless literally true),
plus the no-duplicate affirmation for redistribution deposits.
`--yes` never satisfies it: interactive uploads prompt,
non-interactive uploads must spell it out with dedicated flags
(`--deposit-type`, `--key-status`, `--confirm-deidentified`, `--affirm-no-duplicate`).
Sandbox training datasets attest as owner fixtures at the `nemar sandbox`
create call itself (`SANDBOX_ATTESTATION`), not through the upload prompts.
The wire field is optional so pre-attestation CLIs keep working;
NULL columns mean "no attestation on record"
(legacy rows, server-side imports, old CLIs), never "attested by default".

## Consequences

- NEMAR can answer, per dataset, which contributor terms were accepted and when; this is the artifact a GDPR or IRB inquiry asks for.
- Automation that creates real datasets non-interactively must pass the attestation flags explicitly; pipelines that relied on `--yes` alone will fail loudly until updated. This is intended: nobody silently affirms legal statements.
- Server-side creation paths (OpenNeuro import, exemplar clone, E2E fixtures) leave the columns NULL; their provenance is machine-recorded elsewhere, and a NULL is honest where no human attested.
- Tightening the field to required later is a deliberate compatibility break, to be done via `cliVersionGuard` (`MIN_CLI_VERSION`) once pre-attestation CLIs age out.

## Alternatives considered

- **Require key destruction like OpenNeuro.** Rejected by owner decision: it forecloses longitudinal follow-ups; the declared-status model keeps the legal position explicit either way.
- **Persist attestation in `dataset_description.json` / GitHub only.** Rejected: the repo is depositor-writable after upload, so it cannot serve as the tamper-evident record; D1 is the single table of record (ADR 0003).
- **Let `--yes` cover the attestation.** Rejected: `--yes` exists to skip a proceed-confirmation, not to sign warranties; conflating them makes every CI run an unread legal affirmation.
- **A separate attestations table.** Rejected: one attestation per dataset, read with the dataset; ADR 0003 says no side tables without a second-writer reason.
