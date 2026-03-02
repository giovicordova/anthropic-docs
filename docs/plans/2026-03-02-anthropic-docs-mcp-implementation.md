# Anthropic Docs MCP Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local MCP server that indexes Anthropic docs into SQLite FTS5 and exposes search/read/list/refresh tools to Claude Code via stdio.

**Architecture:** Sitemap-driven crawler fetches English docs from platform.claude.com, converts HTML to markdown with Turndown, splits at headings into sections, stores in SQLite FTS5. MCP server exposes 4 tools over stdio. Background re-crawl when data is stale (>7 days).

**Tech Stack:** Node.js 22 (TypeScript), `@modelcontextprotocol/sdk` v1, `better-sqlite3`, `turndown`, `zod`

**Design doc:** `docs/plans/2026-03-02-anthropic-docs-mcp-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

**Step 1: Initialize npm project**

```bash
cd /Users/giovannicordova/Documents/02_projects/anthropic-docs-mcp
npm init -y
```

Then edit `package.json` to set:
```json
{
  "name": "anthropic-docs-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

Key: `"type": "module"` is required — the MCP SDK uses ESM imports.

**Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk zod better-sqlite3 turndown
npm install -D typescript @types/better-sqlite3 @types/turndown @types/node
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 4: Create src directory**

```bash
mkdir -p src
```

**Step 5: Verify build works with empty file**

Create `src/index.ts` with:
```typescript
console.error("anthropic-docs-mcp: starting...");
```

Run:
```bash
npx tsc
node dist/index.js
```

Expected: prints "anthropic-docs-mcp: starting..." to stderr, then exits.

**Step 6: Commit**

```bash
git init
```

Create `.gitignore`:
```
node_modules/
dist/
*.db
```

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/index.ts
git commit -m "feat: scaffold project with dependencies"
```

---

## Task 2: Database Layer

**Files:**
- Create: `src/database.ts`

**Step 1: Implement database module**

This module handles all SQLite operations. It must:

1. Create the data directory at `~/.claude/mcp-data/anthropic-docs/` if it doesn't exist
2. Open/create `docs.db` in that directory
3. Create three structures on init:
   - `pages` table (id, url, path, title, section_heading, section_anchor, content, section_order, crawled_at)
   - `pages_fts` virtual table using FTS5 indexing title, section_heading, content with tokenize='porter unicode61'
   - `metadata` table (key TEXT PRIMARY KEY, value TEXT)
4. Export functions:
   - `initDatabase()` → opens DB, creates tables if not exist, returns db handle
   - `insertPage(db, page)` → inserts a row into pages and pages_fts
   - `clearPages(db)` → deletes all rows from pages and rebuilds FTS
   - `searchDocs(db, query, limit)` → FTS5 search with BM25, returns results with snippet
   - `getDocPage(db, path)` → get all sections for a path, ordered by section_order
   - `listSections(db)` → SELECT DISTINCT path, title ordered alphabetically
   - `getMetadata(db, key)` → get value from metadata table
   - `setMetadata(db, key, value)` → upsert into metadata table

```typescript
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface PageSection {
  url: string;
  path: string;
  title: string;
  sectionHeading: string | null;
  sectionAnchor: string | null;
  content: string;
  sectionOrder: number;
}

export interface SearchResult {
  title: string;
  url: string;
  sectionHeading: string | null;
  snippet: string;
  relevanceScore: number;
}

const DB_DIR = path.join(os.homedir(), ".claude", "mcp-data", "anthropic-docs");
const DB_PATH = path.join(DB_DIR, "docs.db");

export function initDatabase(): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      section_heading TEXT,
      section_anchor TEXT,
      content TEXT NOT NULL,
      section_order INTEGER NOT NULL,
      crawled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // FTS5 virtual table — check if it exists first
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pages_fts'"
    )
    .get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title,
        section_heading,
        content,
        content='pages',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);
  }

  return db;
}

export function insertPage(db: Database.Database, page: PageSection): void {
  const stmt = db.prepare(`
    INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, crawled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    page.url,
    page.path,
    page.title,
    page.sectionHeading,
    page.sectionAnchor,
    page.content,
    page.sectionOrder,
    new Date().toISOString()
  );

  // Insert into FTS index
  db.prepare(`
    INSERT INTO pages_fts (rowid, title, section_heading, content)
    VALUES (?, ?, ?, ?)
  `).run(
    result.lastInsertRowid,
    page.title,
    page.sectionHeading || "",
    page.content
  );
}

export function clearPages(db: Database.Database): void {
  db.exec("DELETE FROM pages");
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
}

export function searchDocs(
  db: Database.Database,
  query: string,
  limit: number = 10
): SearchResult[] {
  // bm25() weights: title (10x), section_heading (5x), content (1x)
  const stmt = db.prepare(`
    SELECT
      p.title,
      p.url,
      p.section_heading,
      snippet(pages_fts, 2, '<mark>', '</mark>', '...', 40) as snippet,
      bm25(pages_fts, 10.0, 5.0, 1.0) as rank
    FROM pages_fts
    JOIN pages p ON p.id = pages_fts.rowid
    WHERE pages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  return stmt.all(query, limit).map((row: any) => ({
    title: row.title,
    url: row.url,
    sectionHeading: row.section_heading,
    snippet: row.snippet,
    relevanceScore: Math.abs(row.rank),
  }));
}

export function getDocPage(
  db: Database.Database,
  searchPath: string
): { title: string; url: string; content: string } | null {
  // Try exact match first
  let rows = db
    .prepare(
      "SELECT title, url, content FROM pages WHERE path = ? ORDER BY section_order"
    )
    .all(searchPath) as any[];

  // Fuzzy: try matching the end of the path
  if (rows.length === 0) {
    rows = db
      .prepare(
        "SELECT title, url, content FROM pages WHERE path LIKE ? ORDER BY section_order"
      )
      .all(`%${searchPath}`) as any[];
  }

  if (rows.length === 0) return null;

  return {
    title: rows[0].title,
    url: rows[0].url,
    content: rows.map((r: any) => r.content).join("\n\n"),
  };
}

export function listSections(
  db: Database.Database
): { path: string; title: string }[] {
  return db
    .prepare(
      "SELECT DISTINCT path, title FROM pages ORDER BY path"
    )
    .all() as { path: string; title: string }[];
}

export function getMetadata(
  db: Database.Database,
  key: string
): string | null {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(
  db: Database.Database,
  key: string,
  value: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
  ).run(key, value);
}
```

**Step 2: Verify it compiles**

```bash
npx tsc
```

Expected: no errors.

**Step 3: Quick smoke test**

Create a temporary test script `src/_test_db.ts`:
```typescript
import { initDatabase, insertPage, searchDocs, getDocPage, listSections, clearPages } from "./database.js";

const db = initDatabase();
console.error("DB opened");

clearPages(db);

insertPage(db, {
  url: "https://platform.claude.com/docs/en/test",
  path: "/docs/en/test",
  title: "Test Page",
  sectionHeading: null,
  sectionAnchor: null,
  content: "This is a test page about tool use and streaming.",
  sectionOrder: 0,
});

insertPage(db, {
  url: "https://platform.claude.com/docs/en/test",
  path: "/docs/en/test",
  title: "Test Page",
  sectionHeading: "Streaming",
  sectionAnchor: "streaming",
  content: "Streaming allows you to receive partial responses as they are generated.",
  sectionOrder: 1,
});

const results = searchDocs(db, "streaming");
console.error("Search results:", JSON.stringify(results, null, 2));

const page = getDocPage(db, "/docs/en/test");
console.error("Full page:", JSON.stringify(page, null, 2));

const sections = listSections(db);
console.error("Sections:", JSON.stringify(sections, null, 2));

db.close();
console.error("PASS: database layer works");
```

Run:
```bash
npx tsc && node dist/_test_db.js
```

Expected: see search results with "streaming" matching, full page content concatenated, sections listed. Then delete the test file.

```bash
rm src/_test_db.ts dist/_test_db.js dist/_test_db.d.ts
```

**Step 4: Commit**

```bash
git add src/database.ts
git commit -m "feat: implement SQLite database layer with FTS5 search"
```

---

## Task 3: Markdown Conversion & Section Splitting

**Files:**
- Create: `src/markdown.ts`

**Step 1: Implement markdown module**

This module handles two things:
1. Converting HTML to clean markdown (using Turndown)
2. Splitting the resulting markdown into sections at heading boundaries

```typescript
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Remove images (they don't help in text search)
turndown.addRule("removeImages", {
  filter: "img",
  replacement: () => "",
});

// Keep code blocks clean
turndown.addRule("codeBlocks", {
  filter: (node) => {
    return (
      node.nodeName === "PRE" &&
      node.querySelector("code") !== null
    );
  },
  replacement: (_content, node) => {
    const codeEl = (node as HTMLElement).querySelector("code");
    if (!codeEl) return _content;
    const lang = codeEl.className?.match(/language-(\w+)/)?.[1] || "";
    const code = codeEl.textContent || "";
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  },
});

export interface Section {
  heading: string | null;
  anchor: string | null;
  content: string;
  order: number;
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function splitIntoSections(markdown: string): Section[] {
  // Split at ## and ### headings
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    if (content.length > 0) {
      sections.push({
        heading: currentHeading,
        anchor: currentAnchor,
        content,
        order: order++,
      });
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
      // Generate anchor from heading text
      currentAnchor = currentHeading
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-");
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  return sections;
}
```

**Step 2: Verify it compiles**

```bash
npx tsc
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/markdown.ts
git commit -m "feat: implement HTML-to-markdown conversion with section splitting"
```

---

## Task 4: Crawler

**Files:**
- Create: `src/crawler.ts`

**Step 1: Implement crawler module**

This module:
1. Fetches the sitemap from platform.claude.com
2. Parses XML to extract English doc URLs
3. Fetches each page, extracts `article#content-container`, converts to markdown, splits into sections
4. Inserts into database
5. Logs progress to stderr
6. Handles errors per-page (skip and continue)

```typescript
import type Database from "better-sqlite3";
import { insertPage, clearPages, setMetadata } from "./database.js";
import { htmlToMarkdown, splitIntoSections } from "./markdown.js";

const SITEMAP_URL = "https://platform.claude.com/sitemap.xml";
const CONCURRENCY = 5;

interface SitemapEntry {
  url: string;
  path: string;
}

export async function parseSitemap(): Promise<SitemapEntry[]> {
  console.error("[crawler] Fetching sitemap...");
  const response = await fetch(SITEMAP_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status}`);
  }

  const xml = await response.text();

  // Simple XML parsing — extract <loc> tags
  const urls: SitemapEntry[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;

  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    // Filter to English docs only
    if (url.includes("/docs/en/")) {
      const urlObj = new URL(url);
      urls.push({ url, path: urlObj.pathname });
    }
  }

  console.error(`[crawler] Found ${urls.length} English doc pages`);
  return urls;
}

async function fetchPageContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "anthropic-docs-mcp/1.0 (local indexer)",
      },
    });
    if (!response.ok) {
      console.error(`[crawler] SKIP ${url}: HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.error(`[crawler] SKIP ${url}: ${(err as Error).message}`);
    return null;
  }
}

function extractArticleContent(html: string): string | null {
  // Extract content inside <article id="content-container">...</article>
  // Use a simple regex approach since we know the structure
  const articleMatch = html.match(
    /<article[^>]*id=["']content-container["'][^>]*>([\s\S]*?)<\/article>/
  );
  if (articleMatch) return articleMatch[1];

  // Fallback: try any <article> tag
  const fallbackMatch = html.match(
    /<article[^>]*>([\s\S]*?)<\/article>/
  );
  if (fallbackMatch) return fallbackMatch[1];

  return null;
}

function extractPageTitle(html: string): string {
  // Try <h1> first
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/s);
  if (h1Match) {
    // Strip HTML tags from the h1 content
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }

  // Fallback to <title>
  const titleMatch = html.match(/<title>(.*?)<\/title>/);
  if (titleMatch) return titleMatch[1].replace(/ \|.*$/, "").trim();

  return "Untitled";
}

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;

  async function nextBatch() {
    const batch: Promise<void>[] = [];
    while (batch.length < concurrency && index < items.length) {
      const currentIndex = index++;
      batch.push(handler(items[currentIndex], currentIndex));
    }
    await Promise.all(batch);
  }

  while (index < items.length) {
    await nextBatch();
  }
}

export async function crawlDocs(db: Database.Database): Promise<number> {
  const entries = await parseSitemap();
  const total = entries.length;
  let indexed = 0;

  console.error(`[crawler] Starting crawl of ${total} pages...`);
  clearPages(db);

  await processInBatches(entries, CONCURRENCY, async (entry, i) => {
    const html = await fetchPageContent(entry.url);
    if (!html) return;

    const articleHtml = extractArticleContent(html);
    if (!articleHtml) {
      console.error(`[crawler] SKIP ${entry.path}: no article content found`);
      return;
    }

    const title = extractPageTitle(html);
    const markdown = htmlToMarkdown(articleHtml);
    const sections = splitIntoSections(markdown);

    for (const section of sections) {
      insertPage(db, {
        url: entry.url,
        path: entry.path,
        title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
      });
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${total}] Indexed: ${entry.path}`);
  });

  setMetadata(db, "last_crawl_timestamp", new Date().toISOString());
  setMetadata(db, "page_count", String(indexed));

  console.error(`[crawler] Done. Indexed ${indexed}/${total} pages.`);
  return indexed;
}
```

**Important note on `extractArticleContent`:** The regex approach for HTML extraction is a starting point. If the actual page HTML has nested `<article>` tags or different structure than expected, this may need adjustment during testing. The fallback to any `<article>` tag provides a safety net.

**Step 2: Verify it compiles**

```bash
npx tsc
```

Expected: no errors.

**Step 3: Quick integration test — fetch sitemap only**

Create `src/_test_sitemap.ts`:
```typescript
import { parseSitemap } from "./crawler.js";

parseSitemap().then((entries) => {
  console.error(`Found ${entries.length} entries`);
  console.error("First 5:", entries.slice(0, 5));
  console.error("Last 5:", entries.slice(-5));
});
```

Run:
```bash
npx tsc && node dist/_test_sitemap.js
```

Expected: prints the count of English doc URLs and samples. Verify the count is roughly 200-300. Note the exact URL patterns for any needed adjustments.

Clean up:
```bash
rm src/_test_sitemap.ts dist/_test_sitemap.js dist/_test_sitemap.d.ts
```

**Step 4: Full crawl test**

Create `src/_test_crawl.ts`:
```typescript
import { initDatabase } from "./database.js";
import { crawlDocs } from "./crawler.js";

const db = initDatabase();
crawlDocs(db).then((count) => {
  console.error(`Crawled ${count} pages`);
  db.close();
});
```

Run:
```bash
npx tsc && node dist/_test_crawl.js
```

Expected: see progress as pages are crawled. This will take 1-3 minutes. Watch for:
- Are pages being found and indexed?
- Are there many SKIPs? If > 20% skip rate, the article extraction may need adjustment.
- Does it complete without crashing?

After successful crawl, verify DB:
```bash
ls -lh ~/.claude/mcp-data/anthropic-docs/docs.db
```

Expected: DB file exists, size should be several MB.

Clean up:
```bash
rm src/_test_crawl.ts dist/_test_crawl.js dist/_test_crawl.d.ts
```

**Step 5: Commit**

```bash
git add src/crawler.ts
git commit -m "feat: implement sitemap crawler with concurrent page fetching"
```

---

## Task 5: MCP Server

**Files:**
- Modify: `src/index.ts`

**Step 1: Implement the MCP server with all 4 tools**

Replace the placeholder `src/index.ts` with the full server implementation:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDatabase,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
} from "./database.js";
import { crawlDocs } from "./crawler.js";

const server = new McpServer({
  name: "anthropic-docs",
  version: "1.0.0",
});

const db = initDatabase();

// Check if we need to crawl on startup
const STALE_DAYS = 7;

function checkAndCrawl() {
  const lastCrawl = getMetadata(db, "last_crawl_timestamp");

  if (!lastCrawl) {
    console.error("[server] No index found. Starting initial crawl...");
    crawlDocs(db).catch((err) =>
      console.error("[server] Crawl failed:", err.message)
    );
    return;
  }

  const age = Date.now() - new Date(lastCrawl).getTime();
  const staleDays = age / (1000 * 60 * 60 * 24);

  if (staleDays > STALE_DAYS) {
    console.error(
      `[server] Index is ${Math.round(staleDays)} days old. Refreshing in background...`
    );
    crawlDocs(db).catch((err) =>
      console.error("[server] Background crawl failed:", err.message)
    );
  } else {
    console.error(
      `[server] Index is ${Math.round(staleDays)} days old. Fresh enough.`
    );
  }
}

// --- Tool: search_anthropic_docs ---
server.registerTool(
  "search_anthropic_docs",
  {
    description:
      "Full-text search across all indexed Anthropic documentation. Returns ranked results with page title, URL, section heading, and content snippet.",
    inputSchema: {
      query: z.string().describe("Search query string"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (default 10)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = searchDocs(db, query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}". The index may still be building — try again in a minute, or use refresh_index to re-crawl.`,
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**${r.sectionHeading ? ` > ${r.sectionHeading}` : ""}\n   URL: ${r.url}\n   ${r.snippet}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${(err as Error).message}. The query syntax may be invalid for FTS5 — try simpler terms.`,
          },
        ],
      };
    }
  }
);

// --- Tool: get_doc_page ---
server.registerTool(
  "get_doc_page",
  {
    description:
      "Fetch the full markdown content of a specific Anthropic documentation page by its URL path. Supports fuzzy matching.",
    inputSchema: {
      path: z
        .string()
        .describe(
          'URL path of the doc page, e.g., "/docs/en/build-with-claude/tool-use"'
        ),
    },
  },
  async ({ path: docPath }) => {
    const result = getDocPage(db, docPath);

    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Page not found: "${docPath}". Use search_anthropic_docs to find the correct path, or list_doc_sections to browse available pages.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n${result.content}`,
        },
      ],
    };
  }
);

// --- Tool: list_doc_sections ---
server.registerTool(
  "list_doc_sections",
  {
    description:
      "List all indexed Anthropic documentation pages with their paths. Useful for discovering what documentation is available.",
    inputSchema: {},
  },
  async () => {
    const sections = listSections(db);

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No pages indexed yet. The index may still be building — try again in a minute, or use refresh_index.",
          },
        ],
      };
    }

    // Group by top-level path segment
    const grouped: Record<string, { path: string; title: string }[]> = {};
    for (const s of sections) {
      // Extract category from path like /docs/en/category/...
      const parts = s.path.split("/").filter(Boolean);
      const category = parts.length > 2 ? parts[2] : "root";
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(s);
    }

    let output = `# Anthropic Documentation Index\n\n${sections.length} pages indexed.\n\n`;

    for (const [category, pages] of Object.entries(grouped).sort()) {
      output += `## ${category.replace(/-/g, " ")}\n\n`;
      for (const p of pages) {
        output += `- [${p.title}](${p.path})\n`;
      }
      output += "\n";
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// --- Tool: refresh_index ---
server.registerTool(
  "refresh_index",
  {
    description:
      "Re-crawl and update the local Anthropic documentation index. Runs in the background — returns immediately.",
    inputSchema: {},
  },
  async () => {
    const lastCrawl = getMetadata(db, "last_crawl_timestamp");
    const pageCount = getMetadata(db, "page_count") || "unknown";

    // Start crawl in background (don't await)
    crawlDocs(db).catch((err) =>
      console.error("[server] Refresh crawl failed:", err.message)
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Refresh started. Previous index: ${pageCount} pages, last crawled ${lastCrawl || "never"}. Crawling in background — search results will update as pages are re-indexed.`,
        },
      ],
    };
  }
);

// --- Start server ---
async function main() {
  checkAndCrawl();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server running on stdio");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
```

**Step 2: Compile**

```bash
npx tsc
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: implement MCP server with all 4 tools"
```

---

## Task 6: MCP Handshake Verification

**Step 1: Test MCP protocol handshake**

Send an `initialize` request to the server via stdin and verify it responds correctly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node dist/index.js 2>/dev/null | head -1
```

Expected: a JSON response containing `"result"` with server info — NOT an error.

**Step 2: Test tools/list**

After initialize, we need to send both initialize and tools/list. Create a small test script:

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'; echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}') | node dist/index.js 2>/dev/null
```

Expected: see two JSON responses. The second one should list all 4 tools: `search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`.

**Step 3: Test a search call (if index exists from Task 4)**

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'; echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; sleep 0.5; echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_anthropic_docs","arguments":{"query":"tool use","limit":3}}}') | node dist/index.js 2>/dev/null
```

Expected: JSON response with search results about tool use.

**Step 4: Fix any issues found during testing**

If the handshake fails, common issues:
- Server writing to stdout instead of stderr for logging (all console.error is correct, any console.log would break protocol)
- Missing or incorrect `protocolVersion` in response
- ESM import resolution issues (check file extensions in imports)

---

## Task 7: Register in Claude Code

**Step 1: Update ~/.claude/.mcp.json**

Read the current file, add the new entry alongside existing servers:

The file currently contains:
```json
{
  "mcpServers": {
    "lighthouse": { ... },
    "vercel": { ... }
  }
}
```

Add the `anthropic-docs` entry inside `mcpServers`:
```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "npx",
      "args": ["@danielsogl/lighthouse-mcp@latest"]
    },
    "vercel": {
      "type": "http",
      "url": "https://mcp.vercel.com"
    },
    "anthropic-docs": {
      "command": "node",
      "args": ["/Users/giovannicordova/Documents/02_projects/anthropic-docs-mcp/dist/index.js"]
    }
  }
}
```

**Step 2: Commit all files**

```bash
git add -A
git commit -m "feat: complete anthropic-docs MCP server ready for registration"
```

---

## Task 8: End-to-End Verification

This task is done manually by the user starting a new Claude Code session.

**Step 1:** Start a new Claude Code session (close and reopen, or open a new terminal).

**Step 2:** Check that the MCP tools appear. In the new session, try:
- Ask Claude to search the Anthropic docs for "tool use"
- Ask Claude to get a specific doc page
- Ask Claude to list all available doc sections

**Step 3:** If tools don't appear:
- Check `~/.claude/.mcp.json` is valid JSON
- Check `node /Users/giovannicordova/Documents/02_projects/anthropic-docs-mcp/dist/index.js` runs without crashing
- Check stderr output for error messages

---

## Troubleshooting Notes

**If article extraction fails on many pages:**
The `extractArticleContent` regex in `crawler.ts` targets `<article id="content-container">`. If the actual HTML uses a different ID or structure, update the regex. Run a crawl test with verbose logging to see which pages fail.

**If FTS5 search returns no results:**
Check that the `pages_fts` table has data: `sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT count(*) FROM pages_fts"`

**If the MCP handshake hangs:**
The server may be writing to stdout (breaking the JSON-RPC stream). Verify ALL logging uses `console.error`, never `console.log`.

**If imports fail at runtime:**
Ensure all local imports use `.js` extension: `import { foo } from "./bar.js"` — this is required for Node ESM.
