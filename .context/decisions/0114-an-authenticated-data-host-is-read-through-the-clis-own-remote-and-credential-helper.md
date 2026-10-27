# ADR 0114: An authenticated data host is read through the CLI's own special remote and credential helper

**Status:** proposed
**Date:** 2026-10-26
**Owner:** Seyed Yahya Shirazi

Issue #1977.

## Context

NEMAR can serve a dataset from an authenticated data host: a NEMAR host (`https://private.nemar.org` in production, `https://private-test.nemar.org` on staging) that answers only to a signed-in account that may read the dataset.
It serves the dataset's git repository at `/git/<id>.git` over smart HTTP, read-only, with HTTP Basic carrying a NEMAR API key as the password, and the annexed objects at `/o/<id>/<git-annex key>` with `Authorization: Bearer <API key>`.
A small object is answered in place; a large one is answered with a redirect to a short-lived signed address on another origin, which refuses a request that also carries `Authorization`.
The CLI has to read such a dataset: clone it, and fetch its annexed content with `git annex get`.

git-annex can fetch a key from a URL with its `web` remote and can be told to add a header (`annex.http-headers`, `annex.http-headers-command`).
That setting is global to every URL git-annex fetches, and the URLs a `web` remote fetches are recorded in the repository's `git-annex` branch, which anyone who can push to the repository can write.
A header configured that way would therefore be sent to whatever host a writer registered, and it also breaks on the redirect, where the signed address must not receive it.

The same problem applies to the configuration of any git-annex special remote: its `host` setting lives in the `git-annex` branch.

## Decision

**The key goes only to origins on the CLI's own list.**
`src/lib/data-hosts.ts` is the one place that says which origins, besides the NEMAR API, the CLI may send an API key to.
The list is the build's default (`https://private.nemar.org`, or `https://private-test.nemar.org` in a dev build) plus the origins in `NEMAR_DATA_HOSTS` (comma-separated), which exists for staging and for tests.
An entry must be a bare `https` origin; `http` is accepted for a loopback address only, so a test can run a data host on its own machine and a key can never cross a network in clear text.
`NEMAR_DATA_HOSTS_ONLY=1` drops the default, so a test can keep a lookup from reaching a real host; it can only narrow the list.
Origins are compared exactly (scheme, host, port).
Nothing a repository holds, neither a remote's configuration, nor `.git/config`, nor the `git-annex` branch, can add a host.

**Annexed content is read by the CLI's own special remote, `git-annex-remote-nemar`.**
It is a second executable of the package, speaking git-annex's external special remote protocol, version 1.
A repository declares it in its `git-annex` branch with `externaltype=nemar`, `host=<origin>`, `dataset=<id>` and `autoenable=true`, so `git annex init` in a clone enables it.
`INITREMOTE` and `PREPARE` refuse a `host` that is not on the CLI's list, one that is not an origin, and a `dataset` that is not two or three lower-case letters and six digits, and make no request.
The API key is read from the CLI's own stored account, never from the repository.
`TRANSFER RETRIEVE` sends `GET <host>/o/<dataset>/<key>` with the Bearer key and follows redirects by hand, at most three; `Authorization` is attached only to a URL whose origin is the configured host, and only `https` is followed (the one exception is a test: plain `http` on a loopback address, and only when the configured host is itself a loopback `http` origin that `NEMAR_DATA_HOSTS` listed).
The byte count must equal the size the key declares.
`CHECKPRESENT` is a `HEAD`: 200 present, 404 absent, anything else unknown, so a fault is never reported as absence.
`TRANSFER STORE` and `REMOVE` are refused; the remote is read-only for now.
No message the remote prints contains the API key, a redirect address or its query string; a failed request is described by the error's class and code (`ECONNREFUSED`, `ENOTFOUND`), never its text.
The origin that carries the key is a branded `VettedOrigin`, produced only by the list check, and the list is checked again before each request that carries the key.
A key is asked for only if it has the shape the server serves (a backend name, `-s<size>`, optional chunk fields, `--`, then letters, digits, `.`, `_` and `-`); the size is checked against the bytes that arrive and a body that passes it is cut off at once.

**The repository is reached through a credential helper, `nemar auth git-credential`.**
It answers git's `get` for an origin on the list, with the user name `nemar` and the stored key as the password, and for nothing else; `store` and `erase` do nothing.
`nemar dataset clone` passes it for that one origin (`credential.<origin>.helper`, preceded by an empty helper that resets any helper configured for all hosts, so the key is never offered to a keychain) and writes the same two lines into the clone's config.
The key is in no URL, no argument and no file of the clone.
The command skips the update check, the notices and the dev-build banner, because git reads its output.

**`nemar dataset clone <id>`** is unchanged for an id the main NEMAR service knows.
For an id it does not know (a 404, or a 400 for an id shape it does not accept) and that has the shape of a data host id, and with `--host <origin>` for a host on the list, it asks each listed host, but only for a signed-in account: a signed-out run never asks a data host, and `--host` signed out stops with a request to sign in.
If the main service itself fails (a 5xx, or no answer), no data host is asked, because the fallback is for an id the service says it lacks, not for an id it could not answer about.
The question is `GET /api/datasets/<id>` with the key, never following a redirect; the clone is from the first host that answers 200.
**`nemar dataset get`** in a clone whose `origin` is such a repository skips the download credentials the main service issues and runs `git annex get` through the special remote.

## Consequences

- A repository that registers a URL on a foreign host never causes a key to be sent there, because the CLI sets no header for the `web` remote and the special remote refuses any host not on the list.
- A key never reaches the signed-address origin of a large object: it is dropped at the redirect by origin, not by a list of known storage hosts.
- Adding a data host means shipping a new CLI build (or setting `NEMAR_DATA_HOSTS` on the machine). That is the point: the host list is the CLI's, not a repository's.
- The special remote must be on `PATH` when git-annex runs (it is a `bin` of the package). `nemar dataset get` says so when it is not.
- The dev-build step of `npm-publish.yml` rewrites the API URL literal in both bundles, because both read `IS_DEV_BUILD` for their default host.
- Upload (`TRANSFER STORE`) and the batch address route (`POST /api/datasets/<id>/objects/urls`, one call for many objects) are not used yet.

## Alternatives considered

- **The generic `web` remote with `annex.http-headers-command`:** refused. It sends the header to every URL git-annex fetches, including any a writer registered in the repository, and it sends it to the signed address on the redirect, which refuses it.
- **The key in the clone URL (`https://user:key@host/...`):** refused. It lands in `.git/config`, in process listings and in logs.
- **Git's credential store or the operating system's keychain:** refused. It copies the key out of the CLI's own config, where `nemar auth logout` and key revocation can reach it.
- **Trusting the `host` setting of the remote because the repository came from a listed host:** refused. The `git-annex` branch is writable by anyone with push access, and a clone can be re-pointed later.
- **Reading the host list from the repository or from the API:** refused for the same reason; a list the server can change is a list a compromised server can widen.

## Receipts

- git-annex external special remote protocol: https://git-annex.branchable.com/design/external_special_remote_protocol/
- `src/lib/data-hosts.ts`, `src/lib/data-host-remote.ts`, `src/lib/git-credential.ts`, `src/lib/data-host-clone.ts`
- `test/git-annex-remote-nemar.test.ts` (the protocol over a real child process against local servers, a second origin that refuses `Authorization`), `test/data-host-e2e.test.ts` (real git and git-annex: clone, get, fsck, a foreign URL that receives nothing)
