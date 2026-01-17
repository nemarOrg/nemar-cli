# JavaScript/TypeScript Development Standards

## Runtime & Environment
- **Runtime:** Bun (preferred) for speed and native TypeScript support
- **TypeScript:** Strict mode enabled
- **Package Manager:** bun (not npm/npx)

## Code Style
- **Formatter:** Biome or ESLint with Prettier
- **Line Length:** 100 characters
- **Imports:** Sorted, ES modules only
- **Semicolons:** Consistent (prefer with)

## Project Structure
```
nemar-cli/
├── src/
│   ├── index.ts       # CLI entry point
│   ├── commands/      # CLI command implementations
│   ├── lib/           # Core library code
│   └── types/         # TypeScript type definitions
├── tests/             # Real tests only (using bun:test)
├── package.json       # Package config
├── tsconfig.json      # TypeScript config
└── biome.json         # Linting config
```

## CLI Development
- **CLI Framework:** Commander.js or Yargs
- **Input prompts:** Inquirer or Prompts
- **HTTP Client:** Native fetch or Axios
- **Validation:** Zod for schema validation

## Common Patterns
- **Async/Await:** For all async operations
- **Error Handling:** Custom error classes with proper typing
- **Configuration:** Environment variables + config files
- **Logging:** Structured logging with levels

## Testing (with bun:test)
```typescript
import { test, expect, describe } from "bun:test";

describe("myFunction", () => {
  test("handles valid input", () => {
    const result = myFunction(validInput);
    expect(result).toBe(expected);
  });
});
```

## Type Safety
```typescript
// Always define explicit types for public APIs
interface Config {
  apiKey: string;
  baseUrl: string;
  timeout?: number;
}

// Use type guards for runtime validation
function isValidConfig(obj: unknown): obj is Config {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "apiKey" in obj &&
    "baseUrl" in obj
  );
}
```

---
*Use bun for development. Real tests only. Strict TypeScript.*
