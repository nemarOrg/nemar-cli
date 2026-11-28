# License scan fixtures (ADR 0142)

Each directory is one case for `test/license-file-fact.unit.test.ts`:

- `LICENSE`: a public license text, or a public text with one change (a rider, an inserted word, a copyright line, a second license), or NEMAR's own generated notice.
- `case.json`: the `License` field it is judged against and the expected `license_file` fact.
- `result.json`: ScanCode toolkit 32.5.0's real output for that `LICENSE`, written by the sandboxed "Scan LICENSE in a sandbox" step of `run-publication-review.yml` on a GitHub-hosted runner (ubuntu-latest, CPython 3.12.16).

None of `result.json` is hand-written.
They come from the `license-scan-results` artifact of run https://github.com/nemarDatasets/.github/actions/runs/45996003429 (`test-license-scan.yml`, pull request nemarDatasets/.github#171), unchanged.
The same `LICENSE` and `case.json` files live in that repository under `scripts/fixtures/license-scan/`, where the run checked every case against `scripts/ci/license-file-fact.ts`.

To refresh them after a change of the pins, run that workflow again and replace each `result.json` with the artifact's.

## The NEMAR-header cases (2026-11-27)

`gate-cc-by-nc-4.0-{a,b,c}`, `gate-cc-by-sa-4.0-{a,b}`, `header-cc-by-4.0`, `header-cc-by-nc-4.0-and-mit` and the two `header-*-cc-by-*` variants below are not from that run.
The first six are the root LICENSE files of the datasets the epic gate of 2026-11-27 reviewed (nm000677, nm000774, nm000968, nm000712, nm000924) and of nm000699, a CC-BY-4.0 dataset with the same header,
with the dataset id on line 3 replaced by `nm000000`, because those datasets are not yet public.
The seventh is the first of them with the MIT License text appended.
`header-cc-by-4.0-and-cc-by-nc-4.0` and `header-cc-by-nc-4.0-or-cc-by-4.0` are the first of them with line 3's "distributed under CC-BY-NC-4.0," changed to "distributed under CC-BY-4.0 and CC-BY-NC-4.0," and to "distributed under CC-BY-NC-4.0 or CC-BY-4.0,", each scanned after the change.
Their `result.json` is ScanCode toolkit 32.5.0's output for that exact `LICENSE`, scanned with the workflow's options (`SCANCODE_ARGS`) from `scripts/ci/scancode-requirements.txt` in a `linux/amd64` `python:3.12.16-slim-bookworm` container,
then trimmed with `jq` to the fields the parser reads (plus `matcher` and `rule_identifier`); no value was edited.
The same container reproduced the runner's `cc-by-nc-4.0/result.json` `files` exactly, and the redaction left every match's rule, lines and score unchanged.

## The partial-match cases (2026-11-27)

`deed-and-cc-by-sa-4.0`, `gate-cc-by-nc-4.0-clause-deleted` and `mit-word-deleted` were scanned the same way as the NEMAR-header cases.
`deed-and-cc-by-sa-4.0` is nm000982's root LICENSE unchanged (the CC deed's summary, then the legal code; it names no dataset).
`gate-cc-by-nc-4.0-clause-deleted` is `gate-cc-by-nc-4.0-a` with the sentence of Section 8(a) ("For the avoidance of doubt, this Public License does not, ...") deleted.
`mit-word-deleted` is the MIT License text of `header-cc-by-nc-4.0-and-mit` with ", merge" deleted.
