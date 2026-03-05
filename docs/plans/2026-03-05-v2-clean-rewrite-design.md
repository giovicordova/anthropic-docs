# anthropic-docs-mcp v2 — Clean Rewrite Design

**Date:** 2026-03-05
**Goal:** Rebuild the MCP server from scratch for reliability. Eliminate HTML parsing by switching to `llms-full.txt` as the sole data source. Same tool surface, simpler internals.

---

## Decisions

| Decision | Choice |
|----------|--------|
| Primary goal | Reliability — never break when Anthropic changes their site |
| Data sources | `llms-full.txt` only (platform + code) |
| HTML parsing | Eliminated entirely — no Turndown, no cheerio, no regex |
| Database engine | `better-sqlite3` with FTS5 (unchanged) |
| Tool surface | Same 5 tools, same names, same schemas |
| Architecture | 5 files (parser.ts replaces crawler.ts + markdown.ts, new types.ts) |
| Dependencies | 3 runtime (drop Turndown), 1 new dev (vitest) |
| DB schema | Unchanged — drop-in compatible with v1 |
| Project setup | Clean branch in current repo, merge to main when working |
| Tests | Parser, database, section splitting |

---

## Architecture

```
Claude Code <-> stdio <-> MCP Server (index.ts) <-> SQLite FTS5 DB
                              |
                         Parser (on startup if stale >1 day)
                              |
               platform.claude.com/llms-full.txt  (platform + api-reference)
               code.claude.com/docs/llms-full.txt (claude code docs)
```

### File Structure (5 files)

| File | Responsibility |
|------|---------------|
| `src/config.ts` | All constants: URLs, timeouts, thresholds, DB path |
| `src/index.ts` | MCP server, 5 tool registrations, crawl state, stdio transport |
| `src/parser.ts` | Fetches + parses both `llms-full.txt` files into page objects. Replaces `crawler.ts` + `markdown.ts` |
| `src/database.ts` | SQLite schema, FTS5, cached statements, search, page retrieval |
| `src/types.ts` | Shared interfaces (PageSection, SearchResult, etc.) |

### Dependencies

**Runtime (3):**
- `@modelcontextprotocol/sdk` — MCP protocol
- `better-sqlite3` — SQLite with FTS5
- `zod` — input validation

**Dev (4):**
- `typescript`
- `@types/better-sqlite3`
- `@types/node`
- `vitest`

**Removed from v1:**
- `turndown` (HTML->Markdown)
- `@types/turndown`

---

## Parser Design (`src/parser.ts`)

The biggest change. One file replaces three v1 code paths (platform HTML, API reference HTML, Claude Code txt).

**Input:** Two `llms-full.txt` URLs, each returning markdown text.

**Parsing strategy — unified for both sources:**

1. Fetch the full text (30s timeout — files are 10MB+)
2. Split into pages using delimiter patterns:
   - Platform: `# Title` followed by `URL: https://platform.claude.com/...`
   - Code: `# Title` followed by `Source: https://code.claude.com/...`
   - One regex handles both: `/^# (.+)\n(?:URL|Source): (https:\/\/.+)$/m`
3. For each page, extract `title`, `url`, `path` (from URL), and `content` (everything until next page delimiter or `---` separator)
4. Tag with `source` based on URL domain:
   - `platform.claude.com` -> `"platform"`
   - `code.claude.com` -> `"code"`
5. Detect API reference pages by path (e.g. `/docs/en/api/`) -> tag as `"api-reference"` instead of `"platform"`
6. Split content into sections at `##` and `###` headings (same logic as v1)
7. Filter stubs below 50 chars, split oversized sections at `####` (same as v1)

**What's eliminated:**
- HTML fetching per-page (500+ HTTP requests -> 2)
- HTML content extraction regex (`<article>`, `stldocs-root`)
- Turndown HTML->Markdown conversion
- Title extraction from HTML
- `processInBatches` concurrency helper

**Performance:** 2 fetches instead of ~500. Crawl time drops from ~30-60s to ~5-10s.

---

## Database Design (`src/database.ts`)

No schema changes. Drop-in compatible with v1 databases.

```sql
pages (id, url, path, title, section_heading, section_anchor,
       content, section_order, source, generation, crawled_at)
metadata (key, value)
pages_fts (title, section_heading, content)  -- FTS5 virtual table
```

**Preserved from v1:**
- Cached `Statements` interface with all prepared statements
- Generation-based atomic swap (insert new gen -> delete old -> rebuild FTS)
- Orphan cleanup on startup
- 3-step fuzzy path matching (exact -> suffix -> segment -> disambiguation)
- `preprocessQuery` for safe FTS5 input
- BM25 weighting: title 10x, heading 5x, content 1x

**Simplification:** Types move to `types.ts`. Database file only exports functions.

---

## Server & Tools (`src/index.ts`)

Identical tool surface. Same 5 tools, same names, same input schemas, same output formats.

### Tools

1. `search_anthropic_docs` — full-text search with source filter
2. `get_doc_page` — fetch page by path with fuzzy matching
3. `list_doc_sections` — browse all indexed pages grouped by source
4. `refresh_index` — re-fetch and rebuild index
5. `index_status` — lightweight health check

### Startup Flow

1. Init DB + prepare statements
2. Clean orphaned generations
3. Check staleness -> crawl if needed (background)
4. Connect stdio transport

No changes to crawl state machine (idle/crawling/failed), tool handlers, or output formatting.

---

## Testing

**Test runner:** vitest

**What to test:**
- Parser: sample `llms-full.txt` content -> correct page objects, titles, URLs, sources, section splits
- Database: insert, search, fuzzy path matching, disambiguation (in-memory SQLite)
- Section splitting: heading detection, stub filtering, oversized splitting

**What NOT to test:**
- Network fetches (mock-heavy, fragile)
- MCP tool registration (framework handles this)
- stdio transport

---

## Migration Path

1. Create clean branch `v2-rewrite`
2. Build and test v2
3. Merge to main when working
4. Existing DBs are compatible — no user action needed
