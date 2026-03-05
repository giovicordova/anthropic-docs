# Phase 4: Content Expansion - Research

**Researched:** 2026-03-05
**Domain:** HTML crawling, ContentSource interface, sitemap-based URL discovery
**Confidence:** HIGH

## Summary

Phase 4 adds two new content sources: model/product pages (3 pages: opus, sonnet, haiku) and research papers (~144 pages from /research/). Both sources live on anthropic.com and follow the same HTML-to-markdown pattern already used by the blog parser. The existing `ContentSource` interface, `htmlToMarkdown` function, sitemap URL discovery, and batch fetching infrastructure can all be reused directly.

The key design decision is whether to create one ContentSource or two. Research pages are already being crawled by the blog source (the sitemap filter includes `/research/`). This means CONT-02 is partially satisfied -- research papers under `/research/` are already indexed as `source: "blog"`. The real work is: (1) creating a new source for the 3 model pages at `/claude/{opus,sonnet,haiku}`, and (2) re-tagging `/research/` content with a distinct `source` value so it can be filtered separately.

**Primary recommendation:** Create two new ContentSource implementations -- `modelSource` for the 3 static model pages and `researchSource` for /research/ pages -- both using the existing HTML fetch + parse pattern from blog-parser. Re-tag /research/ URLs currently indexed as "blog" to "research". Add "model" and "research" to the DocSource union type.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONT-01 | Index model/product pages (/claude/opus, /claude/sonnet, /claude/haiku) as a new ContentSource | New `modelSource` ContentSource with hardcoded URL list, HTML fetch, htmlToMarkdown parsing, source tag "model" |
| CONT-02 | Index research papers from /research/ section of anthropic.com | Split /research/ URLs out of blog source into dedicated `researchSource`, re-tag existing rows, source tag "research" |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node-html-markdown | ^2.0.0 | HTML to markdown conversion | Already in use for blog parsing, proven reliable |
| better-sqlite3 | ^12.6.2 | SQLite database | Already in use, FTS5 indexing |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All dependencies already installed |

**Installation:** No new dependencies needed. All infrastructure exists.

## Architecture Patterns

### How New Sources Fit the Existing Architecture

The ContentSource interface (defined in `src/types.ts`) is the extension point:

```typescript
export interface ContentSource {
  name: string;
  staleDays: number;
  metaTimestampKey: string;
  metaCountKey: string;
  usesGeneration: boolean;
  fetch(db: Database.Database): Promise<ParsedPage[]>;
}
```

Both new sources follow the blog pattern: `usesGeneration: false` (non-generation sources insert at current generation, are excluded from orphan cleanup).

### Pattern: Model Pages Source

Model pages are a fixed, small set of URLs (3 pages). No sitemap discovery needed -- hardcode the URLs in config.

```
Config: MODEL_PAGE_URLS = [
  "https://www.anthropic.com/claude/opus",
  "https://www.anthropic.com/claude/sonnet",
  "https://www.anthropic.com/claude/haiku"
]
```

Fetch flow:
1. Fetch all 3 URLs with `fetchWithTimeout`
2. Parse HTML with `htmlToMarkdown` (reuse from blog-parser)
3. Extract title from first `# heading` in markdown (reuse `parseBlogPage` pattern)
4. Return `ParsedPage[]` with `source: "model"`

Staleness: Same as blog (~8 hours). Model pages change infrequently but we want to catch pricing/spec updates.

### Pattern: Research Papers Source

Research pages use sitemap discovery, same as blog. The key difference: filter for `/research/` prefix only (currently blog source grabs `/news/`, `/research/`, `/engineering/`).

Two options for splitting research from blog:

**Option A (recommended): Separate the path prefixes**
- Blog source: filter `/news/` and `/engineering/` only (remove `/research/`)
- Research source: filter `/research/` only
- Requires updating `BLOG_PATH_PREFIXES` in config.ts
- Requires a one-time migration to re-tag existing `/research/` rows from `source: "blog"` to `source: "research"`

**Option B: Research source re-fetches /research/ URLs**
- Blog source keeps all 3 prefixes
- Research source also fetches /research/ URLs separately
- Creates duplicate indexing -- wasteful and confusing

Option A is cleaner. The migration can happen in the research source's first `fetch()` call or as a startup step.

### DocSource Type Extension

Current: `"platform" | "code" | "api-reference" | "blog"`
New: `"platform" | "code" | "api-reference" | "blog" | "model" | "research"`

### Files to Modify

```
src/types.ts          # Add "model" | "research" to DocSource union
src/config.ts         # Add MODEL_PAGE_URLS, MODEL_STALE_HOURS, RESEARCH_STALE_HOURS
                      # Update BLOG_PATH_PREFIXES to remove "/research/"
src/blog-parser.ts    # Extract reusable parseHtmlPage function (generalize parseBlogPage)
src/crawl.ts          # Add modelSource and researchSource implementations
                      # Add migration logic for re-tagging /research/ rows
src/index.ts          # Register new sources with CrawlManager
src/tools/status.ts   # Display new source stats
src/database.ts       # Add deletePagesBySource or re-tag function
                      # Update non-generation count query (currently hardcoded to 'blog')
```

### Anti-Patterns to Avoid
- **Hardcoding source name in CrawlManager:** Line 229 of crawl.ts has `WHERE source = 'blog'` hardcoded. This must be parameterized per source for the count query to work with "model" and "research" sources.
- **Duplicating fetch/parse logic:** Don't copy-paste `parseBlogPage` and `htmlToMarkdown`. Extract a shared `parseHtmlPage(url, html, source)` that both blog and new sources use.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTML to markdown | Custom parser | `node-html-markdown` (already installed) | Handles edge cases, tested |
| Sitemap parsing | New XML parser | Existing `parseSitemapWithLastmod` | Already handles the sitemap format |
| Batch concurrent fetching | Custom concurrency control | Existing `fetchBlogPages` pattern | Proven batch + delay pattern |
| Page section splitting | New splitter | Existing `pagesToSections` + `splitIntoSections` | Already handles h2/h3/h4 splitting |

## Common Pitfalls

### Pitfall 1: Hardcoded "blog" in CrawlManager
**What goes wrong:** CrawlManager.crawlSource has `WHERE source = 'blog'` on line 229. New non-generation sources won't get correct counts.
**Why it happens:** Only one non-generation source existed when CrawlManager was written.
**How to avoid:** Pass source name into the count query. Use `source.name` or add a `sourceTag` to ContentSource interface.
**Warning signs:** index_status shows 0 for model/research page counts.

### Pitfall 2: Research pages indexed twice
**What goes wrong:** If `/research/` stays in BLOG_PATH_PREFIXES AND a separate research source fetches them, the same pages get indexed under both "blog" and "research" source tags.
**Why it happens:** Forgetting to remove `/research/` from the blog filter.
**How to avoid:** Update `BLOG_PATH_PREFIXES` to `["/news/", "/engineering/"]` at the same time you add the research source.
**Warning signs:** Duplicate search results for research content.

### Pitfall 3: Orphaned /research/ rows after re-tagging
**What goes wrong:** Existing `/research/` rows have `source = 'blog'`. If blog source runs before re-tagging, it might delete them during sitemap diff (they won't match the new blog filter).
**Why it happens:** Race between blog crawl and migration.
**How to avoid:** Run the re-tag migration at startup, before any crawl triggers. Simple UPDATE statement: `UPDATE pages SET source = 'research' WHERE source = 'blog' AND path LIKE '/research/%'`.
**Warning signs:** Research content disappears after first crawl with new code.

### Pitfall 4: Model pages have no article/main tag
**What goes wrong:** `htmlToMarkdown` falls back to full HTML including nav, footer, cookie banners.
**Why it happens:** Product pages may use different HTML structure than blog posts.
**How to avoid:** Verified via WebFetch that model pages DO have content in standard semantic tags. The existing `htmlToMarkdown` function tries `<article>`, then `<main>`, then full HTML. If model pages lack both, add a content selector (e.g., look for a specific div class). Test with actual fetched HTML during implementation.
**Warning signs:** Indexed model page content includes navigation text and footer boilerplate.

### Pitfall 5: deleteOldGen excludes only 'blog'
**What goes wrong:** `deleteOldGen` in database.ts (line 78) says `WHERE source != 'blog'`. This means "model" and "research" rows WILL be deleted during doc generation swaps.
**Why it happens:** The exclusion was written for blog only.
**How to avoid:** Update the exclusion to cover all non-generation sources: `WHERE source NOT IN ('blog', 'model', 'research')`. Or better: use `usesGeneration` flag to build the exclusion list dynamically.
**Warning signs:** Model and research content disappears after a doc re-crawl.

## Code Examples

### New ContentSource for Model Pages
```typescript
// In src/crawl.ts
export const modelSource: ContentSource = {
  name: "model",
  staleDays: MODEL_STALE_DAYS,
  metaTimestampKey: "last_model_crawl_timestamp",
  metaCountKey: "model_page_count",
  usesGeneration: false,
  async fetch(_db: Database.Database) {
    const pages: ParsedPage[] = [];
    for (const url of MODEL_PAGE_URLS) {
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) continue;
        const html = await response.text();
        const page = parseHtmlPage(url, html, "model");
        if (page) pages.push(page);
      } catch (err) {
        console.error(`[model] Failed to fetch ${url}: ${(err as Error).message}`);
      }
    }
    return pages;
  },
};
```

### Generalized parseHtmlPage (extracted from parseBlogPage)
```typescript
// In src/blog-parser.ts (or new shared file)
export function parseHtmlPage(url: string, html: string, source: DocSource): ParsedPage | null {
  const content = htmlToMarkdown(html);
  if (!content) return null;

  const h1Match = content.match(/^#\s+(.+)$/m);
  let title: string;
  if (h1Match) {
    title = h1Match[1].trim();
  } else {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    title = segments[segments.length - 1] || "Untitled";
  }

  const path = new URL(url).pathname;
  return { title, url, path, content, source };
}
```

### Fix deleteOldGen exclusion
```typescript
// In src/database.ts, prepareStatements
deleteOldGen: db.prepare(
  "DELETE FROM pages WHERE generation != ? AND source NOT IN ('blog', 'model', 'research')"
),
```

### Fix non-generation count query in CrawlManager
```typescript
// In crawl.ts, crawlSource method (non-generation branch)
const countRow = this.db
  .prepare("SELECT COUNT(DISTINCT url) as cnt FROM pages WHERE source = ?")
  .get(source.name) as { cnt: number };
```

### Migration: re-tag /research/ rows
```typescript
// Run at startup in index.ts, after initDatabase
db.prepare("UPDATE pages SET source = 'research' WHERE source = 'blog' AND path LIKE '/research/%'").run();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Blog-only HTML crawling | ContentSource interface | Phase 1 | New sources plug in without modifying core crawl logic |
| Single non-generation source | Multiple non-generation sources | Phase 4 (now) | CrawlManager needs parameterized source queries |

## Open Questions

1. **Model page HTML structure reliability**
   - What we know: WebFetch confirmed model pages have content. `htmlToMarkdown` should extract it.
   - What's unclear: Whether the extracted content is clean (no nav/footer noise) for all 3 model pages.
   - Recommendation: Test during implementation. If noisy, add a CSS selector for the content container.

2. **Research page count growth**
   - What we know: ~144 research pages in sitemap today.
   - What's unclear: Growth rate. Could hit MAX_BLOG_PAGES cap if shared.
   - Recommendation: Give research source its own `MAX_RESEARCH_PAGES` cap (500 is plenty).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none (uses vitest defaults, config in package.json) |
| Quick run command | `npx vitest run` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONT-01 | Model pages fetched, parsed, indexed with source "model" | unit | `npx vitest run tests/crawl.test.ts -t "model"` | Partial (crawl.test.ts exists, model tests needed) |
| CONT-01 | parseHtmlPage produces correct ParsedPage for model URLs | unit | `npx vitest run tests/blog-parser.test.ts -t "parseHtmlPage"` | No (new function) |
| CONT-01 | Model source appears in index_status output | unit | `npx vitest run tests/tools.test.ts -t "status"` | Partial (status tests exist, need model source) |
| CONT-02 | Research pages indexed with source "research" | unit | `npx vitest run tests/crawl.test.ts -t "research"` | No |
| CONT-02 | /research/ URLs excluded from blog source filter | unit | `npx vitest run tests/blog-parser.test.ts -t "parseSitemap"` | Partial (existing test, needs prefix update) |
| CONT-02 | deleteOldGen excludes model and research rows | unit | `npx vitest run tests/database.test.ts -t "deleteOldGen"` | Needs update |
| CONT-02 | Non-generation count query uses parameterized source | unit | `npx vitest run tests/crawl.test.ts -t "count"` | No |

### Sampling Rate
- **Per task commit:** `npx vitest run`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/crawl.test.ts` -- add modelSource and researchSource tests
- [ ] `tests/blog-parser.test.ts` -- add parseHtmlPage tests, update parseSitemap tests for removed /research/ prefix
- [ ] `tests/database.test.ts` -- update deleteOldGen test for new source exclusions

## Sources

### Primary (HIGH confidence)
- Project codebase -- all source files read directly
- anthropic.com/sitemap.xml via WebFetch -- confirmed 3 model pages, ~144 research pages
- anthropic.com/claude/opus, /sonnet, /haiku via WebFetch -- confirmed HTML structure, content exists
- anthropic.com/research/constitutional-classifiers via WebFetch -- confirmed research pages have substantive indexable content

### Secondary (MEDIUM confidence)
- anthropic.com/research via WebFetch -- confirmed URL pattern `/research/[slug]`

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing
- Architecture: HIGH - ContentSource interface designed for exactly this use case
- Pitfalls: HIGH - identified from reading actual source code (hardcoded 'blog' strings, deleteOldGen exclusion)

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable domain, anthropic.com structure unlikely to change)
