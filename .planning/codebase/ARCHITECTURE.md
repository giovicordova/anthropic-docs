# Architecture

**Analysis Date:** 2026-03-05

## Pattern Overview

**Overall:** Single-process MCP server with layered modules (transport -> tools -> data -> storage)

**Key Characteristics:**
- Six source files with strict single-responsibility separation
- Stdio-based JSON-RPC transport (MCP protocol) -- no HTTP server
- SQLite FTS5 for full-text search with BM25 ranking
- Generation-based atomic index swap for doc crawls; incremental append for blog crawls
- Background crawl on startup with staleness checks (1 day docs, 7 days blog)

## Layers

**Transport Layer (MCP/stdio):**
- Purpose: Receives tool calls from Claude Code via JSON-RPC over stdio
- Location: `src/index.ts` (lines 2-3, 460-466)
- Contains: `McpServer` instance, `StdioServerTransport`
- Depends on: `@modelcontextprotocol/sdk`
- Used by: Claude Code (external consumer)

**Tool Layer (request handling):**
- Purpose: Validates input, dispatches to data layer, formats responses
- Location: `src/index.ts` (lines 179-457)
- Contains: 5 registered tools (`search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`, `index_status`)
- Depends on: Data layer, Zod for input validation
- Used by: Transport layer

**Crawl Orchestration Layer:**
- Purpose: Manages crawl lifecycle, staleness checks, state machine
- Location: `src/index.ts` (lines 37-176)
- Contains: `startCrawl()`, `startBlogCrawl()`, `checkAndCrawl()`, `checkAndCrawlBlog()`, crawl state (`idle`/`crawling`/`failed`)
- Depends on: Parser layer, Blog parser layer, Data layer
- Used by: Tool layer (`refresh_index`), startup sequence

**Parser Layer (doc parsing):**
- Purpose: Fetches and parses `llms-full.txt` markdown files into structured pages/sections
- Location: `src/parser.ts`
- Contains: `fetchAndParse()`, `parsePages()`, `splitIntoSections()`, `pagesToSections()`
- Depends on: `src/config.ts` for URLs and thresholds, `src/types.ts` for interfaces
- Used by: Crawl orchestration layer

**Blog Parser Layer:**
- Purpose: Fetches blog posts via sitemap XML, converts HTML to markdown
- Location: `src/blog-parser.ts`
- Contains: `fetchSitemapUrls()`, `fetchBlogPages()`, `parseSitemap()`, `htmlToMarkdown()`, `parseBlogPage()`
- Depends on: `node-html-markdown`, `src/config.ts`, `src/types.ts`
- Used by: Crawl orchestration layer

**Data Layer (database):**
- Purpose: SQLite schema, FTS5 indexing, search queries, page retrieval, metadata
- Location: `src/database.ts`
- Contains: `initDatabase()`, `prepareStatements()`, `searchDocs()`, `getDocPage()`, `insertPageSections()`, `finalizeGeneration()`, `cleanupOrphanedGenerations()`, `getIndexedBlogUrls()`
- Depends on: `better-sqlite3`, `src/config.ts`, `src/types.ts`
- Used by: Crawl orchestration layer, Tool layer

**Shared Types & Config:**
- Purpose: Centralized type definitions and constants
- Location: `src/types.ts`, `src/config.ts`
- Contains: All interfaces (`ParsedPage`, `Section`, `PageSection`, `SearchResult`, `GetDocPageResult`, `Statements`), all constants (URLs, timeouts, thresholds, paths)
- Depends on: Nothing (leaf modules)
- Used by: Every other module

## Data Flow

**Doc Crawl (startup or refresh):**

1. `checkAndCrawl()` reads `last_crawl_timestamp` from metadata table
2. If stale (>1 day) or missing, calls `startCrawl()`
3. `startCrawl()` increments generation counter, calls `fetchAndParse()`
4. `fetchAndParse()` fetches both `llms-full.txt` files concurrently via `Promise.allSettled`
5. `parsePages()` splits raw text at `# heading` + `URL:`/`Source:` boundaries into `ParsedPage[]`
6. For each page, `pagesToSections()` calls `splitIntoSections()` to split at h2/h3 (with h4 sub-splits for oversized sections)
7. `insertPageSections()` writes sections to `pages` table + `pages_fts` in a transaction
8. `finalizeGeneration()` deletes old generation rows (excluding blog), rebuilds FTS index, updates generation metadata

**Blog Crawl (startup or refresh):**

1. `checkAndCrawlBlog()` reads `last_blog_crawl_timestamp` from metadata
2. If stale (>7 days) or missing, calls `startBlogCrawl()`
3. `fetchSitemapUrls()` fetches sitemap XML, extracts blog URLs via regex
4. `getIndexedBlogUrls()` queries existing blog URLs from DB
5. Diff: only new URLs are fetched (incremental)
6. `fetchBlogPages()` fetches HTML in batches of 10 with 200ms inter-batch delay
7. `htmlToMarkdown()` extracts `<article>` or `<main>` content, converts via `node-html-markdown`
8. Blog sections inserted at current generation (not new generation) -- blog rows persist across doc re-crawls
9. FTS index rebuilt after blog insert

**Search Query:**

1. Tool receives `query`, `source`, `limit` from Claude Code
2. `preprocessQuery()` strips special chars, wraps multi-word queries in quotes
3. FTS5 `MATCH` query with BM25 ranking (title 10x, heading 5x, content 1x)
4. Results returned as formatted markdown text

**Page Retrieval (get_doc_page):**

1. Tool receives URL path from Claude Code
2. 3-step fuzzy matching: exact path -> suffix LIKE -> segment LIKE
3. If single path matches: return concatenated sections
4. If multiple paths match: return disambiguation list

**State Management:**
- Crawl state is an in-memory enum (`idle`/`crawling`/`failed`) -- not persisted
- Index metadata (`last_crawl_timestamp`, `page_count`, `current_generation`) stored in `metadata` table
- No application-level caching beyond SQLite's WAL mode and prepared statements

## Key Abstractions

**ParsedPage:**
- Purpose: Represents one documentation page after parsing (before section splitting)
- Examples: `src/types.ts` (line 9-15), produced by `src/parser.ts` `parsePages()` and `src/blog-parser.ts` `parseBlogPage()`
- Pattern: Data transfer object between parser and database layers

**PageSection:**
- Purpose: Represents one section of a page, ready for database insertion
- Examples: `src/types.ts` (line 26-35), produced by `src/parser.ts` `pagesToSections()`
- Pattern: Flattened structure joining page metadata with section data

**Generation (integer):**
- Purpose: Atomic swap mechanism for doc index updates -- new crawl writes to generation N+1, then deletes generation N
- Examples: `src/database.ts` `insertPageSections()` (line 135), `finalizeGeneration()` (line 153)
- Pattern: Blue/green deployment pattern applied to database rows. Blog rows are excluded from generation swap (they use current generation and persist).

**Statements (cached prepared statements):**
- Purpose: Pre-compiled SQL statements passed through all database functions to avoid re-preparation
- Examples: `src/types.ts` (line 51-67), created in `src/database.ts` `prepareStatements()` (line 67)
- Pattern: Object bag of prepared statements initialized once at startup, threaded through all DB calls

## Entry Points

**Main Entry (`src/index.ts`):**
- Location: `src/index.ts` line 460-471
- Triggers: `node dist/index.js` (via `npm start` or Claude Code MCP config)
- Responsibilities: Initialize DB, prepare statements, clean orphans, check staleness and trigger crawls, connect stdio transport

**Binary Entry:**
- Location: `package.json` `"bin"` field points to `dist/index.js`
- Triggers: `npx anthropic-docs-mcp` or direct invocation
- Responsibilities: Same as main entry (shebang `#!/usr/bin/env node` at top of `src/index.ts`)

## Error Handling

**Strategy:** Fail gracefully per-source, never crash the server

**Patterns:**
- `Promise.allSettled` for concurrent fetches -- one source failing does not block others (`src/parser.ts` line 181, `src/blog-parser.ts` line 112)
- Crawl errors set `crawlState = "failed"` but server continues serving stale index (`src/index.ts` line 68)
- Blog crawl errors are caught and logged, return 0 instead of throwing (`src/index.ts` line 109-112)
- Tool handlers return `isError: true` responses instead of throwing (`src/index.ts` lines 227-236)
- First-run detection: if index is building, tools return "try again shortly" message (`src/index.ts` line 115-128)
- Orphaned rows from crashed crawls are cleaned up on startup (`src/index.ts` line 31-34)

## Cross-Cutting Concerns

**Logging:** All output goes to stderr via `console.error()` with `[module]` prefixes (`[server]`, `[parser]`, `[blog-parser]`). Never use `console.log` -- it corrupts the JSON-RPC stdio transport.

**Validation:** Input validation handled by Zod schemas in tool registrations (`src/index.ts`). Query preprocessing strips FTS5-special characters before search (`src/database.ts` `preprocessQuery()` line 178).

**Authentication:** None. This is a local-only MCP server running on stdio. No network-facing endpoints.

---

*Architecture analysis: 2026-03-05*
