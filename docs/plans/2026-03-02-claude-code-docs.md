# Claude Code Docs Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add all 59 English Claude Code documentation pages (from code.claude.com/docs) to the existing MCP server's search index alongside the Anthropic API docs.

**Architecture:** The code.claude.com site renders content client-side (Next.js/Mintlify), so HTML crawling won't work. Instead, we fetch `https://code.claude.com/docs/llms-full.txt` — a single file containing all 59 English docs pre-formatted as markdown with clear page boundaries (`# Title\nSource: URL`). We parse this into pages, split each into sections using the existing `splitIntoSections()`, and insert into the same database/FTS index. The existing platform.claude.com sitemap crawl stays unchanged.

**Tech Stack:** TypeScript, better-sqlite3 with FTS5, Turndown (existing), Node native fetch

---

### Task 1: Add `source` column to database schema

We need to distinguish which site a page came from so `list_doc_sections` can group docs by site. Adding a `source` column (`"platform"` or `"code"`) is the cleanest way.

**Files:**
- Modify: `src/database.ts:33-50` (schema creation)
- Modify: `src/database.ts:75-102` (insertPage function + PageSection interface)

**Step 1: Update PageSection interface**

Add `source` to the interface at `src/database.ts:6-14`:

```typescript
export interface PageSection {
  url: string;
  path: string;
  title: string;
  sectionHeading: string | null;
  sectionAnchor: string | null;
  content: string;
  sectionOrder: number;
  source: "platform" | "code";
}
```

**Step 2: Update CREATE TABLE statement**

Add `source TEXT NOT NULL DEFAULT 'platform'` to the pages table in `initDatabase()`:

```sql
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  section_heading TEXT,
  section_anchor TEXT,
  content TEXT NOT NULL,
  section_order INTEGER NOT NULL,
  crawled_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'platform'
);
```

**Step 3: Update insertPage to include source**

```typescript
export function insertPage(db: Database.Database, page: PageSection): void {
  const stmt = db.prepare(`
    INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, crawled_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    page.url,
    page.path,
    page.title,
    page.sectionHeading,
    page.sectionAnchor,
    page.content,
    page.sectionOrder,
    new Date().toISOString(),
    page.source
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
```

**Step 4: Handle existing database migration**

The `DEFAULT 'platform'` clause handles existing rows. But better-sqlite3 won't add the column to an existing table via `CREATE TABLE IF NOT EXISTS`. Add migration logic after table creation in `initDatabase()`:

```typescript
// Migrate: add source column if missing
const hasSource = db
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('pages') WHERE name='source'")
  .get() as { cnt: number };

if (hasSource.cnt === 0) {
  db.exec("ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'");
}
```

**Step 5: Compile and verify**

Run: `npx tsc 2>&1`
Expected: Compilation errors in `crawler.ts` because `insertPage` calls don't pass `source` yet. That's expected — we fix it in Task 2.

**Step 6: Commit**

```bash
git add src/database.ts
git commit -m "feat(db): add source column to distinguish platform vs code docs"
```

---

### Task 2: Add Claude Code docs crawler using llms-full.txt

The core new functionality. Fetches the llms-full.txt file, parses it into pages, and indexes them.

**Files:**
- Modify: `src/crawler.ts` (add new functions, update crawlDocs)

**Step 1: Add constants and types for Claude Code docs**

Add near the top of `src/crawler.ts`, after the existing constants:

```typescript
const CLAUDE_CODE_DOCS_URL = "https://code.claude.com/docs/llms-full.txt";
```

**Step 2: Add llms-full.txt parser function**

Add after the existing `extractPageTitle` function:

```typescript
interface ParsedPage {
  title: string;
  url: string;
  path: string;
  content: string;
}

function parseLlmsFullTxt(text: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    // Look for page boundary: "# Title" followed by "Source: URL"
    if (lines[i].startsWith("# ") && i + 1 < lines.length && lines[i + 1].startsWith("Source: https://code.claude.com/docs/en/")) {
      const title = lines[i].slice(2).trim();
      const url = lines[i + 1].slice("Source: ".length).trim();
      const path = new URL(url).pathname;

      // Collect content until next page boundary
      const contentLines: string[] = [];
      i += 2; // Skip title and source lines
      while (i < lines.length) {
        // Check if this is the start of a new page
        if (lines[i].startsWith("# ") && i + 1 < lines.length && lines[i + 1].startsWith("Source: https://code.claude.com/docs/en/")) {
          break;
        }
        contentLines.push(lines[i]);
        i++;
      }

      const content = contentLines.join("\n").trim();
      if (content.length > 0) {
        pages.push({ title, url, path, content });
      }
    } else {
      i++;
    }
  }

  return pages;
}
```

**Step 3: Add crawlClaudeCodeDocs function**

Add after `parseLlmsFullTxt`:

```typescript
async function crawlClaudeCodeDocs(db: Database.Database): Promise<number> {
  console.error("[crawler] Fetching Claude Code docs from llms-full.txt...");

  const response = await fetch(CLAUDE_CODE_DOCS_URL, {
    headers: {
      "User-Agent": "anthropic-docs-mcp/1.0 (local indexer)",
    },
  });

  if (!response.ok) {
    console.error(`[crawler] Failed to fetch llms-full.txt: HTTP ${response.status}`);
    return 0;
  }

  const text = await response.text();
  const pages = parseLlmsFullTxt(text);
  console.error(`[crawler] Parsed ${pages.length} Claude Code doc pages`);

  let indexed = 0;
  for (const page of pages) {
    const sections = splitIntoSections(page.content);

    for (const section of sections) {
      insertPage(db, {
        url: page.url,
        path: page.path,
        title: page.title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
        source: "code",
      });
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${pages.length}] Indexed: ${page.path}`);
  }

  return indexed;
}
```

**Step 4: Update crawlDocs to crawl both sources**

Modify the existing `crawlDocs` function to also call `crawlClaudeCodeDocs`. Update the `source` field on existing platform insertions:

```typescript
export async function crawlDocs(db: Database.Database): Promise<number> {
  const entries = await parseSitemap();
  const total = entries.length;
  let indexed = 0;

  console.error(`[crawler] Starting crawl of ${total} platform pages...`);
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
        source: "platform",
      });
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${total}] Indexed: ${entry.path}`);
  });

  // Crawl Claude Code docs
  const codeIndexed = await crawlClaudeCodeDocs(db);
  indexed += codeIndexed;

  setMetadata(db, "last_crawl_timestamp", new Date().toISOString());
  setMetadata(db, "page_count", String(indexed));

  console.error(`[crawler] Done. Indexed ${indexed} total pages (${indexed - codeIndexed} platform + ${codeIndexed} code).`);
  return indexed;
}
```

**Step 5: Compile and verify**

Run: `npx tsc 2>&1`
Expected: Clean compilation, no errors.

**Step 6: Commit**

```bash
git add src/crawler.ts
git commit -m "feat(crawler): add Claude Code docs crawling via llms-full.txt"
```

---

### Task 3: Update MCP tool descriptions and list_doc_sections grouping

Update the server to reflect that it now indexes both Anthropic API docs and Claude Code docs.

**Files:**
- Modify: `src/index.ts:13-16` (server name/description)
- Modify: `src/index.ts:52-103` (search tool description)
- Modify: `src/index.ts:106-142` (get_doc_page description)
- Modify: `src/index.ts:144-190` (list_doc_sections grouping logic)
- Modify: `src/index.ts:192-218` (refresh_index description)
- Modify: `src/database.ts:167-175` (listSections query to include source)

**Step 1: Update listSections to return source**

In `src/database.ts`, update the return type and query:

```typescript
export function listSections(
  db: Database.Database
): { path: string; title: string; source: string }[] {
  return db
    .prepare(
      "SELECT DISTINCT path, title, source FROM pages ORDER BY source, path"
    )
    .all() as { path: string; title: string; source: string }[];
}
```

**Step 2: Update list_doc_sections tool to group by source**

Replace the grouping logic in `src/index.ts` (the `list_doc_sections` handler):

```typescript
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

    // Group by source first, then by category within source
    const platformPages = sections.filter((s) => s.source === "platform");
    const codePages = sections.filter((s) => s.source === "code");

    let output = `# Documentation Index\n\n${sections.length} pages indexed.\n\n`;

    if (platformPages.length > 0) {
      output += `## Anthropic API & Platform Docs\n\n`;
      const grouped: Record<string, { path: string; title: string }[]> = {};
      for (const s of platformPages) {
        const parts = s.path.split("/").filter(Boolean);
        const category = parts.length > 2 ? parts[2] : "root";
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push(s);
      }
      for (const [category, pages] of Object.entries(grouped).sort()) {
        output += `### ${category.replace(/-/g, " ")}\n\n`;
        for (const p of pages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }
    }

    if (codePages.length > 0) {
      output += `## Claude Code Docs\n\n`;
      for (const p of codePages) {
        output += `- [${p.title}](${p.path})\n`;
      }
      output += "\n";
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
```

**Step 3: Update tool descriptions**

In `src/index.ts`, update the `search_anthropic_docs` description:

```typescript
description:
  "Full-text search across all indexed Anthropic documentation. Returns ranked results with page title, URL, section heading, and content snippet.",
```

Change to:

```typescript
description:
  "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet.",
```

Update `get_doc_page` description:

```typescript
description:
  "Fetch the full markdown content of a specific documentation page by its URL path. Supports both platform.claude.com and code.claude.com docs. Supports fuzzy matching.",
```

Update `list_doc_sections` description:

```typescript
description:
  "List all indexed documentation pages with their paths, grouped by source (Anthropic platform docs and Claude Code docs). Useful for discovering what documentation is available.",
```

Update `refresh_index` description:

```typescript
description:
  "Re-crawl and update the local documentation index for both Anthropic platform docs and Claude Code docs. Runs in the background — returns immediately.",
```

**Step 4: Compile and verify**

Run: `npx tsc 2>&1`
Expected: Clean compilation.

**Step 5: Commit**

```bash
git add src/database.ts src/index.ts
git commit -m "feat(server): update tools for dual-source docs (platform + Claude Code)"
```

---

### Task 4: Delete existing database and rebuild

The schema changed (new `source` column). Easiest path: delete the old DB and let it rebuild.

**Step 1: Delete existing database**

```bash
rm -f ~/.claude/mcp-data/anthropic-docs/docs.db
```

**Step 2: Compile the project**

```bash
npx tsc 2>&1
```

Expected: Clean compilation.

**Step 3: Test the server starts and crawls**

Run the server for ~60 seconds to let both crawls complete:

```bash
timeout 120 node dist/index.js 2>&1 >/dev/null || true
```

Watch stderr for: `[crawler] Parsed 59 Claude Code doc pages` and `[crawler] Done. Indexed N total pages (M platform + 59 code).`

**Step 4: Verify database contents**

```bash
sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT source, COUNT(DISTINCT path) as pages, COUNT(*) as sections FROM pages GROUP BY source;"
```

Expected output should show two rows:
- `code|59|<several hundred sections>`
- `platform|<~200 pages>|<several hundred sections>`

**Step 5: Commit**

No files changed — this was a verification step.

---

### Task 5: End-to-end MCP tool verification

Test all 4 tools work with the dual-source index via JSON-RPC.

**Step 1: Test search finds Claude Code docs**

Send a JSON-RPC search request for "hooks" (a topic in Claude Code docs):

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_anthropic_docs","arguments":{"query":"hooks","limit":5}}}\n' | timeout 10 node dist/index.js 2>/dev/null
```

Expected: Results should include pages from both `code.claude.com` (Claude Code hooks docs) and `platform.claude.com` (if any hook-related API docs exist).

**Step 2: Test get_doc_page for a Claude Code doc**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_doc_page","arguments":{"path":"/docs/en/quickstart"}}}\n' | timeout 10 node dist/index.js 2>/dev/null
```

Expected: Returns the full quickstart page content from Claude Code docs.

**Step 3: Test list_doc_sections shows both sources**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_doc_sections","arguments":{}}}\n' | timeout 10 node dist/index.js 2>/dev/null
```

Expected: Output should show "## Anthropic API & Platform Docs" and "## Claude Code Docs" sections.

**Step 4: Commit any fixes needed**

If any tests fail, fix and commit:

```bash
git add -A
git commit -m "fix: resolve issues found during e2e verification"
```

If all pass with no changes, skip this step.
