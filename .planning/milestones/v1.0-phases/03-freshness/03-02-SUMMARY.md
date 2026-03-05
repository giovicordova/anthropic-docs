---
phase: 03-freshness
plan: 02
subsystem: infra
tags: [sitemap-diff, lastmod, blog-crawl, incremental-update, fts5]

# Dependency graph
requires:
  - phase: 03-freshness
    provides: CrawlManager, ContentSource interface, conditionalFetch, blog crawl pipeline
provides:
  - parseSitemapWithLastmod for extracting url+lastmod from sitemap XML
  - Blog diff categorization (new/updated/deleted/unchanged) in blogSource.fetch
  - getIndexedBlogUrlsWithTimestamps for timestamp-based comparison
  - deleteBlogPages for removing stale blog rows with FTS rebuild
  - Safety threshold preventing mass-deletion from incomplete sitemaps
affects: [03-freshness]

# Tech tracking
tech-stack:
  added: []
  patterns: [sitemap lastmod diffing, timestamp-based update detection, safety threshold for deletions]

key-files:
  created: []
  modified:
    - src/types.ts
    - src/blog-parser.ts
    - src/database.ts
    - src/crawl.ts
    - tests/blog-parser.test.ts
    - tests/database.test.ts
    - tests/crawl.test.ts

key-decisions:
  - "fetchSitemapEntries added alongside fetchSitemapUrls (not replacing) to avoid breaking existing consumers"
  - "String comparison for lastmod vs crawled_at -- both ISO 8601, lexicographic comparison is correct"
  - "deleteBlogPages rebuilds FTS only once after all deletions (not per-URL)"

patterns-established:
  - "Sitemap diff: categorize entries as new/updated/deleted/unchanged using lastmod timestamps"
  - "Safety threshold: skip deletions when sitemap count < MIN_PAGE_RATIO * indexed count"

requirements-completed: [FRSH-03]

# Metrics
duration: 4min
completed: 2026-03-05
---

# Phase 3 Plan 2: Blog Sitemap Diff Summary

**Full sitemap diff for blog crawl: detect new, updated, and deleted posts using lastmod timestamps with safety threshold for mass-deletion prevention**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-05T16:23:05Z
- **Completed:** 2026-03-05T16:27:06Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- parseSitemapWithLastmod extracts url + lastmod from sitemap XML blocks
- Blog crawl now detects all four categories: new, updated, deleted, unchanged
- Updated posts are deleted then re-fetched with fresh content
- Deleted posts are removed from pages table and FTS index is rebuilt
- Safety threshold prevents deletion when sitemap appears incomplete (< 50% of indexed)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add parseSitemapWithLastmod and blog DB helpers** - `c01404b` (test) + `ebe6607` (feat)
2. **Task 2: Upgrade blogSource to full sitemap diff** - `1e7a950` (test) + `49f7460` (feat)

_Both tasks used TDD: failing tests committed first, then implementation._

## Files Created/Modified
- `src/types.ts` - Added SitemapEntry interface (url + lastmod)
- `src/blog-parser.ts` - Added parseSitemapWithLastmod and fetchSitemapEntries functions
- `src/database.ts` - Added getIndexedBlogUrlsWithTimestamps and deleteBlogPages functions
- `src/crawl.ts` - Rewrote blogSource.fetch with full diff logic (new/updated/deleted/unchanged)
- `tests/blog-parser.test.ts` - 4 new tests for parseSitemapWithLastmod
- `tests/database.test.ts` - 4 new tests for getIndexedBlogUrlsWithTimestamps and deleteBlogPages
- `tests/crawl.test.ts` - 7 new tests for blog sitemap diff (mocked HTTP, real DB)

## Decisions Made
- Added fetchSitemapEntries alongside existing fetchSitemapUrls rather than replacing it. fetchSitemapUrls is still used in existing tests and could be used by other consumers.
- Used simple string comparison for lastmod vs crawled_at. Both are ISO 8601 timestamps, so lexicographic comparison produces correct results.
- deleteBlogPages rebuilds FTS once after all deletions rather than per-URL. More efficient for batch deletes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Blog crawl pipeline is now fully incremental with update and deletion support
- Phase 3 (Freshness) is complete -- conditional fetch, polling, and blog diff all implemented
- Ready for Phase 4 if any further work is planned

---
*Phase: 03-freshness*
*Completed: 2026-03-05*
