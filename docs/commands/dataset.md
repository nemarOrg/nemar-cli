# dataset

Dataset management operations

## Usage

```bash
Usage: nemar dataset [options] [command]

Dataset management

Options:
  -h, --help                                display help for command

Commands:
  validate [options] [path]                 Validate a BIDS dataset locally using the official BIDS validator
  upload [options] <path>                   Upload a BIDS dataset to NEMAR
  download [options] <dataset-id>           Download a dataset from NEMAR
  status [options] <dataset-id>             Check status of a dataset
  list [options]                            List available datasets on NEMAR
  version [options] <dataset-id> <version>  Create a new version of a dataset with DOI
  request-access <dataset-id>               Request collaborator access to a dataset
  invite <username> <dataset-id>            Invite a user as collaborator to your dataset
  collaborators [options] <dataset-id>      List collaborators for a dataset
  help [command]                            display help for command

Description:
  Manage BIDS datasets on NEMAR. Upload, download, validate, and version
  neurophysiology datasets in Brain Imaging Data Structure (BIDS) format.

Prerequisites:
  - DataLad and git-annex (for upload/download)
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

Validate a BIDS dataset locally using the official BIDS validator

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
  -h, --help           display help for command

Description:
  Validates a BIDS dataset using the official BIDS validator (via Deno).
  The validator checks dataset structure, file naming, and metadata.

Requirements:
  Deno runtime must be installed: https://deno.com

Exit Codes:
  0 - Dataset is valid
  1 - Dataset has errors or validation failed

Examples:
  $ nemar dataset validate                       # Validate current directory
  $ nemar dataset validate ./my-dataset          # Validate specific path
  $ nemar dataset validate ./ds --prune          # Fast validation (skip derivatives)
  $ nemar dataset validate ./ds --json > out.json
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
  --dry-run                 Show what would be uploaded without doing it
  -j, --jobs <number>       Parallel upload streams (default: 8) (default: "8")
  -y, --yes                 Skip confirmation prompt
  -h, --help                display help for command

Description:
  Upload a BIDS dataset to NEMAR. The dataset will be validated, assigned
  a unique ID (nm000XXX), and stored on GitHub (metadata) and S3 (data files).

Requirements:
  - NEMAR account (nemar auth login)
  - DataLad and git-annex installed
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
  Download a BIDS dataset from NEMAR. Uses DataLad/git-annex for efficient
  data transfer with parallel streams.

Requirements:
  - DataLad and git-annex installed (no account needed)

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

List available datasets on NEMAR

Options:
  --mine       List only your datasets (requires authentication)
  --json       Output as JSON for scripting
  --limit <n>  Limit number of results (default: 50) (default: "50")
  -h, --help   display help for command

Description:
  List BIDS datasets available on NEMAR. Use --mine to see only your
  own datasets (requires authentication).

Examples:
  $ nemar dataset list                   # List all public datasets
  $ nemar dataset list --mine            # List your datasets
  $ nemar dataset list --json            # JSON output for scripting
  $ nemar dataset list --limit 10        # Show only 10 datasets
```

### dataset version

```bash
Usage: nemar dataset version [options] <dataset-id> <version>

Create a new version of a dataset with DOI

Arguments:
  dataset-id           Dataset ID (e.g., nm000104)
  version              Version tag (e.g., v1.1.0)

Options:
  -m, --message <msg>  Version description
  -h, --help           display help for command
```

