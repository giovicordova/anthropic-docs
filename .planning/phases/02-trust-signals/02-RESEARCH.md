# Phase 2: Trust Signals - Research

**Researched:** 2026-03-05
**Domain:** MCP tool response enrichment, graceful shutdown, crawl safety
**Confidence:** HIGH

## Summary

Phase 2 adds trust metadata to tool responses so Claude Code knows how fresh results are, surfaces crawl failures in `index_status`, adds graceful shutdown (SIGTERM/SIGINT), and adds a minimum-page-count safety valve to prevent partial crawl failures from wiping the index.

The codebase is well-structured after Phase 1. All five changes touch existing files with clear insertion points. No new dependencies are needed -- everything uses Node.js builtins, existing `better-sqlite3`, and existing metadata infrastructure.

**Primary recommendation:** Add `source` field to `SearchResult`, compute per-source staleness metadata in the search tool handler, store failure info in CrawlManager, wire SIGTERM/SIGINT handlers in index.ts, and add a page-count threshold check in `crawlSource` before calling `finalizeGeneration`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TRST-01 | Search results include last crawl timestamp per source | SearchRow already has `source` field but SearchResult drops it. Add `source` to SearchResult, then aggregate unique sources from results and look up `last_crawl_timestamp`/`last_blog_crawl_timestamp` per source. Append metadata footer to search response. |
| TRST-02 | Search results warn when index data exceeds staleness threshold | After computing per-source timestamps (TRST-01), compare age against `STALE_DAYS`/`BLOG_STALE_DAYS` from config.ts. If any source exceeds threshold, prepend a warning line to search response. |
| TRST-03 | index_status shows crawl failure reason and timestamp | CrawlManager needs to store `lastError: { message: string, timestamp: string }` per source (set in the catch block of `crawlSource`). Status tool reads this from CrawlManager and includes it in output. |
| TRST-04 | Graceful shutdown on SIGTERM/SIGINT | Add `process.on('SIGTERM'/'SIGINT')` in index.ts that calls `server.close()`, `db.close()`, and clears any timers. No timers exist yet (Phase 3 adds polling), but the shutdown handler should be future-proof. |
| TRST-05 | Minimum page count threshold rejects partial crawls | Before `finalizeGeneration` in `crawlSource`, compare new page count to previous count from metadata. If new < 50% of previous, throw/log and skip finalization (preserving existing index). Only applies to generation-based sources (docs). |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | Already used -- `db.close()` for shutdown | Existing dependency |
| @modelcontextprotocol/sdk | ^1.27.1 | Already used -- `server.close()` for shutdown | Existing dependency |
| node:process | built-in | SIGTERM/SIGINT signal handling | No external dep needed |

### Supporting
No new dependencies required. All changes use existing libraries and Node.js builtins.

### Alternatives Considered
None -- this phase adds behavior to existing code, not new infrastructure.

**Installation:**
```bash
# No new packages needed
```

## Architecture Patterns

### Recommended Changes by File

```
src/
  types.ts          # Add source to SearchResult, add CrawlError type
  config.ts         # Add MIN_PAGE_RATIO constant (0.5)
  crawl.ts          # Add error tracking, page count threshold check
  tools/search.ts   # Add staleness metadata footer + warning to responses
  tools/status.ts   # Add failure info section
  index.ts          # Add SIGTERM/SIGINT handlers
```

### Pattern 1: Per-Source Metadata in Search Response
**What:** After executing search, collect unique sources from results, look up each source's last crawl timestamp and staleness threshold, append a metadata footer to the response text.
**When to use:** Every search response (both results and no-results cases need it for TRST-01).
**Example:**
```typescript
// In search tool handler, after formatting results:
const sourcesInResults = [...new Set(results.map(r => r.source))];
const metadata = sourcesInResults.map(s => {
  const key = s === 'blog' ? 'last_blog_crawl_timestamp' : 'last_crawl_timestamp';
  const threshold = s === 'blog' ? BLOG_STALE_DAYS : STALE_DAYS;
  const ts = getMetadata(stmts, key);
  const ageDays = ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : null;
  const stale = ageDays !== null && ageDays > threshold;
  return { source: s, lastCrawl: ts, stale };
});

// Append footer
let footer = '\n\n---\n' + metadata.map(m =>
  `${m.source}: last crawled ${m.lastCrawl || 'never'}`
).join(' | ');

// TRST-02: Warning if any source is stale
const staleSources = metadata.filter(m => m.stale);
if (staleSources.length > 0) {
  footer = `\n\n**Warning: stale data** -- ${staleSources.map(s => s.source).join(', ')} index exceeds freshness threshold. Run refresh_index to update.` + footer;
}
```

### Pattern 2: Error Tracking in CrawlManager
**What:** Store last error per source in CrawlManager's internal state (not in SQLite metadata -- runtime-only is fine since errors are transient).
**When to use:** In `crawlSource` catch block.
**Example:**
```typescript
// In CrawlManager class:
private errors: Map<string, { message: string; timestamp: string }> = new Map();

getLastError(name: string): { message: string; timestamp: string } | null {
  return this.errors.get(name) || null;
}

// In crawlSource catch block:
this.errors.set(source.name, {
  message: (err as Error).message,
  timestamp: new Date().toISOString(),
});
```

**Decision: runtime Map vs SQLite metadata.** Use runtime Map. Failure info is transient -- it resets on server restart, which is correct behavior (if the server restarted, the old failure is irrelevant). Storing in SQLite adds unnecessary persistence of stale error state.

### Pattern 3: Graceful Shutdown
**What:** Wire SIGTERM and SIGINT to close server transport, close DB, and exit cleanly.
**When to use:** In index.ts after server setup.
**Example:**
```typescript
// In index.ts, after server.connect():
function shutdown() {
  console.error('[server] Shutting down...');
  // server.close() closes the transport
  server.close().catch(() => {});
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Key detail:** `better-sqlite3` `db.close()` is synchronous. `server.close()` is async but we don't need to await it during shutdown -- the process is exiting. The important thing is that `db.close()` runs (prevents WAL corruption) and no crash/error output occurs.

### Pattern 4: Minimum Page Count Threshold
**What:** Before calling `finalizeGeneration`, compare incoming page count to stored previous count. If < 50%, reject the crawl.
**When to use:** Only for generation-based sources (docs). Blog is incremental and can legitimately return 0 new pages.
**Example:**
```typescript
// In crawlSource, after collecting pages but before finalizeGeneration:
if (source.usesGeneration) {
  const previousCount = parseInt(getMetadata(stmts, source.metaCountKey) || '0', 10);
  if (previousCount > 0 && pages.length < previousCount * MIN_PAGE_RATIO) {
    console.error(
      `[server] ${source.name} crawl returned ${pages.length} pages ` +
      `(previous: ${previousCount}). Below ${MIN_PAGE_RATIO * 100}% threshold. ` +
      `Rejecting crawl to protect index.`
    );
    this.states.set(source.name, 'failed');
    this.errors.set(source.name, {
      message: `Crawl rejected: ${pages.length}/${previousCount} pages (below safety threshold)`,
      timestamp: new Date().toISOString(),
    });
    return 0; // Don't finalize -- existing index preserved
  }
}
```

### Anti-Patterns to Avoid
- **Don't store error state in SQLite metadata:** Crawl errors are transient. Persisting them means stale error messages survive server restarts and confuse users.
- **Don't compute staleness in the database layer:** Staleness is a tool-level concern (presentation). Keep `searchDocs` pure -- it returns data, the tool handler adds metadata.
- **Don't block shutdown on async operations:** `db.close()` is synchronous. Don't `await server.close()` in the signal handler -- just fire-and-forget then `process.exit(0)`.
- **Don't apply page-count threshold to blog source:** Blog crawls are incremental (only new URLs). Returning fewer pages than before is normal behavior, not a failure.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Signal handling | Custom event system | `process.on('SIGTERM'/'SIGINT')` | Node.js native, handles OS signals correctly |
| Staleness calculation | New date library | Plain `Date.now()` arithmetic | Already used throughout codebase (crawl.ts lines 157-158), millisecond math is trivial |
| Source-to-metadata key mapping | Lookup table | `ContentSource.metaTimestampKey` | Already exists on ContentSource interface |

## Common Pitfalls

### Pitfall 1: SearchResult Missing Source Field
**What goes wrong:** `SearchResult` interface lacks `source`. The SQL query already selects `p.source` but `searchDocs()` drops it when mapping to `SearchResult`.
**Why it happens:** Original design didn't need per-source metadata in search output.
**How to avoid:** Add `source: string` to `SearchResult` interface and `source: row.source` to the mapping in `searchDocs()`. This is a prerequisite for TRST-01/TRST-02.
**Warning signs:** TypeScript error if you try to access `result.source` without updating the interface.

### Pitfall 2: Source-to-Timestamp Key Mapping
**What goes wrong:** Docs use `last_crawl_timestamp` but blog uses `last_blog_crawl_timestamp`. Platform, code, and api-reference all share the same doc crawl timestamp.
**Why it happens:** Docs are crawled as one unit (both llms-full.txt files in one `fetchAndParse`), so all three doc sources share one timestamp.
**How to avoid:** Map source to timestamp key: `blog` -> `last_blog_crawl_timestamp`, everything else -> `last_crawl_timestamp`. Map source to threshold: `blog` -> `BLOG_STALE_DAYS`, everything else -> `STALE_DAYS`.

### Pitfall 3: Shutdown During Active Crawl
**What goes wrong:** SIGTERM arrives while a crawl is in progress. The generation hasn't been finalized. Orphan rows exist.
**Why it happens:** Crawls run async in the background. Shutdown is immediate.
**How to avoid:** This is already handled -- `cleanupOrphanedGenerations` runs on next startup (index.ts line 17). No special shutdown logic needed for in-progress crawls. The existing orphan cleanup is the safety net.

### Pitfall 4: Page Count Threshold on First Crawl
**What goes wrong:** First crawl has no previous count. Threshold check divides by zero or incorrectly rejects.
**Why it happens:** `previousCount` is 0 on first run.
**How to avoid:** Only apply threshold when `previousCount > 0`. First crawl always proceeds.

### Pitfall 5: Multiple SIGTERM/SIGINT Firing
**What goes wrong:** User hits Ctrl+C twice, or process manager sends SIGTERM then SIGKILL. Double-close on `db.close()` throws.
**Why it happens:** Signal handlers fire once per signal event.
**How to avoid:** Use a `shuttingDown` flag to prevent re-entry. Or remove the signal listeners after first invocation.

## Code Examples

### Adding Source to SearchResult (prerequisite change)
```typescript
// src/types.ts -- add source field
export interface SearchResult {
  title: string;
  url: string;
  sectionHeading: string | null;
  snippet: string;
  relevanceScore: number;
  source: string;  // NEW
}

// src/database.ts -- include source in mapping
return rows.map((row) => ({
  title: row.title,
  url: row.url,
  sectionHeading: row.section_heading,
  snippet: row.snippet,
  relevanceScore: Math.abs(row.rank),
  source: row.source,  // NEW -- already in SearchRow
}));
```

### Shutdown Handler (index.ts)
```typescript
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('[server] Shutting down gracefully...');
  server.close().catch(() => {});
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### Page Count Threshold (config.ts)
```typescript
export const MIN_PAGE_RATIO = 0.5; // Reject crawl if < 50% of previous count
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Search returns results without freshness context | TRST-01/02: results include timestamp + staleness warning | This phase | Claude Code can judge result reliability |
| Crawl failures silently swallowed | TRST-03: failures stored and surfaced via index_status | This phase | Users can diagnose crawl issues |
| No shutdown handling | TRST-04: clean SIGTERM/SIGINT | This phase | No WAL corruption, no leaked handles |
| Partial crawl failure wipes index | TRST-05: 50% minimum threshold | This phase | Index survives upstream outages |

## Open Questions

1. **Should staleness warnings appear on get_doc_page too?**
   - What we know: Requirements only mention search results (TRST-01, TRST-02)
   - What's unclear: Whether `get_doc_page` should also show freshness info
   - Recommendation: Implement for search only (per requirements). Easy to extend later.

2. **Should failed crawl state auto-recover?**
   - What we know: Currently "failed" state persists until server restart
   - What's unclear: Whether the CrawlManager should reset "failed" to "idle" after a time period
   - Recommendation: Leave as-is for Phase 2. Phase 3 adds background polling which naturally retries.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | none (vitest defaults, `vitest run` in package.json) |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TRST-01 | Search results include per-source crawl timestamp | unit | `npx vitest run tests/tools.test.ts -t "staleness metadata"` | No -- Wave 0 |
| TRST-02 | Search results include staleness warning | unit | `npx vitest run tests/tools.test.ts -t "staleness warning"` | No -- Wave 0 |
| TRST-03 | index_status shows failure reason and timestamp | unit | `npx vitest run tests/tools.test.ts -t "failure info"` | No -- Wave 0 |
| TRST-04 | Graceful shutdown on SIGTERM | unit | `npx vitest run tests/shutdown.test.ts` | No -- Wave 0 |
| TRST-05 | Crawl rejected when page count < 50% of previous | unit | `npx vitest run tests/crawl.test.ts -t "page count threshold"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/tools.test.ts` -- add tests for TRST-01 (timestamp footer), TRST-02 (staleness warning), TRST-03 (failure display)
- [ ] `tests/crawl.test.ts` -- add test for TRST-05 (page count threshold rejection)
- [ ] `tests/shutdown.test.ts` -- new file for TRST-04 (signal handler wiring, db.close called)

## Sources

### Primary (HIGH confidence)
- Codebase inspection: all source files read directly (src/index.ts, src/database.ts, src/types.ts, src/config.ts, src/crawl.ts, src/tools/*.ts, tests/*.ts)
- `SearchRow` already includes `source` field (database.ts line 88) -- verified in SQL query
- `SearchResult` omits `source` field (types.ts lines 51-57) -- verified gap
- `better-sqlite3` `db.close()` is synchronous -- per library API
- `cleanupOrphanedGenerations` already handles interrupted crawls on startup (index.ts line 17)

### Secondary (MEDIUM confidence)
- Node.js `process.on('SIGTERM')` / `process.on('SIGINT')` -- standard Node.js signal handling pattern

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing code
- Architecture: HIGH -- clear insertion points identified in each file
- Pitfalls: HIGH -- all identified through direct code reading

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable domain, no external API changes expected)
