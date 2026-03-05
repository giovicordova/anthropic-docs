# Blog Indexing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Index ~410 Anthropic blog posts (news, research, engineering) from anthropic.com into the existing SQLite FTS5 database, searchable via existing tools.

**Architecture:** Fetch sitemap.xml to discover blog URLs, convert HTML to markdown via `node-html-markdown`, split into sections with existing `splitIntoSections`, insert into existing DB. Blog pages are excluded from the doc generation swap system — they're purely additive (insert new, never delete). Subsequent refreshes only fetch URLs not already indexed (sitemap-diff).

**Tech Stack:** TypeScript, node-html-markdown, existing SQLite FTS5 database

---

### Task 1: Install node-html-markdown

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `npm install node-html-markdown`

**Step 2: Verify it installed**

Run: `cat package.json | grep node-html-markdown`
Expected: `"node-html-markdown": "^1.x.x"` in dependencies

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add node-html-markdown dependency"
```

---

### Task 2: Add "blog" to DocSource type

**Files:**
- Modify: `src/types.ts:5`

**Step 1: Write the failing test**

Add to `tests/database.test.ts` at the end of the describe block:

```typescript
it("searches with blog source filter", () => {
  insertPageSections(db, stmts, [makeSection({
    path: "/news/test-post",
    url: "https://www.anthropic.com/news/test-post",
    title: "Test Blog Post",
    source: "blog",
    content: "Blog content about new model capabilities and features released today.",
  })], 1);
  finalizeGeneration(db, stmts, 1);

  const results = searchDocs(stmts, "model capabilities", 10, "blog");
  expect(results).toHaveLength(1);
  expect(results[0].title).toBe("Test Blog Post");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database.test.ts`
Expected: TypeScript error — `"blog"` is not assignable to type `DocSource`

**Step 3: Update DocSource**

In `src/types.ts:5`, change:
```typescript
export type DocSource = "platform" | "code" | "api-reference";
```
to:
```typescript
export type DocSource = "platform" | "code" | "api-reference" | "blog";
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/types.ts tests/database.test.ts
git commit -m "feat(types): add blog to DocSource union"
```

---

### Task 3: Add blog constants to config

**Files:**
- Modify: `src/config.ts`

**Step 1: Add blog constants**

Add to end of `src/config.ts`:

```typescript
export const BLOG_SITEMAP_URL = "https://www.anthropic.com/sitemap.xml";
export const BLOG_CONCURRENCY = 10;
export const BLOG_STALE_DAYS = 7;
export const BLOG_PATH_PREFIXES = ["/news/", "/research/", "/engineering/"];
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add blog indexing constants"
```

---

### Task 4: Build blog parser — sitemap fetching

**Files:**
- Create: `src/blog-parser.ts`
- Create: `tests/blog-parser.test.ts`

**Step 1: Write the failing test for parseSitemap**

Create `tests/blog-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseSitemap } from "../src/blog-parser.js";

describe("parseSitemap", () => {
  it("extracts blog URLs from sitemap XML", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.anthropic.com/news/claude-4</loc></url>
  <url><loc>https://www.anthropic.com/research/effective-agents</loc></url>
  <url><loc>https://www.anthropic.com/engineering/tooling</loc></url>
  <url><loc>https://www.anthropic.com/about</loc></url>
  <url><loc>https://www.anthropic.com/careers</loc></url>
</urlset>`;

    const urls = parseSitemap(xml);

    expect(urls).toHaveLength(3);
    expect(urls).toContain("https://www.anthropic.com/news/claude-4");
    expect(urls).toContain("https://www.anthropic.com/research/effective-agents");
    expect(urls).toContain("https://www.anthropic.com/engineering/tooling");
    expect(urls).not.toContain("https://www.anthropic.com/about");
  });

  it("returns empty array for invalid XML", () => {
    const urls = parseSitemap("not xml at all");
    expect(urls).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Implement parseSitemap**

Create `src/blog-parser.ts`:

```typescript
import { NodeHtmlMarkdown } from "node-html-markdown";
import { BLOG_SITEMAP_URL, BLOG_CONCURRENCY, BLOG_PATH_PREFIXES, FETCH_TIMEOUT_MS } from "./config.js";
import type { ParsedPage } from "./types.js";

const nhm = new NodeHtmlMarkdown();

export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1].trim();
    try {
      const path = new URL(url).pathname;
      if (BLOG_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        urls.push(url);
      }
    } catch {
      // skip invalid URLs
    }
  }

  return urls;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/blog-parser.ts tests/blog-parser.test.ts
git commit -m "feat(blog-parser): add sitemap parsing with URL filtering"
```

---

### Task 5: Build blog parser — HTML to markdown conversion

**Files:**
- Modify: `src/blog-parser.ts`
- Modify: `tests/blog-parser.test.ts`

**Step 1: Write the failing test for htmlToMarkdown**

Add to `tests/blog-parser.test.ts`:

```typescript
import { parseSitemap, htmlToMarkdown } from "../src/blog-parser.js";

describe("htmlToMarkdown", () => {
  it("extracts article content from HTML", () => {
    const html = `
<html>
<head><title>Test Post</title></head>
<body>
  <nav>Navigation stuff</nav>
  <article>
    <h1>Test Post Title</h1>
    <p>This is the article body with <strong>bold</strong> text.</p>
    <h2>Section One</h2>
    <p>Content of section one.</p>
  </article>
  <footer>Footer stuff</footer>
</body>
</html>`;

    const md = htmlToMarkdown(html);

    expect(md).toContain("Test Post Title");
    expect(md).toContain("Section One");
    expect(md).toContain("**bold**");
    expect(md).not.toContain("Navigation stuff");
    expect(md).not.toContain("Footer stuff");
  });

  it("falls back to body if no article tag", () => {
    const html = `
<html>
<body>
  <main>
    <h1>Fallback Post</h1>
    <p>Some content here.</p>
  </main>
</body>
</html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain("Fallback Post");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: FAIL — `htmlToMarkdown` is not exported

**Step 3: Implement htmlToMarkdown**

Add to `src/blog-parser.ts`:

```typescript
export function htmlToMarkdown(html: string): string {
  // Try to extract just the article/main content to skip nav/footer
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentHtml = articleMatch?.[1] || mainMatch?.[1] || html;

  return nhm.translate(contentHtml).trim();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/blog-parser.ts tests/blog-parser.test.ts
git commit -m "feat(blog-parser): add HTML to markdown conversion"
```

---

### Task 6: Build blog parser — page fetching and parsing

**Files:**
- Modify: `src/blog-parser.ts`
- Modify: `tests/blog-parser.test.ts`

**Step 1: Write the failing test for parseBlogPage**

Add to `tests/blog-parser.test.ts`:

```typescript
import { parseSitemap, htmlToMarkdown, parseBlogPage } from "../src/blog-parser.js";

describe("parseBlogPage", () => {
  it("converts a blog URL and HTML into a ParsedPage", () => {
    const url = "https://www.anthropic.com/research/effective-agents";
    const html = `
<html>
<head><title>Building Effective Agents | Anthropic</title></head>
<body>
  <article>
    <h1>Building Effective Agents</h1>
    <p>This guide covers how to build agents that actually work well in practice.</p>
    <h2>Workflows</h2>
    <p>Detailed workflow content here.</p>
  </article>
</body>
</html>`;

    const page = parseBlogPage(url, html);

    expect(page).not.toBeNull();
    expect(page!.title).toBe("Building Effective Agents");
    expect(page!.url).toBe(url);
    expect(page!.path).toBe("/research/effective-agents");
    expect(page!.source).toBe("blog");
    expect(page!.content).toContain("Workflows");
  });

  it("extracts title from h1 in content", () => {
    const url = "https://www.anthropic.com/news/some-post";
    const html = `<html><body><article><h1>The Real Title</h1><p>Content that is long enough to be indexed.</p></article></body></html>`;

    const page = parseBlogPage(url, html);
    expect(page!.title).toBe("The Real Title");
  });

  it("returns null for empty content", () => {
    const url = "https://www.anthropic.com/news/empty";
    const html = `<html><body><article></article></body></html>`;

    const page = parseBlogPage(url, html);
    expect(page).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: FAIL — `parseBlogPage` is not exported

**Step 3: Implement parseBlogPage**

Add to `src/blog-parser.ts`:

```typescript
export function parseBlogPage(url: string, html: string): ParsedPage | null {
  const markdown = htmlToMarkdown(html);
  if (markdown.length === 0) return null;

  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    return null;
  }

  // Extract title from first h1 in markdown
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : urlPath.split("/").pop() || "Untitled";

  return {
    title,
    url,
    path: urlPath,
    content: markdown,
    source: "blog",
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/blog-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/blog-parser.ts tests/blog-parser.test.ts
git commit -m "feat(blog-parser): add blog page parsing into ParsedPage"
```

---

### Task 7: Build blog parser — batched fetch orchestration

**Files:**
- Modify: `src/blog-parser.ts`

**Step 1: Implement fetchWithTimeout, fetchBlogPages, and fetchSitemapUrls**

Add to `src/blog-parser.ts`:

```typescript
function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "anthropic-docs-mcp/2.0 (local indexer)" },
  }).finally(() => clearTimeout(timeout));
}

export async function fetchSitemapUrls(): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(BLOG_SITEMAP_URL);
    if (!response.ok) {
      console.error(`[blog-parser] Sitemap fetch failed: HTTP ${response.status}`);
      return [];
    }
    const xml = await response.text();
    return parseSitemap(xml);
  } catch (err) {
    console.error(`[blog-parser] Sitemap fetch error: ${(err as Error).message}`);
    return [];
  }
}

export async function fetchBlogPages(urls: string[]): Promise<ParsedPage[]> {
  const results: ParsedPage[] = [];

  for (let i = 0; i < urls.length; i += BLOG_CONCURRENCY) {
    const batch = urls.slice(i, i + BLOG_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
          console.error(`[blog-parser] ${url}: HTTP ${response.status}`);
          return null;
        }
        const html = await response.text();
        return parseBlogPage(url, html);
      })
    );

    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }

    if (i + BLOG_CONCURRENCY < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    console.error(`[blog-parser] Progress: ${Math.min(i + BLOG_CONCURRENCY, urls.length)}/${urls.length} pages`);
  }

  console.error(`[blog-parser] Fetched ${results.length} blog posts`);
  return results;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/blog-parser.ts
git commit -m "feat(blog-parser): add batched fetch orchestration with concurrency control"
```

---

### Task 8: Update database — exclude blog from generation swap

**Files:**
- Modify: `src/database.ts:77`
- Modify: `tests/database.test.ts`

**Step 1: Write the failing test**

Add to `tests/database.test.ts`:

```typescript
it("generation swap preserves blog rows", () => {
  // Insert blog content at generation 1
  insertPageSections(db, stmts, [makeSection({
    path: "/news/test-post",
    url: "https://www.anthropic.com/news/test-post",
    title: "Blog Post",
    source: "blog",
    content: "Blog content that should survive generation swaps and remain searchable.",
  })], 1);
  finalizeGeneration(db, stmts, 1);

  // Insert docs at generation 2 and finalize (this would normally delete gen 1)
  insertPageSections(db, stmts, [makeSection({
    content: "New docs content from the second generation crawl cycle.",
  })], 2);
  finalizeGeneration(db, stmts, 2);

  // Blog content should still be searchable
  const blogResults = searchDocs(stmts, "survive generation", 10, "blog");
  expect(blogResults).toHaveLength(1);
  expect(blogResults[0].title).toBe("Blog Post");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database.test.ts`
Expected: FAIL — blog row gets deleted by generation swap

**Step 3: Update deleteOldGen query**

In `src/database.ts:77`, change:

```typescript
deleteOldGen: db.prepare("DELETE FROM pages WHERE generation != ?"),
```

to:

```typescript
deleteOldGen: db.prepare("DELETE FROM pages WHERE generation != ? AND source != 'blog'"),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/database.ts tests/database.test.ts
git commit -m "feat(database): exclude blog rows from generation swap"
```

---

### Task 9: Add getIndexedBlogUrls query for sitemap-diff

**Files:**
- Modify: `src/database.ts`
- Modify: `tests/database.test.ts`

**Step 1: Write the failing test**

Add to `tests/database.test.ts` (also update the import to include `getIndexedBlogUrls`):

```typescript
it("returns indexed blog URLs for sitemap diff", () => {
  insertPageSections(db, stmts, [makeSection({
    path: "/news/post-a",
    url: "https://www.anthropic.com/news/post-a",
    source: "blog",
    content: "Content of blog post A with enough words to be meaningful in search.",
  })], 1);
  insertPageSections(db, stmts, [makeSection({
    path: "/research/post-b",
    url: "https://www.anthropic.com/research/post-b",
    source: "blog",
    content: "Content of blog post B with enough words to be meaningful in search.",
  })], 1);
  insertPageSections(db, stmts, [makeSection({
    source: "platform",
    content: "Platform doc content should not appear in blog URL list ever.",
  })], 1);
  finalizeGeneration(db, stmts, 1);

  const blogUrls = getIndexedBlogUrls(db);
  expect(blogUrls).toHaveLength(2);
  expect(blogUrls).toContain("https://www.anthropic.com/news/post-a");
  expect(blogUrls).toContain("https://www.anthropic.com/research/post-b");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database.test.ts`
Expected: FAIL — `getIndexedBlogUrls` is not exported

**Step 3: Implement getIndexedBlogUrls**

Add to `src/database.ts`:

```typescript
export function getIndexedBlogUrls(db: Database.Database): string[] {
  const rows = db.prepare("SELECT DISTINCT url FROM pages WHERE source = 'blog'").all() as { url: string }[];
  return rows.map((r) => r.url);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/database.ts tests/database.test.ts
git commit -m "feat(database): add getIndexedBlogUrls for sitemap-diff"
```

---

### Task 10: Update index.ts — integrate blog crawl

**Files:**
- Modify: `src/index.ts`

**Step 1: Add blog imports**

At top of `src/index.ts`, add:

```typescript
import { fetchSitemapUrls, fetchBlogPages } from "./blog-parser.js";
```

Add `getIndexedBlogUrls` to the existing database import, and `BLOG_STALE_DAYS` to the config import.

**Step 2: Add blog crawl function**

Add after the `startCrawl` function:

```typescript
async function startBlogCrawl(): Promise<number> {
  try {
    console.error("[server] Starting blog crawl...");
    const sitemapUrls = await fetchSitemapUrls();
    if (sitemapUrls.length === 0) {
      console.error("[server] No blog URLs found in sitemap.");
      return 0;
    }

    const indexedUrls = getIndexedBlogUrls(db);
    const newUrls = sitemapUrls.filter((url) => !indexedUrls.includes(url));

    if (newUrls.length === 0) {
      console.error(`[server] Blog index up to date (${indexedUrls.length} posts).`);
      setMetadata(stmts, "last_blog_crawl_timestamp", new Date().toISOString());
      return 0;
    }

    console.error(`[server] Found ${newUrls.length} new blog posts (${indexedUrls.length} already indexed).`);
    const pages = await fetchBlogPages(newUrls);

    const currentGen = getCurrentGeneration(stmts);
    let totalSections = 0;
    for (const page of pages) {
      const sections = pagesToSections(page);
      insertPageSections(db, stmts, sections, currentGen);
      totalSections += sections.length;
    }

    // Rebuild FTS to include new blog content
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");

    setMetadata(stmts, "last_blog_crawl_timestamp", new Date().toISOString());
    setMetadata(stmts, "blog_page_count", String(indexedUrls.length + pages.length));

    console.error(`[server] Blog crawl done. ${pages.length} new posts, ${totalSections} sections indexed.`);
    return pages.length;
  } catch (err) {
    console.error(`[server] Blog crawl failed: ${(err as Error).message}`);
    return 0;
  }
}
```

**Step 3: Add blog staleness check**

Add a `checkAndCrawlBlog` function after `checkAndCrawl`:

```typescript
function checkAndCrawlBlog() {
  const lastBlogCrawl = getMetadata(stmts, "last_blog_crawl_timestamp");

  if (!lastBlogCrawl) {
    console.error("[server] No blog index found. Starting initial blog crawl...");
    startBlogCrawl();
    return;
  }

  const age = Date.now() - new Date(lastBlogCrawl).getTime();
  const staleDays = age / (1000 * 60 * 60 * 24);

  if (staleDays > BLOG_STALE_DAYS) {
    console.error(`[server] Blog index is ${Math.round(staleDays)} days old. Refreshing...`);
    startBlogCrawl();
  } else {
    console.error(`[server] Blog index is ${staleDays.toFixed(1)} days old. Fresh enough.`);
  }
}
```

**Step 4: Call checkAndCrawlBlog in main**

Update `main()`:

```typescript
async function main() {
  checkAndCrawl();
  checkAndCrawlBlog();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");
}
```

**Step 5: Update refresh_index tool to trigger blog refresh**

In the `refresh_index` handler, add after the existing `startCrawl()` call:

```typescript
startBlogCrawl().catch((err) =>
  console.error("[server] Blog refresh failed:", err.message)
);
```

**Step 6: Update source enum in tool schemas**

In `search_anthropic_docs` and `list_doc_sections`, change:

```typescript
z.enum(["all", "platform", "code", "api-reference"])
```

to:

```typescript
z.enum(["all", "platform", "code", "api-reference", "blog"])
```

Update the `.describe()` strings to include `'blog'`.

**Step 7: Update index_status tool**

Add to the status array in `index_status` handler:

```typescript
const blogPageCount = getMetadata(stmts, "blog_page_count") || "0";
const lastBlogCrawl = getMetadata(stmts, "last_blog_crawl_timestamp");

// Add these lines to the status array:
`- Blog posts indexed: ${blogPageCount}`,
`- Last blog crawl: ${lastBlogCrawl || "never"}`,
`- Blog stale threshold: ${BLOG_STALE_DAYS} day(s)`,
```

**Step 8: Update list_doc_sections to show blog pages**

Add after the existing source group blocks:

```typescript
const blogPages = sections.filter((s) => s.source === "blog");

if (blogPages.length > 0) {
  output += `## Anthropic Blog (${blogPages.length} posts)\n\n`;
  for (const p of blogPages) {
    output += `- [${p.title}](${p.path})\n`;
  }
  output += "\n";
}
```

**Step 9: Type-check and run all tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: No type errors, all tests pass

**Step 10: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): integrate blog crawl with sitemap-diff and staleness check"
```

---

### Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update documentation**

Update the following sections:

- **What This Is**: mention blog indexing
- **Architecture**: add blog data flow
- **Data Sources**: add blog source info (~410 pages from sitemap)
- Add `src/blog-parser.ts` to the file list with its responsibility
- **Dependencies**: 4 runtime (add `node-html-markdown`)
- **Key Conventions**: mention `"blog"` source tag and 7-day staleness

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with blog indexing architecture"
```

---

### Task 12: Build and run full test suite

**Step 1: Build**

Run: `npm run build`
Expected: Clean compilation

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Commit if any build artifacts need updating**

```bash
git add -A
git commit -m "chore: verify blog indexing build and tests"
```
