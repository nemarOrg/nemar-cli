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
# Run all tests
bun test

# Run specific test file
bun test test/auth.test.ts

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

```bash
# Never edit package.json version manually!
./scripts/bump-version.sh patch    # Bug fixes (0.2.7 -> 0.2.8)
./scripts/bump-version.sh minor    # New features (0.2.7 -> 0.3.0)
./scripts/bump-version.sh major    # Breaking changes (0.2.7 -> 1.0.0)
./scripts/bump-version.sh dev      # Pre-release (0.2.7 -> 0.2.8-dev)
```

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
