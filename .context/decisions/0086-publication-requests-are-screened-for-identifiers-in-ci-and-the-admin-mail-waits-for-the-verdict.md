# ADR 0086: Publication requests are screened for identifiers in CI, and the admin mail waits for the verdict

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1614.
Follows ADR 0085 (the scrub of published datasets) and builds on ADR 0020 (central workflows
with a callback), ADR 0053 and ADR 0054 (unknown is never healthy), ADR 0065 and ADR 0067
(report, never repair; no GitHub issue on a public-facing org).

## Context

Sixteen datasets reached the public bucket carrying patient names, birth dates and record
numbers in EDF and BDF headers.
Every one of them passed publication review, because review checked that a README and an
author list existed and never opened a recording.
The Data Contributor Terms put the duty on the depositor, and NEMAR is a publisher that is not
liable and is ethically responsible, so the check has to be a standing step of publication that
does not depend on anyone remembering to look.

The pre-screen workflow (ADR 0014, ADR 0026) is the model for how such a step is dispatched and
reports back, but it is advisory and it posts a judgment from a language model.
This check is mechanical, it reads bytes, and the answer decides whether a person's name goes
public.

Two facts shaped the design.
`repository_dispatch` answers 204 whether or not any workflow listens, so a dispatch that
"succeeded" proves nothing about a run.
And the Actions logs of `nemarDatasets/.github` are public, so the workflow must not print
anything that could be a value.

## Decision

**Requesting publication starts an identifier screen in `nemarDatasets/.github`
(`run-identifier-screen.yml`), and the admin publish-request email is sent when the screen
reports, stating the result.**
If the screen cannot be started, fails, or never reports, the admin gets the email anyway,
saying so.

- **The screen is a workflow, not the Worker.**
  It clones the dataset repository without file contents, reads every EDF and BDF header
  (256 bytes each, ranged reads of the S3 object through a presigned URL), the sidecars, the
  participants and scans tables, small code and text files, and every path that ever existed on
  any ref.
  The Worker cannot make tens of thousands of subrequests; an Actions runner can.
  It runs the same scanner as the uploader preflight and the fleet scan
  (`shared/identifier-scan.ts`), so every surface asks one question.
- **The report is a closed vocabulary, enforced at the door.**
  `shared/identifier-screen-report.ts` parses what the workflow posts: only known finding kinds,
  only counts, only extension-shaped format names, only fixed-word reasons and errors.
  An unknown key, a string where a count belongs, or a kind nobody declared is refused with a
  fixed word that does not quote it, so a changed workflow cannot put a name into D1, an email or
  a status view.
  The same module produces the words shown to people (`describeScreen`), so the email, the
  status view and the CLI cannot disagree.
- **The email waits, and cannot be lost.**
  A held request has a state of its own (`pending`).
  The email is claimed with a conditional write before it is sent and the claim is released if
  nobody could be reached, and a production-only sweep on the half-hourly tick both marks a
  screen that did not report within 40 minutes as `unreported` and sends any email that is due
  and was lost.
  Resend says the screen is still running instead of sending a mail that contradicts the gate.
- **Unknown is never clear.**
  `screenGate` maps every state to what may happen next.
  A screen that did not run, did not report, or whose request predates the screen is `rerun`,
  never `clear`; a stored value that is not a state is `rerun` too.
- **Direct identifiers block, and are not acknowledged.**
  A direct finding sets the request to `blocked` (`identifier_screen_findings`), mails the
  requester the kinds and counts only, and has no override: the data is fixed and the screen run
  again.
  A finding of lesser severity, or a scan that could not cover everything (a recording format
  the scanner does not parse, an unreadable header), needs an admin to approve with a recorded
  reason, which is written to the request and the audit log.
  Acquisition dates alone are fine (2026-10-04 policy) and do not hold anything.
- **The gate is bound to a commit.**
  The report names the commit of `main` it screened, and approval refuses if `main` has moved or
  if GitHub cannot say where it is.
  Sandbox datasets (`xx`) never publish real data and are exempt.
- **Nothing is repaired and nothing is filed.**
  The screen reports and gates; it never edits a dataset, and it opens no GitHub issue
  (`nemarDatasets` is public-facing).

## Consequences

- Publication review now reads recordings, deterministically, every time, and the admin sees the
  verdict in the same email that asks for the decision.
- A workflow outage no longer slows publication silently: it produces a "did not run" email and
  holds approval until a run succeeds (an admin can start one).
  The cost is that an extended outage holds publications; there is deliberately no break-glass
  that approves an unscreened dataset.
- The check is best effort, and says what it did not read.
  It does not parse formats outside EDF and BDF, it does not read the contents of earlier
  commits, and it cannot judge free text it does not recognize as a name.
  A clean screen is not a certification; the policy text and the email say so.
- The workflow checks out `nemarOrg/nemar-cli` at `main` for the script, so the script must be
  released before the workflow can pass; until then the failure callback produces the
  "did not run" path, which is the designed degradation and not an outage.
- Reports are counts, so an admin who wants to see a finding opens the file; the report is a
  pointer to where to look, never a copy.

## Alternatives considered

- **Screen in the Worker.**
  Subrequest and CPU limits make a full header read impossible for the largest datasets, and a
  sample is exactly the weakness that let sixteen datasets through.
- **Send the email now and the screen later.**
  Simple, and it makes the screen advisory: an admin who has already been asked to decide does
  not wait.
  The point is that the decision is made with the result in hand.
- **Advisory only, like the pre-screen.**
  A language-model concern is a judgment; a name in a header is a fact.
  Advisory is how the review was bypassed before.
- **An override for direct identifiers.**
  A scanner false positive would justify it; so would a bug.
  The cost of publishing a person's name is larger than the cost of a delayed release, and a
  false positive is fixed in the scanner once, for every dataset.
- **Fail open when the screen is down.**
  Unknown would then read as healthy, which is the failure ADR 0053 forbids.

## Receipts

- Report contract and its tests: `shared/identifier-screen-report.ts`, `test/identifier-screen-report.test.ts`.
- Scanner and fleet scan: ADR 0085 context, PR #1617.
- Epic #1610; this decision is Phase 4 (#1614).
