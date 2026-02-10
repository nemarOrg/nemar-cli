# Installation

## Prerequisites

NEMAR CLI requires **Bun** runtime (v1.0+).

### Install Bun

```bash
# macOS, Linux, WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Homebrew
brew install oven-sh/bun/bun
```

### For Dataset Operations

- **DataLad** (v1.0+) - For dataset upload/download
- **git-annex** (v10+) - Large file management
- **Deno** (v1.40+) - For BIDS validation

## Install NEMAR CLI

### Using Bun

```bash
# Install globally
bun install -g nemar-cli

# Or run directly without installing
bunx nemar-cli --help
```

### From Source

```bash
git clone https://github.com/nemarOrg/nemar-cli.git
cd nemar-cli
bun install
bun link
```

## Install Optional Dependencies

### macOS

```bash
# Using Homebrew
brew install git-annex datalad deno

# Or using conda
conda install -c conda-forge datalad git-annex
```

### Linux (Ubuntu/Debian)

```bash
# Install git-annex
sudo apt-get update
sudo apt-get install -y git-annex

# Install DataLad
pip install datalad

# Install Deno
curl -fsSL https://deno.land/install.sh | sh
```

### Windows (WSL)

We recommend using Windows Subsystem for Linux (WSL) for the best experience:

```bash
# In WSL Ubuntu
sudo apt-get install git-annex
pip install datalad
```

## Verify Installation

```bash
# Check CLI version
nemar --version

# Check Bun
bun --version

# Check optional dependencies (for dataset operations)
git --version
git-annex version
datalad --version
deno --version
```

## Troubleshooting

### "command not found: nemar"

Ensure Bun's bin directory is in your PATH:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$HOME/.bun/bin:$PATH"
```

## Next Steps

- [Quick Start](quickstart.md) - Upload your first dataset
- [Authentication](authentication.md) - Set up your NEMAR account
