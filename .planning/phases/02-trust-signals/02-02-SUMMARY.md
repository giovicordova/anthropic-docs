---
phase: 02-trust-signals
plan: 02
subsystem: api, tools
tags: [mcp, staleness, trust-metadata, freshness-warnings]

# Dependency graph
requires:
  - phase: 02-trust-signals
    plan: 01
    provides: CrawlManager.getLastError(), source field on SearchResult, STALE_DAYS/BLOG_STALE_DAYS constants
provides:
  - buildMetadataFooter for per-source freshness timestamps on search results
  - Stale warning prepended to search when any source exceeds threshold
  - buildStatusText with crawl failure info in index_status
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [metadata-footer-on-search, stale-warning-pattern, testable-status-builder]

key-files:
  created: []
  modified:
    - src/tools/search.ts
    - src/tools/status.ts
    - tests/tools.test.ts

key-decisions:
  - "Extracted buildMetadataFooter as exported pure function for testability"
  - "Extracted buildStatusText with StatusCrawlInfo interface for duck-typed testing"
  - "Non-blog sources grouped under shared doc timestamp in footer"

patterns-established:
  - "Metadata footer: search results always end with per-source freshness info"
  - "Stale warning: prepended before footer when any source exceeds its threshold"
  - "StatusCrawlInfo: minimal interface for duck-typed testing of status tool"

requirements-completed: [TRST-01, TRST-02, TRST-03]

# Metrics
duration: 4min
completed: 2026-03-05
---

# Phase 02 Plan 02: Trust Metadata in Tool Responses Summary

**Per-source freshness timestamps and stale warnings on search results, crawl failure details in index_status**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-05T15:52:10Z
- **Completed:** 2026-03-05T15:56:32Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Search results include per-source crawl timestamp footer (doc sources grouped, blog separate)
- Stale warning prepended when any source exceeds freshness threshold
- index_status displays last failure reason and timestamp for docs and blog independently
- 9 new tests (6 staleness metadata + 3 failure info), 71 total passing

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Search staleness metadata and warnings**
   - `09d175d` (test) - Failing tests for staleness metadata
   - `20e4b35` (feat) - buildMetadataFooter + integration into search handler
2. **Task 2: Status tool failure info display**
   - `4320b75` (test) - Failing tests for failure info
   - `9beb845` (feat) - buildStatusText extraction + failure info lines

## Files Created/Modified
- `src/tools/search.ts` - Added buildMetadataFooter, imports for getMetadata/STALE_DAYS/BLOG_STALE_DAYS, footer appended to results and no-results
- `src/tools/status.ts` - Extracted buildStatusText with StatusCrawlInfo interface, added docs/blog failure lines
- `tests/tools.test.ts` - 9 new tests in "staleness metadata" and "failure info" describe blocks

## Decisions Made
- Extracted buildMetadataFooter as exported pure function (testable without MCP server)
- Extracted buildStatusText with StatusCrawlInfo duck-typed interface (testable without full CrawlManager)
- Non-blog sources grouped under single shared doc timestamp in footer (matching how the DB stores one timestamp for all doc sources)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 02 (Trust Signals) is now complete: all TRST requirements fulfilled
- 71 tests passing (62 existing + 9 new)
- Ready for Phase 03 or Phase 04

---
*Phase: 02-trust-signals*
*Completed: 2026-03-05*
