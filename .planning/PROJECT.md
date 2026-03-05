# Anthropic Docs MCP

## What This Is

A local MCP server that keeps Claude Code informed with the latest Anthropic documentation, blog posts, research papers, and model information. It runs silently in the background, automatically polling for new content, and surfaces freshness metadata so you always know how current the data is.

## Core Value

Claude Code always has access to current, accurate Anthropic facts — never working from stale training data.

## Requirements

### Validated

- [x] Platform docs indexed from `llms-full.txt` (~488 pages) — existing
- [x] Claude Code docs indexed from `llms-full.txt` (~59 pages) — existing
- [x] Blog posts indexed from sitemap.xml (~410 posts from /news, /research, /engineering) — existing
- [x] FTS5 full-text search with BM25 ranking — existing
- [x] 3-step fuzzy page retrieval with disambiguation — existing
- [x] Section-level search (h2/h3 splitting) — existing
- [x] Generation-based atomic index swap for docs — existing
- [x] Incremental blog crawl via sitemap-diff — existing
- [x] Source filtering (platform, code, api-reference, blog) — existing

### Active

- [ ] Simplify `index.ts` monolith — extract tool handlers, crawl orchestration
- [ ] Unify crawl system — single crawl pipeline for all sources instead of two separate paths
- [ ] Fix remaining 6 open concerns from CONCERNS.md
- [ ] Add test coverage for index.ts (tool handlers, crawl state, staleness)
- [ ] Add test coverage for network functions (fetchAndParse, fetchBlogPages)
- [ ] Add test for blog-exclusion in orphan cleanup
- [ ] Frequent background polling (every 1-2 hours) instead of daily/weekly staleness
- [ ] Freshness metadata in search results (last updated timestamp)
- [ ] Stale data warnings when index is older than threshold
- [ ] Blog update/deletion detection (not just new URL detection)
- [ ] Index model/product pages (/claude/opus, /claude/sonnet, etc.)
- [ ] Index research papers from /research/ (beyond blog summaries)
- [ ] Graceful shutdown handler (SIGTERM/SIGINT)

### Out of Scope

- Real-time webhooks — Anthropic doesn't publish doc change webhooks
- Non-Anthropic documentation — focus is Anthropic ecosystem only
- HTTP server mode — this is a local stdio MCP server
- Mobile or web UI — consumed only by Claude Code
- Content caching layer beyond SQLite WAL — premature optimization

## Context

This is a brownfield project. The core functionality works: docs and blog are indexed, search returns relevant results, pages can be retrieved. The codebase was recently audited (CONCERNS.md) and 10 of 16 issues were resolved.

The main problems are structural: `index.ts` is a 480-line monolith mixing tool handlers, crawl orchestration, and state management. Two separate crawl pipelines (docs vs blog) use different logic for the same basic operation. Test coverage has significant gaps in the most critical code (tool handlers, crawl state machine).

The user wants this to run silently and reliably — like infrastructure. Search results should show freshness. Failures should surface clearly. Content should stay current within hours, not days.

## Constraints

- **Transport**: Must remain stdio-based MCP server (Claude Code integration)
- **Storage**: SQLite with FTS5 — proven, no reason to change
- **Runtime**: Node.js 22+, TypeScript, ESM modules
- **Dependencies**: Keep minimal (currently 4 runtime deps)
- **Data sources**: Only public Anthropic content (no auth required)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep SQLite + FTS5 | Works well, no scaling concerns for ~1000 pages | -- Pending |
| Frequent polling over webhooks | Anthropic has no doc change webhook; polling every 1-2h is close enough | -- Pending |
| Unify crawl pipeline | Two separate paths (docs/blog) create duplication and inconsistency | -- Pending |
| Extract tool handlers from index.ts | 480-line monolith is the top structural concern | -- Pending |

---
*Last updated: 2026-03-05 after initialization*
