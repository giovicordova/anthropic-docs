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

Source modules in `src/`:

- **types.ts** — Shared interfaces, no logic
- **config.ts** — Centralized constants (timeouts, URLs, thresholds, DB path)
- **fetch.ts** — HTTP fetch with timeout, conditional fetch, content hashing
- **parser.ts** — Parses `llms-full.txt` into pages and sections
- **blog-parser.ts** — Fetches blog posts via sitemap, converts HTML → markdown
- **database.ts** — SQLite FTS5 schema, BM25 search, fuzzy page lookup
- **index.ts** — MCP server entry point, 5 tools, crawl state management
- **crawl.ts** — Orchestrates incremental crawls per source, staleness checks
- **logger.ts** — Session logging for crawls, tool calls, and errors
- **tools/** — Individual tool implementations (search, get-page, list-sections, refresh, status)

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
- Blog staleness is 7 days (vs 1 day for docs). Blog crawl is incremental (sitemap-diff with Set lookup), not full re-crawl. Capped at `MAX_BLOG_PAGES` (1000) URLs per crawl.
- Conventional commits: `type(scope): description`.
