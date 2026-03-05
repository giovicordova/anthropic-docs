# Coding Conventions

**Analysis Date:** 2026-03-05

## Naming Patterns

**Files:**
- Lowercase kebab-case: `blog-parser.ts`, `database.ts`
- One file per module, named after its responsibility
- Test files mirror source names: `parser.test.ts` matches `parser.ts`

**Functions:**
- camelCase: `splitIntoSections`, `fetchAndParse`, `insertPageSections`
- Prefix with verb describing action: `get`, `set`, `fetch`, `parse`, `insert`, `list`, `search`, `cleanup`
- Boolean-returning helpers not used; conditions are inline

**Variables:**
- camelCase: `currentHeading`, `urlLineIndex`, `totalSections`
- Constants: UPPER_SNAKE_CASE in `src/config.ts`: `STALE_DAYS`, `FETCH_TIMEOUT_MS`, `MAX_SECTION_SIZE`
- Numeric separators for readability: `30_000`, `6_000`

**Types:**
- PascalCase interfaces: `ParsedPage`, `PageSection`, `SearchResult`, `Statements`
- Union types for discriminated results: `GetDocPageResult` uses `type: "page" | "disambiguation"`
- Type alias for string unions: `DocSource = "platform" | "code" | "api-reference" | "blog"`
- Type alias for simple unions: `CrawlState = "idle" | "crawling" | "failed"`

## Code Style

**Formatting:**
- No formatter configured (no Prettier, Biome, or ESLint)
- 2-space indentation used consistently across all files
- Double quotes for strings everywhere
- Semicolons always present
- Trailing commas in multi-line arrays/objects

**Linting:**
- No linter configured
- TypeScript strict mode enforces type safety (`"strict": true` in `tsconfig.json`)

**TypeScript Configuration (`tsconfig.json`):**
- Target: ES2022
- Module: Node16 (ESM)
- Strict mode enabled
- Declaration files emitted
- `skipLibCheck: true`

## Import Organization

**Order:**
1. Node built-in modules: `import path from "node:path"`, `import fs from "node:fs"`
2. Third-party packages: `import Database from "better-sqlite3"`, `import { z } from "zod"`
3. Local modules: `import { splitIntoSections } from "./parser.js"`

**Path Style:**
- All local imports use `.js` extension (required by Node16 ESM resolution)
- No path aliases configured
- Relative paths only (`./config.js`, `../src/parser.js`)

**Import Types:**
- Use `import type` for type-only imports: `import type { ParsedPage } from "./types.js"`
- Use `import type Database from "better-sqlite3"` in `src/types.ts`
- Regular imports for values and mixed value+type imports

## Error Handling

**Patterns:**

1. **Try/catch with type narrowing** - Used in async functions that interact with external services:
```typescript
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[blog-parser] Sitemap fetch error: ${message}`);
  return [];
}
```

2. **Promise.allSettled for parallel fetches** - Never use `Promise.all` for network requests. Check each result individually:
```typescript
const [platformResponse, codeResponse] = await Promise.allSettled([
  fetchWithTimeout(PLATFORM_DOCS_URL),
  fetchWithTimeout(CLAUDE_CODE_DOCS_URL),
]);
if (platformResponse.status === "fulfilled" && platformResponse.value.ok) { ... }
```

3. **Graceful degradation** - Network failures return empty arrays, not thrown errors. Callers always get valid data:
```typescript
// fetchSitemapUrls returns [] on failure, not throws
// fetchBlogPages skips individual page failures
```

4. **Tool-level error wrapping** - MCP tool handlers catch errors and return `{ isError: true }` responses:
```typescript
} catch (err) {
  return {
    content: [{ type: "text" as const, text: `Search error: ${(err as Error).message}` }],
    isError: true,
  };
}
```

5. **Silent skip for invalid data** - Empty `catch {}` blocks for expected parse failures (invalid URLs):
```typescript
try { urlPath = new URL(url).pathname; } catch { i++; continue; }
```

## Logging

**Framework:** `console.error` (stderr only)

**Patterns:**
- **Never use `console.log`** - It corrupts the JSON-RPC stdio transport
- All log messages prefixed with module tag in brackets: `[server]`, `[parser]`, `[blog-parser]`
- Log format: `[module] Action description: details`
- Progress logging for batch operations: `[blog-parser] Fetching batch 3/42 (10 URLs)`
- Counts included in completion messages: `[parser] Total: 547 pages`
- Error messages include the error detail: `[server] Crawl failed: timeout`

**When to log:**
- Start/end of major operations (crawls, server startup)
- Batch progress during long operations
- Error conditions with context
- Staleness check results

## Comments

**When to Comment:**
- Section separators using `// --- Section Name ---` pattern in every file
- Brief inline comments for non-obvious logic: `// Post-process: split oversized sections at h4 boundaries`
- Comment before exported-for-testing sections: `// --- Pure functions (exported for testing) ---`
- Comment before non-exported helpers: `// --- Fetch helpers (not exported for testing) ---`

**JSDoc/TSDoc:**
- Not used anywhere in the codebase
- Function signatures are self-documenting via TypeScript types

## Function Design

**Size:**
- Functions are short (10-40 lines typical)
- Longest function is `splitIntoSections` at ~95 lines including the h4 split post-processing
- Complex logic broken into inner helper functions: `flushSection()` inside `splitIntoSections`

**Parameters:**
- Use optional parameters with defaults: `limit: number = 10`, `dbPath?: string`
- Use `Partial<T>` for test factory overrides: `makeSection(overrides: Partial<PageSection> = {})`
- Pass dependencies explicitly (db, stmts) rather than using globals, except in `src/index.ts`

**Return Values:**
- Return `null` for "not found" cases: `getDocPage` returns `null`, `parseBlogPage` returns `null`
- Use discriminated unions for multi-shape returns: `GetDocPageResult` with `type` field
- Async functions that can partially fail return arrays (empty on full failure)

## Module Design

**Exports:**
- Named exports only, no default exports
- Pure functions exported for direct use and testability
- Network-dependent functions exported separately from pure logic
- `src/types.ts` exports only types and interfaces (no runtime code)
- `src/config.ts` exports only constants

**Barrel Files:**
- Not used. Each file is imported directly by path.

**Module Boundaries:**
- `src/types.ts` - Shared types. No logic. No imports except `better-sqlite3` type.
- `src/config.ts` - All constants. No logic beyond `path.join`.
- `src/parser.ts` - Markdown parsing. Exports pure functions + one async fetch function.
- `src/blog-parser.ts` - HTML/sitemap parsing. Pure functions exported for testing; fetch helpers kept internal.
- `src/database.ts` - All SQLite operations. Takes `db`/`stmts` as parameters.
- `src/index.ts` - MCP server wiring. Only file with module-level state (db, stmts, crawlState).

**State Management:**
- Module-level mutable state exists only in `src/index.ts`: `crawlState` variable, `db`, `stmts`
- All other modules are stateless (pure functions or factory functions)
- Database state managed via `generation` column and `metadata` table

## MCP Tool Registration Pattern

Tools follow a consistent structure in `src/index.ts`:

```typescript
server.registerTool(
  "tool_name",
  {
    description: "Multi-line description with usage guidance.",
    inputSchema: {
      param: z.string().describe("Parameter description."),
      optional: z.enum(["a", "b"]).default("a").describe("Optional with default."),
    },
  },
  async ({ param, optional }) => {
    const building = firstRunBuildingResponse();
    if (building) return building;
    // ... tool logic ...
    return { content: [{ type: "text" as const, text: result }] };
  }
);
```

Key conventions:
- Every read tool checks `firstRunBuildingResponse()` first
- Return type is always `{ content: [{ type: "text", text: string }], isError?: boolean }`
- Use `as const` for literal type assertions on `"text"`
- Zod schemas for input validation with `.describe()` on every parameter

---

*Convention analysis: 2026-03-05*
