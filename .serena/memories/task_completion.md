# Task Completion Checklist

When completing a coding task, run these commands in order.
The rules behind them are in `AGENTS.md`, `.rules/testing.md` ("Test cost") and `.rules/ci_cd.md`.

## 1. Lint and Format
```bash
bun run lint:fix
bun run format
bunx biome check <touched files>
```

## 2. Type Check
```bash
bun run typecheck
```

## 3. Run Targeted Tests
Run only the tests for the services the change likely affects (the files and routers touched, and their neighbours), by path, plus the new test files:
```bash
bun test backend/test/<file>.test.ts test/<file>.test.ts
bun run migrations:d1-check
```
The full `bun test` takes about 80 minutes under load and runs only at epic -> `dev`, as the full CI run.
Do not run it per task, phase, fix or review round, and do not wait on a long job: push and report "not run, would check: X because Y".

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
- Ensure the targeted tests pass
- Check that lint passes with no errors on the files you touched
- Verify the build succeeds
- Test the affected functionality manually if needed

## Before Creating PR
1. Run `/review-pr` skill (pr-review-toolkit)
2. Add review findings as PR comment
3. Address critical/important issues
4. Consider nice-to-haves if they improve flow

## Version Bumping
Never hand-bump the version: `package.json` is owned by CI (ADR 0016).
Do not edit it and do not run `./scripts/bump-version.sh`; see `.rules/release-and-repull.md`.
