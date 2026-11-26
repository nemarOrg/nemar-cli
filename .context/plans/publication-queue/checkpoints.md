# Checkpoints

| ID | Trigger | Lead reads | Produces |
| --- | --- | --- | --- |
| CP-D1 | D2 merged | `d2-blockers-report.md` | The owner question on acknowledgment groups (which are harmless, which need individual looks), then card D3 |
| CP-D2 | The owner approves ADR 0139 | The ADR | ADR 0139 accepted and indexed; cards B3, B4 and B5 |
| CP-D3 | D1, D3, D4 and B3 to B5 merged | The decide branch's diff | A `seam` review (`project:pr-review-toolkit`, lens `seam`, mode `epic`); the manager opens the decide epic PR into `dev`; the owner merges and releases; then C1 in shadow mode. Release order: the Worker serving `/publication-review-inputs` must be deployed before the review script on `main` runs. Both come from the same merge, so for the minutes in between, reviews report `inputs_unavailable` and are restarted with `nemar admin dataset publish start`. In the same release, add vocabulary entries for `license_lineage_unconfirmed`, `resubmission_note_unaddressed`, `source_credit_missing` and `inputs_unavailable`. |
| CP-E1 | A2, A4, A5, A6 and A9 merged | The copy tables | Card A10: docs in nemarOrg/docs, live before release |
| CP-E2 | Every lane E step done and A10 live | The evidence branch's diff | A `seam` review; swap B4's local v2 screen-report reader (backend/src/services/publication-review-inputs.ts) for A1's types once both lanes are in `dev`; the evidence epic PR into `dev`; the owner releases (the Worker parses v2 in the same release); then O2 |

## O1: the three clean requests (owner, now)

```bash
nemar admin dataset publish show nm000630
nemar admin dataset publish approve nm000630
nemar admin dataset publish show nm000566
nemar admin dataset publish approve nm000566
nemar admin dataset publish show nm000979
nemar admin dataset publish approve nm000979
```

## O3: the 37 requests blocked on minimum requirements (owner, now)

All 37 lack an ethics approval statement.
The depositor, our group, adds the `EthicsApprovals` field to `dataset_description.json` (or an ethics statement to the README), pushes, and requests publication again.
For converted datasets, the statement is the upstream dataset's approval, cited.

## O2: after Release E (owner)

With D4 released, re-screen the queue quietly:

```bash
nemar admin dataset publish screen-batch --all-active            # dry run: read the count
nemar admin dataset publish screen-batch --all-active --per-minute 4 --apply
```

Wait for the digest, then compare it with the counts in plan.md.

## O4: the two empty repositories (owner, now)

```bash
nemar admin dataset publish deny nm000589 --reason "The dataset repository has no content (no commit). Please upload the dataset again and request publication once the upload has finished."
nemar admin dataset publish deny nm000978 --reason "The dataset repository has no content (no commit). Please upload the dataset again and request publication once the upload has finished."
```

Check `nemar admin dataset publish deny --help` for the exact name of the reason option before running these.
