# Codebase Concerns

**Analysis Date:** 2026-03-05
**Last Updated:** 2026-03-05 (post-fix audit)

## Tech Debt

**~~Duplicate `fetchWithTimeout` function:~~** RESOLVED
- Extracted to shared `src/fetch.ts`. Both parsers import from there.

**~~Blog crawl has no `crawlState` guard:~~** RESOLVED
- Added `blogCrawlState` with same idle/crawling/failed pattern as doc crawl.

**~~`refresh_index` fires both crawls without awaiting:~~** RESOLVED
- Blog crawl now sequences after doc crawl completes via `.then()` chain.

**~~`as any` casts in database layer:~~** RESOLVED
- Added typed `SearchRow`, `PageRow`, `SectionRow` interfaces in `src/types.ts`.

**`index.ts` at ~480 lines and growing:**
- Issue: `src/index.ts` contains crawl orchestration, MCP tool definitions, state management, and the server entry point all in one file.
- Files: `src/index.ts`
- Impact: Adding new tools or crawl logic increases coupling. The `list_doc_sections` tool handler alone is 84 lines of formatting logic.
- Fix approach: Extract tool handlers into `src/tools/` modules. Extract crawl orchestration into `src/crawl.ts`. Keep `src/index.ts` as a thin entry point.

## Known Bugs

**~~`cleanupOrphanedGenerations` deletes blog rows on startup:~~** RESOLVED
- Added `AND source != 'blog'` guard matching `deleteOldGen`.

**~~Sitemap-diff uses `Array.includes()` on potentially large array:~~** RESOLVED
- Converted `indexedUrls` to a `Set` for O(1) lookups.

## Security Considerations

**~~No input sanitization on FTS5 queries beyond basic character stripping:~~** RESOLVED
- Added try/catch in `searchDocs` (database level). Returns empty results on FTS5 syntax errors instead of throwing.

**~~No rate limiting on external fetches:~~** RESOLVED
- Added `MAX_BLOG_PAGES = 1000` cap in `src/config.ts`. `fetchBlogPages` truncates and warns if exceeded.

**Database stored in user home directory without access restriction:**
- Risk: The SQLite database at `~/.claude/mcp-data/anthropic-docs/docs.db` is readable by any process running as the same user. Contains only public documentation content, so low severity.
- Recommendations: No action required. Location documented in CLAUDE.md.

## Performance Bottlenecks

**~~FTS5 rebuild on every blog crawl:~~** RESOLVED
- Removed unnecessary rebuild. Blog crawl only adds rows; FTS syncs via `insertFts` in `insertPageSections`.

**Blog HTML parsing loads full page into memory:**
- Problem: Each blog page's full HTML is loaded into a string, regex-matched for `<article>` or `<main>`, then converted to markdown.
- Files: `src/blog-parser.ts` (lines 34-47)
- Improvement path: Low priority. Blog pages are typically <100KB.

## Fragile Areas

**Page boundary detection in parser:**
- Files: `src/parser.ts` (lines 98-164)
- Why fragile: The `parsePages` function detects page boundaries by looking for `# heading` followed by `URL:` or `Source:` within the next 3 lines. If Anthropic changes the `llms-full.txt` format, parsing silently fails.
- Test coverage: Tests cover the happy path and preamble skipping. No tests for malformed input or format changes.

**HTML content extraction for blog:**
- Files: `src/blog-parser.ts` (lines 34-47)
- Why fragile: Relies on `<article>` or `<main>` tags. Site redesign could break extraction, falling back to full HTML including nav/footer.
- Test coverage: Unit tests cover the three fallback paths but use trivial HTML.

**Generation swap atomicity:**
- Files: `src/database.ts`, `src/index.ts`
- Why fragile: If the process crashes between `insertPageSections` and `finalizeGeneration`, orphaned rows remain. The `cleanupOrphanedGenerations` on next startup handles this correctly now (blog rows preserved).
- Test coverage: Generation swap is tested. Orphan cleanup is tested. Blog-exclusion in cleanup should be tested.

## Scaling Limits

**~~SQLite single-writer bottleneck (no busy_timeout):~~** RESOLVED
- Added `busy_timeout = 5000` pragma for multi-process safety.

**In-memory page accumulation during crawl:**
- Current capacity: ~550 pages loaded into memory as `ParsedPage[]` before insertion (~5-10MB).
- Scaling path: If data grows 10x+, switch to streaming insertion via async iterator. Low priority.

## Dependencies at Risk

**`node-html-markdown` (v2.0.0):**
- Risk: Niche package. Used only for blog HTML-to-markdown conversion.
- Migration plan: `turndown` (more popular) is a drop-in alternative. Isolated to `src/blog-parser.ts` line 32.

## Missing Critical Features

**No blog post deletion/update detection:**
- Problem: Blog crawl only detects new URLs via sitemap-diff. Removed or updated posts stay stale in the index forever.
- Impact: Index accuracy degrades over time.

**No graceful shutdown:**
- Problem: No `SIGTERM`/`SIGINT` handler. Process killed mid-crawl leaves partial generation data. Orphan cleanup on restart is the safety net.
- Impact: Low. Cleanup handles it.

## Test Coverage Gaps

**No tests for `src/index.ts` (crawl orchestration and tools):**
- What's not tested: Tool handlers, crawl state machine, staleness checks, `firstRunBuildingResponse`, `checkAndCrawl`, `checkAndCrawlBlog`.
- Risk: Regressions in tool response formatting, crawl state transitions, or staleness logic go unnoticed.
- Priority: High.

**No tests for `fetchAndParse` or `fetchBlogPages` (network functions):**
- What's not tested: HTTP error handling, timeout behavior, partial fetch failures.
- Files: `src/parser.ts`, `src/blog-parser.ts`
- Priority: Medium.

**`cleanupOrphanedGenerations` blog-exclusion not tested:**
- The bug is fixed but no test verifies blog rows survive orphan cleanup.
- Priority: High.

---

*Concerns audit: 2026-03-05 | 10 of 16 concerns resolved*
