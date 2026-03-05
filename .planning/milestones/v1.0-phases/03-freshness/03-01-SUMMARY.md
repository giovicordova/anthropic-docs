---
phase: 03-freshness
plan: 01
subsystem: infra
tags: [http-caching, etag, polling, sha256, conditional-fetch]

# Dependency graph
requires:
  - phase: 01-architecture
    provides: CrawlManager, ContentSource interface, fetchWithTimeout
provides:
  - conditionalFetch utility with ETag/Last-Modified support
  - contentHash SHA-256 dedup for doc content
  - Background polling timer (2h interval)
  - Reduced staleness thresholds (3h docs, 8h blog)
affects: [03-freshness]

# Tech tracking
tech-stack:
  added: [node:crypto (SHA-256)]
  patterns: [conditional HTTP requests, content hash fallback, background polling with .unref()]

key-files:
  created:
    - tests/fetch.test.ts
  modified:
    - src/types.ts
    - src/config.ts
    - src/fetch.ts
    - src/parser.ts
    - src/crawl.ts
    - src/index.ts
    - src/tools/status.ts
    - tests/crawl.test.ts
    - tests/network.test.ts
    - tests/shutdown.test.ts

key-decisions:
  - "Fractional days (STALE_DAYS=3/24) instead of renaming staleDays field -- less churn, same behavior"
  - "prepareStatements called inside docSource.fetch -- avoids changing ContentSource interface"
  - "Zero pages + no error = conditional skip (not threshold failure) -- early return in crawlSource"

patterns-established:
  - "Conditional fetch: send stored ETag/Last-Modified, handle 304 gracefully"
  - "Content hash fallback: SHA-256 comparison when HTTP conditional headers absent"
  - "Poll timer pattern: setInterval + .unref() + clearInterval on shutdown"

requirements-completed: [FRSH-01, FRSH-02]

# Metrics
duration: 5min
completed: 2026-03-05
---

# Phase 3 Plan 1: Freshness Summary

**HTTP conditional fetch (ETag/Last-Modified) with SHA-256 content hash fallback, 2-hour background polling, and 3h/8h staleness thresholds**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-05T16:15:18Z
- **Completed:** 2026-03-05T16:20:28Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- conditionalFetch sends ETag/Last-Modified headers and handles 304 Not Modified responses
- Content hash (SHA-256) prevents re-parsing when HTTP conditional headers are absent
- ETag, Last-Modified, and content hash values persist in metadata table across restarts
- Background poll timer fires every 2 hours without blocking process exit
- Staleness thresholds reduced from 1 day / 7 days to 3 hours / 8 hours

## Task Commits

Each task was committed atomically:

1. **Task 1: Add conditionalFetch, content hash, and update doc crawl pipeline** - `fd4f91a` (test) + `5758544` (feat)
2. **Task 2: Add background polling timer with shutdown cleanup** - `fa4e149` (feat)

_Task 1 used TDD: failing tests committed first, then implementation._

## Files Created/Modified
- `src/types.ts` - Added ConditionalFetchResult interface
- `src/config.ts` - Added POLL_INTERVAL_MS, STALE_HOURS, BLOG_STALE_HOURS; updated thresholds
- `src/fetch.ts` - Added conditionalFetch and contentHash functions
- `src/parser.ts` - fetchAndParse now uses conditionalFetch, returns FetchAndParseResult
- `src/crawl.ts` - docSource reads/writes conditional metadata; crawlSource handles conditional skip
- `src/index.ts` - Added polling timer with .unref() and shutdown cleanup
- `src/tools/status.ts` - Display staleness in hours instead of fractional days
- `tests/fetch.test.ts` - New: 7 tests for conditionalFetch and contentHash
- `tests/crawl.test.ts` - Added 2 tests for conditional skip behavior; updated staleness thresholds
- `tests/network.test.ts` - Updated mocks for conditionalFetch (was fetchWithTimeout)
- `tests/shutdown.test.ts` - Added 2 tests for poll timer cleanup

## Decisions Made
- Used fractional days (STALE_DAYS = 3/24) instead of renaming the `staleDays` field across all types and consumers. Less churn, identical behavior.
- Called prepareStatements inside docSource.fetch to read metadata. Avoids changing the ContentSource interface (which only passes db).
- Zero pages from docSource.fetch with no error = conditional skip. Returns early in crawlSource (idle state, timestamp updated) instead of triggering the threshold check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - UX] Updated status display from fractional days to hours**
- **Found during:** Task 1
- **Issue:** STALE_DAYS=0.125 displayed as "0.125 day(s)" in index_status -- confusing
- **Fix:** Added STALE_HOURS/BLOG_STALE_HOURS exports, status.ts displays hours
- **Files modified:** src/config.ts, src/tools/status.ts
- **Committed in:** 5758544 (part of Task 1 commit)

**2. [Rule 1 - Bug] Updated network.test.ts mocks for new parser signature**
- **Found during:** Task 1
- **Issue:** network.test.ts mocked fetchWithTimeout for fetchAndParse tests, but parser now uses conditionalFetch
- **Fix:** Updated mock to include conditionalFetch and contentHash; updated test assertions for FetchAndParseResult
- **Files modified:** tests/network.test.ts
- **Committed in:** 5758544 (part of Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 UX, 1 bug)
**Impact on plan:** Both necessary for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Conditional fetch infrastructure ready for any future content sources
- Poll timer active -- docs will stay fresh within hours automatically
- Ready for Plan 02 (if any further freshness work planned)

---
*Phase: 03-freshness*
*Completed: 2026-03-05*
