# sandbox

Sandbox training (required before uploading)

## Usage

```bash
Usage: nemar sandbox [options] [command]

Complete sandbox training before uploading datasets

Options:
  -h, --help        display help for command

Commands:
  status [options]  Check sandbox training completion status
  reset [options]   Reset sandbox training status for re-training

Description:
  Sandbox training verifies your setup and familiarizes you with the upload
  workflow. You must complete sandbox training before uploading real datasets.

  The training creates a placeholder BIDS dataset (~500KB) and uploads it to
  the sandbox environment, testing your git-annex and SSH setup.

Examples:
  $ nemar sandbox           # Run sandbox training
  $ nemar sandbox status    # Check if training is completed
  $ nemar sandbox reset     # Reset for re-training

```

## Subcommands

### sandbox status

```bash
Usage: nemar sandbox status [options]

Check sandbox training completion status

Options:
  --refresh   Fetch latest status from server
  -h, --help  display help for command
```

### sandbox reset

```bash
Usage: nemar sandbox reset [options]

Reset sandbox training status for re-training

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

