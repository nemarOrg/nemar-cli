# License scan fixtures (ADR 0142)

Each directory is one case for `test/license-file-fact.unit.test.ts`:

- `LICENSE`: a public license text, or a public text with one change (a rider, an inserted word, a copyright line, a second license), or NEMAR's own generated notice.
- `case.json`: the `License` field it is judged against and the expected `license_file` fact.
- `result.json`: ScanCode toolkit 32.5.0's real output for that `LICENSE`, written by the sandboxed "Scan LICENSE in a sandbox" step of `run-publication-review.yml` on a GitHub-hosted runner (ubuntu-latest, CPython 3.12.16).

None of `result.json` is hand-written.
They come from the `license-scan-results` artifact of run https://github.com/nemarDatasets/.github/actions/runs/45996003429 (`test-license-scan.yml`, pull request nemarDatasets/.github#171), unchanged.
The same `LICENSE` and `case.json` files live in that repository under `scripts/fixtures/license-scan/`, where the run checked every case against `scripts/ci/license-file-fact.ts`.

To refresh them after a change of the pins, run that workflow again and replace each `result.json` with the artifact's.
