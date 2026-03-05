# Requirements: Anthropic Docs MCP

**Defined:** 2026-03-05
**Core Value:** Claude Code always has access to current, accurate Anthropic facts

## v1 Requirements

### Architecture

- [x] **ARCH-01**: Tool handlers extracted from index.ts into separate modules under src/tools/
- [x] **ARCH-02**: Crawl orchestration extracted from index.ts into src/crawl.ts
- [x] **ARCH-03**: Unified crawl pipeline via ContentSource interface replacing separate doc/blog paths
- [x] **ARCH-04**: index.ts reduced to thin entry point (wiring only)

### Trust

- [ ] **TRST-01**: Search results include last crawl timestamp per source
- [ ] **TRST-02**: Search results warn when index data exceeds staleness threshold
- [ ] **TRST-03**: index_status tool shows crawl failure reason and timestamp
- [ ] **TRST-04**: Graceful shutdown on SIGTERM/SIGINT (clean timer teardown, DB close)
- [ ] **TRST-05**: Minimum page count threshold before accepting a crawl result (prevents partial failure from wiping index)

### Testing

- [x] **TEST-01**: Tool handler tests covering crawl state transitions, staleness checks, response formatting
- [x] **TEST-02**: Network function tests for fetchAndParse and fetchBlogPages (error handling, timeouts, partial failures)
- [x] **TEST-03**: Blog-exclusion test verifying blog rows survive orphan cleanup

### Freshness

- [ ] **FRSH-01**: Content change detection via ETag/Last-Modified/hash before re-parsing unchanged content
- [ ] **FRSH-02**: Background polling every 1-2 hours (configurable interval, timer with .unref())
- [ ] **FRSH-03**: Blog update/deletion detection (full sitemap comparison, not just new URL detection)

### Content

- [ ] **CONT-01**: Index model/product pages (/claude/opus, /claude/sonnet, /claude/haiku) as a new ContentSource
- [ ] **CONT-02**: Index research papers from /research/ section of anthropic.com

## v2 Requirements

### Freshness

- **FRSH-04**: Polling frequency configuration (user-tunable interval)
- **FRSH-05**: Incremental doc crawl (detect changed sections, not just changed file)

### Observability

- **OBSV-01**: Crawl health dashboard in index_status (pages per source, last crawl duration, error history, next scheduled crawl)

### Search Quality

- **SRCH-01**: Query preprocessing improvements (synonym expansion, better tokenization)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Semantic/vector search | FTS5 handles ~1000 pages well. Vector search adds embedding dependency for minimal gain at this corpus size |
| HTTP server mode | Local stdio MCP server for Claude Code only. MCP spec supports remote transport natively if needed later |
| Web UI | Claude Code IS the UI. Exposing everything through MCP tools is sufficient |
| Non-Anthropic documentation | Scope creep. Context7, docs-mcp-server handle general docs. This tool's value is being the best at Anthropic content |
| Multi-user support | Personal tool, single-instance design |
| OAuth/authentication | All content is public. No auth needed |
| Real-time webhooks | Anthropic doesn't publish doc change webhooks. Polling is the practical approach |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARCH-01 | Phase 1 | Complete |
| ARCH-02 | Phase 1 | Complete |
| ARCH-03 | Phase 1 | Complete |
| ARCH-04 | Phase 1 | Complete |
| TRST-01 | Phase 2 | Pending |
| TRST-02 | Phase 2 | Pending |
| TRST-03 | Phase 2 | Pending |
| TRST-04 | Phase 2 | Pending |
| TRST-05 | Phase 2 | Pending |
| TEST-01 | Phase 1 | Complete |
| TEST-02 | Phase 1 | Complete |
| TEST-03 | Phase 1 | Complete |
| FRSH-01 | Phase 3 | Pending |
| FRSH-02 | Phase 3 | Pending |
| FRSH-03 | Phase 3 | Pending |
| CONT-01 | Phase 4 | Pending |
| CONT-02 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-05*
*Last updated: 2026-03-05 after roadmap creation*
