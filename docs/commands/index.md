# Command Reference

Overview of all available NEMAR CLI commands.

## Main Help

```bash
Usage: nemar [options] [command]

CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)

NEMAR is a curated repository for neurophysiology data in BIDS format.
This CLI provides tools for uploading, downloading, and managing datasets.

Options:
  -v, --version     Output the current version
  --no-color        Disable colored output
  --verbose         Enable verbose output
  -h, --help        display help for command

Commands:
  auth              Authentication management
  dataset           Dataset management
  sandbox           Complete sandbox training before uploading datasets
  admin             Admin commands (requires admin privileges)
  login [options]   Authenticate with your API key (shortcut for 'auth login')
  logout [options]  Clear stored credentials (shortcut for 'auth logout')
  signup            Register for a new account (shortcut for 'auth signup')
  register          Register for a new account (alias for signup)
  whoami [options]  Show current user (shortcut for 'auth status')
  help [command]    display help for command

Examples:
  $ nemar auth login              # Authenticate with your API key
  $ nemar dataset validate ./my-dataset
  $ nemar dataset upload ./my-dataset -n "My EEG Dataset"
  $ nemar dataset download nm000104

Documentation:
  https://nemar-cli.pages.dev

Support:
  https://github.com/nemarOrg/nemar-cli/issues
```

## Command Groups

| Command | Description |
|---------|-------------|
| [auth](auth.md) | Authentication and account management |
| [dataset](dataset.md) | Dataset management operations |
| [sandbox](sandbox.md) | Sandbox training (required before uploading) |
| [admin](admin.md) | Administrative operations (admin only) |
