# Development Setup

This guide covers setting up a local development environment for nemar-cli.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- Git
- GitHub CLI (`gh`) for integration testing

## Install Dependencies

```bash
bun install
```

This also runs `husky` via the `prepare` script, which sets up Git pre-commit hooks automatically.

## Pre-commit Hooks

The project uses [husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) for pre-commit checks. These run automatically on every commit:

1. **lint-staged** - Runs `biome check --fix` on staged TypeScript files in `src/` and `backend/src/`
2. **Frontend typecheck** - Runs `tsc --noEmit` on the CLI source
3. **Backend typecheck** - Runs `tsc --noEmit` on the backend source (Cloudflare Workers)

Both frontend and backend typechecks run because they have separate `tsconfig.json` files with different targets (Bun vs Cloudflare Workers). A type error in either will block the commit.

### If a Hook Fails

Fix the reported errors and try committing again. Common issues:

| Error | Fix |
|-------|-----|
| Biome lint error | Run `bun run lint:fix` to auto-fix, or fix manually |
| Frontend type error | Check `src/` for TypeScript issues |
| Backend type error | Check `backend/src/` for TypeScript issues |

## Running Locally

```bash
# Run CLI in development
bun run src/index.ts

# Run with arguments
bun run src/index.ts dataset list
```

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/license-provenance.test.ts
```

## Linting and Formatting

```bash
# Check for lint issues
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Format code
bun run format

# Type check (frontend only)
bun run typecheck

# Type check backend
cd backend && bun run typecheck
```

## Building

```bash
bun run build
```

This produces `dist/index.js` targeting the Bun runtime.
