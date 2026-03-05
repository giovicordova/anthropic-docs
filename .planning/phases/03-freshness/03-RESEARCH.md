# Phase 3: Freshness - Research

**Researched:** 2026-03-05
**Domain:** HTTP conditional requests, background polling, sitemap-based change detection
**Confidence:** HIGH

## Summary

Phase 3 makes the index stay current within hours instead of days. Three capabilities are needed: (1) skip re-parsing unchanged content using HTTP conditional requests, (2) automatic background polling every 1-2 hours, and (3) detect blog updates and deletions via full sitemap comparison.

The good news: all three data sources already support the mechanisms needed. Platform docs return both `ETag` and `Last-Modified` headers, and correctly respond with `304 Not Modified` to conditional requests. Code docs return `Last-Modified` and honor `If-Modified-Since`. The anthropic.com sitemap includes `<lastmod>` timestamps on every URL, enabling update detection without re-fetching page content.

**Primary recommendation:** Use HTTP conditional requests (ETag/Last-Modified) as the primary change detection for docs, content hashing as a fallback safety net, and `<lastmod>` timestamps from the sitemap for blog update/deletion detection. Use `setInterval` with `.unref()` for background polling.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FRSH-01 | Content change detection via ETag/Last-Modified/hash before re-parsing unchanged content | HTTP conditional requests verified working on both doc sources (304 responses confirmed). Content hash via Node.js crypto as fallback. |
| FRSH-02 | Background polling every 1-2 hours (configurable interval, timer with .unref()) | Node.js `setInterval` + `.unref()` pattern. Timer stored for cleanup in shutdown handler. |
| FRSH-03 | Blog update/deletion detection (full sitemap comparison, not just new URL detection) | Sitemap `<lastmod>` tags confirmed on all blog URLs. Enables update detection by comparing lastmod against stored crawled_at. Deletion = indexed URL absent from sitemap. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node:crypto | built-in | SHA-256 content hashing | Zero-dependency, fast, standard Node.js API |
| node:timers | built-in | setInterval with .unref() | Built-in, no extra dependency needed |

### Supporting
No new dependencies needed. All functionality uses Node.js built-ins and the existing `fetch` API.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ETag/Last-Modified conditional requests | Content hash only | Conditional requests save bandwidth (304 = no body). Content hash requires downloading the full file first. Use both: conditional request first, hash as backup. |
| setInterval | setTimeout chain | setInterval is simpler for fixed-interval polling. setTimeout chain is better if poll duration varies, but unnecessary here since crawl guards already prevent overlap. |

## Architecture Patterns

### Change Detection Flow (FRSH-01)

```
Poll triggered
  -> conditionalFetch(url, storedETag, storedLastModified)
     -> 304 Not Modified? -> skip, log "unchanged"
     -> 200 OK? -> store new ETag/Last-Modified in metadata
                -> hash content with SHA-256
                -> compare hash to stored hash
                -> hash unchanged? -> skip re-parsing (safety net)
                -> hash changed? -> proceed with normal crawl pipeline
```

**Key design:** Modify `fetchWithTimeout` (or create a wrapper) to accept optional conditional headers and return a result that distinguishes 304 from 200. Store ETag/Last-Modified values in the existing `metadata` table.

### Background Polling (FRSH-02)

```
index.ts (after server.connect):
  const pollInterval = setInterval(() => {
    crawl.checkAndCrawlAll();
  }, POLL_INTERVAL_MS);
  pollInterval.unref();  // don't block process exit

  // Store reference for shutdown cleanup
  // In shutdown handler: clearInterval(pollInterval);
```

**Key design:** The existing `checkAndCrawlAll()` already handles staleness checks and the `isAnyCrawling()` guard prevents overlap. The only change is: (1) reduce staleness thresholds to match poll frequency, (2) add the timer in `index.ts`, (3) clear the timer in the shutdown handler.

### Blog Update/Delete Detection (FRSH-03)

```
Current blogSource.fetch:
  1. Fetch sitemap URLs
  2. Get indexed URLs
  3. Filter to NEW URLs only (indexed set difference)
  4. Fetch only new URLs

New blogSource.fetch:
  1. Fetch sitemap with <lastmod> parsing
  2. Get indexed URLs WITH their crawled_at timestamps
  3. Categorize:
     - NEW: in sitemap, not in index -> fetch and insert
     - UPDATED: in sitemap AND index, lastmod > crawled_at -> re-fetch and update
     - DELETED: in index but NOT in sitemap -> delete from DB
     - UNCHANGED: in sitemap AND index, lastmod <= crawled_at -> skip
  4. Process each category
```

### Metadata Keys to Store
| Key | Value | Purpose |
|-----|-------|---------|
| `platform_etag` | ETag string | Conditional request for platform docs |
| `platform_last_modified` | Last-Modified string | Conditional request for platform docs |
| `code_etag` | ETag string | Conditional request for code docs |
| `code_last_modified` | Last-Modified string | Conditional request for code docs |
| `platform_content_hash` | SHA-256 hex | Backup change detection |
| `code_content_hash` | SHA-256 hex | Backup change detection |

### Recommended Changes by File

```
src/config.ts          # Add POLL_INTERVAL_MS (2 hours default)
                       # Reduce STALE_DAYS and BLOG_STALE_DAYS to match poll frequency
src/fetch.ts           # Add conditionalFetch() with ETag/Last-Modified support
src/types.ts           # Add ConditionalFetchResult type, SitemapEntry interface (url + lastmod)
src/parser.ts          # fetchAndParse returns early on 304 (no content change)
src/blog-parser.ts     # parseSitemap returns {url, lastmod}[], add update/delete logic
src/crawl.ts           # CrawlManager handles 304 skip, blog update/delete
src/database.ts        # Add getIndexedBlogUrlsWithTimestamps(), deleteBlogPages()
src/index.ts           # Add polling timer, cleanup in shutdown
```

### Anti-Patterns to Avoid
- **Re-fetching all blog pages to check for changes:** Use `<lastmod>` from sitemap, not content re-download
- **Storing conditional headers in memory:** Use metadata table -- they survive process restarts
- **Polling without overlap protection:** Already handled by `isAnyCrawling()` guard in CrawlManager
- **Using setTimeout recursion instead of setInterval:** Adds complexity without benefit here since the crawl guard already prevents overlap

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Content hashing | Custom hash function | `crypto.createHash('sha256')` | Built-in, constant-time comparison, standard |
| HTTP conditional requests | Custom caching layer | Native `fetch` with `If-None-Match` / `If-Modified-Since` headers | HTTP standard, server-side support confirmed |
| XML parsing for lastmod | Full XML parser | Regex extraction (already used in parseSitemap) | Sitemap XML is simple, predictable structure |

## Common Pitfalls

### Pitfall 1: Stale ETag/Last-Modified After Server Changes
**What goes wrong:** Anthropic changes their CDN or server, previous ETag format no longer valid
**Why it happens:** ETag formats are server-implementation-specific (weak vs strong, format varies)
**How to avoid:** Always fall back to full fetch + content hash if conditional request fails or returns unexpected status. Treat any non-304, non-200 response as "fetch fresh."
**Warning signs:** Sudden increase in full re-crawls after a period of 304s

### Pitfall 2: Timer Not Cleaned Up on Shutdown
**What goes wrong:** Process hangs on exit because timer keeps event loop alive
**Why it happens:** Forgetting `.unref()` or not clearing interval in shutdown handler
**How to avoid:** Call `.unref()` immediately after creating the interval, AND clear it in the shutdown handler. Both are needed: `.unref()` for graceful exit, `clearInterval()` for explicit shutdown.
**Warning signs:** Process doesn't exit on SIGTERM

### Pitfall 3: Blog Deletion Race Condition
**What goes wrong:** A URL temporarily missing from sitemap (CDN issue) causes deletion of valid content
**Why it happens:** Treating sitemap as authoritative source of truth for deletions
**How to avoid:** Only delete if URL is missing from sitemap for 2+ consecutive polls, OR require the URL to be absent AND the sitemap to have a minimum entry count (similar to MIN_PAGE_RATIO for docs). A simple approach: log deletions but don't act on them until confirmed on next poll.
**Warning signs:** Blog page count suddenly drops

### Pitfall 4: Content Hash Collisions with Whitespace Changes
**What goes wrong:** Trivial whitespace changes (trailing newline, encoding differences) cause unnecessary re-crawls
**Why it happens:** Hashing raw response body includes irrelevant formatting differences
**How to avoid:** Normalize content before hashing (trim, normalize whitespace). Or accept the occasional unnecessary re-crawl as harmless.
**Warning signs:** Every poll triggers a re-crawl despite no visible content changes

### Pitfall 5: Concurrent Timer Fires
**What goes wrong:** If a crawl takes longer than the poll interval, multiple crawls queue up
**Why it happens:** setInterval fires regardless of whether the callback completed
**How to avoid:** Already handled -- `isAnyCrawling()` guard in CrawlManager.crawlSource returns -1 if a crawl is in progress. Just make sure `checkAndCrawlAll` respects this.
**Warning signs:** "already in progress, skipping" log messages every poll

## Code Examples

### Conditional Fetch
```typescript
// Source: verified with curl against actual endpoints (304 confirmed)
import { createHash } from 'node:crypto';
import { FETCH_TIMEOUT_MS } from './config.js';

interface ConditionalFetchResult {
  modified: boolean;
  response?: Response;
  etag?: string;
  lastModified?: string;
}

export async function conditionalFetch(
  url: string,
  storedEtag?: string | null,
  storedLastModified?: string | null,
): Promise<ConditionalFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': 'anthropic-docs-mcp/2.0 (local indexer)',
  };

  if (storedEtag) headers['If-None-Match'] = storedEtag;
  if (storedLastModified) headers['If-Modified-Since'] = storedLastModified;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal, headers });

    if (response.status === 304) {
      return { modified: false };
    }

    return {
      modified: true,
      response,
      etag: response.headers.get('etag') || undefined,
      lastModified: response.headers.get('last-modified') || undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

### Content Hash
```typescript
// Source: Node.js crypto docs
import { createHash } from 'node:crypto';

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

### Sitemap Entry with Lastmod
```typescript
// Extended from existing parseSitemap
export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

export function parseSitemapWithLastmod(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlBlockRegex = /<url>\s*([\s\S]*?)\s*<\/url>/g;
  let block: RegExpExecArray | null;

  while ((block = urlBlockRegex.exec(xml)) !== null) {
    const locMatch = block[1].match(/<loc>\s*(.*?)\s*<\/loc>/);
    if (!locMatch) continue;

    const url = locMatch[1];
    try {
      const pathname = new URL(url).pathname;
      if (!BLOG_PATH_PREFIXES.some((p) => pathname.startsWith(p))) continue;
    } catch { continue; }

    const lastmodMatch = block[1].match(/<lastmod>\s*(.*?)\s*<\/lastmod>/);
    entries.push({
      url,
      lastmod: lastmodMatch ? lastmodMatch[1] : null,
    });
  }

  return entries;
}
```

### Polling Timer Setup
```typescript
// In index.ts, after server.connect():
import { POLL_INTERVAL_MS } from './config.js';

const pollTimer = setInterval(() => {
  console.error('[server] Scheduled poll triggered.');
  crawl.checkAndCrawlAll();
}, POLL_INTERVAL_MS);
pollTimer.unref();

// In shutdown handler:
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  // ... rest of shutdown
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Full re-fetch every time | HTTP conditional requests (ETag/If-None-Match) | HTTP/1.1 standard | Saves 25MB bandwidth per doc poll when content unchanged |
| Check staleness on startup only | Background polling every 1-2 hours | This phase | Index freshness goes from 24h+ to 1-2h |
| Blog: only detect new URLs | Full sitemap diff (new + updated + deleted) | This phase | Blog index reflects actual state of anthropic.com |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | implied via package.json `"test": "vitest run"` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FRSH-01 | conditionalFetch returns modified:false on 304 | unit | `npx vitest run tests/fetch.test.ts -x` | No - Wave 0 |
| FRSH-01 | conditionalFetch returns response + new headers on 200 | unit | `npx vitest run tests/fetch.test.ts -x` | No - Wave 0 |
| FRSH-01 | Content hash comparison skips re-parse when hash matches | unit | `npx vitest run tests/crawl.test.ts -x` | No - extend existing |
| FRSH-01 | ETag/Last-Modified stored in metadata after successful crawl | unit | `npx vitest run tests/crawl.test.ts -x` | No - extend existing |
| FRSH-02 | Poll timer created with .unref() | unit | `npx vitest run tests/crawl.test.ts -x` | No - extend existing |
| FRSH-02 | Poll timer cleared on shutdown | unit | `npx vitest run tests/shutdown.test.ts -x` | No - extend existing |
| FRSH-03 | parseSitemapWithLastmod extracts url and lastmod | unit | `npx vitest run tests/blog-parser.test.ts -x` | No - extend existing |
| FRSH-03 | Blog categorization: new, updated, deleted, unchanged | unit | `npx vitest run tests/crawl.test.ts -x` | No - extend existing |
| FRSH-03 | Deleted blog pages removed from DB and FTS | unit | `npx vitest run tests/database.test.ts -x` | No - extend existing |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `tests/fetch.test.ts` -- new file for conditionalFetch tests (mock fetch to return 304/200)
- [ ] Extend `tests/blog-parser.test.ts` -- add parseSitemapWithLastmod tests
- [ ] Extend `tests/crawl.test.ts` -- add conditional crawl skip, blog diff categorization tests
- [ ] Extend `tests/database.test.ts` -- add deleteBlogPages, getIndexedBlogUrlsWithTimestamps tests

## Open Questions

1. **Blog deletion safety threshold**
   - What we know: Sitemap could temporarily be incomplete (CDN issue)
   - What's unclear: How aggressive to be with deletions
   - Recommendation: Require URL to be missing for 2 consecutive polls before deleting. Store a `pending_deletions` list in metadata.

2. **Poll interval configurability**
   - What we know: FRSH-02 says "configurable interval"
   - What's unclear: Whether this means user-configurable (FRSH-04 in v2) or just a config.ts constant
   - Recommendation: For v1, make it a constant in config.ts. FRSH-04 (v2) will add user-tunable config.

3. **Per-source conditional headers for docs**
   - What we know: fetchAndParse fetches both platform and code docs in parallel
   - What's unclear: Whether to track ETag/Last-Modified per URL or for the combined result
   - Recommendation: Track per URL. If one source returns 304 and the other returns 200, only re-parse the changed one.

## Sources

### Primary (HIGH confidence)
- Verified via `curl -sI` against actual endpoints:
  - `platform.claude.com/llms-full.txt` returns ETag + Last-Modified, responds 304 to If-None-Match
  - `code.claude.com/docs/llms-full.txt` returns Last-Modified, responds 304 to If-Modified-Since
  - `anthropic.com/sitemap.xml` includes `<lastmod>` on all blog URLs
- [Node.js Timers API](https://nodejs.org/api/timers.html) - `.unref()` behavior
- [Node.js Crypto API](https://nodejs.org/api/crypto.html) - `createHash('sha256')`

### Secondary (MEDIUM confidence)
- [HTTP Conditional Requests - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests) - ETag/Last-Modified protocol
- [If-None-Match - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match)
- [If-Modified-Since - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Modified-Since)
- [Unblocking Node With Unref()](https://httptoolkit.com/blog/unblocking-node-with-unref/) - Timer unref patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all built-in Node.js APIs, no new dependencies
- Architecture: HIGH - conditional requests verified against actual endpoints, 304 confirmed
- Pitfalls: HIGH - based on real HTTP behavior and existing codebase patterns

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (30 days - stable domain, HTTP standards don't change)
