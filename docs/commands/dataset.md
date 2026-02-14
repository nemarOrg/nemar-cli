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
  -n, --name <name>         Dataset name (defaults to directory name)
  -d, --description <desc>  Dataset description
  --skip-validation         Skip BIDS validation (not recommended)
  --skip-orcid              Skip co-author ORCID collection
  --dry-run                 Show what would be uploaded without doing it
  -j, --jobs <number>       Parallel upload streams (default: 4) (default: "4")
  -y, --yes                 Skip confirmation and proceed
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

Requirements:
  - git-annex installed (no account needed)

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

### dataset version

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

