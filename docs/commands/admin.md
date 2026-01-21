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
  approve <username>                       Approve a pending user
  revoke <username>                        Revoke user access
  regenerate-iam <username>                Regenerate AWS IAM credentials for a user
  doi                                      DOI management
  revert [options] <dataset-id> [version]  Revert a dataset to a previous version (creates PR for review)
  help [command]                           display help for command

Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users          - List users and their status
  approve        - Approve a pending user registration
  revoke         - Revoke user access
  regenerate-iam - Regenerate AWS credentials for a user

Dataset Management:
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin regenerate-iam john_doe    # Regenerate AWS credentials
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
  -h, --help  display help for command
```

### admin revoke

```bash
Usage: nemar admin revoke [options] <username>

Revoke user access

Arguments:
  username    Username to revoke

Options:
  -h, --help  display help for command
```

### admin regenerate-iam

```bash
Usage: nemar admin regenerate-iam [options] <username>

Regenerate AWS IAM credentials for a user

Arguments:
  username    Username to regenerate credentials for

Options:
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

**Note on Branch Protection:**
When creating a concept DOI (`admin doi create`), branch protection is automatically applied to the dataset repository. This is because:
- DOI = permanent record that should not be accidentally modified
- Before DOI: Private datasets allow direct pushes (owner's workspace)
- After DOI: All changes require pull requests

This ensures that once a dataset has a DOI, it cannot be accidentally overwritten.

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
  -h, --help       display help for command
```

