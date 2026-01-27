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
  s3                                       S3 and IAM credential management
  repo                                     Repository visibility management
  ci                                       CI workflow management
  doi                                      DOI management
  publish                                  Publication workflow management
  revert [options] <dataset-id> [version]  Revert a dataset to a previous version (creates PR for review)
  help [command]                           display help for command

Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users          - List users and their status
  approve        - Approve a pending user registration
  revoke         - Revoke user access

Dataset Management:
  repo     - Manage repository visibility (public/private)
  ci       - Manage CI workflows (check status, deploy)
  s3       - S3/IAM credential management
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin approve john_doe           # Approve a user
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
  --pending   Show only pending approval
  --verified  Show only verified (awaiting approval)
  --approved  Show only approved users
  --revoked   Show only revoked users
  -h, --help  display help for command
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

### admin regenerate-iam

```bash
Usage: nemar admin regenerate-iam [options] <username>

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### admin doi

```bash
Usage: nemar admin doi [options] [command]

DOI management

Options:
  -h, --help                     display help for command

Commands:
  create [options] <dataset-id>  Create concept DOI for a dataset
  info <dataset-id>              Get DOI info for a dataset
  help [command]                 display help for command
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

### admin publish list

```bash
Usage: nemar admin publish list [options]

List publication requests

Options:
  -s, --status <status>  Filter by status (requested, approving, published,
                         denied)
  -h, --help             display help for command
```

### admin publish approve

```bash
Usage: nemar admin publish approve [options] <dataset-id>

Approve and publish a dataset (runs orchestrator)

Arguments:
  dataset-id  Dataset ID

Options:
  --resume    Resume from last failed step
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
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
```

