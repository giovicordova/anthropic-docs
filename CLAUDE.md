# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local MCP server that indexes Anthropic documentation (platform.claude.com, code.claude.com, API reference) and Anthropic blog posts (news, research, engineering) into a searchable SQLite FTS5 database. Runs on stdio, exposes 5 tools for Claude Code to search, browse, list, refresh, and check index status.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm start            # Run MCP server (stdio transport)
npm test             # Run all tests (vitest)
npx tsc              # Type-check without emitting
```

## Architecture

```
Claude Code ↔ stdio ↔ MCP Server (index.ts) ↔ SQLite FTS5 DB
                           ↑
                      Parser (background, on startup if stale)
                           ↑
            platform.claude.com/llms-full.txt  (daily)
            code.claude.com/docs/llms-full.txt (daily)
            anthropic.com/sitemap.xml → HTML    (weekly, incremental)
```

Six source files, each with a single responsibility:

- **src/types.ts** — Shared interfaces (`ParsedPage`, `Section`, `PageSection`, `SearchResult`, `GetDocPageResult`, `Statements`). No logic.
- **src/config.ts** — Centralized constants (timeouts, URLs, thresholds, DB path). All magic numbers live here.
- **src/parser.ts** — Fetches and parses `llms-full.txt` from both sources. Splits pages at `# heading` + `URL:`/`Source:` boundaries, splits content into sections at h2/h3, filters stubs, splits oversized sections at h4. Pure markdown parsing, no HTML.
- **src/blog-parser.ts** — Fetches blog posts from anthropic.com via sitemap.xml. Parses sitemap XML for blog URLs (/news, /research, /engineering), fetches HTML pages in batches (10 concurrent, 200ms delay), converts HTML to markdown via `node-html-markdown`, extracts article content from `<article>` or `<main>` tags. Incremental: only fetches URLs not already indexed (sitemap-diff).
- **src/database.ts** — SQLite schema with `generation` column for atomic crawl swap (blog rows excluded from generation swap), FTS5 virtual table (BM25 weighted: title 10x, heading 5x, content 1x), search with query preprocessing, `get_doc_page` with 3-step fuzzy matching + disambiguation, metadata tracking, cached prepared statements via `Statements` interface, batched section inserts per page, and `getIndexedBlogUrls` for sitemap-diff. DB location: `~/.claude/mcp-data/anthropic-docs/docs.db`.
- **src/index.ts** — MCP server entry point. Registers 5 tools (`search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`, `index_status`), manages stdio transport, crawl state tracking (idle/crawling/failed), first-run detection, daily staleness check for docs, weekly staleness check for blog, and orphaned generation cleanup on startup.

## Data Sources

- **Platform docs**: `https://platform.claude.com/llms-full.txt` — ~488 pages (platform + api-reference). Plain markdown.
- **Claude Code docs**: `https://code.claude.com/docs/llms-full.txt` — ~59 pages. Plain markdown.
- **Anthropic blog**: `https://www.anthropic.com/sitemap.xml` → ~410 posts from /news, /research, /engineering. HTML fetched and converted to markdown. Incremental crawl (only new posts).

## Dependencies

4 runtime: `@modelcontextprotocol/sdk`, `better-sqlite3`, `node-html-markdown`, `zod`
2 dev: `typescript`, `vitest`

## Key Conventions

- All logging goes to **stderr** (`console.error`). Never use `console.log` — it corrupts the JSON-RPC stdio transport.
- Each indexed page is split into sections at h2/h3 headings. Sections are the unit of search and retrieval.
- The `source` column tags content as `"platform"`, `"code"`, `"api-reference"`, or `"blog"` for filtered search. API reference pages are auto-detected by path (`/docs/en/api/`). Blog posts are tagged `"blog"` and excluded from the doc generation swap (they persist across doc re-crawls).
- Blog staleness is 7 days (vs 1 day for docs). Blog crawl is incremental (sitemap-diff), not full re-crawl.
- Conventional commits: `type(scope): description`.
