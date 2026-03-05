# Codebase Concerns

**Analysis Date:** 2026-03-05

## Tech Debt

**Duplicate `fetchWithTimeout` function:**
- Issue: Identical `fetchWithTimeout` is defined in both `src/parser.ts` (line 169) and `src/blog-parser.ts` (line 72). Same signature, same logic, same User-Agent header.
- Files: `src/parser.ts`, `src/blog-parser.ts`
- Impact: Bug fixes or config changes (e.g., adding retry logic, changing headers) must be applied in two places.
- Fix approach: Extract into a shared `src/fetch.ts` utility and import from both parsers.

**Blog crawl has no `crawlState` guard:**
- Issue: `startBlogCrawl()` in `src/index.ts` (line 73) has no mutex or state check. Multiple blog crawls can run concurrently (e.g., if `refresh_index` is called during startup blog crawl). The `crawlState` variable only guards the doc crawl, not blog.
- Files: `src/index.ts` (lines 37-44 vs 73-113)
- Impact: Duplicate blog rows could be inserted if two blog crawls overlap, since sitemap-diff reads indexed URLs before the other crawl finishes inserting.
- Fix approach: Add a `blogCrawlState` guard identical to the doc `crawlState`, or unify into a single crawl state machine.

**`refresh_index` fires both crawls without awaiting:**
- Issue: `src/index.ts` lines 403-407 fire `startCrawl()` and `startBlogCrawl()` concurrently with independent `.catch()`. The blog crawl reads `getCurrentGeneration()` (line 94) which could return a stale value if the doc crawl is mid-finalization.
- Files: `src/index.ts` (lines 400-418)
- Impact: Blog sections could be inserted with a generation number that immediately gets swept by the doc crawl's `finalizeGeneration`. Blog posts would vanish until next blog crawl.
- Fix approach: Run blog crawl after doc crawl completes, or ensure blog crawl reads generation after doc finalization.

**`as any` casts in database layer:**
- Issue: `src/database.ts` uses `as any[]` casts for all query results (lines 208, 221, 224, 228, 233, 244, 245). This bypasses TypeScript's type safety on database row shapes.
- Files: `src/database.ts`
- Impact: If the schema changes, TypeScript will not catch mismatches. Runtime errors only.
- Fix approach: Define row interfaces (e.g., `SearchRow`, `PageRow`) and use them as generics on `.all<T>()` and `.get<T>()`.

**`index.ts` at 471 lines and growing:**
- Issue: `src/index.ts` contains crawl orchestration, MCP tool definitions, state management, and the server entry point all in one file.
- Files: `src/index.ts`
- Impact: Adding new tools or crawl logic increases coupling. The `list_doc_sections` tool handler alone (lines 294-378) is 84 lines of formatting logic.
- Fix approach: Extract tool handlers into `src/tools/` modules. Extract crawl orchestration into `src/crawl.ts`. Keep `src/index.ts` as a thin entry point that wires things together.

## Known Bugs

**`cleanupOrphanedGenerations` deletes blog rows on startup:**
- Symptoms: `cleanupOrphanedGenerations` in `src/database.ts` (line 171) uses `DELETE FROM pages WHERE generation != ?` without the `AND source != 'blog'` guard that `deleteOldGen` uses (line 77). On startup, if the blog was crawled at generation N and a new doc crawl bumps to N+1, the cleanup on next startup deletes all blog rows.
- Files: `src/database.ts` (lines 166-176)
- Trigger: Restart the server after a doc crawl that incremented the generation beyond the blog's generation.
- Workaround: Blog crawl re-indexes on next staleness check, but there is a window where blog search returns nothing.

**Sitemap-diff uses `Array.includes()` on potentially large array:**
- Symptoms: `src/index.ts` line 83 does `sitemapUrls.filter((url) => !indexedUrls.includes(url))`. With ~410 blog posts, this is O(n*m) on every blog crawl check.
- Files: `src/index.ts` (line 83)
- Trigger: Every blog crawl invocation.
- Workaround: Not a bug per se, but will degrade as blog post count grows. Convert `indexedUrls` to a `Set` for O(1) lookups.

## Security Considerations

**No input sanitization on FTS5 queries beyond basic character stripping:**
- Risk: `preprocessQuery` in `src/database.ts` (line 178) strips some special characters but the FTS5 query syntax is rich. Edge cases with certain character combinations could cause SQLite FTS5 syntax errors that bubble up as unhandled exceptions.
- Files: `src/database.ts` (lines 178-193)
- Current mitigation: The `search_anthropic_docs` tool handler wraps in try/catch and returns a user-friendly error. The query preprocessor strips `*"():^~{}[]`.
- Recommendations: Wrap FTS5 queries in a try/catch at the `searchDocs` level (not just tool level) so any caller is protected. Consider using FTS5's `quote()` function for full escaping.

**No rate limiting on external fetches:**
- Risk: A malicious or broken sitemap could list thousands of URLs, causing the server to hammer anthropic.com with batch requests.
- Files: `src/blog-parser.ts` (lines 103-135), `src/config.ts` (BLOG_CONCURRENCY = 10)
- Current mitigation: 200ms delay between batches, 10 concurrent max. No upper bound on total URLs.
- Recommendations: Add a `MAX_BLOG_PAGES` cap in `src/config.ts` (e.g., 1000) and log a warning if exceeded.

**Database stored in user home directory without access restriction:**
- Risk: The SQLite database at `~/.claude/mcp-data/anthropic-docs/docs.db` is readable by any process running as the same user. Contains only public documentation content, so low severity.
- Files: `src/config.ts` (line 12)
- Current mitigation: None needed for public data.
- Recommendations: No action required. Document the location for transparency (already done in CLAUDE.md).

## Performance Bottlenecks

**FTS5 rebuild on every blog crawl:**
- Problem: `src/index.ts` line 102 runs `INSERT INTO pages_fts(pages_fts) VALUES('rebuild')` after every blog crawl, even if only 1 new post was added.
- Files: `src/index.ts` (line 102)
- Cause: FTS5 rebuild reconstructs the entire full-text index. With ~1000+ sections, this takes noticeable time.
- Improvement path: The FTS5 content-sync already inserts individual FTS rows via `insertFts` in `insertPageSections`. The rebuild is only needed to clean up deleted rows. Since blog crawl only adds rows (never deletes), the rebuild is unnecessary. Remove it.

**Blog HTML parsing loads full page into memory:**
- Problem: Each blog page's full HTML is loaded into a string, regex-matched for `<article>` or `<main>`, then converted to markdown.
- Files: `src/blog-parser.ts` (lines 34-47)
- Cause: `node-html-markdown` operates on full HTML strings. Regex matching `<article>` with `[\s\S]*?` is non-greedy but still scans the entire string.
- Improvement path: Low priority. Blog pages are typically <100KB. Only matters if Anthropic starts publishing very large pages.

## Fragile Areas

**Page boundary detection in parser:**
- Files: `src/parser.ts` (lines 98-167)
- Why fragile: The `parsePages` function detects page boundaries by looking for `# heading` followed by `URL:` or `Source:` within the next 3 lines. If Anthropic changes the `llms-full.txt` format (e.g., adds metadata fields, changes delimiter style), parsing silently fails and returns 0 pages.
- Safe modification: Always test with real `llms-full.txt` data after changes. The parser test uses synthetic data that may not cover all format variations.
- Test coverage: Tests cover the happy path and preamble skipping. No tests for malformed input, partial downloads, or format changes.

**HTML content extraction for blog:**
- Files: `src/blog-parser.ts` (lines 34-47)
- Why fragile: Relies on `<article>` or `<main>` tags existing in Anthropic's blog HTML. If the site redesign changes these semantic tags, the fallback processes the entire HTML including nav/footer/scripts, polluting the index with garbage content.
- Safe modification: Check a few blog pages manually after any change. Add a content-length sanity check (if extracted content is >50KB, something is wrong).
- Test coverage: Unit tests cover the three fallback paths but use trivial HTML. No test with real-world blog HTML structure.

**Generation swap atomicity:**
- Files: `src/database.ts` (lines 153-164), `src/index.ts` (lines 40-71)
- Why fragile: `finalizeGeneration` deletes all non-blog rows with generation != N in a transaction. If the process crashes between `insertPageSections` and `finalizeGeneration`, orphaned rows from the new generation remain. The `cleanupOrphanedGenerations` on next startup handles this, but (as noted in bugs) it incorrectly deletes blog rows too.
- Safe modification: Fix the cleanup function first. Then any changes to generation logic are safe.
- Test coverage: Generation swap is tested. Orphan cleanup is tested. The blog-exclusion bug in cleanup is not tested.

## Scaling Limits

**SQLite single-writer bottleneck:**
- Current capacity: Single MCP server process, single writer. WAL mode allows concurrent reads during writes.
- Limit: If multiple Claude Code instances share the same DB file, write contention causes `SQLITE_BUSY` errors. Currently no retry or busy-timeout configured.
- Scaling path: Add `db.pragma("busy_timeout = 5000")` in `src/database.ts` to handle brief contention. For true multi-process, would need to move to a client-server database, but this is unlikely to be needed.

**In-memory page accumulation during crawl:**
- Current capacity: ~550 pages loaded into memory as `ParsedPage[]` before insertion.
- Limit: Each page is a few KB of markdown. Total is ~5-10MB. Not a concern for current data volume.
- Scaling path: If data grows 10x+, switch to streaming insertion (process and insert pages one at a time instead of collecting all first). The current architecture already inserts per-page in a loop, so the array could be replaced with an async iterator.

## Dependencies at Risk

**`node-html-markdown` (v2.0.0):**
- Risk: Niche package with modest maintenance activity. Used only for blog HTML-to-markdown conversion.
- Impact: If abandoned, blog indexing breaks on future HTML changes that the library cannot handle.
- Migration plan: Alternative packages include `turndown` (more popular, actively maintained). The conversion is isolated to `src/blog-parser.ts` line 32, making swaps trivial.

## Missing Critical Features

**No blog post deletion/update detection:**
- Problem: Blog crawl only detects new URLs via sitemap-diff. If Anthropic removes or updates a blog post, the stale/deleted content remains in the index forever.
- Blocks: Index accuracy degrades over time as blog content changes.

**No graceful shutdown:**
- Problem: No `SIGTERM`/`SIGINT` handler. If the process is killed mid-crawl, the database may have partial generation data. The orphan cleanup on next startup handles this, but could be cleaner.
- Blocks: Nothing critical. The orphan cleanup is the safety net.

## Test Coverage Gaps

**No tests for `src/index.ts` (crawl orchestration and tools):**
- What's not tested: Tool handlers, crawl state machine, staleness checks, `firstRunBuildingResponse`, `checkAndCrawl`, `checkAndCrawlBlog`.
- Files: `src/index.ts` (471 lines, 0% test coverage)
- Risk: Regressions in tool response formatting, crawl state transitions, or staleness logic go unnoticed.
- Priority: High. This is the largest file and the integration point for all other modules.

**No tests for `fetchAndParse` or `fetchBlogPages` (network functions):**
- What's not tested: HTTP error handling, timeout behavior, partial fetch failures (one source succeeds, one fails).
- Files: `src/parser.ts` (lines 178-212), `src/blog-parser.ts` (lines 81-135)
- Risk: Network edge cases (timeouts, 5xx, malformed responses) could crash the crawl or silently produce empty indexes.
- Priority: Medium. These use `Promise.allSettled` which is inherently resilient, but the error paths are untested.

**`cleanupOrphanedGenerations` blog-exclusion bug is not tested:**
- What's not tested: The cleanup function deleting blog rows (the bug described above).
- Files: `src/database.ts` (lines 166-176)
- Risk: The bug persists undetected because existing tests only check that orphaned rows are removed, not that blog rows survive.
- Priority: High. Directly causes data loss.

---

*Concerns audit: 2026-03-05*
