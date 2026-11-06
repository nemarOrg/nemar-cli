# Suggested Commands

## Development

```bash
# Run CLI in development mode
bun run src/index.ts

# Run with arguments
bun run src/index.ts auth status
bun run src/index.ts dataset validate ./path/to/dataset
```

## Building

```bash
# Build for distribution
bun run build

# Or directly:
bun build src/index.ts --outdir dist --target bun --minify
```

## Testing

```bash
# Run specific test files (the default: targeted tests per change, see .rules/testing.md)
bun test test/auth.test.ts

# Run all tests: about 80 minutes under load, only at epic -> dev (the full CI run)
bun test

# Run tests with coverage
bun test --coverage
```

## Linting & Formatting

```bash
# Check for issues
bun run lint

# Fix issues automatically
bun run lint:fix

# Format code
bun run format

# Type check
bun run typecheck
```

## Version Management

The version is owned by CI (ADR 0016): never edit `package.json` version and never run `./scripts/bump-version.sh` by hand.
See `.rules/release-and-repull.md`.

## Documentation

```bash
# Generate CLI docs
bun run docs:generate

# Serve docs locally
bun run docs:serve

# Build docs for deployment
bun run docs:build
```

## Git Workflow

```bash
# Create feature branch
git checkout -b feature/short-description

# Commit (no emojis, no co-author tags)
git commit -m "Add feature X"

# Push and create PR
git push -u origin feature/short-description
gh pr create
```

## System Utilities (macOS/Darwin)

```bash
# Standard utilities work normally
git, ls, cd, grep, find, cat, etc.

# Use gh for GitHub operations
gh pr list
gh issue list
gh repo view
```
