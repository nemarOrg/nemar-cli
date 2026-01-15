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
  doi                                      DOI management
  revert [options] <dataset-id> [version]  Revert a dataset to a previous version (creates PR for review)
  help [command]                           display help for command

Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users    - List users and their status
  approve  - Approve a pending user registration
  revoke   - Revoke user access

Dataset Management:
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified         # List users awaiting approval
  $ nemar admin approve john_doe         # Approve a user
  $ nemar admin doi create nm000104      # Create concept DOI
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

### admin reject

```bash
Usage: nemar admin [options] [command]

Admin commands (requires admin privileges)

Options:
  -h, --help                               display help for command

Commands:
  users [options]                          List NEMAR users
  approve <username>                       Approve a pending user
  revoke <username>                        Revoke user access
  doi                                      DOI management
  revert [options] <dataset-id> [version]  Revert a dataset to a previous version (creates PR for review)
  help [command]                           display help for command

Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users    - List users and their status
  approve  - Approve a pending user registration
  revoke   - Revoke user access

Dataset Management:
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified         # List users awaiting approval
  $ nemar admin approve john_doe         # Approve a user
  $ nemar admin doi create nm000104      # Create concept DOI
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

