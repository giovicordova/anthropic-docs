---
phase: 01-architecture-and-safety
plan: 02
subsystem: architecture
tags: [refactor, modular, crawl-manager, content-source, mcp-tools]

# Dependency graph
requires:
  - phase: 01-architecture-and-safety/01
    provides: "Safety-net test suite with crawl state contract and tool response format tests"
provides:
  - "CrawlManager class with ContentSource interface for extensible crawl orchestration"
  - "Modular tool handlers in src/tools/ (one file per MCP tool)"
  - "Thin index.ts entry point (34 lines, pure wiring)"
  - "ContentSource interface ready for Phase 4 new content sources"
affects: [02-trust-and-provenance, 03-freshness-engine, 04-content-expansion]

# Tech tracking
tech-stack:
  added: []
  patterns: [ContentSource interface for pluggable crawl sources, CrawlManager class for crawl orchestration, registerTool pattern per tool file]

key-files:
  created:
    - src/crawl.ts
    - src/tools/search.ts
    - src/tools/get-page.ts
    - src/tools/list-sections.ts
    - src/tools/refresh.ts
    - src/tools/status.ts
    - src/tools/index.ts
  modified:
    - src/types.ts
    - src/index.ts

key-decisions:
  - "ContentSource.fetch receives db param so blogSource can call getIndexedBlogUrls for sitemap-diff"
  - "Non-generation sources (blog) query total count from DB after insert rather than tracking in-memory"
  - "Blog crawl errors caught and logged (return 0) matching original behavior; doc crawl errors rethrown"
  - "checkAndCrawlAll triggers crawlAll on first stale source (sequential all-or-nothing)"
  - "index_status now shows blog crawl state separately"

patterns-established:
  - "ContentSource interface: name, staleDays, metaTimestampKey, metaCountKey, usesGeneration, fetch(db)"
  - "Tool registration pattern: registerXTool(server, stmts, crawl) per file"
  - "CrawlManager owns all crawl state -- no module-level mutable state"

requirements-completed: [ARCH-01, ARCH-02, ARCH-03, ARCH-04]

# Metrics
duration: 4min
completed: 2026-03-05
---

# Phase 1 Plan 2: Architecture Decomposition Summary

**Monolith index.ts (478 lines) decomposed into CrawlManager class, ContentSource interface, and 6 modular tool files while preserving all 54 existing tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-05T15:15:39Z
- **Completed:** 2026-03-05T15:19:30Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- CrawlManager class in src/crawl.ts with full crawl orchestration (state tracking, staleness checks, generation swap, sequential crawl ordering)
- ContentSource interface enabling pluggable content sources for Phase 4
- 5 MCP tool handlers extracted to individual files in src/tools/
- index.ts reduced from 478 to 34 lines (pure wiring, no business logic)
- All 54 tests pass unchanged (safety net from Plan 01 validates behavioral equivalence)

## Task Commits

Each task was committed atomically:

1. **Task 1: ContentSource interface, CrawlState type, CrawlManager class** - `65e1324` (feat)
2. **Task 2: Extract tool handlers, rewrite index.ts, verify tests** - `2ad1eee` (feat)

## Files Created/Modified
- `src/types.ts` - Added ContentSource interface and CrawlState type
- `src/crawl.ts` - CrawlManager class with docSource and blogSource implementations
- `src/tools/search.ts` - search_anthropic_docs tool handler
- `src/tools/get-page.ts` - get_doc_page tool handler
- `src/tools/list-sections.ts` - list_doc_sections tool handler
- `src/tools/refresh.ts` - refresh_index tool handler
- `src/tools/status.ts` - index_status tool handler
- `src/tools/index.ts` - registerTools barrel export
- `src/index.ts` - Thin entry point (34 lines)

## Decisions Made
- ContentSource.fetch receives db param so blogSource can call getIndexedBlogUrls for sitemap-diff
- Non-generation sources (blog) query total count from DB after insert rather than tracking in-memory -- slightly different from original (which added indexedSet.size + pages.length) but produces the same result
- Blog crawl errors caught and logged (return 0) matching original behavior; doc crawl errors rethrown
- checkAndCrawlAll triggers crawlAll on first stale source -- sequential all-or-nothing, preserving the requirement that blog reads generation set by doc crawl
- index_status now shows blog crawl state separately (minor enhancement, was implicit before)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Architecture decomposition complete -- all modules have single responsibilities
- ContentSource interface ready for Phase 4 (new content sources just implement the interface)
- CrawlManager testable in isolation (constructor injection of sources)
- Tool handlers independently testable (register function takes server, stmts, crawl)
- Phase 1 complete (both plans done)

---
*Phase: 01-architecture-and-safety*
*Completed: 2026-03-05*
