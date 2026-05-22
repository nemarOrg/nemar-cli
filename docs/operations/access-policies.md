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
`getManifest()` and `loadSummary()` after the 2026-05-22 incident.
The same pattern must be used by every new public-serving code path.

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

### 5. No long-lived keys in `~/.aws/credentials`

For personal CLI work (administrators running `nemar admin ...`,
ad-hoc S3 operations, the `nemar-tools/credentials.sh` publishing
flow), use AWS SSO or `aws-vault` to mint short-lived credentials
on demand. Do not commit a long-lived `AKIA*` access key to your
local `~/.aws/credentials` plaintext.

**Why.** Any file under your home directory is exposed to every
process you run, every shell extension you install, every editor
plugin with filesystem access. The 2026-05-22 quarantine fired
because a long-lived key reached a place AWS scanned. SSO sessions
expire automatically; even if they leak, the blast radius is
hours, not the lifetime of the key.

**Not okay.** Hardcoding access keys in `nemar-tools/credentials.sh`
or any shell config. Sharing access keys between your personal AWS
CLI sessions and any service runtime.

---

## IAM user catalog

Four scoped IAM users in AWS account `191754232783`, replacing the
previous single-admin pattern. Each section lists the user's
purpose, where its access key is deployed, and the inline policy
JSON to attach.

| User | Where the key lives | Scope summary |
|---|---|---|
| `nemar-worker-prod` | Workers secret on SCCN `nemar-api` | Full S3 R/W on `nemar/*` + `sts:GetFederationToken` |
| `nemar-worker-dev` | Workers secret on SCCN `nemar-api-dev` | Same scope, restricted to sandbox + staging keys |
| `nemar-actions` | `nemarDatasets` org secret + `nemarOrg/nemar-cli` repo secret | S3 R/W on `nemar/*` only (no STS) |
| `nemar-hallu-readonly` | SDSC Hallu server local config | S3 ReadOnly on `nemar/*` only |

All four users carry a permissions boundary that denies `iam:*`,
`organizations:*`, and `account:*` so a future policy change cannot
escalate beyond bucket scope. The boundary policy is documented in
[appendix A](#appendix-a-permissions-boundary) below.

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
- Setting per-object public-read ACLs when an admin publishes a
  dataset (`nemar admin make-public` flow).
- Setting S3 Object Lock when a dataset's DOI is minted
  (`nemar admin s3 lock`).
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
        "s3:GetBucketLocation"
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
        "s3:PutObjectAcl",
        "s3:DeleteObject",
        "s3:GetObjectLegalHold",
        "s3:PutObjectLegalHold"
      ],
      "Resource": "arn:aws:s3:::nemar/*"
    }
  ]
}
```

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
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::nemar",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "xx*",
            "staging/*",
            "nm099999/*"
          ]
        }
      }
    },
    {
      "Sid": "ObjectReadWriteSandbox",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:HeadObject",
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:DeleteObject"
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

**Rotation cadence.** Quarterly, same protocol as prod.

---

### `nemar-actions`

**Purpose.** GitHub Actions workflows that need to read or write
S3. There are three consumers:

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
- `nemarOrg/nemar-cli/.github/workflows/test.yml` integration
  tests exercise the upload path against the dev backend.

None of these workflows mint federated tokens — that's strictly a
Worker concern. So this user has **no STS permission at all**.

**Where the key lives.**

- `nemarDatasets` org-level secret `AWS_ACCESS_KEY_ID` (visibility:
  ALL repos) and `AWS_SECRET_ACCESS_KEY` (same visibility).
- `nemarOrg/nemar-cli` repo-level secret `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`.

The same key value lives in both locations because both run the
same kind of workload (read/write S3, no federation). If the
workloads diverge later, split into two users.

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

Note the deliberate omissions vs. `nemar-worker-prod`:

- No `sts:GetFederationToken`. Workflows never federate.
- No `s3:PutObjectAcl`. Workflows don't change object visibility;
  the make-public flow runs through the Worker.
- No `s3:PutObjectLegalHold`. Object Lock is a Worker concern.

**Rotation cadence.** Quarterly. Both the org-level secret and the
nemar-cli repo secret are updated in the same maintenance window.

---

### `nemar-hallu-readonly`

**Purpose.** The SDSC Hallu mirror server runs an hourly cron that
pulls every published dataset's S3 content into local Qumulo
storage. The cron does only `aws s3 sync` and `aws s3 cp` reads;
it never writes back to S3.

**Where the key lives.**

- `/data/qumulo/openneuro/nemar-cli/.aws/credentials` on the Hallu
  server (or wherever the cron's `AWS_PROFILE` resolves).

The key is server-local because the cron runs on Hallu hardware,
not in a managed runtime that supports secrets injection.

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

Strictly read-only. No `PutObject`, no `DeleteObject`. A leak of
this key cannot cause data loss.

**Rotation cadence.** Yearly is sufficient given the read-only
scope. Rotate immediately on any sign of compromise.

---

## Appendix A: Permissions boundary

All four IAM users should carry the following customer-managed
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

---

## Appendix B: Provisioning checklist

For each of the four users, when first creating them (or
re-creating after a security incident):

- [ ] IAM → Users → Create user → name from the catalog above
- [ ] Skip console access (programmatic only)
- [ ] Attach the inline policy from this document (don't paraphrase
      — copy the JSON exactly so future audits can grep for the Sid
      strings)
- [ ] Attach the `nemar-bucket-boundary` permissions boundary
- [ ] Create one access key (slot 1)
- [ ] Save the access key + secret key to the destination's secret
      store immediately (Workers secret, GH secret, server file)
- [ ] Verify the destination uses it: hit a known endpoint and
      confirm a successful operation appears in CloudTrail for that
      access key ID
- [ ] Record the key ID (not the secret) in the team's secret
      registry along with the destination and the rotation due date
