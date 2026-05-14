# admin

Administrative operations (requires admin privileges)

## Usage

```bash
Usage: nemar admin [options] [command]

Admin commands (requires admin privileges)

Options:
  -h, --help                               display help for command

Commands:
  users [options]                          List NEMAR users
  approve [options] <username>             Approve a pending user
  revoke [options] <username>              Revoke user access
  role [options] <username> <role>         Change a user's role (owner only)
  s3                                       S3 and IAM credential management
  repo                                     Repository visibility management
  ci                                       CI workflow management
  doi                                      DOI management
  publish                                  Publication workflow management
  revert [options] <dataset-id> [version]  Revert a dataset to a previous version (creates PR for review)
  make-public <dataset-id>                 Publish a dataset (make repository and data public) - PERMANENT
  delete-dataset [options] <dataset-id>    Delete a dataset and all associated resources (GitHub, S3, D1)
  e2e-test [options]                       Run end-to-end test against nm099999 (admin only)
  help [command]                           display help for command

Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users          - List users and their status
  approve        - Approve a pending user registration
  revoke         - Revoke user access
  role           - Change a user's role (owner only: owner > admin > member)

Dataset Management:
  repo            - Manage repository visibility (public/private)
  ci              - Manage CI workflows (check status, deploy)
  s3              - S3/IAM credential management
  doi             - Create and manage DOIs for datasets
  publish         - Publication workflow management
  revert          - Revert dataset to previous version (via PR)
  make-public     - Publish a dataset (permanent, irreversible)
  delete-dataset  - Delete a dataset and all associated resources

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin users --role admin         # List all admins
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin role john_doe admin        # Promote user to admin (owner only)
  $ nemar admin repo public nm000104       # Make dataset repo public
  $ nemar admin ci check nm000104          # Check CI status
  $ nemar admin s3 regenerate-iam john_doe # Regenerate AWS credentials
  $ nemar admin doi create nm000104        # Create concept DOI
```

## Subcommands

### admin users

```bash
Usage: nemar admin users [options]

List NEMAR users

Options:
  --pending      Show only pending approval
  --verified     Show only verified (awaiting approval)
  --approved     Show only approved users
  --revoked      Show only revoked users
  --role <role>  Filter by role: owner, admin, or member
  -h, --help     display help for command

Examples:
  $ nemar admin users                    # List all users
  $ nemar admin users --verified         # Users awaiting approval
  $ nemar admin users --role admin       # List all admins
  $ nemar admin users --role owner       # List all owners
  $ nemar admin users --approved --role member  # Approved regular users
```

### admin approve

```bash
Usage: nemar admin approve [options] <username>

Approve a pending user

Arguments:
  username    Username to approve

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin revoke

```bash
Usage: nemar admin revoke [options] <username>

Revoke user access

Arguments:
  username    Username to revoke

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin role

```bash
Usage: nemar admin role [options] <username> <role>

Change a user's role (owner only)

Arguments:
  username    Username to change role for
  role        New role: owner, admin, or member

Options:
  -y, --yes   Skip confirmation prompt
  -h, --help  display help for command

Permission Model:
  owner  - Full access: can manage users, roles, datasets, DOIs, and system settings
  admin  - Can approve/revoke users, manage datasets and DOIs
  member - Can upload and manage their own datasets only

Rules:
  - Only owners can change roles
  - You cannot change your own role (prevents self-lockout)
  - The last owner cannot be demoted (prevents total lockout)
  - Demoting a user revokes their tokens (they must re-login)

Examples:
  $ nemar admin role john_doe admin        # Promote to admin
  $ nemar admin role john_doe member       # Demote to member
  $ nemar admin role jane_doe owner -y     # Promote to owner (skip confirm)
```

### admin s3 regenerate-iam

```bash
Usage: nemar admin s3 regenerate-iam [options] <username>

Regenerate AWS IAM credentials for a user

Arguments:
  username    Username to regenerate credentials for

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin s3 lock

```bash
Usage: nemar admin s3 lock [options] <dataset-id>

Apply S3 Object Lock (Governance mode) to a dataset

Arguments:
  dataset-id  Dataset ID to lock

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin repo public

```bash
Usage: nemar admin repo public [options] <dataset-id>

Make a dataset repository public

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin repo private

```bash
Usage: nemar admin repo private [options] <dataset-id>

Make a dataset repository private

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin ci check

```bash
Usage: nemar admin ci check [options] <dataset-id>

Check CI workflow status for a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command
```

### admin ci add

```bash
Usage: nemar admin ci add [options] <dataset-id>

Deploy CI workflows to a dataset repository

Arguments:
  dataset-id      Dataset ID (e.g., nm000104)

Options:
  -y, --yes       Skip confirmation and proceed
  -n, --no        Skip confirmation and decline
  --no-validate   Skip post-deploy workflow parseability validation
  -h, --help      display help for command

Description:
  After committing the workflow files to the dataset repository, the
  backend lists the repo's parsed workflows via the GitHub Actions API
  and reports any workflow that failed to parse as a `validation_warning`.
  The CLI prints these warnings inline after deploy.

  For fleet deploys (running `ci add` across many datasets in a loop),
  pass `--no-validate` to skip the 2-3 second listing delay per dataset.
  Workflow parseability is also caught at PR time by the YAML validation
  test in this repo.
```

### admin doi create

```bash
Usage: nemar admin doi create [options] <dataset-id>

Create concept DOI for a dataset

Arguments:
  dataset-id             Dataset ID (e.g., nm000104)

Options:
  --title <title>        DOI title (defaults to dataset name)
  --description <desc>   DOI description
  --provider <provider>  DOI provider: ezid (default) or zenodo (default:
                         "ezid")
  --sandbox              Use sandbox/test DOI
  -y, --yes              Skip confirmation and proceed
  -n, --no               Skip confirmation and decline
  -h, --help             display help for command
```

### admin doi info

```bash
Usage: nemar admin doi info [options] <dataset-id>

Get DOI info for a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command
```

### admin doi update

```bash
Usage: nemar admin doi update [options] <dataset-id>

Update EZID DOI metadata or status

Arguments:
  dataset-id     Dataset ID (e.g., nm000104)

Options:
  --make-public  Transition DOI from reserved to public (permanent)
  --refresh      Refresh metadata from dataset_description.json and
                 .nemar/metadata.json
  -y, --yes      Skip confirmation and proceed
  -n, --no       Skip confirmation and decline
  -h, --help     display help for command
```

### admin doi enrich

```bash
Usage: nemar admin doi enrich [options] <dataset-id>

Enrich DOI metadata with ORCIDs, descriptions, funding, and more

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  --no-llm    Skip LLM-based enrichment from README
  --sandbox   Use sandbox DOI
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin publish list

```bash
Usage: nemar admin publish list [options]

List publication requests

Options:
  -s, --status <status>  Filter by status (requested, approving, published,
                         denied)
  -h, --help             display help for command

Description:
  List all publication requests from users, with optional filtering by status.
  Shows dataset ID, status, requesting user, and current progress.

Filter Options:
  requested  - Pending requests awaiting admin action
  approving  - Currently being processed by orchestrator
  published  - Successfully published datasets
  denied     - Denied requests with reasons

Examples:
  $ nemar admin publish list                # All requests
  $ nemar admin publish list --status requested   # Pending only
  $ nemar admin publish list --status approving   # In progress
  $ nemar admin publish list --status denied      # View denied
```

### admin publish approve

```bash
Usage: nemar admin publish approve [options] <dataset-id>

Approve and publish a dataset (runs orchestrator)

Arguments:
  dataset-id       Dataset ID

Options:
  --resume         Resume from last failed step
  --sandbox        Use Zenodo sandbox for testing
  --skip-ci-check  Skip BIDS validation CI check (admin override)
  -y, --yes        Skip confirmation and proceed
  -n, --no         Skip confirmation and decline
  -h, --help       display help for command

Description:
  Approve a publication request and run the automated 15-step orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps:
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Enrichment Check  - Verify metadata pipeline has run (warn-only, non-blocking)
   3. Make Public       - Change GitHub repository visibility to public
   4. S3 Public Read    - Grant public read access to S3 data
   5. Tag Protection    - Enable tag protection rules
   6. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   7. Update Metadata   - Update dataset metadata from BIDS description
   8. Update README     - Add DOI badge and citation info to README
   9. Create Tag        - Create version tag (e.g., v1.0.0)
  10. Create Release    - Create GitHub release from tag
  11. Upload to Zenodo  - Upload dataset archive to Zenodo (if Zenodo provider)
  12. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  13. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  14. Generate Archive  - Create downloadable zip archive
  15. Notify User       - Send publication confirmation email

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm000104                    # Run full orchestrator
  $ nemar admin publish approve nm000104 --resume           # Resume from failed step
  $ nemar admin publish approve nm000104 --skip-ci-check    # Override BIDS validation
  $ nemar admin publish approve nm000104 --yes              # Skip confirmation

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock
```

### admin publish deny

```bash
Usage: nemar admin publish deny [options] <dataset-id>

Deny a publication request

Arguments:
  dataset-id             Dataset ID

Options:
  -r, --reason <reason>  Reason for denial
  -y, --yes              Skip confirmation and proceed
  -n, --no               Skip confirmation and decline
  -h, --help             display help for command

Description:
  Deny a user's publication request with a specific reason.
  The user will receive an email notification with your reason.

  A clear, actionable reason helps users understand what to fix
  before resubmitting their publication request.

Requirements:
  - Must provide a reason for denial
  - Reason will be sent to the user via email
  - User can fix issues and submit a new request

Examples:
  $ nemar admin publish deny nm000104 --reason "BIDS validation failing"
  $ nemar admin publish deny nm000104 -r "Dataset incomplete - missing subjects"
  $ nemar admin publish deny nm000104    # Prompts for reason interactively
```

### admin revert

```bash
Usage: nemar admin revert [options] <dataset-id> [version]

Revert a dataset to a previous version (creates PR for review)

Arguments:
  dataset-id       Dataset ID (e.g., nm000104)
  version          Target version to revert to (e.g., 1.0.0)

Options:
  --list           List available versions without reverting
  --force          Direct push to main without PR (emergency only)
  --message <msg>  Custom revert commit message
  --dir <path>     Use existing local clone instead of cloning fresh
  -y, --yes        Skip confirmation and proceed
  -n, --no         Skip confirmation and decline
  -h, --help       display help for command
```

### admin make-public

```bash
Usage: nemar admin make-public [options] <dataset-id>

Publish a dataset (make repository and data public) - PERMANENT

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Publish a dataset by making both the GitHub repository and S3 data publicly accessible.

  WARNING: This operation is PERMANENT and IRREVERSIBLE

  Once published:
  - GitHub repository will be publicly visible
  - S3 data files will be publicly downloadable
  - git-annex will use public URLs for downloads

  Publishing cannot be undone because:
  - Data may be cached, indexed, or linked externally
  - Unpublishing would create broken links
  - Aligns with DOI permanence principles

  Use this when:
  - Dataset has been reviewed and validated
  - Ready for public release and citation
  - Associated with a DOI (concept or version)

Requirements:
  - Dataset must not be a sandbox dataset
  - Dataset must have a GitHub repository
  - Must be dataset owner or admin

Examples:
  $ nemar admin make-public nm000104

  This will prompt for confirmation by requiring you to type
  the dataset ID to confirm the permanent action.

```

### admin delete-dataset

```bash
Usage: nemar admin delete-dataset [options] <dataset-id>

Delete a dataset and all associated resources (GitHub, S3, D1)

Arguments:
  dataset-id  Dataset ID (e.g., nm000108)

Options:
  --force     Force deletion of published datasets with DOIs (owner only)
  -h, --help  display help for command
```

### admin notify

```bash
Usage: nemar admin notify [options]

Send a broadcast or per-user transactional email

Options:
  --to <group>          Broadcast group: all | admins | members
  --user <username>     Send to exactly one user (mutually exclusive with --to)
  --subject <text>      Email subject (required)
  --body <text>         Email body (markdown; mutually exclusive with --body-file)
  --body-file <path>    Read email body from file
  --dry-run             Preview recipients without sending
  -h, --help            display help for command

Description:
  Send admin announcements to a group or a single user. Exactly one of
  --to (broadcast) or --user (per-user transactional) must be supplied.

  Per-user sends ignore the recipient's announcements email preference
  because they represent direct admin contact, not a broadcast. All sends
  record an audit-log row; per-user sends record the recipient as
  `user:<username>` so the audit trail distinguishes them from broadcasts.

Examples:
  $ nemar admin notify --to all --subject "v0.8.14 released" --body-file ./notes.md
  $ nemar admin notify --to admins --subject "Stuck publication" --body "..."
  $ nemar admin notify --user AlexWoods --subject "Sandbox fix" --body-file ./alex.md
  $ nemar admin notify --user AlexWoods --subject "Ping" --body "..." --dry-run
```

### admin sync

```bash
Usage: nemar admin sync <subcommand>

Manage nemar.org dataset metadata sync

Subcommands:
  run [dataset-id]    Sync one dataset (or all published if omitted)
  status              Show sync status across all published datasets

Description:
  The backend mirrors dataset metadata to the nemar.org data explorer
  across four tables: dataexplorer_dataset, dataexplorer_extra_dataset,
  dataexplorer_dataset_channel_count, dataexplorer_supplementary_dataset.

  Sync runs automatically on publication approval and on version-DOI
  publish. Use `sync run` to force-refresh after manual fixes or to
  recover from a failed sync. `sync status` reports the last sync time
  and any persisted failure reason per dataset.

Examples:
  $ nemar admin sync run nm000132    # Sync one dataset
  $ nemar admin sync run             # Sync all eligible
  $ nemar admin sync status
```

### admin reindex

```bash
Usage: nemar admin reindex [options] [dataset-id]

Refresh enrichment, nemar.org sync, and D1 metadata columns

Arguments:
  dataset-id                      Dataset ID (optional with bulk flags below)

Options:
  --all                           Reindex every published dataset
  --missing-metadata              Reindex only datasets missing populated metadata columns
  --stale [--older-than <days>]   Reindex datasets whose enrichment is older than N days
  -h, --help                      display help for command

Description:
  Full reindex pipeline: re-runs the enrichment stages (seed -> enrich ->
  validate) on .nemar/metadata.json, refreshes nemar.org via the sync
  service, and updates the D1 metadata columns the catalog reads from.

  Bulk modes process datasets serially with backend-side rate limiting,
  so it is safe to run on weekends or off-peak.

Examples:
  $ nemar admin reindex nm000132
  $ nemar admin reindex --all
  $ nemar admin reindex --missing-metadata
  $ nemar admin reindex --stale --older-than 30
```

### admin email-preferences

```bash
Usage: nemar admin email-preferences <subcommand>

Manage a user's email notification preferences (admin override)

Subcommands:
  show <username>                  Display current preferences
  update <username> [options]      Change one or more preferences

Description:
  Admin override for user-level email preferences. Normal users manage
  their own via the web UI; this command is for support cases where a
  user is locked out or needs an account-level change applied.

Examples:
  $ nemar admin email-preferences show alex
  $ nemar admin email-preferences update alex --announcements off
```

