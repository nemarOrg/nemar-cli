# ADR 0058: What moves to the private side, and what deliberately does not

**Status:** accepted
**Date:** 2026-09-13
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0057 decided that admin-only material becomes private at source rather than merely gated at
serving. It did not say what counts as admin-only, and that judgment is about to be applied to
roughly 19,400 committed lines of agent-facing material in this repo alone, and about 23,100 across
the public repos this epic touches (`nemar-cli`, `docs`, `website`, `nemar-observability`). A rule that lives in
one person's head produces a different answer every time it is applied, and the two failure modes
point in opposite directions: collect too little and the gate stays cosmetic, collect too much and
the project stops being open for no security gain.

The evaluation behind this rule is on issue #1339. Its calibration is binding: no credential value
is in any of the public material, nothing needs rotating, this is not an incident, and NEMAR's
public documentation stays public because that is what the project is for. A determined reader
digging through public history will find most of it. The goal is that they should not find an
assembled map on the first click.

## Decision

Move an item to the private side if it does at least one of:

1. **Names a code-execution or credential path concretely enough to act on** -- host, plus path,
   plus ref, plus cadence.
2. **Names where a credential or a full copy of the data lives.**
3. **Describes an incomplete security migration**, which is the one case where a roadmap is more
   sensitive than the end state.
4. **Is an assembled operational map rather than a single fact.**

**Assembly is the trigger, and it is the part people get wrong.** That the Zarr converter runs on an
SDSC host is worth documenting and stays public. Host alias, plus state path, plus cron window, plus
the deploy mechanism, gathered into one table, is a different artifact than the sum of those facts
published separately.

## What does NOT move, and this half is load-bearing

- **ADRs, architecture, contracts, schemas, and the API and CLI surface.** This is the project's
  value and most of what makes contribution possible.
- **Every blast-radius warning**, and this is the one that will look tempting later. The dev
  database holds real users, the `nemarDatasets` org is shared with production, `nm000103`-`nm000107`
  are live, the version is owned by CI. Those warnings are what prevent the LIKELIER harm, which is
  a contributor breaking something by accident rather than an attacker exploiting anything. Moving
  them behind the gate trades a small reconnaissance gain for a real increase in accidents. Anyone
  tidying them into the private repo later is making the system less safe, not more.
- **Material whose only protection would be obscurity against someone who already holds an admin
  key.** Dataset ID bands, the S3 layout, which endpoints cascade: someone with a key runs
  `nemar admin --help` and has the same map in a minute. The control there is key hygiene, not
  document classification, and collecting these pages buys nothing while costing contributors.

## Consequences

- The expected result is a **small** move. Applied to this repo it is four documents --
  `systems-inventory.md`, `validated_workflows.md`, `research-d1-backup-655.md` and
  `plan-923-test-staging.md` -- out of the 99 files under `.context/`. Named individually rather
  than described, because an earlier draft of this line double-counted one file and referred to a
  document that does not exist.
- Classification is recorded as a destination column on `.context/README.md`, which is already the
  curated index. Destination only, with no per-file rationale: a list of destinations is not a
  target list, and the reasoning belongs here as a general rule rather than beside each file.
- The rule has to be applied by reading, not by grep. A mechanical scan for host, path, cron and
  credential shapes is useful triage and it ranked the same two files far above everything else,
  but "assembled map" is a judgment a regex cannot make.
- Anything that moves stays in public git history. Accepted: no credential value is involved, and
  operational detail ages out on its own as paths and schedules drift. This reasoning does not
  extend to a key, and must not be cited for one.
- Applying the rule to a repo is cheap; changing it later is not, because material that has been
  made private and then republished was public all along. Prefer leaving an item public when the
  rule is genuinely ambiguous, and revisit.

## Alternatives considered

- **Classify by feel, per file, as each phase reaches it.** Rejected: the sorting is the actual work
  of this epic, it will be done by more than one person across four repos, and an unwritten rule
  produces an inconsistent result that nobody can review.
- **Move everything that mentions infrastructure.** Rejected as over-collection. It would sweep up
  the blast-radius warnings and most of the architecture, which is the majority of what makes the
  repos useful, in exchange for hiding facts an admin key already grants.
- **Move nothing and rely on the serving gate.** Rejected by ADR 0057: a gate in front of a public
  source is cosmetic.
