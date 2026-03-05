# Architecture Research

**Domain:** MCP server with background crawling and full-text search
**Researched:** 2026-03-05
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Entry Point (index.ts)                     │
│  Thin wiring: init DB, register tools, connect transport         │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
│  │  Tool Handlers  │  │  Tool Handlers  │  │  Tool Handlers  │    │
│  │  (search)       │  │  (pages)        │  │  (admin)        │    │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘      │
│          │                   │                   │                │
├──────────┴───────────────────┴───────────────────┴────────────────┤
│                     Crawl Orchestrator                             │
│  State machine, scheduling, sequencing, staleness checks           │
├───────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
│  │  Source: Docs   │  │  Source: Blog   │  │  Source: Future │    │
│  │  (llms-full)    │  │  (sitemap+HTML) │  │  (new sources)  │    │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘      │
│          │                   │                   │                │
├──────────┴───────────────────┴───────────────────┴────────────────┤
│                        Database Layer                              │
│  SQLite FTS5, generation swap, metadata, queries                   │
├───────────────────────────────────────────────────────────────────┤
│                     Types + Config (leaf modules)                  │
└───────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Entry point (`index.ts`) | Wire components together, connect transport, start server | 30-50 lines. Imports, initializes, connects. No logic. |
| Tool handlers (`tools/`) | Validate input, call data layer, format responses | One file per tool or grouped by function (search, pages, admin) |
| Crawl orchestrator (`crawl.ts`) | State machine, scheduling, staleness checks, sequencing | Single module owning all crawl lifecycle. No parsing, no DB writes. |
| Source adapters (`sources/`) | Fetch + parse one content source into `ParsedPage[]` | One module per source. Uniform interface: `fetch() => ParsedPage[]` |
| Database layer (`database.ts`) | Schema, FTS5, search, retrieval, metadata, generation swap | Already exists and is well-structured. Keep as-is. |
| Types + Config | Shared interfaces and constants | Already exists as leaf modules. Keep as-is. |

## Recommended Project Structure

```
src/
├── index.ts              # Entry point: init, wire, connect (thin)
├── tools/
│   ├── search.ts         # search_anthropic_docs handler
│   ├── pages.ts          # get_doc_page + list_doc_sections handlers
│   └── admin.ts          # refresh_index + index_status handlers
├── crawl.ts              # Crawl orchestrator: state, scheduling, sequencing
├── sources/
│   ├── types.ts          # ContentSource interface
│   ├── docs-source.ts    # llms-full.txt fetcher + parser (current parser.ts)
│   └── blog-source.ts    # sitemap + HTML fetcher + parser (current blog-parser.ts)
├── database.ts           # Keep as-is (already clean)
├── fetch.ts              # Keep as-is (shared HTTP utility)
├── types.ts              # Keep as-is (shared interfaces)
└── config.ts             # Keep as-is (constants)
```

### Structure Rationale

- **tools/**: Each tool handler is isolated. Adding a new tool means adding a file, not modifying a monolith. Grouped by function rather than one-file-per-tool because `get_doc_page` and `list_doc_sections` share the "first run building" guard and page-retrieval context.
- **crawl.ts**: Single file, not a folder. The orchestrator is one state machine -- splitting it further adds indirection without value. It imports source adapters and database layer, owns scheduling and sequencing.
- **sources/**: Each source adapter conforms to a shared interface. Adding a new content source (research papers, model pages) means adding a file that implements the interface. No changes to the orchestrator's core loop.

## Architectural Patterns

### Pattern 1: Source Adapter with Uniform Interface

**What:** Every content source implements the same interface. The orchestrator treats all sources identically.
**When to use:** When you have multiple data sources that produce the same output shape (pages/sections).
**Trade-offs:** Slight over-abstraction for two sources, but pays off immediately when adding a third (research papers, model pages are on the roadmap).

**Example:**
```typescript
// sources/types.ts
export interface ContentSource {
  name: string;
  staleAfterMs: number;
  metadataKey: string;  // e.g. "last_crawl_timestamp", "last_blog_crawl_timestamp"

  // Returns pages ready for section splitting + insertion
  fetch(context: CrawlContext): Promise<ParsedPage[]>;

  // Whether this source uses generation swap or incremental append
  strategy: "generation-swap" | "incremental";
}

export interface CrawlContext {
  db: Database.Database;
  stmts: Statements;
  currentGeneration: number;
}
```

```typescript
// sources/docs-source.ts
export const docsSource: ContentSource = {
  name: "docs",
  staleAfterMs: 1 * 24 * 60 * 60 * 1000,  // 1 day
  metadataKey: "last_crawl_timestamp",
  strategy: "generation-swap",

  async fetch(): Promise<ParsedPage[]> {
    return fetchAndParse();  // existing function
  },
};
```

### Pattern 2: Crawl State Machine

**What:** A single state machine manages crawl lifecycle for all sources, replacing the two separate `crawlState` / `blogCrawlState` variables and the duplicated `startCrawl` / `startBlogCrawl` functions.
**When to use:** When multiple crawl targets share the same lifecycle (idle -> crawling -> idle/failed) but differ in fetch logic and indexing strategy.
**Trade-offs:** More structured than two booleans, but the current codebase only has two sources. Worth it because the orchestrator replaces ~140 lines of duplicated logic with ~80 lines of unified logic.

**Example:**
```typescript
// crawl.ts
interface SourceState {
  source: ContentSource;
  status: "idle" | "crawling" | "failed";
}

export class CrawlOrchestrator {
  private sources: Map<string, SourceState> = new Map();

  register(source: ContentSource): void {
    this.sources.set(source.name, { source, status: "idle" });
  }

  async crawlIfStale(name: string): Promise<void> {
    const state = this.sources.get(name);
    if (!state || state.status === "crawling") return;

    const lastCrawl = getMetadata(this.stmts, state.source.metadataKey);
    if (lastCrawl && !this.isStale(lastCrawl, state.source.staleAfterMs)) return;

    state.status = "crawling";
    try {
      const pages = await state.source.fetch(this.context);
      this.indexPages(pages, state.source.strategy);
      setMetadata(this.stmts, state.source.metadataKey, new Date().toISOString());
      state.status = "idle";
    } catch (err) {
      state.status = "failed";
      console.error(`[crawl] ${name} failed: ${(err as Error).message}`);
    }
  }

  // Sequence: docs first (sets generation), then blog (appends to it)
  async crawlAll(): Promise<void> {
    await this.crawlIfStale("docs");
    await this.crawlIfStale("blog");
  }
}
```

### Pattern 3: Tool Handler Extraction

**What:** Each tool handler is a plain function that receives dependencies (stmts, orchestrator) and returns the MCP response shape. Registration happens in `index.ts` by calling `server.registerTool()` with the extracted handler.
**When to use:** When tool handlers contain significant formatting logic (the current `list_doc_sections` is 84 lines of markdown formatting).
**Trade-offs:** More files, but each is testable in isolation without spinning up an MCP server.

**Example:**
```typescript
// tools/search.ts
export function createSearchHandler(stmts: Statements, orchestrator: CrawlOrchestrator) {
  return async ({ query, source, limit }: { query: string; source: string; limit: number }) => {
    const building = orchestrator.firstRunBuildingResponse();
    if (building) return building;

    const results = searchDocs(stmts, query, limit, source);
    // ... format and return
  };
}

// index.ts
const handler = createSearchHandler(stmts, orchestrator);
server.registerTool("search_anthropic_docs", { description: "...", inputSchema: { ... } }, handler);
```

## Data Flow

### Crawl Flow (unified)

```
Startup / refresh_index tool
    |
    v
CrawlOrchestrator.crawlAll()
    |
    ├──> docs source: stale? ──> fetch llms-full.txt ──> parsePages() ──> pagesToSections()
    |        |                                                                    |
    |        v                                                                    v
    |    generation N+1 ──> insertPageSections(gen N+1) ──> finalizeGeneration(N+1)
    |
    ├──> blog source: stale? ──> fetchSitemapUrls() ──> diff with indexed ──> fetchBlogPages()
    |        |                                                                       |
    |        v                                                                       v
    |    current gen ──> insertPageSections(current gen) ──> update metadata
    |
    v
  Done (all sources idle)
```

### Query Flow (unchanged)

```
Claude Code ──> stdio ──> MCP Server ──> Tool Handler
                                              |
                                              v
                                    searchDocs(stmts, query)
                                              |
                                              v
                                    FTS5 MATCH + BM25 ranking
                                              |
                                              v
                                    Format as markdown ──> stdio ──> Claude Code
```

### State Management

```
CrawlOrchestrator (in-memory)
    |
    ├── sources: Map<name, { source, status }>    // runtime crawl state
    |
    v
metadata table (SQLite)
    |
    ├── last_crawl_timestamp          // persisted staleness
    ├── last_blog_crawl_timestamp     // persisted staleness
    ├── current_generation            // persisted generation counter
    ├── page_count                    // informational
    └── blog_page_count               // informational
```

### Key Data Flows

1. **Crawl pipeline:** Source adapter fetches raw content -> parses into `ParsedPage[]` -> orchestrator calls `pagesToSections()` -> orchestrator calls `insertPageSections()` -> orchestrator finalizes (generation swap or metadata update). The orchestrator owns the insert-and-finalize step, not the source adapter.
2. **Search query:** Tool handler validates input -> calls `searchDocs()` on database layer -> formats results as markdown -> returns to MCP transport.
3. **Staleness check:** Orchestrator reads metadata timestamp -> compares against source's `staleAfterMs` -> triggers crawl if stale. Happens at startup and on `refresh_index`.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| ~1000 pages (current) | Single-process, synchronous SQLite, in-memory page accumulation. Works well. |
| ~5000 pages | Still fine. Consider streaming inserts (async iterator) to reduce memory. |
| ~50000 pages | Stream pages during crawl instead of accumulating. Consider splitting FTS index by source for faster rebuilds. |

### Scaling Priorities

1. **First bottleneck:** Blog HTML fetching is the slowest part (~40s for 400 pages at 10 concurrent + 200ms delays). Already addressed by incremental crawl (only new URLs). If full re-crawl is needed (update detection), increase concurrency or add ETag/If-Modified-Since headers.
2. **Second bottleneck:** FTS5 rebuild after generation swap. Currently fast (~500ms for 1000 pages). Would only matter at 50k+ pages.

## Anti-Patterns

### Anti-Pattern 1: Mega Entry Point

**What people do:** Put tool handlers, crawl logic, state management, and transport setup all in one file.
**Why it's wrong:** This is the current state of `index.ts` (480 lines). Adding a tool or source means modifying the same file. Tool handlers can't be unit tested without the full MCP server. State management is tangled with tool response formatting.
**Do this instead:** Entry point should only wire components. Tool handlers in `tools/`. Crawl logic in `crawl.ts`. Each testable independently.

### Anti-Pattern 2: Source-Specific Crawl Functions

**What people do:** Write `startDocCrawl()` and `startBlogCrawl()` as separate functions with duplicated state management, error handling, and metadata updates.
**Why it's wrong:** Every new source requires copying the same boilerplate. State management (idle/crawling/failed) is duplicated. The sequencing logic (`doc crawl then blog crawl`) is ad-hoc.
**Do this instead:** Uniform `ContentSource` interface. Orchestrator handles state, error, and metadata for all sources. Sequencing is explicit in `crawlAll()`.

### Anti-Pattern 3: Source Adapters Writing to Database

**What people do:** Let source adapters import and call database functions directly.
**Why it's wrong:** The source adapter's job is fetch + parse. If it also writes to the DB, it needs to know about generations, FTS, and metadata -- concerns that belong to the orchestrator. Testing becomes harder because you need a real DB to test parsing.
**Do this instead:** Source adapters return `ParsedPage[]`. The orchestrator handles `pagesToSections()`, `insertPageSections()`, and `finalizeGeneration()`. Clean boundary: adapters are pure fetch+parse, orchestrator owns persistence.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| platform.claude.com/llms-full.txt | HTTP GET, full fetch, markdown parsing | Fail gracefully, serve stale index |
| code.claude.com/docs/llms-full.txt | HTTP GET, full fetch, markdown parsing | Same as above, fetched concurrently |
| anthropic.com/sitemap.xml | HTTP GET, regex XML parsing, batch HTML fetch | Incremental via sitemap-diff |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Entry point -> Tools | Function import + `server.registerTool()` | Tools are factory functions returning handlers |
| Tools -> Database | Direct function calls via `stmts` | No changes from current pattern |
| Tools -> Orchestrator | Method calls for status checks, `firstRunBuildingResponse()` | Tools need crawl state for status/refresh |
| Orchestrator -> Sources | `source.fetch(context)` returning `ParsedPage[]` | Uniform interface, orchestrator controls lifecycle |
| Orchestrator -> Database | `insertPageSections()`, `finalizeGeneration()`, metadata | Orchestrator owns write path during crawl |

## Build Order (dependencies between components)

This is the suggested implementation order based on dependencies:

1. **ContentSource interface** (`sources/types.ts`) -- no dependencies, defines the contract
2. **Refactor parsers into source adapters** (`sources/docs-source.ts`, `sources/blog-source.ts`) -- wraps existing `parser.ts` and `blog-parser.ts` with the interface. Existing modules stay intact; adapters are thin wrappers.
3. **CrawlOrchestrator** (`crawl.ts`) -- depends on ContentSource interface + database layer. Replaces the ~140 lines of crawl logic from `index.ts`.
4. **Extract tool handlers** (`tools/search.ts`, `tools/pages.ts`, `tools/admin.ts`) -- depends on database layer + orchestrator for status checks. Moves ~280 lines of tool logic from `index.ts`.
5. **Thin entry point** (`index.ts`) -- depends on everything above. Becomes ~40 lines of wiring.

Each step can be validated independently:
- Step 2: Source adapters are testable without the orchestrator (just call `fetch()` and check the output)
- Step 3: Orchestrator is testable with mock sources (inject fake `ContentSource` implementations)
- Step 4: Tool handlers are testable with mock `stmts` and mock orchestrator (no MCP server needed)

## Sources

- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture) -- official MCP architecture docs
- [MCP Server Development Guide](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-server-development-guide.md) -- community guide on server structure
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/) -- architecture and implementation patterns
- [TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- official SDK, tool registration patterns
- [Pipeline Pattern](https://dev.to/wallacefreitas/the-pipeline-pattern-streamlining-data-processing-in-software-architecture-44hn) -- pipeline architecture for data processing
- [MCP Tips and Pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) -- real-world MCP implementation lessons

---
*Architecture research for: MCP server with background crawling*
*Researched: 2026-03-05*
