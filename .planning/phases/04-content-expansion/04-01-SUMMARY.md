---
phase: 04-content-expansion
plan: 01
subsystem: database, parser
tags: [sqlite, fts5, html-parsing, content-sources, typescript-unions]

# Dependency graph
requires:
  - phase: 01-architecture
    provides: ContentSource interface, CrawlManager, database module
provides:
  - Extended DocSource union with 'model' and 'research' values
  - Shared parseHtmlPage function for any HTML source
  - Fixed generation swap exclusions for all non-generation sources
  - Config constants for model and research sources
  - retagResearchPages migration function
  - deletePagesBySource utility function
affects: [04-02, 04-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [parameterized-source-exclusion, shared-html-parser]

key-files:
  created: []
  modified:
    - src/types.ts
    - src/config.ts
    - src/blog-parser.ts
    - src/database.ts
    - src/crawl.ts
    - tests/blog-parser.test.ts
    - tests/database.test.ts
    - tests/crawl.test.ts

key-decisions:
  - "parseHtmlPage delegates to htmlToMarkdown (same pipeline as parseBlogPage)"
  - "retagResearchPages is a one-time migration for existing /research/ blog rows"
  - "deletePagesBySource parameterized by source string for reuse across sources"

patterns-established:
  - "Non-generation source exclusion: use NOT IN list instead of single != check"
  - "parseHtmlPage as shared entry point for all HTML-based content sources"

requirements-completed: [CONT-01, CONT-02]

# Metrics
duration: 3min
completed: 2026-03-05
---

# Phase 4 Plan 1: Foundation for Content Expansion Summary

**Extended DocSource type, extracted shared parseHtmlPage, fixed hardcoded blog exclusions in generation swap and orphan cleanup**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-05T17:12:20Z
- **Completed:** 2026-03-05T17:15:13Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- DocSource union type extended with 'model' and 'research' values
- parseHtmlPage extracted as shared function with configurable source parameter
- Generation swap (deleteOldGen) and orphan cleanup both exclude model+research rows
- Blog path prefixes updated to exclude /research/ (now separate source)
- CrawlManager non-generation count query parameterized by source name
- 104 tests passing (4 new tests added, 2 existing tests updated)

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend types, config, extract parseHtmlPage, fix hardcoded exclusions** - `bec9fac` (feat)
2. **Task 2: Add tests for new foundation code** - `87845f7` (test)

## Files Created/Modified
- `src/types.ts` - Added 'model' and 'research' to DocSource union
- `src/config.ts` - Added MODEL_PAGE_URLS, staleness constants, RESEARCH_PATH_PREFIX, updated BLOG_PATH_PREFIXES
- `src/blog-parser.ts` - Extracted parseHtmlPage with DocSource param, refactored parseBlogPage to delegate
- `src/database.ts` - Fixed NOT IN exclusions, added retagResearchPages and deletePagesBySource
- `src/crawl.ts` - Parameterized non-generation count query with source.name
- `tests/blog-parser.test.ts` - Added parseHtmlPage tests, updated parseSitemap for /research/ exclusion
- `tests/database.test.ts` - Added model/research preservation and retagResearchPages tests
- `tests/crawl.test.ts` - Added parameterized count query test

## Decisions Made
- parseHtmlPage uses same htmlToMarkdown pipeline as parseBlogPage (consistency)
- retagResearchPages as migration function for existing /research/ blog rows before source separation
- deletePagesBySource parameterized by source string for reuse across model/research sources

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Type system ready for modelSource and researchSource implementations
- Config constants ready for model page URLs and research staleness
- Database exclusions correctly handle all non-generation sources
- parseHtmlPage ready to be called by model and research fetch functions

---
*Phase: 04-content-expansion*
*Completed: 2026-03-05*
