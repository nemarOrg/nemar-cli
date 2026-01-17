# NEMAR CLI - Project Overview

## Purpose
Command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) dataset management. Enables users to upload, download, validate, and manage neuroimaging datasets following BIDS standards.

## Tech Stack
- **Runtime:** Bun (not Node.js)
- **Language:** TypeScript (ES modules)
- **CLI Framework:** Commander.js
- **UI Libraries:** chalk (colors), inquirer (prompts), ora (spinners)
- **Validation:** Zod for schema validation
- **Linting/Formatting:** Biome
- **Backend:** Cloudflare Workers/D1 (in `backend/` directory)
- **Data Management:** DataLad, git-annex, S3, GitHub

## Project Structure
```
nemar-cli/
├── src/                 # Main source code
│   ├── index.ts         # Entry point
│   ├── commands/        # CLI command implementations
│   ├── lib/             # Shared utilities and services
│   └── types/           # TypeScript type definitions
├── backend/             # Cloudflare Workers backend
├── test/                # Test files
├── scripts/             # Build and utility scripts
├── docs/                # Documentation (MkDocs)
├── .rules/              # Development guidelines
├── .context/            # Project context and planning
└── dist/                # Build output
```

## Core Features
1. **Authentication:** User registration, API tokens, admin approval workflow
2. **Dataset Management:** BIDS validation, DataLad integration, upload/download
3. **Storage Integration:** GitHub (metadata), S3 (data files), Zenodo (DOI)

## Entry Point
The CLI is invoked via `nemar` command after installation, or `bun run src/index.ts` in development.
