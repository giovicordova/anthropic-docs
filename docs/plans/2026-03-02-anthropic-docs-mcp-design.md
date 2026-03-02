# Anthropic Docs MCP Server — Design

**Date:** 2026-03-02
**Status:** Approved

## Purpose

A local MCP server that gives Claude Code searchable access to the full Anthropic documentation (platform.claude.com/docs). Indexes English docs into a local SQLite database with full-text search.

## Key Decisions

- **Domain:** `platform.claude.com` (docs.anthropic.com redirects here)
- **Languages:** English only (~250 pages)
- **Search granularity:** Section-level (split at h2/h3 headings)
- **Storage:** SQLite with FTS5, stored at `~/.claude/mcp-data/anthropic-docs/docs.db`
- **Crawl strategy:** Sitemap XML → HTTP fetch → extract `article#content-container` → Turndown → split at headings
- **MCP SDK:** `@modelcontextprotocol/sdk` v1 stable with `registerTool()` API and Zod schemas
- **No `node-fetch`:** Node 22 has native fetch

## Architecture

```
Claude Code ←→ stdio ←→ MCP Server ←→ SQLite (docs.db)
                                ↑
                          Crawler (background)
                                ↑
                    platform.claude.com/sitemap.xml
```

Server starts → checks DB freshness → if stale/missing, crawls in background → tools work immediately with whatever data exists.

## Database Schema

### `pages` table

| Column | Type | Purpose |
|--------|------|---------|
| id | INTEGER PK | Auto-increment |
| url | TEXT | Full URL |
| path | TEXT | Path portion, e.g., `/docs/en/build-with-claude/tool-use` |
| title | TEXT | Page title from h1 |
| section_heading | TEXT | h2/h3 heading, NULL for page intro |
| section_anchor | TEXT | Anchor ID for deep linking |
| content | TEXT | Markdown content of this section |
| section_order | INTEGER | Order within page (0-based) |
| crawled_at | TEXT | ISO timestamp |

### `pages_fts` (FTS5 virtual table)

Indexes: `title`, `section_heading`, `content`
Weighted ranking: title > section_heading > content

### `metadata` table

| Column | Type | Purpose |
|--------|------|---------|
| key | TEXT PK | e.g., `last_crawl_timestamp` |
| value | TEXT | The value |

## Tools

### `search_anthropic_docs`

- **Input:** `query` (string), `limit` (number, default 10)
- **Output:** Array of `{ title, url, section_heading, snippet, relevance_score }`
- **Implementation:** FTS5 query with BM25 ranking, 200-char snippet

### `get_doc_page`

- **Input:** `path` (string)
- **Output:** Full markdown of the page (sections concatenated in order)
- **Implementation:** Filter pages by path, order by section_order, join content. Fuzzy match if exact path not found.

### `list_doc_sections`

- **Input:** none
- **Output:** Hierarchical list of all sections and pages grouped by path segments
- **Implementation:** SELECT DISTINCT path, title, grouped into tree structure

### `refresh_index`

- **Input:** none
- **Output:** Status message ("Refresh started, indexing ~N pages...")
- **Implementation:** Triggers background re-crawl, returns immediately

## Crawler

1. Fetch `platform.claude.com/sitemap.xml`
2. Parse XML, filter to `/docs/en/` URLs
3. Fetch pages with concurrency limit of 5
4. Extract `article#content-container` innerHTML
5. Convert to markdown with Turndown
6. Split at `## ` and `### ` headings into sections
7. Insert each section into database
8. Log progress to stderr
9. On error: skip page, continue

Staleness: check `metadata.last_crawl_timestamp` on startup. Re-crawl in background if > 7 days.

## Project Structure

```
anthropic-docs-mcp/
  package.json
  tsconfig.json
  src/
    index.ts          # MCP server, tool registration, stdio transport
    crawler.ts        # Sitemap discovery, page fetching, HTML extraction
    database.ts       # SQLite schema, indexing, search queries
    markdown.ts       # Turndown config, section splitting
  dist/               # Compiled output
```

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — schema validation (required by SDK)
- `better-sqlite3` — SQLite with FTS5
- `turndown` — HTML to markdown

## MCP Registration

Added to `~/.claude/.mcp.json`:

```json
{
  "anthropic-docs": {
    "command": "node",
    "args": ["/Users/giovannicordova/Documents/02_projects/anthropic-docs-mcp/dist/index.js"]
  }
}
```

## Verification Criteria

- Server starts and completes MCP handshake (responds to `initialize` and `tools/list`)
- SQLite DB created and populated at `~/.claude/mcp-data/anthropic-docs/docs.db`
- `search_anthropic_docs("tool use")` returns relevant results
- `get_doc_page` returns clean markdown for a known path
- `list_doc_sections` returns a structured table of contents
- `refresh_index` triggers re-crawl without blocking
