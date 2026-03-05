# External Integrations

**Analysis Date:** 2026-03-05

## APIs & External Services

**Anthropic Platform Docs:**
- URL: `https://platform.claude.com/llms-full.txt`
- Purpose: Fetch full platform documentation (~488 pages) as plain markdown
- Client: Native `fetch()` with 30s timeout and custom User-Agent (`anthropic-docs-mcp/2.0 (local indexer)`)
- Auth: None (public endpoint)
- Frequency: Daily staleness check on server startup
- Implementation: `src/parser.ts` → `fetchAndParse()`

**Claude Code Docs:**
- URL: `https://code.claude.com/docs/llms-full.txt`
- Purpose: Fetch Claude Code documentation (~59 pages) as plain markdown
- Client: Native `fetch()` with 30s timeout
- Auth: None (public endpoint)
- Frequency: Daily staleness check on server startup
- Implementation: `src/parser.ts` → `fetchAndParse()`

**Anthropic Blog (Sitemap):**
- URL: `https://www.anthropic.com/sitemap.xml`
- Purpose: Discover blog post URLs under `/news/`, `/research/`, `/engineering/` prefixes
- Client: Native `fetch()` with 30s timeout
- Auth: None (public endpoint)
- Frequency: Weekly staleness check on server startup
- Implementation: `src/blog-parser.ts` → `fetchSitemapUrls()`

**Anthropic Blog (Pages):**
- URLs: Individual blog post pages from `anthropic.com`
- Purpose: Fetch HTML blog posts, convert to markdown for indexing (~410 posts)
- Client: Native `fetch()` with batched concurrency (10 parallel, 200ms inter-batch delay)
- Auth: None (public pages)
- Frequency: Incremental (sitemap-diff — only fetches URLs not already indexed)
- Implementation: `src/blog-parser.ts` → `fetchBlogPages()`

## Data Storage

**Database:**
- SQLite 3 via `better-sqlite3` (synchronous, native bindings)
- Location: `~/.claude/mcp-data/anthropic-docs/docs.db`
- Schema defined inline in `src/database.ts` → `initDatabase()`
- Tables:
  - `pages` — Indexed doc sections (url, path, title, section_heading, content, source, generation)
  - `pages_fts` — FTS5 virtual table (BM25 ranking: title 10x, heading 5x, content 1x). Tokenizer: `porter unicode61`.
  - `metadata` — Key-value store for crawl timestamps and counters
- Indexes: `idx_pages_path`, `idx_pages_source`, `idx_pages_generation`
- WAL mode enabled for concurrent read/write
- Generation-based atomic swap for doc crawls (blog rows excluded from swap)
- Directory auto-created on first run

**File Storage:**
- Local filesystem only (SQLite DB file)

**Caching:**
- SQLite prepared statements cached in `Statements` interface (`src/types.ts`)
- No external cache

## Authentication & Identity

**Auth Provider:**
- Not applicable. This is a local tool server with no user authentication.
- All external endpoints are public; no API keys required.

## Monitoring & Observability

**Error Tracking:**
- None (local tool)

**Logs:**
- All logging via `console.error` (stderr) to avoid corrupting JSON-RPC on stdout
- Log prefix pattern: `[server]`, `[parser]`, `[blog-parser]`
- Logs crawl progress, page counts, errors, and staleness checks

## CI/CD & Deployment

**Hosting:**
- Local machine only. Runs as a stdio MCP server registered in Claude Code's MCP config.

**CI Pipeline:**
- None detected

## Environment Configuration

**Required env vars:**
- None. All configuration is hardcoded in `src/config.ts`.

**Secrets location:**
- Not applicable. No secrets or API keys used.

## Webhooks & Callbacks

**Incoming:**
- None. Server communicates exclusively via stdin/stdout JSON-RPC (MCP protocol).

**Outgoing:**
- None.

## Network Behavior

**Fetch Pattern:**
- All HTTP requests use Node.js native `fetch()` (no axios/got)
- Custom User-Agent header: `anthropic-docs-mcp/2.0 (local indexer)`
- AbortController timeout: 30s (configured in `src/config.ts` as `FETCH_TIMEOUT_MS`)
- `Promise.allSettled` used for parallel fetches — partial failures don't block other sources
- Blog fetches batched: 10 concurrent with 200ms inter-batch delay

**Resilience:**
- Doc crawl: If one source fails (platform or code), the other still indexes
- Blog crawl: Individual page fetch failures logged and skipped
- Crawl state tracked (`idle`/`crawling`/`failed`) to prevent concurrent crawls
- Orphaned generation rows cleaned up on startup

---

*Integration audit: 2026-03-05*
