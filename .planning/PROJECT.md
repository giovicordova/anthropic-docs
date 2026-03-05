# Anthropic Docs MCP

## What This Is

A local MCP server that keeps Claude Code informed with the latest Anthropic documentation, blog posts, research papers, and model information. It runs silently in the background — automatically polling 4 content sources every 2 hours — and surfaces freshness metadata so you always know how current the data is.

## Core Value

Claude Code always has access to current, accurate Anthropic facts — never working from stale training data.

## Requirements

### Validated

- ✓ Platform docs indexed from `llms-full.txt` (~488 pages) — v1.0
- ✓ Claude Code docs indexed from `llms-full.txt` (~59 pages) — v1.0
- ✓ Blog posts indexed from sitemap.xml (~410 posts) — v1.0
- ✓ FTS5 full-text search with BM25 ranking — v1.0
- ✓ 3-step fuzzy page retrieval with disambiguation — v1.0
- ✓ Section-level search (h2/h3 splitting) — v1.0
- ✓ Generation-based atomic index swap for docs — v1.0
- ✓ Incremental blog crawl via sitemap-diff — v1.0
- ✓ Source filtering (platform, code, api-reference, blog, model, research) — v1.0
- ✓ Modular architecture with ContentSource interface and CrawlManager — v1.0
- ✓ Unified crawl pipeline for all sources — v1.0
- ✓ Tool handlers extracted into separate modules — v1.0
- ✓ Test coverage: crawl state, network errors, tool responses (124 tests) — v1.0
- ✓ Per-source freshness timestamps on search results — v1.0
- ✓ Stale data warnings when index exceeds threshold — v1.0
- ✓ Crawl failure info in index_status — v1.0
- ✓ Graceful shutdown on SIGTERM/SIGINT — v1.0
- ✓ Minimum page count threshold (crawl safety) — v1.0
- ✓ Conditional fetch (ETag/Last-Modified/hash) — v1.0
- ✓ Background polling every 2 hours — v1.0
- ✓ Blog update/deletion detection via full sitemap diff — v1.0
- ✓ Model/product pages indexed as ContentSource — v1.0
- ✓ Research papers indexed from /research/ — v1.0

### Active

(None — next milestone not yet defined)

### Out of Scope

- Real-time webhooks — Anthropic doesn't publish doc change webhooks
- Non-Anthropic documentation — focus is Anthropic ecosystem only
- HTTP server mode — this is a local stdio MCP server
- Mobile or web UI — consumed only by Claude Code
- Semantic/vector search — FTS5 handles ~1000 pages well
- Multi-user support — personal tool, single-instance design

## Context

Shipped v1.0 with 4,666 LOC TypeScript across 7 source files + test suite.
Tech stack: Node.js 22+, TypeScript, SQLite FTS5, MCP SDK.
4 runtime deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `node-html-markdown`, `zod`.
124 tests passing. 4 content sources indexed. Background polling every 2h.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep SQLite + FTS5 | Works well, no scaling concerns for ~1000 pages | ✓ Good |
| Frequent polling over webhooks | Anthropic has no doc change webhook; polling every 2h is practical | ✓ Good |
| Unified crawl pipeline | Two separate paths created duplication; ContentSource interface solved it | ✓ Good |
| Extract tool handlers from index.ts | 480-line monolith was the top structural concern | ✓ Good — index.ts now 34 lines |
| ContentSource.fetch receives db param | blogSource needs getIndexedBlogUrls for sitemap-diff | ✓ Good |
| Fractional STALE_DAYS (3/24) | Avoids renaming staleDays field everywhere | ✓ Good |
| Per-source timestamp tracking in footer | Each source has independent freshness; grouped approach lost detail | ✓ Good |
| Generation swap excludes non-generation sources | Blog/model/research persist across doc re-crawls | ✓ Good |

## Constraints

- **Transport**: Must remain stdio-based MCP server (Claude Code integration)
- **Storage**: SQLite with FTS5 — proven, no reason to change
- **Runtime**: Node.js 22+, TypeScript, ESM modules
- **Dependencies**: Keep minimal (currently 4 runtime deps)
- **Data sources**: Only public Anthropic content (no auth required)

---
*Last updated: 2026-03-05 after v1.0 milestone*
