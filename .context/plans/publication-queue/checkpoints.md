# Checkpoints

| ID | Trigger | Lead reads | Produces |
| --- | --- | --- | --- |
| CP1 | A7 merged and the owner answered Q-A8; or A2, A4, A5, A6 and A9 merged | The A7 report and the merged copy tables | Card A8 (the image and document policy), and card A10 (docs pages generated from the copy tables in nemarOrg/docs, each with reproduce and remedy) |
| CP2 | Every A step done | The epic diff | A `seam` review of track A. The epic PR into `dev` goes to the owner for the merge, and the owner releases. Then the owner command list O2 is handed over (below). |
| CP3 | B2 approved | The ADR | Cards B3, B4 and B5 |
| CP4 | B5 merged | Calibration results | Card C1, then the C2 hand-over: release 2 and the #1732 production enablement |

## O2: owner commands after Release 1

The manager hands these over as exact commands; it never runs them.

1. Re-run the screen on every queued request.
   Use `nemar admin repo publish screen` with the request selection its help offers; the exact form is to be read from `--help` at that time.
2. For the requests whose screen never ran, start the screen the same way.
3. Run `nemar admin repo publish list --json`, and read the before-and-after counts by status.
