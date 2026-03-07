---
paths:
  - "src/**/*.ts"
---

# TypeScript Conventions

- All logging goes to **stderr** (`console.error`). Never use `console.log` — it corrupts the JSON-RPC stdio transport.
- Each indexed page is split into sections at h2/h3 headings. Sections are the unit of search and retrieval.
- The `source` column tags content as `"platform"`, `"code"`, `"api-reference"`, or `"blog"` for filtered search. API reference pages are auto-detected by path (`/docs/en/api/`). Blog posts are tagged `"blog"` and excluded from the doc generation swap (they persist across doc re-crawls).
- Blog staleness is 7 days (vs 1 day for docs). Blog crawl is incremental (sitemap-diff with Set lookup), not full re-crawl. Capped at `MAX_BLOG_PAGES` (1000) URLs per crawl.
