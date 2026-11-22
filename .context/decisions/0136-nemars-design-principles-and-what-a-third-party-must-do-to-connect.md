# ADR 0136: NEMAR's design principles, and what a third party must do to connect

**Status:** proposed
**Date:** 2026-11-22
**Owner:** Seyed Yahya Shirazi

Refines [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) and [ADR 0119](0119-nemar-is-an-openid-connect-provider-and-orcid-stays-the-upstream-identity.md) by naming the partner requirements as binding.
It supersedes nothing, and it changes no verdict of any Architecture Decision Record (ADR) it cites.
ADRs are cited by number whatever their status;
several that still read `proposed` are built, and moving those headers is a separate change.

## Context

About 130 ADRs record single decisions, and the same few reasons recur in most of them.
Those reasons were never written down as rules of their own.
Three were stated on 2026-11-22 on two documentation pages (the public "Compute partner integration" page and the gated compute design page), with a note that no ADR owned them.
A reviewer therefore had no short list to hold a new design against,
and a third party that wants to connect had requirements with no ruling behind them.

The principles below were distilled from the ADR index, the ADRs cited here, `AGENTS.md`, `.rules/testing.md`, the two pages, and the partner contract as built on `dev`.
Every ADR cited was read for the claim it carries, and every enforcement claim in Part B was checked against the code it names.

## Decision

**NEMAR has ten design principles.
A new design names the principle it serves, or the exception it takes and why.
A third party that connects to NEMAR meets the requirements of Part B, each of which follows from a principle.**

### Part A: the principles

Each principle has a statement, what it requires, the test a reviewer applies, the ADRs it rests on, and its known exceptions.

#### P1. Portability: one contract, any endpoint

**Statement.**
The same image, launcher and contract run wherever compute or reading happens,
and a new endpoint is connected, not rebuilt for.

**Requires.**

- One Open Container Initiative (OCI) image, built once and pinned by digest, runs under Apptainer or Docker (ADR 0122).
- A job names its executor as data, and no code path forks per site (ADR 0121).
- Every reader of the Zarr serving copy passes one conformance suite, and a public store stays readable by stock tools with no NEMAR code (ADR 0124).
- The pipeline contract (checkpoints, progress, signalJourney records) is the same for every compute job (ADR 0134, decision 8).

**Reviewer's test.**
Does adding the next endpoint need a new image, a new contract word or a site-specific branch?
If yes, the design is not portable.

**Rests on.** ADRs 0049, 0118, 0121, 0122, 0124, 0134.

**Known exceptions.**
A workstation runner takes only NEMAR's own pipeline jobs (ADR 0121, decision 1).
Podman is refused until it is verified on a real host (ADR 0122).
How a partner-launched job receives its launch specification is planned and not built.

#### P2. NEMAR is the system of record, and it reads back what it relies on

**Statement.**
Accounting, job records, limits, eligibility and dataset state live in NEMAR;
whoever executes or relays is never the authority.

**Requires.**

- Decide from NEMAR's own row at every use, never from the request, a webhook or a cached copy (ADRs 0003, 0066, 0084, 0126).
- Treat a notification as a hint, then read the fact back from its source (ADR 0118, decision 6).
- Confirm a write by reading it back, not by an exit code (ADR 0061).
- Derive a verdict; never read it from the party being judged (ADRs 0092, 0102).

**Reviewer's test.**
If the other party lied or went silent, would NEMAR's record still be right, and would NEMAR notice?

**Rests on.** ADRs 0003, 0061, 0066, 0084, 0092, 0102, 0111, 0118, 0121, 0126.

**Known exceptions.**
A runner job has a job record but writes no ledger entry, because a workstation has no allocation to meter (ADR 0121).
Git operations and merges on a dataset repository happen on GitHub, outside NEMAR's path (ADR 0002);
ADR 0093 calls its own merge "a check, not an enforcement", and the repository ruleset enforces.

#### P3. One account, one profile

**Statement.**
A person has exactly one NEMAR account,
and every setting and every job is reachable from it on every surface.

**Requires.**

- An Open Researcher and Contributor identifier (ORCID iD), an email address or a GitHub handle backs at most one live account (ADR 0043).
- A third party signs people in through NEMAR, which is an OpenID Connect (OIDC) provider, so nobody needs a second account (ADR 0119).
- The command-line interface (CLI) and the website give the same answer about an account, through the same handlers (ADRs 0044, 0045).
- Sign-in has one path, the browser, for the website and the CLI alike (ADRs 0047, 0097).

**Reviewer's test.**
Does this feature add a second identity, a second place to change a setting, or a job the profile cannot list?

**Rests on.** ADRs 0043, 0044, 0045, 0047, 0048, 0097, 0119, 0132.

**Known exceptions.**
Service and test accounts are explicit kinds, not persons (ADR 0048).
An ORCID iD that was attested for a person, and not proven by the person's own sign-in, does not count as proof for a client that requires it (ADRs 0106, 0119).

#### P4. Declare once, and hold every copy by a test

**Statement.**
A rule, a word or a sentence has one declaration;
any copy in another repository is a transcription that a test compares to the source.

**Requires.**

- Shared words live in `shared/contract/`, and other repositories copy them byte for byte with a pinned digest (ADRs 0045, 0118 decision 10, 0124 decision 3).
- A drift test fails when a copy differs, and compares pre-release branches so that a coordinated release cannot deadlock (ADR 0046).
- Documentation says a thing once, and where an ADR and another document disagree, the ADR wins.

**Reviewer's test.**
Name the single file that declares it, and the test that fails when a copy differs.

**Rests on.** ADRs 0031, 0032, 0045, 0046, 0118, 0123, 0124, 0132; `test/adr-index.unit.test.ts`.

**Known exceptions.**
Transcription was chosen over a shared package, so drift is caught, not prevented.
A few bespoke filters were deliberately left outside the declared facet table (ADR 0032).

#### P5. Closed by default, and unknown is never clean

**Statement.**
Anything irreversible or disclosing starts off and is switched on only by the owner,
and a check that could not run is reported as unknown, never as a pass or a zero.

**Requires.**

- A new switch is dark and absent from configuration, with a test that fails if one is added (ADRs 0111, 0118 decision 8, 0121; the switch rules of `AGENTS.md`).
- A new scheduled job is production-only by default, and non-production mail is fenced (ADRs 0088, 0110).
- Three states, not two: fine, not fine, could not check (ADRs 0053, 0054, 0067, 0086, 0102).
- A misconfiguration refuses; it never falls back silently (ADRs 0083, 0095, 0110).

**Reviewer's test.**
What happens when the check errors, the secret is missing or the flag is unset?
If the answer is "it proceeds", the design fails.

**Rests on.** ADRs 0053, 0054, 0067, 0083, 0086, 0088, 0095, 0102, 0110, 0111, 0118, 0121.

**Known exceptions.**
Availability and flows that must not block fail open on purpose, under the rule in "Conflicts" below (ADRs 0005, 0084, 0113).

#### P6. Honest status

**Statement.**
What is planned, built, released and switched on is always stated as such,
a test must be able to fail,
and status that lags behind the code is a defect.

**Requires.**

- Every claim about the system says which state it is in: designed, built, released, or on in production.
  An ADR annotates what is built and what is not (ADR 0111), and a page that describes unreleased work carries a dated "Where this stands".
- A document does not claim more than was checked: "verified" means what the check can see (ADR 0067), and an unmeasured figure is said to be unmeasured (ADRs 0116, 0122 decision 3).
- A test is shown to fail when the line it guards is changed (`.rules/testing.md`, mutation), with no mock of NEMAR's logic.
  ADR 0067 exists because deleting two blinds left 3,418 tests green.
- A report arrives whether or not anything is wrong, so that its absence is evidence (ADR 0054).
- When a status line lags (an ADR header, a tracker row, a page), fixing it is work of the same rank as fixing code.

**Reviewer's test.**
For each claim, which state does it assert, and what would show it to be false?
Which test fails if the guarded line is removed?

**Rests on.** ADRs 0054, 0067, 0111, 0116, 0122; `.rules/testing.md`; the index test's own check that its gap rule can fail.

**Known exceptions.**
None is granted.
A known lag is recorded where a reader will find it, as the index does for ADR headers that still read `proposed`.

#### P7. Keep the history: supersede, report, do not silently repair

**Statement.**
Records are appended and superseded, not rewritten,
and automation that finds a disagreement reports it before anything acts on it.

**Requires.**

- ADRs are superseded and never deleted; the ledger is append-only (ADR 0118, decision 3); derivatives are immutable once stored (ADR 0123).
- A sweep or a reconcile reports, and files or repairs nothing until the report's shape is proven (ADRs 0055, 0061, 0067, 0088).
- A state change is a stamp on the old row, not a rewrite (ADRs 0104, 0125), and the raw object is the record from which tables are rebuilt (ADR 0112).

**Reviewer's test.**
After this runs, can someone reconstruct what was true before, and who decided the change?

**Rests on.** ADRs 0055, 0061, 0067, 0088, 0104, 0112, 0118, 0123, 0125.

**Known exceptions.**
Privacy overrides it: a correction scrubs every version in place and keeps only counts and fixed words (ADR 0085).
A recovered copy that does not verify is deleted (ADR 0063), and password hashes were cleared when password sign-in was retired (ADR 0097).

#### P8. Take what owns the semantics, and fix it upstream

**Statement.**
Where a standard, a registry or a maintained library owns the meaning, NEMAR uses it and contributes fixes there;
NEMAR keeps only its own policy bespoke, and writes the verdict down either way.

**Requires.**

- An explicit replace, wrap or keep verdict for every subsystem an established system could serve (ADR 0037).
- Standards are the record: the Brain Imaging Data Structure (BIDS; ADRs 0108, 0129), signalJourney and neuroschema (ADR 0134), OIDC (ADR 0119), one registrar for every Digital Object Identifier (DOI; ADR 0007), the stock Neurobagel stack (ADRs 0081 to 0083).
- Numerics go into the upstream library, never into a recipe, and a scan enforces it (ADR 0134, decision 6).
- A refusal to adopt is also recorded (ADR 0128 declines Neurodata Without Borders conformance; ADRs 0038 and 0039 keep two small pieces bespoke).

**Reviewer's test.**
Name the established alternative, what it owns, and the runtime it brings.
Is the verdict written down?

**Rests on.** ADRs 0007, 0037, 0038, 0039, 0069, 0081, 0082, 0083, 0108, 0119, 0128, 0129, 0134.

**Known exceptions.**
A fallback engine is named while the preferred one cannot yet run in a lane (ADR 0049).
Measurement-only assembly may live beside a recipe with an upstream issue filed (nemar-process `AGENTS.md`).

#### P9. Edge-first hosting, with cost as an optimizing factor

**Statement.**
A new service runs on the managed edge platform and its storage, not on a host someone must log in to and operate;
among options that meet the requirement, the cheaper one is chosen when its performance cost is manageable.

**Requires.**

- The application programming interface (API), the data plane, the Model Context Protocol (MCP) server and mail run as Cloudflare Workers in one account (ADRs 0008, 0050, 0066, 0072, 0078, 0095, 0110).
- State lives in the platform's managed stores: the SQL database and the vector index (ADR 0003), and private object-store buckets for news images, raw mail, compute records and derivatives (ADRs 0076, 0112, 0118 decision 7, 0123).
- NEMAR's servers do not run compute for users: it runs in the browser, on registered runners or on the supercomputer (ADRs 0049, 0121), and the application host is not an executor (ADR 0080).
- Cost is weighed explicitly.
  Dataset bytes stay in the sponsored object store and the Worker never proxies bulk bytes (ADR 0076 records why);
  a model call is bounded in money and in time before it ships (ADR 0116).

**How "manageable" is judged.**
The performance cost of the cheaper option is manageable when both of these hold:

1. It is measured, on the platform the design will run on, not estimated.
   ADR 0049 corrected its own estimate after measuring, ADR 0069 measured the download before choosing, and ADR 0116 says plainly that its latency was not measured.
2. The measurement is within the user-facing budget that the ADR for that surface sets:
   for example the memory bound of one Worker isolate and the 60-second trust in an edge copy (ADR 0072),
   the 4-second bound on reranking (ADR 0116),
   or the download budget of the browser runtime (ADR 0069).
   Where no ADR sets a budget for the surface, the design proposes one and records it before choosing.

A cheaper option that is unmeasured, or that breaks a recorded budget, is not chosen on cost.

**Reviewer's test.**
Does this add a host that someone must patch, log in to or restart?
If so, which exception below does it take?
If a cheaper option was chosen, where is the measurement, and which budget does it sit within?

**Rests on.** ADRs 0003, 0008, 0049, 0050, 0066, 0069, 0072, 0076, 0078, 0080, 0095, 0110, 0112, 0116, 0118, 0123.

**Known exceptions.**
The Neurobagel node runs stock on the lab's shared host, under hard limits and fed by pull, because its unmodified stack cannot run on Workers (ADR 0082, an approved exception that also says a service needing more is a different decision).
Batch Zarr conversion runs on a lab node because one conversion needs tens of gibibytes of memory (ADRs 0029, 0101);
it is batch work, not a service.

#### P10. Least disclosure, and ending a credential ends what it minted

**Statement.**
A person's identity, data and credentials go only where a stated rule sends them,
and a revocation cascades in one batch.

**Requires.**

- One writer or one predicate decides each disclosure (ADRs 0017, 0065, 0084, 0115).
- A credential is sent only to listed origins (ADR 0114), and a model never receives an identifier or data content (ADR 0102).
- A third party identifies a person by an opaque subject that is not an email address or a row number (ADR 0119, rule 5), and an external allocation program is told a separate pseudonym (ADR 0118, decision 9).
- The API token is the master credential, and ending it ends every credential minted from it (ADR 0021);
  the paths that end a credential are a list that a test holds to the code (ADR 0119, rule 12).
- Operational material is private at source, not merely gated at serving (ADR 0057).
- Identifiers are screened before publication, at upload and at import (ADRs 0086, 0087, 0089, 0091).

**Reviewer's test.**
List every place the value travels and every credential derived from it.
Which single function ends them?

**Rests on.** ADRs 0017, 0021, 0057, 0065, 0079, 0085, 0086, 0087, 0089, 0091, 0102, 0114, 0115, 0118, 0119, 0132.

**Known exceptions.**
A role demotion and an API key revocation deliberately leave `private` sessions and OIDC grants alone, because neither was minted from the role or the key (ADRs 0079, 0119).
A recall reaches revoked accounts (ADR 0132).
With a person's consent, a client may also read the name and the ORCID iD through scopes (ADR 0119, rule 6), so the opaque subject is a stable key, not a promise of anonymity.

### Conflicts between principles, and how the ADRs resolve them

- **P5 against availability.**
  Fail closed on disclosure and on anything irreversible;
  fail open where only availability is at stake and the gap is reported.
  ADR 0005 serves partial data, and ADR 0064 bounds it: below 90 percent of data keys, after recovery and a notice period, a dataset is withdrawn, reversibly.
- **P5 against flows that must not block.**
  The Neurobagel writer contains every failure (ADR 0084), and a failed blocklist lookup stores the mail (ADR 0113).
  Both keep the record and a later check behind the open path.
- **P7 against P10.**
  Privacy wins: scrub in place, and keep counts and fixed words only (ADR 0085).
  Anonymity cannot be granted after publication, because publication cannot be undone (ADR 0065).
- **P2 against P1.**
  A partner launches its own jobs, so NEMAR requires a reservation first, verifies by its own read, and charges a mismatch to the partner pool, never to the person (ADR 0118, decision 5).
- **P4 against separate repositories.**
  Transcribe, pin and test, comparing pre-release branches (ADRs 0045, 0046, 0124).
- **P8 against P9.**
  Taking a stock system can bring a runtime the edge cannot host.
  ADR 0037 already weighs the runtime a dependency brings, and ADR 0082 is the one recorded case where the stock system won and a host was accepted under limits.
- **P9 against cost.**
  Cost optimizes among options that already meet the requirement and the budget; it never buys a broken budget or a skipped measurement (P6).
- **P3 against P10.**
  One account does not mean one identifier everywhere: a client and an allocation program each see a different opaque value (ADRs 0118, 0119).

### Part B: what a third party must do to connect

These are binding on any third party that launches compute for NEMAR users, the first being the partner site of ADR 0118.
Each is tied to its principle and marked by how it holds on `dev` today:

- **enforced in code:** the Worker refuses otherwise;
- **checked:** confirmed by a person before the client is registered or the contract is opened;
- **by agreement:** NEMAR cannot see it, and the partner commits to it;
- **planned:** not built.

| Requirement | Principle | Basis | How it holds |
|---|---|---|---|
| Sign in with NEMAR is the only sign-in; every other method on the site, local accounts included, is off | P3 | ADR 0119 | Checked. No code can see the partner's site. |
| No separate partner or supercomputer account; the person's `sub` is their username on the job platform | P3, P2 | ADR 0118 decision 1; ADR 0119 rule 11 | Enforced in code at report: the job's owner must equal the person's username, else `owner_mismatch` (`backend/src/services/compute-report-verify.ts`). |
| Registered as a third-party client, with the six scopes of the partner page and the API origin as audience | P3, P10 | ADR 0119 rules 6 and 8 | Enforced in code: registration is an owner command, `first_party` is refused for a partner host (`backend/src/services/oidc-clients.ts`), and the routes refuse `forbidden_credential`, `insufficient_scope` and `wrong_audience`. The list of scopes is set at registration, which is checked. |
| Show NEMAR's state (`GET /compute/me`, `GET /compute/me/jobs`); keep no parallel profile, balance or job ledger; send the person to their NEMAR profile for access and settings | P2, P3 | ADR 0045; ADR 0118 decision 2 | The routes exist and are enforced in code for the `compute.read` scope. That the partner keeps no copy is checked and then by agreement. |
| Mint a job platform token only while `access.state` is `active`, read before every launch | P2 | ADR 0119 rule 11 | Checked on the partner's side. NEMAR's side is enforced in code: a reservation is refused with `no_compute_access` or `suspended`, and a suspension ends the compute grants. |
| Reserve through the NEMAR API before every launch, with an `Idempotency-Key`; no reservation, no launch | P2, P5 | ADR 0118 decisions 3 and 5 | Enforced in code: `POST /compute/holds`, `idempotency_key_required`, `idempotency_conflict`; a job that skipped its reservation is canceled and charged to the partner pool (`compute-tenant-sweep.ts`). The contract answers `partner_not_enabled` to every new reservation until `policy.partner.tapisVisibilityConfirmed` is set. |
| Put the returned tag on the job, make the job match its reservation, and report the job platform's job id at once | P2 | ADR 0118 decisions 2 and 6 | Enforced in code: NEMAR reads the job back itself and refuses `report_mismatch` with one of four closed words (`compute-report-verify.ts`, `shared/contract/compute-partner.ts`). Not yet exercised against a real tenant. |
| Release the reservation when a launch fails | P2, P7 | ADR 0118 decision 3 | Enforced in effect: `DELETE /compute/holds/:id` exists, and a reservation with no job is released by the hold reaper after a search of the job platform for its tag finds none. |
| Declare and upload the submitted files of every batch job | P2 | ADR 0118 decision 2 | By agreement. `files` is optional in `ComputeReportRequestSchema`, so a report without it is accepted and the record then holds no submitted files. |
| Honor every refusal and limit, including the client's caps | P5 | ADR 0118; ADR 0119 rule 8 | Enforced in code at reserve: the refusal words are a closed list (`COMPUTE_PARTNER_ERROR_STATUS`), with `client_cap_reached` and `platform_busy`. That the partner launches nothing after a refusal is caught afterwards by the sweep above. |
| Send no separate usage report to an external allocation program | P2 | ADR 0118 decision 9 | By agreement. NEMAR's own reporter is built. |
| Honor back-channel logout | P10 | ADR 0119 | NEMAR's sender is built (`backend/src/services/oidc-cascade.ts`). The partner's side is by agreement, and the read before every launch is the control that does not depend on it. |
| Run a job that follows the pipeline contract unchanged: the nemar-process image or one built from it, the launcher and its launch specification, declared checkpoints, signalJourney records | P1 | ADR 0122; ADR 0134 decision 8 | Planned. How a partner-launched job receives a launch specification is not designed; until then a partner's jobs report job-level states only. |
| Serve interactive sessions so that their pages cannot set cookies for `nemar.org` | P10 | ADR 0119 rules 9 and 10 | NEMAR's side is enforced in code (`shared/partner-hosts.ts`, host-only `__Host-` cookies). The partner's hosting is checked. |

The words and numbers of the contract are `shared/contract/compute-partner.ts` and `shared/contract/compute-partner-request.ts`, and this ADR restates none of them (P4).
A requirement marked "checked" or "by agreement" is still binding;
the mark says how NEMAR would learn of a breach, not whether one is allowed.

**Agreement with the documentation pages.**
The requirements above are the list on the public "Compute partner integration" page and in the gated design page's partner table, as merged on 2026-11-22.
The differences are of form only:

- The two pages state three principles (P1 to P3 here); this ADR states ten and ties some rows to the others.
  The interactive-session row and the token row are under principle 3 on the gated page, and under P10 and P2 here.
- The public page says "must" for both enforced and checked requirements and "should" for the rest; this ADR uses the four marks above.
  Submitted files and back-channel logout are "should" there and "by agreement" here.
- Back-channel logout has its own row here; the gated table folds it into the token row.
- The gated page says the principles have no ADR of their own; that sentence and its tracker row are stale once this ADR is accepted.

## Consequences

- A reviewer has ten tests to apply, and a design that fails one says which exception it takes.
- The two documentation pages cite this ADR for the rationale and stop restating it, and keep the list of requirements, which a partner reads there (P4).
  Until that edit lands in the documentation repository, the gated page's "no ADR of their own yet" is a known lag (P6).
- The partner requirements are binding by a ruling and no longer only by a page.
- Eight of the fourteen requirements depend wholly or partly on a person's check or on the partner's word.
  That is stated, not hidden, and each one names the control NEMAR does hold.
- The ADR is longer than the convention asks, because it is an index of reasons across the others.
  It decides nothing those ADRs decided, so where it and a cited ADR disagree, the cited ADR wins and this one is corrected.
- Edge-first hosting was a practice with no ADR; it is now a principle with a stated test, and the next host-based service needs an exception written down.

## Alternatives considered

- **Leave the principles on the documentation pages.**
  A page is not a ruling, the pages covered three of the ten, and only compute.
- **One ADR per principle.**
  Ten short ADRs would each restate their evidence, and the conflicts between principles would have no home.
- **Fold honest status into "closed by default".**
  They fail differently: one is about what the system does when it cannot check, the other about what people and documents say is true.
  Status that lags was found in the index itself, which is reason enough for a principle of its own.
- **Treat edge-first hosting as a case of "take what owns the semantics".**
  It is a decision about who operates the runtime, not who owns the meaning, and the two conflict in ADR 0082.
- **State the principles without exceptions.**
  Every one of them has a recorded exception, and a principle that hides its exceptions is not followed.

## Related ADRs

- **Compute and sign-in:** 0049, 0118, 0119, 0121, 0122, 0123, 0124, 0134.
- **Accounts:** 0043, 0044, 0045, 0046, 0047, 0048, 0097, 0106, 0132.
- **Record, history and reporting:** 0002, 0003, 0005, 0053, 0054, 0055, 0061, 0063, 0064, 0067, 0088, 0092, 0093, 0102, 0104, 0111, 0112, 0113, 0125, 0126.
- **Declared once:** 0031, 0032.
- **Make or take:** 0007, 0037, 0038, 0039, 0069, 0081, 0082, 0083, 0108, 0128, 0129.
- **Hosting:** 0008, 0029, 0050, 0066, 0072, 0076, 0078, 0080, 0095, 0101, 0110, 0116.
- **Disclosure and credentials:** 0017, 0021, 0057, 0065, 0079, 0084, 0085, 0086, 0087, 0089, 0091, 0114, 0115.

## Receipts

- The public page `platform/compute-partner` and the gated page `admin/design/compute-gateway` of the documentation site, as merged on 2026-11-22.
- `shared/contract/compute-partner.ts`, `shared/contract/compute-partner-request.ts`, `shared/partner-hosts.ts`, `shared/oidc.ts`.
- `backend/src/routes/compute/partner.ts`, `backend/src/routes/compute/auth.ts`, and the services `compute-partner.ts`, `compute-report-verify.ts`, `compute-partner-excess.ts`, `compute-tenant-sweep.ts`, `compute-hold-reaper.ts`, `oidc-clients.ts` and `oidc-cascade.ts`.
- `AGENTS.md` (the hard rules on switches, revocation and declared-once copy) and `.rules/testing.md`.
- nemar-process: `launcher/schema/launch-spec.v1.json`, `tests/recipes/test_upstream_first.py`, `AGENTS.md`.
