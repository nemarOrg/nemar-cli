# dataset

Dataset management operations

## Usage

```bash
Usage: nemar dataset [options] [command]

Dataset management

Options:
  -h, --help                            display help for command

Commands:
  validate [options] [path]             Validate a BIDS dataset using the
                                        official BIDS validator (requires Deno)
  upload [options] <path>               Upload a BIDS dataset to NEMAR
  download [options] <dataset-id>       Download a dataset from NEMAR
  status [options] <dataset-id>         Check status of a dataset
  list [options]                        List publicly available datasets on
                                        NEMAR
  release [options] <dataset-id>        Create a version bump PR for a dataset
  update [options] [path]               Push local changes to a dataset via PR
  request-access <dataset-id>           Request collaborator access to a
                                        dataset
  invite <username> <dataset-id>        Invite a user as collaborator to your
                                        dataset
  collaborators [options] <dataset-id>  List collaborators for a dataset
  publish                               Publication workflow management
  clone [options] <dataset-id>          Clone a dataset from NEMAR
  get [options] [files...]              Download annexed data files for the
                                        current dataset
  save [options]                        Stage and commit changes in the current
                                        dataset
  push [options]                        Push commits and data to remotes
  drop [files...]                       Free local copies of annexed files
                                        (keeps remote copies)
  ci [dataset-id]                       Check BIDS validation CI status for the
                                        current dataset
  manifest [options] [version]          View version manifests for a dataset
  help [command]                        display help for command

Description:
  Manage BIDS datasets on NEMAR. Upload, download, validate, and version
  neurophysiology datasets in Brain Imaging Data Structure (BIDS) format.

Prerequisites:
  - git-annex (for upload/download)
  - Deno runtime (for BIDS validation)
  - NEMAR account (for upload)

Examples:
  $ nemar dataset validate ./my-dataset          # Validate locally
  $ nemar dataset upload ./my-dataset            # Upload to NEMAR
  $ nemar dataset download nm000104              # Download a dataset
  $ nemar dataset list --mine                    # List your datasets
  $ nemar dataset status nm000104                # Check dataset status
  $ nemar dataset request-access nm000104        # Request collaborator access
  $ nemar dataset invite johndoe nm000104        # Invite user as collaborator

Learn More:
  https://nemar-cli.pages.dev/commands/dataset/
```

## Subcommands

### dataset validate

```bash
Usage: nemar dataset validate [options] [path]

Validate a BIDS dataset using the official BIDS validator (requires Deno)

Arguments:
  path                 Path to BIDS dataset directory (default: ".")

Options:
  --ignore-warnings    Only report errors, not warnings
  -c, --config <file>  Validation config file (.bidsvalidatorrc)
  -r, --recursive      Validate derivatives subdirectories
  --prune              Skip sourcedata and derivatives for faster validation
  -v, --verbose        Show verbose output
  --json               Output results as JSON (for scripting)
  --version-info       Show BIDS validator version info
  --update             Force update the BIDS validator to the latest version
  -h, --help           display help for command

  Extra flags after known options are passed through to the BIDS validator.
  See all validator flags: deno run jsr:@bids/validator --help

  Examples:
    $ nemar dataset validate                            # Validate current directory
    $ nemar dataset validate ./ds --prune               # Skip derivatives
    $ nemar dataset validate ./ds --json > out.json     # JSON for scripting
    $ nemar dataset validate ./ds --ignoreNiftiHeaders  # Pass-through flag
    $ nemar dataset validate ./ds --max-rows 0           # Headers only
```

### dataset upload

```bash
Usage: nemar dataset upload [options] <path>

Upload a BIDS dataset to NEMAR

Arguments:
  path                      Path to BIDS dataset directory

Options:
  -n, --name <name>         Dataset name (defaults to BIDS Name, then directory
                            name)
  -d, --description <desc>  Dataset description
  --skip-validation         Skip BIDS validation (not recommended)
  --skip-orcid              Skip co-author ORCID collection
  --dry-run                 Show what would be uploaded without doing it
  -j, --jobs <number>       Parallel upload streams (default: 4) (default: "4")
  -y, --yes                 Skip confirmation and proceed
  --restart                 Clear upload progress and re-upload all files
  --no                      Skip confirmation and decline
  -h, --help                display help for command

Description:
  Upload a BIDS dataset to NEMAR. The dataset will be validated, assigned
  a unique ID (nm000XXX), and stored on GitHub (metadata) and S3 (data files).

Requirements:
  - NEMAR account (nemar auth login)
  - git-annex installed
  - GitHub SSH access configured

Process:
  1. Validates BIDS format (unless --skip-validation)
  2. Creates GitHub repository for metadata
  3. Uploads large files to S3 in parallel
  4. Enables PR-based versioning workflow

Examples:
  $ nemar dataset upload ./my-eeg-dataset
  $ nemar dataset upload ./ds -n "My EEG Study" -d "64-channel EEG data"
  $ nemar dataset upload ./ds --dry-run        # Preview without uploading
  $ nemar dataset upload ./ds -j 16            # More parallel streams
```

### dataset download

```bash
Usage: nemar dataset download [options] <dataset-id>

Download a dataset from NEMAR

Arguments:
  dataset-id           Dataset ID (e.g., nm000104)

Options:
  -o, --output <path>  Output directory (default: ./<dataset-id>)
  -j, --jobs <number>  Parallel download streams (default: 4) (default: "4")
  --no-data            Download metadata only (skip large data files)
  -h, --help           display help for command

Description:
  Download a BIDS dataset from NEMAR. Uses git-annex for efficient
  data transfer with parallel streams.

  Private datasets require authentication (nemar auth login) and can
  only be downloaded by the owner or designated collaborators.
  After publishing, datasets become publicly available.

Requirements:
  - git-annex installed
  - NEMAR account (for private datasets)

Examples:
  $ nemar dataset download nm000104              # Download to ./nm000104
  $ nemar dataset download nm000104 -o ./data    # Custom output directory
  $ nemar dataset download nm000104 --no-data    # Metadata only (fast)
  $ nemar dataset download nm000104 -j 8         # More parallel streams
```

### dataset status

```bash
Usage: nemar dataset status [options] <dataset-id>

Check status of a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  --json      Output as JSON for scripting
  -h, --help  display help for command

Description:
  Show detailed information about a NEMAR dataset including owner,
  creation date, GitHub repository, and DOI information.

Examples:
  $ nemar dataset status nm000104
  $ nemar dataset status nm000104 --json | jq '.concept_doi'
```

### dataset list

```bash
Usage: nemar dataset list [options]

List publicly available datasets on NEMAR

Options:
  --mine       List only your datasets (both private and public)
  --json       Output as JSON for scripting
  --limit <n>  Limit number of results (default: 50) (default: "50")
  -h, --help   display help for command

Description:
  By default, lists only PUBLIC datasets on NEMAR that anyone can access.

  To see your own datasets (including private ones), use the --mine flag.
  This requires authentication.

Visibility Rules:
  Without --mine:
    - Shows only public datasets (visible to everyone)
    - Does not show private datasets, even your own
    - Exception: Admins see ALL datasets for oversight

  With --mine:
    - Shows all YOUR datasets (both private and public)
    - Requires authentication (nemar auth login)

Examples:
  $ nemar dataset list                   # List public datasets only
  $ nemar dataset list --mine            # List YOUR datasets (private + public)
  $ nemar dataset list --json            # JSON output for scripting
  $ nemar dataset list --limit 10        # Show only 10 datasets
```

### dataset release

```bash
Usage: nemar dataset release [options] <dataset-id>

Create a version bump PR for a dataset

Arguments:
  dataset-id           Dataset ID (e.g., nm000104)

Options:
  --type <type>        Bump type: patch, minor, or major
  --version <version>  Explicit version (e.g., 2.0.0)
  --dir <path>         Use existing local clone instead of cloning
  --monitor            Watch CI checks and offer to merge
  -y, --yes            Skip confirmation and proceed
  -h, --help           display help for command

Description:
  Create a pull request that bumps the dataset version in
  dataset_description.json. The PR triggers CI checks (BIDS validation,
  version check). On merge, GitHub Actions tags the release and
  publishes a version DOI (if a concept DOI exists).

Examples:
  $ nemar dataset release nm000104 --type patch
  $ nemar dataset release nm000104 --version 2.0.0
  $ nemar dataset release nm000104                   # interactive prompt
```

### dataset update

```bash
Usage: nemar dataset update [options] [path]

Push local changes to a dataset via PR

Arguments:
  path                 Path to local dataset clone (default: current directory)

Options:
  --bump <type>        Version bump type: patch, minor, or major (default:
                       "patch")
  --branch <name>      Custom branch name
  -m, --message <msg>  Commit message
  --monitor            Watch CI checks and offer to merge
  -y, --yes            Skip confirmation and proceed
  -h, --help           display help for command

Description:
  Push local changes (metadata or data files) to a dataset via a pull
  request. Automatically bumps the version, commits, pushes, and creates
  a PR. For data files (annexed), copies them to S3 via git-annex.

  Run this from inside a dataset clone, or pass the path as an argument.

Examples:
  $ cd nm000104 && nemar dataset update
  $ nemar dataset update ./nm000104 --bump minor -m "Add new subjects"
  $ nemar dataset update --branch fix/metadata -m "Fix participant ages"
```

### dataset request-access

```bash
Usage: nemar dataset request-access [options] <dataset-id>

Request collaborator access to a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Request access to a NEMAR dataset to push data via git-annex.
  Access is automatically granted for public repositories.

  For metadata-only changes, you can fork and submit a PR without
  requesting access.

Requirements:
  - NEMAR account (nemar auth login)
  - Approved user status

Examples:
  $ nemar dataset request-access nm000104
```

### dataset invite

```bash
Usage: nemar dataset invite [options] <username> <dataset-id>

Invite a user as collaborator to your dataset

Arguments:
  username    Username to invite
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Invite a NEMAR user as a collaborator to your dataset.
  Only dataset owners and admins can invite collaborators.

  Works for both public and private repositories.

Requirements:
  - NEMAR account (nemar auth login)
  - Dataset ownership or admin status

Examples:
  $ nemar dataset invite johndoe nm000104
```

### dataset collaborators

```bash
Usage: nemar dataset collaborators [options] <dataset-id>

List collaborators for a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  --json      Output as JSON for scripting
  -h, --help  display help for command

Description:
  List all collaborators who have access to a dataset.
  Only dataset owners and admins can view collaborators.

Examples:
  $ nemar dataset collaborators nm000104
  $ nemar dataset collaborators nm000104 --json
```

### dataset publish request

```bash
Usage: nemar dataset publish request [options] <dataset-id>

Request publication of a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Submit a publication request to make your private dataset publicly accessible.
  NEMAR admins will be notified and can approve or deny your request.

  Once approved, your dataset will:
  - Become publicly visible on GitHub
  - Receive a permanent DOI via Zenodo
  - Have tag protection enabled (prevents version manipulation)
  - Have S3 Object Lock enabled (prevents data deletion)

  You can only have one active publication request per dataset.

Status Flow:
  requested → approving → published (or denied)

Examples:
  $ nemar dataset publish request nm000104
  $ nemar dataset publish status nm000104     # Check request status
```

### dataset publish status

```bash
Usage: nemar dataset publish status [options] <dataset-id>

Check publication status of a dataset

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Check the status of your publication request and see progress through
  the approval workflow.

Possible Statuses:
  requested  - Waiting for admin review
  approving  - Admin is running the publication process
  published  - Dataset is now public with DOI
  denied     - Request was denied (includes reason)

Steps in Approval Process:
   1. CI check          - Verify BIDS validation passes
   2. Make public       - Change repository visibility
   3. S3 public read    - Grant public read access to S3 data
   4. Tag protection    - Prevent version manipulation
   5. Create DOI        - Create concept DOI (EZID/Zenodo)
   6. Update metadata   - Update from BIDS description
   7. Update README     - Add DOI badge and citation
   8. Create tag        - Create version tag
   9. Create release    - Create GitHub release
  10. Upload to Zenodo  - Upload archive (if Zenodo provider)
  11. Publish DOI       - Make DOI public (permanent)
  12. S3 lock           - Enable Object Lock for data preservation
  13. Generate archive  - Create downloadable zip
  14. Notify user       - Send publication confirmation email

Examples:
  $ nemar dataset publish status nm000104
```

### dataset publish resend

```bash
Usage: nemar dataset publish resend [options] <dataset-id>

Resend publication request notification to admins

Arguments:
  dataset-id  Dataset ID (e.g., nm000104)

Options:
  -h, --help  display help for command

Description:
  Resend the publication request notification email to all NEMAR admins.
  Use this if admins haven't responded to your original request.

  This does NOT create a duplicate request - it only sends a reminder
  email for your existing publication request.

When to Use:
  - Admins haven't responded after several days
  - You want to remind admins about your pending request
  - Your request status is still "requested"

Examples:
  $ nemar dataset publish resend nm000104
```

### dataset clone

```bash
Usage: nemar dataset clone [options] <dataset-id>

Clone a dataset from NEMAR

Arguments:
  dataset-id           Dataset ID (e.g., nm000104)

Options:
  -o, --output <path>  Output directory (default: ./<dataset-id>)
  -h, --help           display help for command

Description:
  Clone a NEMAR dataset repository with git-annex initialized.
  Data files are not downloaded; use 'nemar dataset get' afterward.

  Private datasets require authentication (nemar auth login) and are
  only accessible to the owner or designated collaborators.

Requirements:
  - git-annex installed
  - NEMAR account (for private datasets)

Examples:
  $ nemar dataset clone nm000104
  $ nemar dataset clone nm000104 -o ./my-dataset
```

### dataset get

```bash
Usage: nemar dataset get [options] [files...]

Download annexed data files for the current dataset

Arguments:
  files                Specific files/paths to get (default: all)

Options:
  -j, --jobs <number>  Parallel download streams (default: "4")
  -h, --help           display help for command

Description:
  Download data files from the remote for a cloned dataset.
  Must be run inside a git-annex dataset directory.

  For private datasets, credentials are fetched automatically
  if you are logged in (nemar auth login).

Examples:
  $ nemar dataset get                    # Get all files
  $ nemar dataset get sub-01/eeg/        # Get specific directory
  $ nemar dataset get *.edf -j 8         # Get EDF files with 8 streams
```

### dataset save

```bash
Usage: nemar dataset save [options]

Stage and commit changes in the current dataset

Options:
  -m, --message <msg>  Commit message (default: "Save changes")
  -h, --help           display help for command

Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

Examples:
  $ nemar dataset save
  $ nemar dataset save -m "Add new EEG recordings"
```

### dataset push

```bash
Usage: nemar dataset push [options]

Push commits and data to remotes

Options:
  -j, --jobs <number>  Parallel upload streams for S3 (default: "4")
  --no-s3              Skip pushing data to S3 remote
  --pr                 Create a pull request after pushing
  -t, --title <title>  Pull request title (with --pr)
  -b, --body <body>    Pull request body (with --pr)
  -h, --help           display help for command

Description:
  Push git commits to GitHub (main + git-annex branches) and optionally
  copy annexed data to the S3 remote.

  With --pr, creates a pull request after pushing the current branch.

  S3 push uses temporary credentials from the NEMAR API. Falls back to
  environment AWS credentials if not logged in.

Examples:
  $ nemar dataset push
  $ nemar dataset push --no-s3      # Git only, skip S3
  $ nemar dataset push -j 8         # More parallel S3 streams
  $ nemar dataset push --pr -t "Add new recordings"
```

### dataset drop

```bash
Usage: nemar dataset drop [options] [files...]

Free local copies of annexed files (keeps remote copies)

Arguments:
  files       Specific files to drop (default: all)

Options:
  -h, --help  display help for command

Description:
  Remove local copies of annexed data files. Git-annex verifies that
  remote copies exist before dropping. Use 'nemar dataset get' to
  re-download later.

Examples:
  $ nemar dataset drop                   # Drop all local data
  $ nemar dataset drop sub-01/eeg/       # Drop specific directory
  $ nemar dataset drop *.edf             # Drop EDF files
```

### dataset ci

```bash
Usage: nemar dataset ci [options] [dataset-id]

Check BIDS validation CI status for the current dataset

Arguments:
  dataset-id  Dataset ID (auto-detected from git remote if omitted)

Options:
  -h, --help  display help for command

Description:
  Show the status of the BIDS validation CI workflow for a dataset.
  When run inside a cloned dataset, the dataset ID is auto-detected
  from the git remote URL.

Examples:
  $ nemar dataset ci              # Auto-detect from CWD
  $ nemar dataset ci nm000104     # Explicit dataset ID
```

### dataset manifest

```bash
Usage: nemar dataset manifest [options] [version]

View version manifests for a dataset

Arguments:
  version             Version to view (lists available if omitted)

Options:
  -d, --dataset <id>  Dataset ID (auto-detected from git remote if omitted)
  --json              Output raw JSON
  -h, --help          display help for command

Description:
  View version manifests that map file paths to S3 annex keys.
  Manifests are generated when a version DOI is published.

  When run inside a dataset directory, the dataset ID is auto-detected.

Examples:
  $ nemar dataset manifest                    # List available versions
  $ nemar dataset manifest v1.0.0             # View specific version
  $ nemar dataset manifest v1.0.0 --json      # Raw JSON output
  $ nemar dataset manifest -d nm000104        # Explicit dataset ID
```

