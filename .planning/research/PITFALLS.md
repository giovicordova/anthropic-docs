# Domain Pitfalls

**Domain:** MCP documentation indexing server (stdio, SQLite FTS5, crawl pipelines)
**Researched:** 2026-03-05

## Critical Pitfalls

Mistakes that cause data loss, silent corruption, or require rewrites.

### Pitfall 1: FTS5 External Content Table Desync

**What goes wrong:** The FTS5 virtual table (`pages_fts`) uses `content='pages'` (external content mode). If rows are deleted from `pages` without corresponding deletes from `pages_fts`, the FTS index contains phantom entries. If rows are inserted into `pages` without a matching `insertFts`, searches miss real content. The current code does paired inserts correctly, but `finalizeGeneration` bulk-deletes old-gen rows from `pages` and then runs `rebuild` on FTS. If the rebuild fails or is interrupted, the FTS index is corrupt until next successful rebuild.

**Why it happens:** FTS5 external content tables put 100% of sync responsibility on application code. There are no triggers enforcing consistency. SQLite will not warn you -- queries just return wrong results silently.

**Consequences:** Search returns stale results pointing to deleted pages, or misses newly indexed pages. Users see "page not found" for results that appear in search. No error is thrown.

**Prevention:**
- Wrap the entire `deleteOldGen` + `rebuildFts` + `setGeneration` in a single transaction (already done in `finalizeGeneration`). Keep it that way.
- After any refactor that changes how rows are deleted or inserted, run an integrity check: `INSERT INTO pages_fts(pages_fts) VALUES('integrity-check')`. Add this as a test assertion.
- Never delete from `pages` outside of `finalizeGeneration` or `cleanupOrphanedGenerations` without also rebuilding FTS.

**Detection:** Search returns a result whose URL 404s when passed to `get_doc_page`. Test: search for a term, verify every result resolves to a real page.

**Phase relevance:** Crawl pipeline unification. When merging doc and blog crawl paths into a single pipeline, the generation/deletion logic will be restructured. This is the highest-risk moment for FTS desync.

---

### Pitfall 2: stdout Corruption in stdio MCP Server

**What goes wrong:** Any `console.log()` call, any library that writes to stdout, or any unhandled error that dumps to stdout will inject non-JSON-RPC data into the stdio transport. The MCP client (Claude Code) silently drops the connection or returns cryptic errors.

**Why it happens:** stdio transport uses stdout exclusively for JSON-RPC messages. Node.js libraries, debug output, and stack traces all default to stdout. During refactoring, it is easy to add a temporary `console.log` or import a library that writes to stdout internally.

**Consequences:** MCP server appears to crash from Claude Code's perspective. No useful error message. Hard to diagnose because the server process is still running.

**Prevention:**
- The codebase already uses `console.error` everywhere. Add a lint rule or startup guard that patches `console.log` to throw: `console.log = () => { throw new Error('Use console.error for MCP stdio servers'); };`
- When adding dependencies, verify they do not write to stdout. `node-html-markdown` and `better-sqlite3` are safe. New deps need checking.
- Redirect `process.stdout` writes through a guard in development.

**Detection:** MCP tools stop responding after a code change. Check `smoke_stderr.txt` or similar logs. If the server starts but tools hang, stdout pollution is the likely cause.

**Phase relevance:** Every phase. Any code change can introduce this. The guard should go in during the first refactoring phase.

---

### Pitfall 3: Generation Swap Race During Background Polling

**What goes wrong:** With frequent polling (every 1-2 hours), a doc crawl could start while a search or `get_doc_page` query is reading from the database. The `finalizeGeneration` transaction deletes all old-gen rows and rebuilds FTS in one transaction. During that transaction, readers are blocked (WAL mode allows concurrent reads, but the FTS rebuild is a write that holds the lock). If the crawl is triggered by a timer while a tool handler is mid-query, the tool handler times out or returns partial results.

**Why it happens:** `better-sqlite3` is synchronous -- all DB operations block the event loop. A `finalizeGeneration` call during a tool handler's execution will block until the transaction completes. With daily crawls this rarely overlaps. With hourly polling, the window grows.

**Consequences:** Tool responses become slow (blocked by FTS rebuild), or searches return empty results during the rebuild window. `busy_timeout = 5000` helps but a full FTS rebuild of ~1000 pages can take longer than 5 seconds.

**Prevention:**
- Run crawl operations during idle periods. Do not fire `setInterval` blindly -- check if any tool handler is currently executing before starting a crawl.
- Consider replacing the full FTS `rebuild` with incremental FTS operations: delete FTS rows for old-gen pages, then delete the pages rows. This avoids the expensive full rebuild.
- Keep `busy_timeout` but monitor if 5000ms is sufficient for the growing index.

**Detection:** Intermittent slow responses from search or get_doc_page during crawl windows. Log crawl duration and compare against `busy_timeout`.

**Phase relevance:** Background polling phase. This is the phase where crawl frequency increases from daily to hourly, directly widening the race window.

---

### Pitfall 4: Blog Rows Surviving Generation Swap -- Invariant Violation During Refactoring

**What goes wrong:** Blog rows use `source = 'blog'` and are excluded from generation swaps via `AND source != 'blog'` in both `deleteOldGen` and `cleanupOrphanedGenerations`. If someone refactors the deletion logic and drops this guard, all blog posts (~410 rows) are wiped on the next doc crawl. The blog crawl is incremental (sitemap-diff), so it will not re-fetch already-indexed posts -- it will see an empty index and re-crawl everything.

**Why it happens:** The `source != 'blog'` guard is a business rule embedded in a SQL string. It is not enforced by schema constraints, not documented by a type system, and easy to miss during refactoring. This bug already happened once (see CONCERNS.md) and was fixed.

**Consequences:** All blog content disappears from the index. Blog crawl must re-fetch ~410 pages (takes several minutes, hits Anthropic's servers unnecessarily).

**Prevention:**
- Add a dedicated test: insert blog rows, run `finalizeGeneration`, assert blog rows still exist. This test exists conceptually in CONCERNS.md but is not yet written.
- When unifying crawl pipelines, make the blog-exclusion explicit at the type/interface level, not just in SQL. A `CrawlSource` enum that governs which sources are subject to generation swap.
- Add a pre-finalization count check: count blog rows before and after `finalizeGeneration`. Log a warning if the count changes.

**Detection:** `index_status` shows `blog_page_count: 0` after a doc crawl. Blog search returns no results.

**Phase relevance:** Crawl pipeline unification phase. This is the exact phase where the deletion logic will be restructured.

## Moderate Pitfalls

### Pitfall 5: WAL File Growth Under Frequent Polling

**What goes wrong:** With hourly crawls inserting hundreds of rows and then bulk-deleting old generations, the WAL file grows. If checkpoints cannot complete (because a long-running read query holds a snapshot), the WAL file grows unbounded. Over days or weeks, the WAL file can exceed the main database size.

**Prevention:**
- Run `PRAGMA wal_checkpoint(TRUNCATE)` after each successful `finalizeGeneration`. This forces a checkpoint and resets WAL size.
- Monitor WAL file size in `index_status` output. If it exceeds 10MB, something is wrong.
- Ensure no queries hold read transactions open for extended periods. `better-sqlite3` synchronous queries finish immediately, so this is mainly a risk if async crawl work interleaves with reads.

**Phase relevance:** Background polling phase.

---

### Pitfall 6: setInterval Timer Accumulation and Process Lifecycle

**What goes wrong:** Adding `setInterval` for polling without cleanup causes issues. If the MCP server is spawned and killed frequently by Claude Code (normal behavior), timers that fire during shutdown can cause unhandled errors. If the process is kept alive by a timer reference, it will not exit when the stdio transport closes.

**Prevention:**
- Store timer references and call `clearInterval` in a shutdown handler.
- Use `timer.unref()` so the timer does not prevent process exit.
- Add `SIGTERM`/`SIGINT` handlers that clear timers and close the database connection gracefully. This is already identified as a missing feature in PROJECT.md.

**Detection:** MCP server processes accumulate as zombie processes. `ps aux | grep anthropic-docs` shows multiple instances.

**Phase relevance:** Background polling phase and graceful shutdown implementation.

---

### Pitfall 7: Selector Drift in Blog HTML Extraction

**What goes wrong:** The blog parser relies on `<article>` or `<main>` tags to extract content. If Anthropic redesigns their blog (new HTML structure, React hydration changes, layout shifts), the parser falls back to full HTML -- which includes navigation, footer, cookie banners, and other noise. This inflates the index with irrelevant content and degrades search quality.

**Prevention:**
- Add a content quality check: if the extracted markdown exceeds a threshold (say 50KB) or contains known noise patterns (e.g., "Cookie Policy", "Sign up for updates"), log a warning.
- Add a periodic validation: pick 5 random blog pages, fetch them, and compare extracted content length against indexed content length. Flag significant deviations.
- Keep the fallback chain (`<article>` then `<main>` then full HTML) but add logging when falling back to full HTML so drift is visible.

**Detection:** Search for common terms returns blog results with irrelevant snippets (navigation text, footer links). Blog section count per page spikes unexpectedly.

**Phase relevance:** Any phase that touches blog parsing. Should add the quality check during crawl pipeline unification.

---

### Pitfall 8: Partial Crawl Failure Treated as Success

**What goes wrong:** `fetchAndParse` uses `Promise.allSettled` for the two doc sources. If platform docs fail but code docs succeed, the crawl proceeds and `finalizeGeneration` runs -- deleting all existing platform docs and keeping only code docs (~59 pages). The index shrinks from ~550 pages to ~59 with no error surfaced to the user.

**Why it happens:** `startCrawl` checks `pages.length` for logging but has no minimum threshold. A crawl returning 59 pages (only code docs) is treated the same as one returning 550 pages.

**Consequences:** Platform docs (the vast majority of content) disappear from the index. Users searching for API or platform features get no results.

**Prevention:**
- Add a minimum page count threshold. If the crawl returns fewer pages than X% of the previous count (e.g., less than 50%), abort the generation swap and keep the old index. Log an error.
- Track per-source page counts in metadata. After crawl, compare per-source counts against previous values. Refuse to finalize if any source dropped to zero unexpectedly.
- Surface partial failures in `index_status` output.

**Detection:** `index_status` shows a dramatic drop in page count. Searches for platform-specific topics return no results.

**Phase relevance:** Crawl pipeline unification phase. The unified pipeline should enforce this threshold.

## Minor Pitfalls

### Pitfall 9: Query Preprocessing Breaks Phrase Searches

**What goes wrong:** `preprocessQuery` strips quotes and wraps multi-word queries as `"word1" "word2"`, forcing each word to be an exact phrase match rather than allowing proximity or OR matching. Users searching for "tool use streaming" get results that contain each word individually, not necessarily in context.

**Prevention:** Consider supporting quoted phrases from user input (pass through intentional quotes). The current approach is safe for FTS5 but could be improved for search quality in a later phase.

**Phase relevance:** Low priority. Can be addressed when adding search quality improvements.

---

### Pitfall 10: Metadata Timestamps as Strings Without Timezone

**What goes wrong:** `new Date().toISOString()` produces UTC timestamps, but staleness calculations compare against `Date.now()` which is also UTC. This works correctly, but if someone later stores local time strings or parses them differently, the staleness check will be wrong by hours.

**Prevention:** Keep using `toISOString()` consistently. Add a comment documenting that all timestamps are UTC ISO-8601.

**Phase relevance:** Minor. Document during any refactoring that touches timestamps.

---

### Pitfall 11: llms-full.txt Format Change Goes Undetected

**What goes wrong:** The parser detects page boundaries by pattern: `# heading` followed by `URL:` or `Source:` within 3 lines. If Anthropic changes this format (different header level, different URL prefix, additional metadata lines), parsing silently returns 0 pages. The generation swap then deletes all existing content.

**Prevention:** This is mitigated by Pitfall 8's threshold check. Additionally, log a warning if `parsePages` returns 0 pages for a non-empty input string. Consider fetching a small sample and validating the format before committing to a full parse.

**Phase relevance:** Crawl pipeline unification. The threshold check from Pitfall 8 is the primary defense.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Extract tool handlers from index.ts | stdout corruption from new imports; breaking `firstRunBuildingResponse` guard | Add stdout guard (Pitfall 2). Test all tool handlers return valid MCP responses. |
| Unify crawl pipeline | FTS desync (Pitfall 1), blog row deletion (Pitfall 4), partial failure (Pitfall 8) | Add FTS integrity-check test. Add blog survival test. Add minimum page count threshold. |
| Background polling | Generation swap race (Pitfall 3), WAL growth (Pitfall 5), timer leaks (Pitfall 6) | Use incremental FTS ops. Add WAL checkpoint. Add timer cleanup + graceful shutdown. |
| Blog update/deletion detection | Selector drift (Pitfall 7), accidental full re-crawl | Add content quality check. Ensure diff logic handles URL removals without wiping all blog rows. |
| Test coverage expansion | False confidence from shallow tests | Test FTS consistency end-to-end, not just row counts. Test tool handler output format, not just "no error." |

## Sources

- [SQLite FTS5 Extension documentation](https://sqlite.org/fts5.html) -- external content table sync responsibility
- [SQLite Forum: Corrupt FTS5 table after trigger patterns](https://sqlite.org/forum/info/da59bf102d7a7951740bd01c4942b1119512a86bfa1b11d4f762056c8eb7fc4e) -- FTS5 corruption scenarios
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) -- WAL mode and checkpoint behavior
- [SQLite WAL documentation](https://sqlite.org/wal.html) -- checkpoint starvation
- [MCP Transports specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) -- stdio transport constraints
- [Exploring the Future of MCP Transports](http://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/) -- transport/session separation
- [Node.js Event Loop documentation](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) -- timer and event loop behavior
- [How to Fix Inaccurate Web Scraping Data](https://brightdata.com/blog/web-data/fix-inaccurate-web-scraping-data) -- selector drift and partial content issues
- Project CONCERNS.md -- previously-identified fragile areas and resolved bugs
