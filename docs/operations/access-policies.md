# Access Policies

This document codifies how NEMAR manages credentials and access across
its infrastructure. It is the canonical reference for **who can do what,
from where, with which key**. It exists because on 2026-05-22 a single
compromised IAM key took down `data.nemar.org` for every dataset, and
that should never happen again.

The document has two parts:

1. **Operational principles** — the rules every contributor and every
   piece of code is expected to follow.
2. **IAM user catalog** — the four scoped IAM users that replace the
   former single-admin key, with the inline policy attached to each and
   the exact places its credentials are deployed.

The scope today is AWS IAM and S3. Future revisions will add sections
for Cloudflare API token scoping, GitHub PAT/App scoping, and Workers
secret rotation.

---

## Operational principles

### 1. Per-purpose IAM users, not one mega-admin

Every distinct runtime that needs AWS credentials gets its own IAM
user with a tightly scoped inline policy. The Worker has its own
identity, GitHub Actions has its own, the SDSC mirror has its own.
There is no "shared admin" key.

**Why.** A leak in any one runtime then only invalidates that runtime's
credentials. Rotating one identity does not require coordinating across
every consumer of a shared key. AWS's automatic
`AWSCompromisedKeyQuarantineV3` enforcement (which is what triggered
the 2026-05-22 outage) only quarantines the leaked identity, not the
others.

**Not okay.** Reusing your personal admin credentials (e.g., the
contents of `~/.aws/credentials`) for any production runtime. Putting
the same `AWS_ACCESS_KEY_ID` value in more than one of: a Worker
secret, a GitHub org secret, a GitHub repo secret, or a server
config file.

### 2. Public reads MUST be unsigned

Any code path that serves data from a publicly-readable S3 object to
a user-facing endpoint must fetch that object **without** SigV4
signing. The object's own public-read ACL is the access control; the
signature adds nothing and creates a hidden coupling between the
credentials' liveness and the endpoint's availability.

If your code must sometimes serve a private object (private dataset,
pre-publish staging), the right pattern is:

```typescript
let response = await fetch(url);              // unsigned first
if (response.status === 403) {                // not public-read
  const signed = await aws.sign(url, ...);    // signed fallback
  response = await fetch(signed);
}
```

This pattern is implemented in `backend/src/services/s3.ts` for
`getManifest()` and `loadSummary()` as of PR #570 (merged
2026-05-22 after the credential-quarantine outage). The same
pattern must be used by every new public-serving code path. Other
S3-touching helpers in the same file (`generatePresignedGetUrl`,
`buildRedirectUrl`) still sign unconditionally because they serve
mixed public-and-private paths; a follow-up will route public
datasets through unsigned URLs there too.

**Why.** `data.nemar.org` is the canonical public face of NEMAR. It
must keep serving when the Worker's AWS credentials are revoked,
quarantined, or rotated. If the Worker has working credentials, the
unsigned path returns 200 and we never reach the signing call; if it
doesn't, the public objects still return 200. There is no scenario
where the unsigned path is slower or less correct than the signed
one for public reads.

**Not okay.** Signing public-read GETs "because we already have the
credentials handy". Generating presigned URLs for files that have a
public-read ACL.

### 3. Bucket-scoped, not user-scoped

Each policy in this document grants permissions only against
`arn:aws:s3:::nemar` and `arn:aws:s3:::nemar/*`. None of them grant
`s3:*` at the account level. None of them grant `iam:*`. None of
them grant access to other AWS services beyond what's strictly
required.

When a policy needs STS (the Worker needs `sts:GetFederationToken`
to mint temporary upload credentials for users), the STS permission
is scoped to a specific federated-user name pattern that matches
what the Worker actually uses (`upload-*`).

**Why.** A credential leak (the failure mode this document exists
to mitigate) is bounded by the leaked credential's scope. A
bucket-scoped key cannot delete other buckets, cannot enumerate IAM,
cannot pivot to other AWS services. The AWS quarantine machinery
also tends to be less aggressive on scoped keys than on `s3:*`
admin keys.

### 4. Two-slot rotation, never down to zero

AWS limits each IAM user to **two access keys**. Use both slots when
rotating:

1. Provision a new key on the second slot.
2. Update every consumer (Worker secret, GH org secret, etc.) to the
   new key. Verify each consumer is using the new key
   (CloudTrail filtered by access-key-id, or `aws sts
   get-access-key-info` against logged calls).
3. Mark the old key **inactive** (not deleted) for a soak period
   (24-72 hours).
4. Delete the old key once you're confident no consumer still calls
   with it.

**Why.** Zero-downtime rotation. Rolling back is an "activate the
old key again" operation, not a "re-issue everything" operation.

**Not okay.** Deleting the old key before all consumers are
verified on the new one. Storing both keys' raw values in the same
location after the rotation completes (the old key value should be
discarded after deletion).

### 5. No long-lived keys on personal/interactive machines

For personal CLI work (administrators running `nemar admin ...`,
ad-hoc S3 operations, the `nemar-tools/credentials.sh` publishing
flow), use AWS SSO or `aws-vault` to mint short-lived credentials
on demand. Do not commit a long-lived `AKIA*` access key to your
laptop's `~/.aws/credentials` plaintext.

Server-side service accounts (the SDSC Hallu cron user, future
unattended workers) are a different story — they need long-lived
keys because there's no human present to refresh an SSO session.
For those, principle 6 below applies.

**Why.** Any file under a developer's home directory is exposed to
every process they run, every shell extension they install, every
editor plugin with filesystem access. The 2026-05-22 quarantine
fired because a long-lived key reached a place AWS scanned. SSO
sessions expire automatically; even if they leak, the blast
radius is hours, not the lifetime of the key.

**Not okay.** Hardcoding access keys in `nemar-tools/credentials.sh`
or any shell config on a developer laptop. Sharing access keys
between your personal AWS CLI sessions and any service runtime.

### 6. Service-account credentials in single-tenant locations only

Server-side service credentials (Hallu sync cron, future unattended
workers) must live in a path owned by the service-account user, on a
filesystem that no other user can read. Concretely:

- The cron user's own `~/.aws/credentials` (mode 0600) on a local
  filesystem.
- Never in any shared workspace such as `/data/qumulo/...`,
  `/scratch/...`, project-shared NFS, or anywhere the directory's
  permissions don't strictly enforce single-user read.
- Never in a path other team members could `cat` even briefly.

The credentials file itself must be `chmod 600` and owned by the
service-account user. The parent directory must be `chmod 700` or
the credentials file is readable to anyone in the user's primary
group.

**Why.** A shared filesystem leak is permanent: every user on the
machine, every backup that captures that directory, every team
member with sudo can read the key. AWS's compromise detection
won't necessarily catch this kind of slow leak. A single-tenant
home directory at least scopes the leak surface to one user
account.

**Not okay.** Placing service credentials in any path that begins
with `/data/`, `/scratch/`, `/projects/`, `/shared/`, or another
multi-tenant prefix on a server. Symlinking from `~/.aws/credentials`
to such a path.

---

## IAM user catalog

Four scoped IAM users in AWS account `191754232783`, replacing the
previous single-admin pattern. Each section lists the user's
purpose, where its access key is deployed, and the inline policy
JSON to attach.

| User | Where the key lives | Scope summary |
|---|---|---|
| `nemar-worker-prod` | Workers secret on SCCN `nemar-api` | Full S3 R/W on `nemar/*` + bucket policy + Object Lock + `sts:GetFederationToken` |
| `nemar-worker-dev` | Workers secret on SCCN `nemar-api-dev` | Same scope, restricted to `xx*` / `staging/*` / `nm099999/*` |
| `nemar-actions-datasets` | `nemarDatasets` org secret (visibility: ALL) | S3 R/W on `nemar/*` only (no STS) |
| `nemar-actions-cli` | `nemarOrg/nemar-cli` repo secret | S3 R/W on `nemar/*` only (no STS) |
| `nemar-hallu-readonly` | SDSC Hallu server local config | S3 ReadOnly on `nemar/*` only |

The `nemar-actions` workload is split into two users because the
two destinations have **distinct trust boundaries**: the
`nemarDatasets` org secret is visible to every dataset repo
(including future repos a malicious contributor could compromise),
while the `nemarOrg/nemar-cli` repo secret is scoped to maintainers
of the tooling repo. A single key would mean a dataset-repo
compromise grants the attacker write access to nemar-cli CI and
vice versa. Two keys with identical policies still isolate the
blast radius.

All five users carry a permissions boundary that confines them to
the `nemar` bucket and the `upload-*` federated user pattern at
service-scope level. The boundary is a **service-scope ceiling, not
a read/write ceiling** — `nemar-hallu-readonly`'s read-only promise
is enforced by its inline policy, not by the boundary. The
boundary policy is documented in [appendix A](#appendix-a-permissions-boundary)
below.

---

### `nemar-worker-prod`

**Purpose.** The Cloudflare Worker (`nemar-api` on SCCN production)
calls AWS for:

- Generating presigned PUT URLs when users upload via
  `nemar dataset upload` (admin path).
- Generating presigned GET URLs for private-dataset file downloads
  (`data.nemar.org/<id>/<v>/<path>` for non-public datasets).
- Minting federated session tokens via `sts:GetFederationToken` so
  the user's local `git-annex` can talk to S3 directly during
  uploads (`nemar admin sandbox` flow).
- Updating the bucket policy when an admin publishes a dataset
  (`nemar admin make-public` flow uses `addPublicReadPolicy()` in
  `backend/src/services/s3.ts`, which GETs and PUTs the bucket
  policy — NOT per-object ACLs).
- Applying S3 Object Lock retention + legal hold when a DOI is
  minted (`nemar admin s3 lock` flow, `applyObjectLockBatch()`).
- Signed fallback for `getManifest()` / `loadSummary()` on private
  datasets per principle 2.

Public reads do NOT go through this user — they hit the bucket via
unsigned `https://nemar.s3.us-east-2.amazonaws.com/...` URLs per
principle 2.

**Where the key lives.**

- Workers secret `AWS_ACCESS_KEY_ID` on the SCCN `nemar-api` worker
  (set via `npx cfman wrangler --account sccn secret put
  AWS_ACCESS_KEY_ID -c backend/wrangler-sccn.toml --env=""`).
- Workers secret `AWS_SECRET_ACCESS_KEY` on the same worker.

**Inline policy.**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FederationTokenForUploadFlow",
      "Effect": "Allow",
      "Action": "sts:GetFederationToken",
      "Resource": "arn:aws:sts::191754232783:federated-user/upload-*"
    },
    {
      "Sid": "BucketLevel",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:CreateBucket"
      ],
      "Resource": "arn:aws:s3:::nemar"
    },
    {
      "Sid": "ObjectReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObjectLegalHold",
        "s3:PutObjectLegalHold",
        "s3:GetObjectRetention",
        "s3:PutObjectRetention"
      ],
      "Resource": "arn:aws:s3:::nemar/*"
    }
  ]
}
```

Notable choices:

- `s3:GetBucketPolicy` + `s3:PutBucketPolicy` are at bucket level
  (not object level) because `addPublicReadPolicy()` mutates the
  whole bucket policy in one call rather than per-object ACLs.
- `s3:PutObjectRetention` is required separately from
  `s3:PutObjectLegalHold`. The Object Lock flow uses both
  GOVERNANCE-mode retention (`PutObjectRetention`) and per-object
  legal holds (`PutObjectLegalHold`).
- `s3:PutObjectAcl` is intentionally absent. The codebase has zero
  call sites for it; making-public goes through the bucket policy.
- `s3:CreateBucket` is present at bucket level because git-annex's
  `initremote` calls `CreateBucket` even when the bucket exists.
  Scoped to `arn:aws:s3:::nemar` (the only bucket), so a federated
  session — or a leaked IAM user — cannot create new buckets.
  Returns 200 no-op against the existing bucket.

**Federation policy at session-mint time.** The federation policy
passed by the Worker (`generateUploadPolicy()` in
`backend/src/services/s3.ts`) further restricts the session to
`s3:PutObject`/`s3:AbortMultipartUpload` on
`arn:aws:s3:::nemar/<dataset_id>/objects/*`. AWS enforces the
intersection of the IAM user's policy and the session policy, so
the federated session is strictly bounded to the dataset the
caller authorized — even if the IAM user itself has broader
`s3:PutObject` rights.

**Rotation cadence.** Quarterly. Use both key slots; soak each new
key for 48 hours before deactivating the previous one.

---

### `nemar-worker-dev`

**Purpose.** Same operations as `nemar-worker-prod`, but for the
`nemar-api-dev` Worker. Restricted to sandbox (`xx*`), staging
(`staging/*`), and the disposable E2E test dataset (`nm099999/*`)
so that a destructive test run cannot touch live `nm*` or `on*`
data even via a Worker bug.

**Where the key lives.**

- Workers secret `AWS_ACCESS_KEY_ID` on the SCCN `nemar-api-dev`
  worker (set via `npx cfman wrangler --account sccn secret put
  AWS_ACCESS_KEY_ID -c backend/wrangler-sccn.toml --env dev`).
- Workers secret `AWS_SECRET_ACCESS_KEY` on the same worker.

**Inline policy.**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FederationTokenForUploadFlow",
      "Effect": "Allow",
      "Action": "sts:GetFederationToken",
      "Resource": "arn:aws:sts::191754232783:federated-user/upload-*"
    },
    {
      "Sid": "BucketLevelList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::nemar",
      "Condition": {
        "StringLikeIfExists": {
          "s3:prefix": [
            "xx*",
            "staging/*",
            "nm099999/*"
          ]
        }
      }
    },
    {
      "Sid": "BucketOps",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:CreateBucket",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy"
      ],
      "Resource": "arn:aws:s3:::nemar"
    },
    {
      "Sid": "ObjectReadWriteSandbox",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObjectLegalHold",
        "s3:PutObjectLegalHold",
        "s3:GetObjectRetention",
        "s3:PutObjectRetention"
      ],
      "Resource": [
        "arn:aws:s3:::nemar/xx*",
        "arn:aws:s3:::nemar/staging/*",
        "arn:aws:s3:::nemar/nm099999/*"
      ]
    }
  ]
}
```

Three notable choices specific to dev:

- The `BucketListWithOptionalPrefix` statement uses
  `StringLikeIfExists` rather than `StringLike`. `s3:HeadBucket`
  (which git-annex calls during `initremote`) maps to the
  `s3:ListBucket` action but sends NO `s3:prefix` context. With a
  plain `StringLike`, the condition would fail for HeadBucket, the
  statement wouldn't match, git-annex would assume the bucket
  doesn't exist, and would fall through to `s3:CreateBucket` —
  which returns `BucketAlreadyOwnedByYou` (409) and breaks the
  upload. `StringLikeIfExists` matches the condition only when
  the context key is present, so HeadBucket passes and prefix-
  scoped `s3:ListObjectsV2` still gets restricted.
- Bucket-level actions other than `s3:ListBucket` live in their
  own unconditioned statement (`BucketOps`). They don't accept a
  prefix context, so a conditional statement would be unmatchable.
- Object Lock actions and bucket policy actions are present
  because `nemar admin e2e-test` exercises all 10 publish pipeline
  steps (including the lock step and the make-public step) against
  `nm099999`.

**Rotation cadence.** Quarterly, same protocol as prod.

---

### `nemar-actions-datasets`

**Purpose.** GitHub Actions workflows running in the
`nemarDatasets` org that need S3 read/write. Consumers:

- `nemarDatasets/.github/.github/workflows/onboard-openneuro.yml`
  copies dataset blobs from OpenNeuro S3 into `nemar/` during
  dataset import.
- `nemarDatasets/.github/.github/workflows/generate-manifest.yml`
  writes `nemar/<id>/version/v<X.Y.Z>.json` and
  `nemar/<id>/version/v<X.Y.Z>-summary.json` after a publish.
- Per-dataset workflows shipped via `getWorkflowTemplates()` in
  `backend/src/services/github.ts`:
  - `pr-merge.yml` cleans up `nemar/staging/*` on PR close.
  - `generate-archive.yml` writes `nemar/<id>/archives/v<X.Y.Z>.zip`.

None of these workflows mint federated tokens, change bucket
policy, or touch Object Lock — those are strictly Worker concerns.

**Where the key lives.**

- `nemarDatasets` org-level secret `AWS_ACCESS_KEY_ID` (visibility:
  ALL repos) and `AWS_SECRET_ACCESS_KEY` (same visibility).

This key is visible to every dataset repo in the `nemarDatasets`
org. That's a wider trust surface than the nemar-cli CI key
(separate user below).

**Inline policy.**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BucketLevel",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::nemar"
    },
    {
      "Sid": "ObjectReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::nemar/*"
    }
  ]
}
```

Deliberate omissions vs. `nemar-worker-prod`:

- No `sts:GetFederationToken`. Workflows never federate.
- No `s3:GetBucketPolicy` / `s3:PutBucketPolicy`. The make-public
  flow runs through the Worker.
- No `s3:PutObjectLegalHold` / `s3:PutObjectRetention`. Object Lock
  is a Worker concern.

**Rotation cadence.** Quarterly.

---

### `nemar-actions-cli`

**Purpose.** GitHub Actions workflows running in `nemarOrg/nemar-cli`
that need S3 read/write. Consumer:

- `nemarOrg/nemar-cli/.github/workflows/test.yml` integration
  tests (`api-test`, `e2e-upload`, `e2e-sandbox`, `unit-test-all`)
  exercise upload/download paths against the dev backend. They
  read and write sandbox-prefix objects directly.

Identical policy to `nemar-actions-datasets`, but a **separate IAM
user** so the two trust boundaries are isolated:

- A dataset-repo compromise (someone gets repo write on any
  `nemarDatasets/nmXXXXXX` repo) leaks the `nemar-actions-datasets`
  key but cannot read or rotate the `nemar-actions-cli` key.
- A nemar-cli CI compromise (a malicious test PR exfiltrating
  secrets in a workflow run) leaks the `nemar-actions-cli` key
  but cannot read the `nemar-actions-datasets` key.

**Where the key lives.**

- `nemarOrg/nemar-cli` repo-level secret `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`.

**Inline policy.** Identical content to `nemar-actions-datasets`
above. See [appendix C](#appendix-c-shared-actions-policy) for
the canonical JSON used by both users.

**Rotation cadence.** Quarterly. Both action users are typically
rotated in the same maintenance window, but each retains its own
2-slot rotation independence so one can be rolled back without the
other.

---

### `nemar-hallu-readonly`

**Purpose.** The SDSC Hallu mirror server runs an hourly cron that
pulls every published dataset's S3 content into local Qumulo
storage. The cron does only `aws s3 sync` and `aws s3 cp` reads;
it never writes back to S3.

**Where the key lives.**

- `/home/<cron-user>/.aws/credentials` (mode `0600`) on the Hallu
  server. As of 2026-05-22 the cron runs as `yahya`, so the path
  is `/home/yahya/.aws/credentials`. If the cron user changes,
  the credentials must move with it.

The key is server-local because the cron runs on Hallu hardware,
not in a managed runtime that supports secrets injection. Per
principle 6, the credentials file MUST live in the cron user's
own home directory — never in `/data/qumulo/...` or any other
shared SDSC workspace, even if those paths are convenient for
the script.

If the cron script needs to read from a shared script path
(e.g., `/data/qumulo/openneuro/nemar-cli/scripts/hallu-sync.sh`)
and shell into the AWS CLI, AWS automatically resolves
`~/.aws/credentials` for the user the script runs as. No
shared-path credential file is needed.

**Inline policy.**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BucketReadOnly",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:GetObjectLegalHold",
        "s3:GetObjectRetention",
        "s3:HeadObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::nemar",
        "arn:aws:s3:::nemar/*"
      ]
    }
  ]
}
```

`s3:GetObjectLegalHold` and `s3:GetObjectRetention` are included so
the sync script can read the lock status of objects without
needing a separate IAM update if a future feature inspects lock
state. They are inert read-only — including them costs nothing.

Strictly read-only otherwise. No `PutObject`, no `DeleteObject`,
no bucket policy actions. A leak of this key cannot cause data
loss; the operator-side enforcement (no write actions in the
inline policy) is what guarantees this, NOT the permissions
boundary (see Appendix A note).

**Rotation cadence.** Yearly is sufficient given the read-only
scope. Rotate immediately on any sign of compromise.

---

## Appendix A: Permissions boundary

All five IAM users should carry the following customer-managed
permissions boundary policy (call it `nemar-bucket-boundary`).
A permissions boundary is a ceiling — even if a future inline
policy expands beyond it, AWS denies the excess.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BoundaryAllowS3OnNemar",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::nemar",
        "arn:aws:s3:::nemar/*"
      ]
    },
    {
      "Sid": "BoundaryAllowSTSForUploadFederation",
      "Effect": "Allow",
      "Action": "sts:GetFederationToken",
      "Resource": "arn:aws:sts::191754232783:federated-user/upload-*"
    }
  ]
}
```

This boundary lets each user have a tighter inline policy (the
actual operations they need) while guaranteeing that even a
misconfigured inline policy cannot escape the `nemar` bucket or
mint anything beyond `upload-*` federated tokens.

**What the boundary does NOT enforce.** The boundary is a
service-scope ceiling — it confines users to S3 on the nemar
bucket + scoped STS. It does NOT enforce read-vs-write at the
object level. That means:

- `nemar-hallu-readonly`'s read-only guarantee comes from its
  inline policy, not the boundary. If a future change accidentally
  adds `s3:DeleteObject` to its inline policy, the boundary will
  allow it (since `s3:*` is the boundary's S3 reach).
- Auditing `nemar-hallu-readonly`'s actual write-immunity means
  auditing the inline policy, not just verifying boundary
  attachment.

If stronger write-tier enforcement is needed, add a permissions
boundary specifically for read-only users that omits write actions
(e.g., `nemar-readonly-boundary` with `s3:Get*` + `s3:List*` only,
no `s3:Put*` / `s3:Delete*`). Out of scope for the current
revision; track as a follow-up.

---

## Appendix B: Provisioning checklist

For each of the five users, when first creating them (or
re-creating after a security incident):

- [ ] IAM → Users → Create user → name from the catalog above
- [ ] Skip console access (programmatic only)
- [ ] Verify no console password exists:
      `aws iam get-login-profile --user-name <name>` should return
      `NoSuchEntity` (a successful response means the user can sign in
      to the AWS console, which violates the programmatic-only rule)
- [ ] Tag the user with `purpose=<short tag>` and
      `rotation-due=<YYYY-MM-DD>` for audit
- [ ] Attach the `nemar-bucket-boundary` permissions boundary BEFORE
      the inline policy (the boundary attachment is a separate API
      call; if you reverse the order, there is a brief window where
      the user has the inline-policy reach without the ceiling)
- [ ] Attach the inline policy from this document (don't paraphrase
      — copy the JSON exactly so future audits can grep for the Sid
      strings)
- [ ] Create one access key (slot 1)
- [ ] Save the access key + secret key to the destination's secret
      store immediately (Workers secret, GH secret, server file)
- [ ] Verify the destination uses it: hit a known endpoint and
      confirm a successful operation appears in CloudTrail for that
      access key ID
- [ ] Record the key ID (not the secret) in the team's secret
      registry along with the destination and the rotation due date
