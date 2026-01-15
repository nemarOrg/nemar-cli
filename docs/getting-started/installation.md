# Installation

## Prerequisites

Before installing NEMAR CLI, ensure you have the following:

### Required

- **Bun** (v1.0+) or **Node.js** (v18+)
- **Git** (v2.20+)

### For Dataset Operations

- **DataLad** (v1.0+) - For dataset upload/download
- **git-annex** (v10+) - Large file management
- **Deno** (v1.40+) - For BIDS validation

## Install NEMAR CLI

### Using Bun (Recommended)

```bash
bun install -g nemar-cli
```

### Using npm

```bash
npm install -g nemar-cli
```

### From Source

```bash
git clone https://github.com/nemarDatasets/nemar-cli.git
cd nemar-cli
bun install
bun link
```

## Install Dependencies

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
sudo apt-get install git-annex

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

# Check dependencies
git --version
git-annex version
datalad --version
deno --version
```

## Next Steps

- [Quick Start](quickstart.md) - Upload your first dataset
- [Authentication](authentication.md) - Set up your NEMAR account
