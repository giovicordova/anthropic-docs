# Feature Landscape

**Domain:** Documentation indexing MCP server for keeping an LLM current with Anthropic docs
**Researched:** 2026-03-05
**Overall confidence:** HIGH

## Table Stakes

Features users expect from a documentation indexing MCP server. Missing any of these and the tool feels broken or untrustworthy.

| Feature | Why Expected | Complexity | Status | Notes |
|---------|--------------|------------|--------|-------|
| Full-text search with ranking | Every doc tool must answer "find docs about X" accurately. BM25 or semantic search is baseline. Microsoft, AWS, Google, Context7 all have this. | Med | DONE | FTS5 with BM25 weighting (title 10x, heading 5x, content 1x) |
| Page retrieval by topic/URL | Users need to pull up a specific doc page. Google has `get_document`, AWS has `read_documentation`, Microsoft has `docs_fetch`. | Med | DONE | 3-step fuzzy matching with disambiguation |
| Source filtering | Users search "platform docs" vs "blog" vs "API reference" differently. AWS separates API docs from guides. | Low | DONE | Source column: platform, code, api-reference, blog |
| Section-level granularity | Whole pages are too large for LLM context. Every serious doc tool chunks at heading boundaries. | Med | DONE | Splits at h2/h3, oversized sections split at h4 |
| Automatic background indexing | Users should never have to manually trigger a crawl. Google re-indexes within 24 hours. AWS and Microsoft serve live. | Med | PARTIAL | Daily for docs, weekly for blog. Should be every 1-2 hours. |
| Freshness metadata in results | Users must know "is this from yesterday or 3 weeks ago?" Without timestamps, trust erodes. AWS and Google both surface this. | Low | MISSING | No last-updated timestamp in search results or page retrieval |
| Stale data warnings | When the index is old (crawl failed, network down), the tool should say so proactively. MCP best practice: surface `isError` for failures. | Low | MISSING | No warning when index age exceeds threshold |
| Error surfacing on crawl failure | If a crawl fails, the user should know via `index_status` or inline warnings. Silent failures are the worst pattern. | Low | PARTIAL | crawlState tracks "failed" but doesn't surface reason or timestamp |
| Manual refresh trigger | Escape hatch: "I know docs changed, re-crawl now." Every doc tool has this. | Low | DONE | `refresh_index` tool exists |
| Index status reporting | "What's indexed? How old? How many pages?" Baseline observability. | Low | DONE | `index_status` tool exists |
| Incremental updates | Full re-crawl of 1000 pages on every check is wasteful. Blog already uses sitemap-diff. Docs should detect changes too. | Med | PARTIAL | Blog is incremental. Docs do full re-parse of llms-full.txt every time. |
| Graceful degradation on network failure | If crawl fails, serve stale data and say so. Never return empty results because a crawl errored. | Low | DONE | Generation swap means old data persists until new crawl succeeds |

## Differentiators

Features that set this tool apart from generic doc MCP servers. Not expected, but valuable.

| Feature | Value Proposition | Complexity | Status | Notes |
|---------|-------------------|------------|--------|-------|
| Content change detection for docs | Detect when llms-full.txt actually changed (hash/ETag/Last-Modified) before re-parsing. Saves CPU and avoids unnecessary DB churn. Google does 24h re-index; this could be smarter. | Low | MISSING | Currently re-parses regardless of whether content changed |
| Blog update/deletion detection | Catch when a blog post is edited or removed, not just when new URLs appear. Current sitemap-diff only detects additions. | Med | MISSING | Noted in CONCERNS.md as a gap |
| Polling frequency configuration | Let users tune crawl interval (hourly for active dev, daily for casual use). No other doc MCP server exposes this. | Low | MISSING | Hardcoded to daily/weekly |
| Cross-source search synthesis | Search across docs + blog + API reference in one query with source-aware ranking. Most doc MCP servers are single-source. | Low | DONE | Already searches across all sources with optional filtering |
| Crawl health dashboard via tool | `index_status` could show: pages per source, last crawl time, last crawl duration, errors encountered, next scheduled crawl. Richer than competitors. | Low | PARTIAL | Shows basic counts but not crawl history or error details |
| Model/product page indexing | Index /claude/opus, /claude/sonnet pages for current model info. No competitor does this for Anthropic content. | Med | MISSING | Listed in PROJECT.md as active requirement |
| Research paper indexing | Go beyond blog summaries to index actual research content. Unique to Anthropic-focused tool. | High | MISSING | Listed in PROJECT.md. Complex: PDFs, different content structure |
| Semantic search option | Add vector embeddings alongside FTS5 for meaning-based search. docs-mcp-server (arabold) supports this. Overkill for ~1000 pages but could improve result quality. | High | MISSING | FTS5 keyword search works well for current corpus size |
| Graceful shutdown handler | Clean SIGTERM/SIGINT handling to avoid orphaned generation data. Infrastructure-grade reliability. | Low | MISSING | Listed in CONCERNS.md. Orphan cleanup on restart is the safety net. |

## Anti-Features

Features to explicitly NOT build. These look tempting but add complexity without proportional value.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Real-time webhooks | Anthropic has no doc change webhook. Building a webhook listener for a source that doesn't publish events is wasted infrastructure. | Poll every 1-2 hours. Use HTTP ETag/Last-Modified to skip unchanged content. |
| HTTP server mode | This is a local stdio MCP server for Claude Code. Adding HTTP transport doubles the attack surface and maintenance burden for zero users. | Stay stdio-only. If remote access is needed later, MCP spec supports it natively. |
| Web UI for managing index | docs-mcp-server has a web UI at localhost:6280. Overkill for a single-purpose Anthropic docs tool. Claude Code IS the UI. | Expose everything through MCP tools (`index_status`, `refresh_index`). |
| Semantic/vector search | For ~1000 pages of well-structured Anthropic docs, FTS5 with BM25 weighting is sufficient. Vector search adds an embedding dependency (OpenAI/Ollama), increases complexity 3x, and the corpus isn't large enough to benefit meaningfully. | Keep FTS5. Improve query preprocessing instead (synonym expansion, better tokenization). |
| Non-Anthropic documentation | Scope creep. Context7, docs-mcp-server, and Google's MCP already handle general documentation. This tool's value is being the best at Anthropic content specifically. | Stay focused on Anthropic ecosystem: docs, blog, API reference, models, research. |
| Content caching beyond SQLite WAL | SQLite with WAL mode already handles concurrent reads during writes. Adding Redis, memcached, or an in-memory cache layer is premature optimization for a local tool. | Trust SQLite. It handles this corpus size trivially. |
| OAuth/authentication | All indexed content is public Anthropic documentation. Auth adds complexity for zero security benefit. | No auth needed. DB permissions are OS-level (same-user access only). |
| Multi-user support | This is a personal tool running locally per developer. Multi-tenancy is architectural baggage. | Single-user, single-instance design. |

## Feature Dependencies

```
Frequent polling (1-2h) → Content change detection (ETag/hash)
  (Without change detection, frequent polling wastes resources re-parsing identical content)

Freshness metadata in results → Crawl timestamp tracking
  (Must store when each source was last successfully crawled)

Stale data warnings → Freshness metadata
  (Can't warn about staleness without tracking freshness)

Blog update/deletion detection → Full sitemap comparison (not just new URL detection)
  (Must compare full URL set + potentially check Last-Modified per URL)

Model/product page indexing → New parser for HTML pages (similar to blog parser)
  (Product pages aren't in llms-full.txt; need HTML fetching like blog)

Research paper indexing → PDF parsing capability + new content type
  (Requires new dependency for PDF extraction, new source tag)
```

## MVP Recommendation

The project already has core search and indexing working. The next milestone should focus on **reliability and trust** -- making the tool feel like infrastructure that "just works."

**Priority 1 -- Trust signals (Low complexity, high impact):**
1. Freshness metadata in search results (last crawl timestamp per source)
2. Stale data warnings when index exceeds age threshold
3. Better error surfacing (crawl failure reason + timestamp in `index_status`)

**Priority 2 -- Freshness improvement (Low-Med complexity, high impact):**
4. Content change detection via ETag/Last-Modified/hash before re-parsing
5. Increase polling frequency to 1-2 hours (gated on change detection)
6. Blog update/deletion detection

**Priority 3 -- Content expansion (Med complexity, medium impact):**
7. Model/product page indexing (/claude/opus, /claude/sonnet)
8. Graceful shutdown handler

**Defer:**
- Research paper indexing: High complexity (PDF parsing), unclear ROI. Revisit after core reliability is solid.
- Semantic search: FTS5 is sufficient for current corpus. Revisit only if search quality complaints emerge.
- Polling frequency configuration: Hardcode a good default (1-2h) first. Make configurable only if users request it.

## Competitive Landscape

| Capability | This Project | Context7 | Microsoft MCP | AWS MCP | Google MCP | docs-mcp-server |
|------------|-------------|----------|---------------|---------|------------|-----------------|
| Scope | Anthropic only | Multi-library | Microsoft only | AWS only | Google only | Any docs site |
| Search type | FTS5/BM25 | Context-aware | Semantic/vector | Semantic | Semantic | FTS + optional vectors |
| Freshness | Daily/weekly poll | Live fetch | Live API | Live API | 24h re-index | On-demand fetch |
| Offline capable | Yes (SQLite) | No | No | No | No | Yes (local index) |
| Section-level results | Yes | Yes | No | No | No | Varies |
| Source filtering | Yes | By library | No | By doc type | No | No |
| Self-hosted | Yes (local) | Remote + local | Remote | Remote | Remote | Local |

**Key advantage:** This is the only tool purpose-built for Anthropic documentation, running fully offline with a local SQLite index. No network dependency at query time. The gap is freshness and observability.

## Sources

- [Google Developer Knowledge API and MCP Server](https://developers.googleblog.com/introducing-the-developer-knowledge-api-and-mcp-server/) -- 24h re-indexing, search + fetch tools
- [Microsoft Learn MCP Server](https://github.com/MicrosoftDocs/mcp) -- 3 tools: search, fetch, code samples; real-time; token budget control
- [AWS Documentation MCP Server](https://awslabs.github.io/mcp/servers/aws-documentation-mcp-server) -- search, read, SOPs; live API access
- [Context7 MCP Server](https://github.com/upstash/context7) -- Library resolution + versioned doc query; live fetch
- [docs-mcp-server (arabold)](https://github.com/arabold/docs-mcp-server) -- Multi-format indexing, optional semantic search, web UI
- [MCP Error Handling Best Practices](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) -- isError flag, structured error responses
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/) -- Input validation, error surfacing patterns
- [CData MCP Best Practices 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026) -- Production deployment patterns
