# ADR 0122: One OCI image runs under Apptainer or Docker from one digest

**Status:** proposed
**Date:** 2026-11-13
**Owner:** Seyed Yahya Shirazi

This Architecture Decision Record (ADR) records how a compute job's container is built, signed and run, so that the same job runs on a lab workstation and on a cluster.
It refines [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) decision 14 (the launch specification names a digest-named Singularity image file) and goes with [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md).
It supersedes nothing.

## Context

ADR 0118 runs a job from a Singularity Image Format (SIF) file named by its digest, and the launcher's continuous integration (CI) already exercises Apptainer.
The two lab workstations probed on 2026-11-13 run Docker only: both daemons are rootful and the login is in the `docker` group, which is root-equivalent on that host, and neither has Apptainer or a scheduler.
Shared clusters generally run Apptainer and not Docker.
The plan needs one artifact that both can run, whose identity a result can name, without a second build that could drift from the first.

## Decision

1. **One Open Container Initiative (OCI) image is built once, in CI, and pinned by its digest.**
   The digest is the identity a job records as `image_digest`; a tag is never an identity.
2. **The image is signed only from `main` or an `image-nemar-python-v*` tag.**
   The signing workflow's `SIGNING_IDENTITY` is the certificate identity a verifier accepts, so a branch build cannot produce a signature that verifies.
3. **Apptainer is the primary runtime, on workstations and clusters.**
   It needs no daemon and no root, and the launcher's CI already runs it.
   The SIF is derived from the OCI digest on the machine that runs it, and its file name carries that digest, so the file and the image cannot be confused.
4. **Docker or Podman is the second runtime, under pinned isolation flags and a limits rule.**
   Docker gets `--cpus` and `--memory` on every run.
   Apptainer gets them only when the runner's `doctor` has proved cgroup delegation (`NEMAR_ENFORCE_LIMITS=1`); otherwise the runner's own watchdog enforces wall time and resident memory, and reports that this is the mode in force.
5. **A rootful `docker` group is allowed only on a single-tenant lab machine recorded in the gated systems inventory.**
   On any shared or multi-user host the second runtime must be rootless, or the host is not a runner.
6. **An operator-built image is unsigned and must say so.**
   Its source commit and image id are written into a label, a result that used it is labeled "operator-built, unsigned", and it is never presented as built in CI.
   Verifying a signature before first use is a runner feature added later; until then a runner trusts only the digest it was told.

## Consequences

- A result can name one digest that either runtime ran, so a workstation run and a cluster run are comparable by construction.
- A rootful Docker daemon is root-equivalent for its group; the single-tenant rule and the inventory record are the only guard, so a new machine needs an owner decision, not a configuration change.
- Signing only from `main` or a tag means a pre-merge image cannot verify; a demo before a merge uses the labeled operator-built path.
- Without cgroup delegation Apptainer cannot cap CPU per user, so the watchdog is a weaker, after-the-fact limit and the runner says so.
- Two runtimes double the test matrix; the Docker backend can be cut first when time is short, and the Apptainer path stays.

## Alternatives considered

- **One image per runtime:** two builds can drift, and a digest would no longer identify a result.
- **Docker only:** shared clusters generally do not run it, which defeats portability.
- **Apptainer only:** the lab workstations in hand do not have it.
- **Signing from any branch:** a signature would no longer mean "reviewed and merged".
- **Rootful Docker on any host:** a group that is root-equivalent has no place on a shared machine.
- **An unlabeled local build:** a result would claim provenance it does not have.

## Receipts

- [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) decisions 11 and 14, the two digests and the digest-named image file.
- The two-workstation probe of 2026-11-13: runtimes, group membership and cgroup delegation.
