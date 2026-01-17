# Code Style and Conventions

## General Principles
- Rigorous, thoughtful development; no shortcuts
- Avoid over-engineering; only make directly requested changes
- Keep solutions simple and focused

## TypeScript/JavaScript
- Use Bun runtime (not npm/npx)
- ES modules (`"type": "module"` in package.json)
- Biome for linting and formatting
- Strict TypeScript with `noEmit` for type checking

## Naming Conventions
- Files: kebab-case (`auth-service.ts`)
- Functions/Variables: camelCase
- Types/Interfaces: PascalCase
- Constants: SCREAMING_SNAKE_CASE (for true constants)

## Code Organization
- Keep related code together in `src/lib/`
- Commands go in `src/commands/`
- Types in `src/types/`
- Prefer editing existing files over creating new ones

## Comments
- Only add comments where logic isn't self-evident
- Don't add docstrings to code you didn't change
- No unnecessary type annotations

## Testing
- **NO MOCKS** - Real tests only; no mock data, mock tests, or mock classes
- Use `bun test`
- Test files in `test/` directory

## Writing Style (Documentation)
- No em-dashes; use commas or semicolons
- Define abbreviations before using them (e.g., "Brain Imaging Data Structure (BIDS)" before "BIDS")
- No emojis unless explicitly requested

## Git Commits
- Atomic commits with concise messages (<50 chars)
- No emojis in commit messages
- No "Co-Authored-By" tags
- Describe what changed and whether tested
