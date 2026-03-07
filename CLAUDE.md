# CLAUDE.md

@VISION.md

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

## Data Sources

- **Platform docs**: `https://platform.claude.com/llms-full.txt` — ~488 pages (platform + api-reference). Plain markdown.
- **Claude Code docs**: `https://code.claude.com/docs/llms-full.txt` — ~59 pages. Plain markdown.
- **Anthropic blog**: `https://www.anthropic.com/sitemap.xml` → ~410 posts from /news, /research, /engineering. HTML fetched and converted to markdown. Incremental crawl (only new posts).

## Dependencies

4 runtime: `@modelcontextprotocol/sdk`, `better-sqlite3`, `node-html-markdown`, `zod`
2 dev: `typescript`, `vitest`

## Key Conventions

- Conventional commits: `type(scope): description`.
