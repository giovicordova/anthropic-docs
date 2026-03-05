---
phase: 04-content-expansion
plan: 02
subsystem: parser, crawl, tools
tags: [html-parsing, sitemap, content-sources, incremental-diff]

# Dependency graph
requires:
  - phase: 04-content-expansion
    provides: Extended DocSource type, parseHtmlPage, config constants, retagResearchPages, deletePagesBySource
provides:
  - modelSource ContentSource fetching 3 model page URLs
  - researchSource ContentSource with incremental sitemap diff for /research/
  - fetchSitemapEntriesForPrefix for prefix-filtered sitemap queries
  - Status display for all 4 content source types
  - Startup migration re-tagging /research/ blog rows
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [prefix-filtered-sitemap, source-parameterized-fetch]

key-files:
  created: []
  modified:
    - src/crawl.ts
    - src/blog-parser.ts
    - src/database.ts
    - src/index.ts
    - src/tools/status.ts
    - tests/crawl.test.ts
    - tests/blog-parser.test.ts
    - tests/tools.test.ts

key-decisions:
  - "modelSource uses fetchWithTimeout + parseHtmlPage per URL (sequential, 3 URLs)"
  - "researchSource reuses fetchBlogPages with source param for batch fetch"
  - "fetchSitemapEntriesForPrefix parses sitemap inline (no dependency on parseSitemapWithLastmod)"
  - "researchSource caps at MAX_RESEARCH_PAGES before passing to fetchBlogPages"

patterns-established:
  - "fetchSitemapEntriesForPrefix as reusable prefix-filtered sitemap query"
  - "fetchBlogPages source param for any HTML-to-markdown content source"

requirements-completed: [CONT-01, CONT-02]

# Metrics
duration: 5min
completed: 2026-03-05
---

# Phase 4 Plan 2: Content Source Implementations Summary

**modelSource and researchSource ContentSource implementations with incremental sitemap diff, server registration, startup migration, and status display for all 4 source types**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-05T17:17:23Z
- **Completed:** 2026-03-05T17:22:07Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- modelSource fetches 3 hardcoded model page URLs (opus, sonnet, haiku), parses HTML, indexes as source "model"
- researchSource does incremental sitemap diff for /research/ prefix with new/updated/deleted detection
- fetchSitemapEntriesForPrefix enables any prefix-based sitemap filtering
- fetchBlogPages accepts optional source param for non-blog HTML sources
- index.ts registers all 4 sources, runs retagResearchPages migration before crawl triggers
- buildStatusText displays model and research page counts, timestamps, crawl states, errors
- 118 tests passing (14 new tests added), no type errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement modelSource and researchSource, register in server, update status** - `680dc57` (test RED) + `0689ae2` (feat GREEN)
2. **Task 2: Add tests for new content sources and integration** - `f023e09` (test)

## Files Created/Modified
- `src/crawl.ts` - Added modelSource and researchSource ContentSource implementations
- `src/blog-parser.ts` - Added fetchSitemapEntriesForPrefix, source param on fetchBlogPages
- `src/database.ts` - Added getIndexedUrlsWithTimestamps parameterized by source
- `src/index.ts` - Registered all 4 sources, added retagResearchPages startup migration
- `src/tools/status.ts` - Added model and research source info with error tracking
- `tests/crawl.test.ts` - Added modelSource, researchSource, and 4-source CrawlManager tests
- `tests/blog-parser.test.ts` - Added fetchSitemapEntriesForPrefix and source param tests
- `tests/tools.test.ts` - Added model/research status display and error tests

## Decisions Made
- modelSource uses sequential fetchWithTimeout per URL (only 3 URLs, no batching needed)
- researchSource reuses fetchBlogPages with source="research" param for batch fetch
- fetchSitemapEntriesForPrefix parses sitemap XML inline rather than delegating to parseSitemapWithLastmod (keeps prefix filtering self-contained)
- researchSource applies MAX_RESEARCH_PAGES cap before passing URLs to fetchBlogPages

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 4 content sources (docs, blog, model, research) are fully implemented and registered
- Phase 4 content expansion is complete
- 118 tests provide safety net for all source types

---
*Phase: 04-content-expansion*
*Completed: 2026-03-05*
