# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local MCP server that indexes Anthropic documentation (platform.claude.com, code.claude.com, API reference) into a searchable SQLite FTS5 database. Runs on stdio, exposes 5 tools for Claude Code to search, browse, list, refresh, and check index status.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm start            # Run MCP server (stdio transport)
npx tsc              # Type-check without emitting
```

No test suite exists yet.

## Architecture

```
Claude Code ↔ stdio ↔ MCP Server (index.ts) ↔ SQLite FTS5 DB
                           ↑
                      Crawler (background, on startup if stale >1 day)
                           ↑
            platform.claude.com/sitemap.xml
            code.claude.com/docs/llms-full.txt
```

Five source files, each with a single responsibility:

- **src/config.ts** — Centralized constants (timeouts, concurrency, URLs, thresholds, DB path). All magic numbers live here.
- **src/index.ts** — MCP server entry point. Registers 5 tools (`search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`, `index_status`), manages stdio transport, crawl state tracking (idle/crawling/failed), first-run detection, daily staleness check, and orphaned generation cleanup on startup.
- **src/crawler.ts** — Fetches pages from 3 sources (platform docs via `<article>`, API reference via `<div class="stldocs-root">`, Claude Code docs via llms-full.txt). Uses generation-based atomic crawl (old data preserved until new crawl completes). All fetches have 15s timeouts. Concurrency: 10 parallel fetches.
- **src/database.ts** — SQLite schema with `generation` column for atomic crawl swap, FTS5 virtual table (BM25 weighted: title 10x, heading 5x, content 1x), search with query preprocessing, `get_doc_page` with 3-step fuzzy matching + disambiguation, metadata tracking, cached prepared statements via `Statements` interface, and batched section inserts per page. DB location: `~/.claude/mcp-data/anthropic-docs/docs.db`.
- **src/markdown.ts** — HTML→Markdown via Turndown, section splitting at h2/h3 boundaries, stub filtering, oversized section splitting at h4.

## Key Conventions

- All logging goes to **stderr** (`console.error`). Never use `console.log` — it corrupts the JSON-RPC stdio transport.
- Each indexed page is split into sections at h2/h3 headings. Sections are the unit of search and retrieval.
- The `source` column tags content as `"platform"`, `"code"`, or `"api-reference"` for filtered search.
- Conventional commits: `type(scope): description`.
