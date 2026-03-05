# Phase 1: Architecture and Safety - Research

**Researched:** 2026-03-05
**Domain:** TypeScript refactoring, MCP server decomposition, vitest testing
**Confidence:** HIGH

## Summary

This phase is a pure refactor of `src/index.ts` (478 lines) into smaller modules, plus adding a test suite. No new features, no dependency changes, no behavior changes. The codebase is small (1226 total lines across 7 files) and well-understood -- the main challenge is decomposing index.ts without breaking the 5 MCP tool behaviors or the crawl sequencing logic.

The key architectural change is introducing a `ContentSource` interface that unifies the doc crawl path (`fetchAndParse` + generation swap) and the blog crawl path (`fetchSitemapUrls` + incremental insert). Today these two paths have different logic inlined in index.ts. A shared interface lets Phase 4 add new content sources (model pages, research papers) without touching crawl orchestration.

**Primary recommendation:** Extract three modules -- `src/tools/` (tool handlers), `src/crawl.ts` (orchestration + ContentSource interface), and keep index.ts as pure wiring (~30 lines). Test with vitest using in-memory SQLite for speed.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ARCH-01 | Tool handlers extracted from index.ts into separate modules under src/tools/ | Architecture Patterns section: tool handler extraction pattern |
| ARCH-02 | Crawl orchestration extracted from index.ts into src/crawl.ts | Architecture Patterns section: crawl module pattern |
| ARCH-03 | Unified crawl pipeline via ContentSource interface replacing separate doc/blog paths | Architecture Patterns section: ContentSource interface design |
| ARCH-04 | index.ts reduced to thin entry point (wiring only) | Architecture Patterns section: thin entry point pattern |
| TEST-01 | Tool handler tests covering crawl state transitions, staleness checks, response formatting | Validation Architecture section: test map |
| TEST-02 | Network function tests for fetchAndParse and fetchBlogPages (error handling, timeouts, partial failures) | Validation Architecture section: test map |
| TEST-03 | Blog-exclusion test verifying blog rows survive orphan cleanup | Validation Architecture section: test map |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | ^4.0.18 | Test runner | Already in devDependencies, zero config for ESM + TypeScript |
| typescript | ^5.9.3 | Type checking | Already in devDependencies |
| better-sqlite3 | ^12.6.2 | Database | Already in dependencies, supports `:memory:` for tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @modelcontextprotocol/sdk | ^1.27.1 | MCP server | Already in dependencies, provides McpServer and types |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| vitest | jest | vitest already installed, native ESM support, faster |

**Installation:** No new packages needed. Everything is already installed.

## Architecture Patterns

### Current Structure (before refactor)
```
src/
  blog-parser.ts    (132 lines) - blog fetching + parsing
  config.ts         (18 lines)  - constants
  database.ts       (280 lines) - SQLite schema + queries
  fetch.ts          (10 lines)  - fetchWithTimeout
  index.ts          (478 lines) - EVERYTHING ELSE (tools, crawl, state, wiring)
  parser.ts         (218 lines) - doc fetching + parsing
  types.ts          (90 lines)  - type definitions
```

### Recommended Structure (after refactor)
```
src/
  blog-parser.ts    (unchanged)
  config.ts         (unchanged)
  crawl.ts          (NEW ~120 lines) - ContentSource interface, CrawlManager class
  database.ts       (unchanged)
  fetch.ts          (unchanged)
  index.ts          (SHRUNK to ~30 lines) - wiring only
  parser.ts         (unchanged)
  tools/
    index.ts        (NEW ~20 lines) - re-export registerTools()
    search.ts       (NEW ~50 lines) - search_anthropic_docs handler
    get-page.ts     (NEW ~45 lines) - get_doc_page handler
    list-sections.ts(NEW ~55 lines) - list_doc_sections handler
    refresh.ts      (NEW ~25 lines) - refresh_index handler
    status.ts       (NEW ~30 lines) - index_status handler
  types.ts          (extended with ContentSource + CrawlState)
tests/
  crawl.test.ts     (NEW) - crawl state transitions, orchestration
  tools.test.ts     (NEW) - tool handler responses
  database.test.ts  (NEW) - blog-exclusion, orphan cleanup
```

### Pattern 1: ContentSource Interface

**What:** A unified interface that both doc and blog crawl paths implement. The crawl manager iterates over registered sources instead of having separate `startCrawl()` and `startBlogCrawl()` functions.

**When to use:** Any content that gets fetched, parsed into `ParsedPage[]`, and inserted into the database.

**Design:**

```typescript
// src/types.ts (additions)
export interface ContentSource {
  name: string;                    // "docs" | "blog" | future sources
  staleDays: number;               // 1 for docs, 7 for blog
  metaTimestampKey: string;        // "last_crawl_timestamp" | "last_blog_crawl_timestamp"
  metaCountKey: string;            // "page_count" | "blog_page_count"
  usesGeneration: boolean;         // true for docs (atomic swap), false for blog (incremental)
  fetch(db: Database.Database): Promise<ParsedPage[]>;  // fetch + parse
}
```

**Key insight:** The doc path and blog path differ in two ways:
1. Docs use generation swap (insert at newGen, then delete oldGen). Blog inserts at currentGen and never deletes.
2. Blog does incremental fetch (sitemap-diff). Docs re-fetch everything.

The `usesGeneration` flag controls whether `finalizeGeneration()` runs after insert. The `fetch()` method encapsulates the source-specific logic (including blog's sitemap-diff).

### Pattern 2: CrawlManager

**What:** A class that owns crawl state and orchestration, extracted from index.ts.

```typescript
// src/crawl.ts
export class CrawlManager {
  private states: Map<string, CrawlState> = new Map();

  constructor(
    private db: Database.Database,
    private stmts: Statements,
    private sources: ContentSource[]
  ) {}

  async crawlSource(source: ContentSource): Promise<number> { ... }
  async crawlAll(): Promise<void> { ... }  // sequenced: docs first, then blog
  checkAndCrawlAll(): void { ... }         // staleness check + background crawl
  getState(name: string): CrawlState { ... }
  isAnyCrawling(): boolean { ... }
}
```

### Pattern 3: Tool Handler Extraction

**What:** Each tool handler becomes a pure function that takes dependencies (stmts, crawlManager) and returns the MCP handler callback.

```typescript
// src/tools/search.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerSearchTool(
  server: McpServer,
  stmts: Statements,
  crawlManager: CrawlManager
): void {
  server.registerTool("search_anthropic_docs", { ... }, async ({ query, source, limit }) => {
    // same logic as today, but uses crawlManager.getState()
    // instead of reading module-level crawlState variable
  });
}
```

### Pattern 4: Thin Entry Point

**What:** index.ts becomes pure wiring -- no logic.

```typescript
// src/index.ts (~30 lines)
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDatabase, prepareStatements, cleanupOrphanedGenerations } from "./database.js";
import { CrawlManager } from "./crawl.js";
import { registerTools } from "./tools/index.js";
import { docSource, blogSource } from "./sources.js";  // or inline in crawl.ts

const server = new McpServer({ name: "anthropic-docs", version: "2.0.0" });
const db = initDatabase();
const stmts = prepareStatements(db);

const orphans = cleanupOrphanedGenerations(db, stmts);
if (orphans > 0) console.error(`[server] Cleaned up ${orphans} orphaned rows.`);

const crawl = new CrawlManager(db, stmts, [docSource, blogSource]);
registerTools(server, stmts, crawl);

async function main() {
  crawl.checkAndCrawlAll();
  await server.connect(new StdioServerTransport());
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");
}

main().catch((err) => { console.error("[server] Fatal:", err); process.exit(1); });
```

### Anti-Patterns to Avoid

- **Splitting too granularly:** Don't create a file per 10-line function. The tools/ directory is justified because there are 5 tools with distinct logic. Don't split crawl.ts further.
- **Changing behavior during refactor:** Every tool must return byte-identical responses. The refactor is structural only.
- **Breaking the crawl sequence:** Docs MUST complete before blog starts (blog reads generation set by doc crawl). CrawlManager.crawlAll() must enforce this.
- **Losing the firstRunBuildingResponse guard:** This function checks both crawl state and metadata. It must remain accessible to all tool handlers that need it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test mocking of fetch | Custom fetch wrapper | vitest.fn() / vi.mock() | Vitest has built-in module mocking |
| In-memory test DB | File-based test DB with cleanup | better-sqlite3 `:memory:` | Faster, no cleanup needed, isolated per test |
| Test runner | npm scripts with node --test | vitest (already installed) | Already configured, watch mode, TypeScript support |

## Common Pitfalls

### Pitfall 1: Circular imports between crawl.ts and tools/
**What goes wrong:** CrawlManager imports from database.ts, tools import CrawlManager, and if CrawlManager also needs tool types, you get a cycle.
**How to avoid:** CrawlManager should only depend on types.ts, database.ts, parser.ts, blog-parser.ts. Tools depend on CrawlManager but not vice versa. Types go in types.ts.

### Pitfall 2: Module-level state becoming unreachable
**What goes wrong:** `crawlState` and `blogCrawlState` are module-level variables in index.ts. After extraction, tool handlers need to read crawl state but it lives in crawl.ts.
**How to avoid:** CrawlManager owns state as instance properties. Pass the CrawlManager instance to tool registration functions.

### Pitfall 3: firstRunBuildingResponse depends on both state and metadata
**What goes wrong:** This function checks `crawlState === "crawling"` AND `!getMetadata(stmts, "last_crawl_timestamp")`. After splitting, it needs access to both CrawlManager and stmts.
**How to avoid:** Make it a method on CrawlManager (it already has access to stmts), or a standalone function that takes both as args. CrawlManager method is cleaner.

### Pitfall 4: FTS5 rebuild not in transaction
**What goes wrong:** If `cleanupOrphanedGenerations` deletes rows and then the FTS rebuild fails, you have orphaned FTS entries.
**How to avoid:** The existing code already wraps delete + rebuild in a transaction. Keep this pattern in the refactored code.

### Pitfall 5: Test isolation with SQLite
**What goes wrong:** Tests share a database instance and interfere with each other.
**How to avoid:** Each test (or test suite) creates its own `:memory:` database via `initDatabase(":memory:")`. The function already accepts an optional path parameter.

## Code Examples

### vitest test file structure

```typescript
// tests/crawl.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initDatabase, prepareStatements } from "../src/database.js";

describe("CrawlManager", () => {
  let db: ReturnType<typeof initDatabase>;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("prevents concurrent crawls for the same source", async () => {
    // ...
  });

  it("sequences doc crawl before blog crawl", async () => {
    // ...
  });
});
```

### Mocking fetch for network tests

```typescript
// tests/tools.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the fetch module before importing the module under test
vi.mock("../src/fetch.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "../src/fetch.js";

describe("fetchAndParse", () => {
  it("handles network timeout gracefully", async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(new Error("timeout"));
    // ...
  });
});
```

### Blog-exclusion orphan cleanup test

```typescript
// tests/database.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, prepareStatements, insertPageSections,
         finalizeGeneration, cleanupOrphanedGenerations } from "../src/database.js";
import type { PageSection } from "../src/types.js";

describe("orphan cleanup", () => {
  it("preserves blog rows when cleaning orphaned generations", () => {
    const db = initDatabase(":memory:");
    const stmts = prepareStatements(db);

    // Insert doc rows at generation 1
    const docSection: PageSection = {
      url: "https://platform.claude.com/docs/test",
      path: "/docs/test",
      title: "Test Doc",
      sectionHeading: null,
      sectionAnchor: null,
      content: "Doc content that is long enough to pass minimum size filter",
      sectionOrder: 0,
      source: "platform",
    };
    insertPageSections(db, stmts, [docSection], 1);

    // Insert blog rows at generation 1
    const blogSection: PageSection = {
      ...docSection,
      url: "https://anthropic.com/news/test",
      path: "/news/test",
      title: "Test Blog",
      content: "Blog content that is long enough to pass minimum size filter",
      source: "blog",
    };
    insertPageSections(db, stmts, [blogSection], 1);

    // Finalize generation 2 (doc crawl produced gen 2)
    // This deletes gen 1 docs but NOT blog rows
    finalizeGeneration(db, stmts, 2);

    // Blog row should survive
    const rows = db.prepare("SELECT * FROM pages WHERE source = 'blog'").all();
    expect(rows).toHaveLength(1);
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CommonJS + Jest | ESM + Vitest | 2023-2024 | Project already uses ESM + vitest |
| Module-level mutable state | Class instances with dependency injection | evergreen | Makes testing possible without module-level hacks |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none -- vitest auto-detects from package.json. May need vitest.config.ts for test file patterns |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01a | Crawl state transitions (idle->crawling->idle, idle->crawling->failed) | unit | `npx vitest run tests/crawl.test.ts -t "state transitions"` | No -- Wave 0 |
| TEST-01b | Staleness check triggers crawl at correct thresholds | unit | `npx vitest run tests/crawl.test.ts -t "staleness"` | No -- Wave 0 |
| TEST-01c | Tool response formatting (search results, disambiguation, errors) | unit | `npx vitest run tests/tools.test.ts -t "response format"` | No -- Wave 0 |
| TEST-02a | fetchAndParse handles network timeout | unit | `npx vitest run tests/network.test.ts -t "timeout"` | No -- Wave 0 |
| TEST-02b | fetchAndParse handles partial failure (one source down) | unit | `npx vitest run tests/network.test.ts -t "partial"` | No -- Wave 0 |
| TEST-02c | fetchBlogPages handles batch failures gracefully | unit | `npx vitest run tests/network.test.ts -t "blog batch"` | No -- Wave 0 |
| TEST-03 | Blog rows survive orphan cleanup / generation finalization | unit | `npx vitest run tests/database.test.ts -t "blog-exclusion"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run && npx tsc --noEmit`
- **Phase gate:** Full suite green + `npx tsc --noEmit` clean

### Wave 0 Gaps
- [ ] `tests/crawl.test.ts` -- covers TEST-01a, TEST-01b
- [ ] `tests/tools.test.ts` -- covers TEST-01c
- [ ] `tests/network.test.ts` -- covers TEST-02a, TEST-02b, TEST-02c
- [ ] `tests/database.test.ts` -- covers TEST-03
- [ ] `vitest.config.ts` -- configure test file patterns if needed (vitest may auto-detect `tests/` dir)

## Open Questions

1. **Should ContentSource implementations live in their own files or inline in crawl.ts?**
   - What we know: There are only 2 sources now (doc, blog). Phase 4 adds 2 more.
   - Recommendation: Keep them inline in crawl.ts for now. 4 sources is not enough to justify separate files. Phase 4 can split if needed.

2. **Should tools/ use one file per tool or group related tools?**
   - What we know: 5 tools, each 25-55 lines. One file per tool = more files but clearer ownership.
   - Recommendation: One file per tool. Each is self-contained and independently testable.

## Sources

### Primary (HIGH confidence)
- Project source code -- all 7 src/*.ts files read directly
- package.json -- confirmed vitest ^4.0.18, better-sqlite3 ^12.6.2
- CLAUDE.md -- project architecture documentation

### Secondary (MEDIUM confidence)
- vitest behavior with ESM TypeScript -- based on project already using `"type": "module"` and vitest successfully

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, everything already installed
- Architecture: HIGH -- straightforward extraction from a well-documented monolith
- Pitfalls: HIGH -- derived from reading the actual code and identifying state dependencies

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable refactoring patterns, no fast-moving dependencies)
