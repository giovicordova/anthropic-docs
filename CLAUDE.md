# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local MCP server that indexes Anthropic documentation (platform.claude.com, code.claude.com, API reference) into a searchable SQLite FTS5 database. Runs on stdio, exposes 5 tools for Claude Code to search, browse, list, refresh, and check index status.

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
                      Parser (background, on startup if stale >1 day)
                           ↑
            platform.claude.com/llms-full.txt
            code.claude.com/docs/llms-full.txt
```

Five source files, each with a single responsibility:

- **src/types.ts** — Shared interfaces (`ParsedPage`, `Section`, `PageSection`, `SearchResult`, `GetDocPageResult`, `Statements`). No logic.
- **src/config.ts** — Centralized constants (timeouts, URLs, thresholds, DB path). All magic numbers live here.
- **src/parser.ts** — Fetches and parses `llms-full.txt` from both sources. Splits pages at `# heading` + `URL:`/`Source:` boundaries, splits content into sections at h2/h3, filters stubs, splits oversized sections at h4. Pure markdown parsing, no HTML.
- **src/database.ts** — SQLite schema with `generation` column for atomic crawl swap, FTS5 virtual table (BM25 weighted: title 10x, heading 5x, content 1x), search with query preprocessing, `get_doc_page` with 3-step fuzzy matching + disambiguation, metadata tracking, cached prepared statements via `Statements` interface, and batched section inserts per page. DB location: `~/.claude/mcp-data/anthropic-docs/docs.db`.
- **src/index.ts** — MCP server entry point. Registers 5 tools (`search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`, `index_status`), manages stdio transport, crawl state tracking (idle/crawling/failed), first-run detection, daily staleness check, and orphaned generation cleanup on startup.

## Data Sources

Both sources are plain markdown (`llms-full.txt`). No HTML parsing, no sitemap crawling.

- **Platform docs**: `https://platform.claude.com/llms-full.txt` — ~488 pages (platform + api-reference)
- **Claude Code docs**: `https://code.claude.com/docs/llms-full.txt` — ~59 pages

## Dependencies

3 runtime: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`
2 dev: `typescript`, `vitest`

## Key Conventions

- All logging goes to **stderr** (`console.error`). Never use `console.log` — it corrupts the JSON-RPC stdio transport.
- Each indexed page is split into sections at h2/h3 headings. Sections are the unit of search and retrieval.
- The `source` column tags content as `"platform"`, `"code"`, or `"api-reference"` for filtered search. API reference pages are auto-detected by path (`/docs/en/api/`).
- Conventional commits: `type(scope): description`.
