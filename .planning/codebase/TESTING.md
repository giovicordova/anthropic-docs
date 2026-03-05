# Testing Patterns

**Analysis Date:** 2026-03-05

## Test Framework

**Runner:**
- Vitest 4.x
- No config file (uses defaults from `package.json` script)
- ESM mode (inherits `"type": "module"` from package.json)

**Assertion Library:**
- Vitest built-in `expect` (Chai-compatible API)

**Run Commands:**
```bash
npm test              # Run all tests (vitest run, single pass)
```

No watch mode or coverage scripts configured. To run manually:
```bash
npx vitest            # Watch mode (default vitest behavior)
npx vitest --coverage # Coverage (requires @vitest/coverage-v8)
```

## Test File Organization

**Location:**
- Separate `tests/` directory at project root (not co-located with source)

**Naming:**
- `{module}.test.ts` matching source file name
- `tests/parser.test.ts` tests `src/parser.ts`
- `tests/blog-parser.test.ts` tests `src/blog-parser.ts`
- `tests/database.test.ts` tests `src/database.ts`

**Structure:**
```
tests/
├── parser.test.ts        # splitIntoSections, parsePages
├── blog-parser.test.ts   # parseSitemap, htmlToMarkdown, parseBlogPage
└── database.test.ts      # Full database CRUD, search, generation swap
```

**Coverage Gaps:**
- `src/index.ts` (MCP server, tool handlers, crawl orchestration) - No tests
- `src/config.ts` - No tests (trivial constants)
- `src/types.ts` - No tests (type-only, no runtime code)
- Network fetch functions (`fetchAndParse`, `fetchSitemapUrls`, `fetchBlogPages`) - No tests

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from "vitest";
import { functionUnderTest } from "../src/module.js";

describe("functionName", () => {
  it("describes expected behavior in plain English", () => {
    // Arrange: build input data inline
    // Act: call the function
    // Assert: check result with expect()
  });
});
```

**Patterns:**
- One `describe` block per exported function
- `it` descriptions are behavior-focused: "splits markdown at ## and ### headings", "filters out non-blog URLs"
- No nested `describe` blocks
- No `beforeAll` or `afterAll` usage
- `beforeEach` used only in database tests to create fresh in-memory DB

## Test Data Construction

**Inline Strings:**
Parser and blog-parser tests construct test data as inline multiline strings:
```typescript
const markdown = [
  "## Getting Started",
  "",
  "This section has content about getting started.",
].join("\n");
```

Use array-of-lines joined with `\n` for readability. Do not use template literals for multiline test markdown.

**Factory Function:**
Database tests use a `makeSection` factory with `Partial<T>` overrides:
```typescript
function makeSection(overrides: Partial<PageSection> = {}): PageSection {
  return {
    url: "https://platform.claude.com/docs/en/test",
    path: "/docs/en/test",
    title: "Test Page",
    sectionHeading: "Overview",
    sectionAnchor: "overview",
    content: "This is test content for the search index with enough words to be meaningful.",
    sectionOrder: 0,
    source: "platform",
    ...overrides,
  };
}
```

Override only what matters for the test case:
```typescript
insertPageSections(db, stmts, [makeSection({ source: "blog", path: "/news/test" })], 1);
```

**Location:**
- Factory functions defined at top of test file, outside `describe` blocks
- No shared fixtures directory

## Database Test Setup

**In-Memory SQLite:**
Database tests use `:memory:` to avoid filesystem side effects:
```typescript
let db: Database.Database;
let stmts: ReturnType<typeof prepareStatements>;

beforeEach(() => {
  db = initDatabase(":memory:");
  stmts = prepareStatements(db);
});
```

Every test gets a fresh database. No cleanup needed.

**Pattern for database tests:**
1. Insert test data with `insertPageSections`
2. Finalize generation with `finalizeGeneration`
3. Query and assert results

## Mocking

**Framework:** None

**Approach:** The codebase avoids mocking entirely. Instead:

1. **Pure functions are tested directly** - `splitIntoSections`, `parsePages`, `parseSitemap`, `htmlToMarkdown`, `parseBlogPage` are all pure functions that take input and return output. No mocking needed.

2. **Database tests use real SQLite in-memory** - `initDatabase(":memory:")` creates a real database. Tests exercise actual SQL queries and FTS5 search.

3. **Network functions are not tested** - `fetchAndParse`, `fetchSitemapUrls`, `fetchBlogPages` involve real HTTP calls and are excluded from tests.

4. **Testability through architecture** - `src/blog-parser.ts` explicitly separates pure functions from fetch helpers with comments: `// --- Pure functions (exported for testing) ---` and `// --- Fetch helpers (not exported for testing) ---`

**What to mock (if adding new tests):**
- Global `fetch` for testing `fetchAndParse`, `fetchSitemapUrls`, `fetchBlogPages`

**What NOT to mock:**
- SQLite database (use `:memory:` instead)
- Pure parsing functions (test directly with input/output)

## Coverage

**Requirements:** None enforced. No coverage thresholds configured.

**Current state:**
- `src/parser.ts` - Well covered (splitIntoSections, parsePages tested)
- `src/blog-parser.ts` - Pure functions covered (parseSitemap, htmlToMarkdown, parseBlogPage)
- `src/database.ts` - Well covered (insert, search, getDocPage, listSections, generation swap, metadata, blog URLs)
- `src/index.ts` - **Not tested** (MCP server wiring, crawl orchestration, tool handlers)

## Test Types

**Unit Tests:**
- All tests are unit tests
- Test pure functions in isolation with constructed inputs
- Database tests are unit-level (in-memory, no external dependencies)

**Integration Tests:**
- Not present
- The `src/index.ts` MCP server integration is untested

**E2E Tests:**
- Not present
- Manual smoke testing via `npm start` (evidence: `smoke_stderr.txt` in repo root)

## Common Patterns

**Testing Return Shape:**
```typescript
const result = getDocPage(stmts, "/docs/en/test");
expect(result).not.toBeNull();
expect(result!.type).toBe("page");
if (result!.type === "page") {
  expect(result!.content).toContain("First section");
}
```

Use non-null assertion (`!`) after checking `not.toBeNull()`. Use type narrowing with `if` for discriminated unions.

**Testing Array Contents:**
```typescript
const urls = parseSitemap(xml);
expect(urls).toHaveLength(3);
expect(urls).toContain("https://www.anthropic.com/news/claude-4");
```

Use `toHaveLength` for count, `toContain` for membership, `toEqual([])` for empty.

**Testing Null/Empty Edge Cases:**
```typescript
it("returns null for empty content", () => {
  const page = parseBlogPage(url, `<article></article>`);
  expect(page).toBeNull();
});

it("handles empty string", () => {
  const urls = parseSitemap("");
  expect(urls).toEqual([]);
});
```

Always test null/empty/whitespace inputs as separate test cases.

**Testing Search Absence:**
```typescript
const results = searchDocs(stmts, "Old content previous");
expect(results).toHaveLength(0);
```

Verify old data is gone after generation swap by searching for it and expecting 0 results.

## Adding New Tests

**For a new pure function in an existing module:**
1. Add test cases to the existing `tests/{module}.test.ts`
2. Add a new `describe("functionName", () => { ... })` block
3. Test happy path, edge cases (empty input, null), and error conditions

**For a new module:**
1. Create `tests/{module-name}.test.ts`
2. Import from `../src/{module-name}.js` (use `.js` extension)
3. Follow the `describe` per function pattern
4. If it needs database, use the `beforeEach` + `:memory:` pattern from `tests/database.test.ts`
5. If it has network code, separate pure logic from fetch helpers and test only pure functions

---

*Testing analysis: 2026-03-05*
