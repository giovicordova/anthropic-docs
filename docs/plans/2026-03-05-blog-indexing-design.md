# Design: Add Anthropic Blog Indexing

## Summary

Add full-text indexing of Anthropic blog posts (anthropic.com/news, /research, /engineering) to the MCP server. Blog posts get fetched from HTML, converted to markdown, split into sections, and indexed in the same SQLite FTS5 database. No new tools — the existing 5 tools handle blogs via source filtering.

## Data Flow

```
sitemap.xml -> extract /news, /research, /engineering URLs
    |
Compare against already-indexed URLs (sitemap-diff)
    |
Fetch new pages (batched, 10 concurrent)
    |
HTML -> markdown (node-html-markdown)
    |
Strip nav/header/footer -> extract article body
    |
Split into sections at h2/h3 (existing splitIntoSections)
    |
Insert into SQLite FTS5 (existing database layer)
```

## Files Affected

- **src/types.ts** — add `"blog"` to `DocSource` union
- **src/config.ts** — add `BLOG_SITEMAP_URL`, `BLOG_CONCURRENCY` (10), `BLOG_STALE_DAYS` (7), blog URL path prefixes
- **src/parser.ts** — new functions: `fetchSitemap()`, `fetchBlogPage()`, `htmlToSections()`, `fetchAndParseBlog()`. Existing `fetchAndParse()` calls this alongside the docs fetchers
- **src/database.ts** — new query: `getIndexedBlogUrls()` for sitemap-diff. Everything else (insert, search, FTS) works as-is since blog sections use the same `PageSection` schema
- **src/index.ts** — blog crawl runs alongside doc crawl on startup. `refresh_index` triggers blog refresh too. `index_status` reports blog page count

## No New Tools

Existing 5 tools handle blogs naturally:
- `search_anthropic_docs` — already supports `source` filter, pass `"blog"`
- `get_doc_page` — works via path matching, blog URLs have unique paths
- `list_doc_sections` — same
- `refresh_index` — triggers blog re-crawl
- `index_status` — reports blog stats

## New Dependency

`node-html-markdown` — one runtime dep added (total: 3 -> 4)

## Staleness & Refresh

- Docs: daily full re-crawl (unchanged)
- Blog: 7-day staleness check. On refresh, fetch sitemap, diff against indexed URLs, only fetch new posts. No re-fetching existing posts (blog content doesn't change after publication).

## Rate Limiting

Batched concurrency: 10 concurrent requests with small delays between batches. First crawl ~410 pages in ~2-3 minutes. Subsequent refreshes only fetch new posts (seconds).

## Source Tagging

All blog posts tagged as `source: "blog"`. No sub-tagging by /news vs /research vs /engineering — the URL path already distinguishes them, and a single "blog" filter keeps the API simple.
