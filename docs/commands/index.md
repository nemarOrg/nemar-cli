# Command Reference

Overview of all available NEMAR CLI commands.

## Main Help

```bash
Usage: nemar [options] [command]

CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)

NEMAR is a curated repository for neurophysiology data in BIDS format.
This CLI provides tools for uploading, downloading, and managing datasets.

Options:
  -v, --version   Output the current version
  --no-color      Disable colored output
  --verbose       Enable verbose output
  -h, --help      display help for command

Commands:
  auth            Authentication management
  dataset         Dataset management
  admin           Admin commands (requires admin privileges)
  help [command]  display help for command

Examples:
  $ nemar auth login              # Authenticate with your API key
  $ nemar dataset validate ./my-dataset
  $ nemar dataset upload ./my-dataset -n "My EEG Dataset"
  $ nemar dataset download nm000104

Documentation:
  https://nemar-cli.pages.dev

Support:
  https://github.com/nemarDatasets/nemar-cli/issues
```

## Command Groups

| Command | Description |
|---------|-------------|
| [auth](auth.md) | Authentication and account management |
| [dataset](dataset.md) | Dataset management operations |
| [admin](admin.md) | Administrative operations (admin only) |
