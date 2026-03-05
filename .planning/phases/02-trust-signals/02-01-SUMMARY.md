---
phase: 02-trust-signals
plan: 01
subsystem: api, database, infra
tags: [sqlite, mcp, crawl-safety, graceful-shutdown, error-tracking]

# Dependency graph
requires:
  - phase: 01-architecture
    provides: CrawlManager class, ContentSource interface, searchDocs function
provides:
  - CrawlManager.getLastError() for per-source error tracking
  - MIN_PAGE_RATIO safety threshold for generation crawls
  - SIGTERM/SIGINT graceful shutdown handler
  - source field on SearchResult and SearchRow types
affects: [02-trust-signals plan 02, tool response formatting]

# Tech tracking
tech-stack:
  added: []
  patterns: [page-count-safety-threshold, error-tracking-per-source, shutdown-guard-pattern]

key-files:
  created:
    - tests/shutdown.test.ts
  modified:
    - src/types.ts
    - src/config.ts
    - src/database.ts
    - src/crawl.ts
    - src/index.ts
    - tests/crawl.test.ts

key-decisions:
  - "Threshold check placed inside usesGeneration branch -- blog source automatically excluded"
  - "Error tracking uses Map<string, {message, timestamp}> -- simple, no new types needed"
  - "Shutdown handler placed after main() call -- ensures server and db are initialized"

patterns-established:
  - "Safety threshold: reject crawl when page count < 50% of previous (prevents silent data loss)"
  - "Error tracking: per-source last-error with timestamp for diagnostics"
  - "Shutdown guard: shuttingDown boolean prevents double-close on rapid signals"

requirements-completed: [TRST-03, TRST-04, TRST-05]

# Metrics
duration: 3min
completed: 2026-03-05
---

# Phase 02 Plan 01: Trust Infrastructure Summary

**Error tracking, page count safety threshold, graceful SIGTERM/SIGINT shutdown, and source field plumbing on search types**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-05T15:47:38Z
- **Completed:** 2026-03-05T15:50:09Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- CrawlManager tracks last error per source via getLastError() method
- Generation-based crawls rejected when page count drops below 50% of previous (prevents silent data loss from upstream issues)
- SIGTERM/SIGINT triggers clean server.close + db.close with double-fire guard
- SearchResult and SearchRow now include source field, searchDocs maps it from row data
- MIN_PAGE_RATIO constant (0.5) centralized in config.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Types, config, and source field plumbing** - `a22d409` (feat)
2. **Task 2: Error tracking, page count threshold, and graceful shutdown** - `03c355f` (feat)

## Files Created/Modified
- `src/types.ts` - Added source field to SearchResult and SearchRow interfaces
- `src/config.ts` - Added MIN_PAGE_RATIO = 0.5 constant
- `src/database.ts` - Maps row.source into searchDocs return objects
- `src/crawl.ts` - Error tracking Map, getLastError(), page count threshold check in generation branch
- `src/index.ts` - SIGTERM/SIGINT shutdown handler with shuttingDown guard
- `tests/crawl.test.ts` - 6 new tests for threshold and error tracking
- `tests/shutdown.test.ts` - 2 tests for shutdown guard pattern

## Decisions Made
- Threshold check placed inside usesGeneration branch so blog source is automatically excluded (no conditional needed)
- Error tracking uses simple Map instead of new CrawlError type -- keeps types.ts minimal
- Shutdown handler placed after main() call to ensure server and db exist

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- getLastError() ready for Plan 02 to surface in tool responses
- source field on SearchResult ready for Plan 02 trust metadata formatting
- All 62 tests pass (54 existing + 8 new)

---
*Phase: 02-trust-signals*
*Completed: 2026-03-05*
