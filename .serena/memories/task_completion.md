# Task Completion Checklist

When completing a coding task, run these commands in order:

## 1. Lint and Format
```bash
bun run lint:fix
bun run format
```

## 2. Type Check
```bash
bun run typecheck
```

## 3. Run Tests
```bash
bun test
```

## 4. Build (if applicable)
```bash
bun run build
```

## 5. Verify CLI Works
```bash
bun run src/index.ts --version
bun run src/index.ts --help
```

## Before Committing
- Ensure all tests pass
- Check that lint passes with no errors
- Verify the build succeeds
- Test the affected functionality manually if needed

## Before Creating PR
1. Run `/review-pr` skill (pr-review-toolkit)
2. Add review findings as PR comment
3. Address critical/important issues
4. Consider nice-to-haves if they improve flow

## Version Bumping
Only bump version when ready to release:
```bash
./scripts/bump-version.sh patch  # or minor/major
```
The script handles: version update, build, verification, and commit.
