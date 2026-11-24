# ADR 0138: Rootless Podman runs through prevention and a verified OCI configuration

**Status:** accepted
**Date:** 2026-11-24
**Accepted:** 2026-11-24
**Owner:** Seyed Yahya Shirazi

This Architecture Decision Record (ADR) supersedes [ADR 0122](0122-one-oci-image-runs-under-apptainer-or-docker-from-one-digest.md) decision 6, its Podman clause only.
The rest of ADR 0122, including decision 6's rule for rootful Docker, stands unchanged.
It was built in nemarOrg/nemar-process#85.

## Context

ADR 0122 decision 6 left Podman unsupported "until it is verified on a real host",
because a site-wide `containers.conf` and `mounts.conf` reach every container and the launcher could neither disable nor detect them.
Its Consequences named the planned check: inspect a container's mounts and devices against the declared binds.
That check alone does not work.
On rootless Podman 4.9.3, `podman container inspect` omits configured devices, tmpfs mounts and `mounts.conf` entries;
only the OCI configuration the runtime is given, `config.json`, holds all of them.
On a shared host, where only rootless engines are allowed, the refusal left Apptainer as the only engine.

## Decision

1. **Podman is supported rootless only, and only through the path below.**
   Every other Podman path, including a Podman that does not report itself rootless, is refused as `runtime_unusable` before any user code runs.
2. **Prevention shuts out site and user configuration.**
   Every Podman call the launcher and the runner make runs with `CONTAINERS_CONF` naming an empty file the caller owns,
   `--default-mounts-file=/dev/null` and `--hooks-dir` naming an empty directory the caller owns,
   and never with `CONTAINERS_CONF_OVERRIDE`,
   so no site or user `containers.conf`, `mounts.conf` or OCI hook applies.
   The container is created with `--systemd=false`,
   so a command named like an init system cannot turn on systemd mode and the tmpfs mounts it adds.
3. **Verification reads `config.json` before the container starts.**
   After `podman init`, the container's state must be `initialized`,
   because `start` writes `config.json` again for a container in any other state, and what was read would then not be what runs.
   The launcher then reads the `config.json` the runtime was given;
   its mounts must be exactly the declared binds plus a fixed allowlist of engine defaults written in the launcher docs, and its devices must be empty.
   Anything else removes the container and fails the job as `runtime_unusable` before any user code runs.
   `podman container inspect` alone is not enough, for the reason in Context.
4. **Hooks are guarded only by the prevention.**
   `config.json` may carry no `hooks` key at all, but that refusal is a tripwire, not a guard:
   a `createRuntime` hook runs on the host during `init`, before the check can look,
   and Podman's own `precreate` and `poststop` hooks are never written into `config.json`.
5. **A Federal Information Processing Standards (FIPS) host is refused for Podman jobs.**
   On a host with `/etc/system-fips`, Podman 4.9.3 adds FIPS mounts that no setting removes, and the verification refuses them.
6. **No GPU is handed over under Podman.**
   A Podman launch that would hand one over is refused as `runtime_unusable` before any engine call,
   while a runner's `cpu` decision for a GPU job still runs on the CPU.
7. **`/dev/shm` is read-only under Podman** with the launcher's flags,
   where Docker's and Apptainer's are writable.
8. **On a shared host, where only rootless engines are allowed, Apptainer and rootless Podman through this path are the engines.**
   ADR 0122's rule for rootful Docker is unchanged.

### Where verification happened

The path was verified in continuous integration (CI), on GitHub's hosted Ubuntu runner with rootless Podman 4.9.3, in the `podman (rootless)` job of nemar-process.
That counts as the real host decision 6 named: it is a real rootless engine, not a stand-in.
The job runs the launcher end to end, shows that the prevention holds against planted site and user configuration,
and shows that the verification refuses each planted mount, device and hook when the prevention is bypassed.
A lab host repeats the verification later.
Other distributions' defaults are unexercised; an engine default outside the allowlist fails closed, as `runtime_unusable`.

## Consequences

- A shared host that has Podman but not Apptainer can run jobs, rootless, with no new engine to install.
- The allowlist of engine defaults is pinned to Podman 4.9.3; a Podman release or distribution that adds a default refuses every job until the allowlist is reviewed and extended.
- A recipe that needs writable POSIX shared memory or a GPU does not run under Podman.
- Hooks rest on the prevention alone: a change that drops the empty hooks directory or `CONTAINERS_CONF` from any Podman call reopens them, and the check would not see it in time.

## Alternatives considered

- **Check with `podman container inspect` alone:** it omits devices, tmpfs mounts and `mounts.conf` entries.
- **Verification without prevention:** a hook runs before the check and Podman's own hooks never show in `config.json`.
- **Prevention without verification:** an engine default or a path the prevention misses would reach the container unseen.
- **Keep Podman refused:** a rootless-only shared host would have one engine, and the path is now verified.

## Receipts

- nemarOrg/nemar-process#85: the launcher and runner change, the `podman (rootless)` CI job and its mutation runs.
- [ADR 0122](0122-one-oci-image-runs-under-apptainer-or-docker-from-one-digest.md) decision 6, the clause this supersedes.
