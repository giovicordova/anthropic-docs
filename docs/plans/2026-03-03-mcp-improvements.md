# MCP Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the Anthropic docs MCP server with complete doc coverage, cleaner data, source-filtered search, and better tool descriptions.

**Architecture:** Four source files (`crawler.ts`, `database.ts`, `markdown.ts`, `index.ts`) in a TypeScript MCP server using SQLite FTS5 for search. Changes touch all four files: markdown.ts gets section filtering/splitting improvements, database.ts gets source-filtered search + query preprocessing, crawler.ts gets API reference page extraction, index.ts gets updated tool descriptions and source filter parameter.

**Tech Stack:** TypeScript, better-sqlite3, FTS5, Turndown, MCP SDK

---

### Task 1: Improve Section Splitting and Filtering in markdown.ts

**Files:**
- Modify: `src/markdown.ts:43-82`

**Step 1: Update `splitIntoSections` to split at h2/h3/h4 and filter short sections**

Replace the entire `splitIntoSections` function (lines 43-82) with:

```typescript
export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    // Filter out stub sections with less than 50 chars of real content
    if (content.length < 50) return;
    sections.push({
      heading: currentHeading,
      anchor: currentAnchor,
      content,
      order: order++,
    });
  }

  for (const line of lines) {
    // Split at ## and ### headings
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
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

  // Post-process: split oversized sections (>6KB) at h4 boundaries
  const MAX_SECTION_SIZE = 6000;
  const result: Section[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_SECTION_SIZE) {
      result.push(section);
      continue;
    }
    // Try splitting at #### headings
    const subLines = section.content.split("\n");
    let subHeading = section.heading;
    let subAnchor = section.anchor;
    let subContent: string[] = [];
    let subOrder = section.order;
    let didSplit = false;

    for (const subLine of subLines) {
      const h4Match = subLine.match(/^(####)\s+(.+)$/);
      if (h4Match && subContent.join("\n").trim().length >= 200) {
        const chunk = subContent.join("\n").trim();
        if (chunk.length >= 50) {
          result.push({
            heading: subHeading,
            anchor: subAnchor,
            content: chunk,
            order: subOrder++,
          });
          didSplit = true;
        }
        subHeading = `${section.heading} > ${h4Match[2].trim()}`;
        subAnchor = h4Match[2].trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-");
        subContent = [subLine];
      } else {
        subContent.push(subLine);
      }
    }
    // Flush remaining
    const remaining = subContent.join("\n").trim();
    if (remaining.length >= 50) {
      result.push({
        heading: didSplit ? subHeading : section.heading,
        anchor: didSplit ? subAnchor : section.anchor,
        content: remaining,
        order: subOrder,
      });
    }
    if (!didSplit) {
      // Couldn't split at h4 — keep the original large section
      // (already pushed via the remaining flush above)
    }
  }

  // Re-number order sequentially
  for (let i = 0; i < result.length; i++) {
    result[i].order = i;
  }

  return result;
}
```

**Step 2: Build and verify**

Run: `npx tsc`
Expected: No errors

**Step 3: Commit**

```bash
git add src/markdown.ts
git commit -m "feat(markdown): filter stub sections and split oversized ones at h4"
```

---

### Task 2: Add Source Filter and Query Preprocessing to database.ts

**Files:**
- Modify: `src/database.ts:14` (PageSection type)
- Modify: `src/database.ts:121-148` (searchDocs function)

**Step 1: Update the PageSection source type to include api-reference**

Change line 14 from:
```typescript
  source: "platform" | "code";
```
to:
```typescript
  source: "platform" | "code" | "api-reference";
```

**Step 2: Add query preprocessing function**

Add this function before `searchDocs` (before line 121):

```typescript
function preprocessQuery(query: string): string {
  // Remove characters that break FTS5 syntax
  let cleaned = query
    .replace(/[*"():^~{}[\]]/g, " ")  // Remove FTS5 special chars
    .replace(/\s+/g, " ")              // Collapse whitespace
    .trim();

  if (cleaned.length === 0) return '""';

  // Split into terms, filter empties
  const terms = cleaned.split(" ").filter((t) => t.length > 0);

  // If multiple terms, wrap each in quotes to avoid FTS5 operator conflicts
  // (words like "OR", "AND", "NOT" are FTS5 operators)
  if (terms.length > 1) {
    return terms.map((t) => `"${t}"`).join(" ");
  }

  return terms[0];
}
```

**Step 3: Update `searchDocs` to accept source filter and use query preprocessing**

Replace the entire `searchDocs` function (lines 121-148) with:

```typescript
export function searchDocs(
  db: Database.Database,
  query: string,
  limit: number = 10,
  source?: string
): SearchResult[] {
  const ftsQuery = preprocessQuery(query);

  const sourceFilter = source && source !== "all"
    ? "AND p.source = ?"
    : "";

  const stmt = db.prepare(`
    SELECT
      p.title,
      p.url,
      p.section_heading,
      p.source,
      snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
      bm25(pages_fts, 10.0, 5.0, 1.0) as rank
    FROM pages_fts
    JOIN pages p ON p.id = pages_fts.rowid
    WHERE pages_fts MATCH ?
    ${sourceFilter}
    ORDER BY rank
    LIMIT ?
  `);

  const params: any[] = [ftsQuery];
  if (source && source !== "all") params.push(source);
  params.push(limit);

  return stmt.all(...params).map((row: any) => ({
    title: row.title,
    url: row.url,
    sectionHeading: row.section_heading,
    snippet: row.snippet,
    relevanceScore: Math.abs(row.rank),
  }));
}
```

**Step 4: Build and verify**

Run: `npx tsc`
Expected: No errors

**Step 5: Commit**

```bash
git add src/database.ts
git commit -m "feat(database): add source filter, query preprocessing, tighter snippets"
```

---

### Task 3: Add API Reference Page Extraction to crawler.ts

**Files:**
- Modify: `src/crawler.ts:59-77` (extractArticleContent function)
- Modify: `src/crawler.ts:197-244` (crawlDocs function)

**Step 1: Update `extractArticleContent` to also handle API reference pages**

Replace the `extractArticleContent` function (lines 59-77) with:

```typescript
function extractArticleContent(html: string): { html: string; isApiRef: boolean } | null {
  // Standard docs: extract content inside <article id="content-container">
  const articleMatch = html.match(
    /<article[^>]*id=["']content-container["'][^>]*>([\s\S]*?)<\/article>/
  );
  if (articleMatch) return { html: articleMatch[1], isApiRef: false };

  // Fallback: try any <article> tag
  const fallbackMatch = html.match(
    /<article[^>]*>([\s\S]*?)<\/article>/
  );
  if (fallbackMatch) return { html: fallbackMatch[1], isApiRef: false };

  // API reference pages: extract from stldocs-root (excluding sidebar)
  // These pages have two stldocs-root divs — one with stldocs-sidebar (nav), one without (content)
  const stldocsMatches = html.match(
    /<div[^>]*class="[^"]*stldocs-root(?![^"]*stldocs-sidebar)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*stldocs-root|$)/g
  );

  if (stldocsMatches) {
    // Find the content div (the one without stldocs-sidebar)
    for (const match of stldocsMatches) {
      if (!match.includes("stldocs-sidebar")) {
        // Extract the inner content
        const innerMatch = match.match(/<div[^>]*>([\s\S]*)/);
        if (innerMatch) return { html: innerMatch[1], isApiRef: true };
      }
    }
  }

  return null;
}
```

**Step 2: Update the crawlDocs page processing to use the new return type**

In the `crawlDocs` function, update the `processInBatches` callback (around lines 205-234). Replace lines 209-230 with:

```typescript
    const extracted = extractArticleContent(html);
    if (!extracted) {
      console.error(`[crawler] SKIP ${entry.path}: no content found`);
      return;
    }

    const title = extractPageTitle(html);
    const markdown = htmlToMarkdown(extracted.html);
    const sections = splitIntoSections(markdown);
    const source = extracted.isApiRef ? "api-reference" : "platform";

    for (const section of sections) {
      insertPage(db, {
        url: entry.url,
        path: entry.path,
        title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
        source,
      });
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${total}] Indexed: ${entry.path} (${source})`);
```

**Step 3: Build and verify**

Run: `npx tsc`
Expected: No errors

**Step 4: Commit**

```bash
git add src/crawler.ts
git commit -m "feat(crawler): index API reference pages via stldocs extraction"
```

---

### Task 4: Update Tool Descriptions and Add Source Filter to index.ts

**Files:**
- Modify: `src/index.ts:52-103` (search tool)
- Modify: `src/index.ts:105-142` (get_doc_page tool)
- Modify: `src/index.ts:144-202` (list_doc_sections tool)
- Modify: `src/index.ts:204-230` (refresh_index tool)

**Step 1: Update the search tool with better description and source filter**

Replace the entire search tool registration (lines 52-103) with:

```typescript
server.registerTool(
  "search_anthropic_docs",
  {
    description:
      "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet. Use this tool when you need to find documentation about a specific topic, API endpoint, SDK method, or concept. Results are ranked by relevance using BM25 with title matches weighted highest. For broad queries, increase the limit; for precise lookups, use get_doc_page instead.",
    inputSchema: {
      query: z.string().describe("Search query string. Use specific terms for best results — e.g., 'tool use streaming' rather than 'how to stream tools'. Avoid FTS5 operators (OR, AND, NOT) as queries are auto-preprocessed."),
      source: z
        .enum(["all", "platform", "code", "api-reference"])
        .default("all")
        .describe("Filter results by documentation source: 'platform' for API/platform guides, 'code' for Claude Code docs, 'api-reference' for API endpoint reference, or 'all' (default)."),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (default 10)"),
    },
  },
  async ({ query, source, limit }) => {
    try {
      const results = searchDocs(db, query, limit, source);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}"${source !== "all" ? ` in ${source} docs` : ""}. Try different terms, or use refresh_index to re-crawl if the index is stale.`,
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
            text: `Search error: ${(err as Error).message}. Try simpler search terms.`,
          },
        ],
      };
    }
  }
);
```

**Step 2: Update get_doc_page description**

Replace the description string (line 110) with:

```typescript
    description:
      "Fetch the full markdown content of a specific documentation page by its URL path. Supports both platform.claude.com and code.claude.com docs. Use this when you already know which page you need — for example, after finding it via search_anthropic_docs or list_doc_sections. Supports fuzzy matching on the path suffix, so '/tool-use' will match '/docs/en/agents-and-tools/tool-use/overview'. Returns the complete page content concatenated from all sections.",
```

**Step 3: Update list_doc_sections description and add api-reference grouping**

Replace the list_doc_sections registration (lines 144-202) with:

```typescript
server.registerTool(
  "list_doc_sections",
  {
    description:
      "List all indexed documentation pages with their paths, grouped by source (Anthropic platform docs, Claude Code docs, and API reference). Use this to discover what documentation is available, browse by category, or find the correct path for get_doc_page. Returns a structured index of all pages — no search query needed.",
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

    const platformPages = sections.filter((s) => s.source === "platform");
    const codePages = sections.filter((s) => s.source === "code");
    const apiRefPages = sections.filter((s) => s.source === "api-reference");

    let output = `# Documentation Index\n\n${sections.length} pages indexed.\n\n`;

    if (platformPages.length > 0) {
      output += `## Anthropic Platform Docs (${platformPages.length} pages)\n\n`;
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

    if (apiRefPages.length > 0) {
      output += `## API Reference (${apiRefPages.length} pages)\n\n`;
      for (const p of apiRefPages) {
        output += `- [${p.title}](${p.path})\n`;
      }
      output += "\n";
    }

    if (codePages.length > 0) {
      output += `## Claude Code Docs (${codePages.length} pages)\n\n`;
      for (const p of codePages) {
        output += `- [${p.title}](${p.path})\n`;
      }
      output += "\n";
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);
```

**Step 4: Update refresh_index description**

Replace the description string (around line 209) with:

```typescript
    description:
      "Re-crawl and update the local documentation index for all sources: Anthropic platform docs, Claude Code docs, and API reference pages. Runs in the background and returns immediately — search results will update as pages are re-indexed. Use this if search results seem stale or if you know documentation has been updated recently. The index auto-refreshes every 7 days.",
```

**Step 5: Build and verify**

Run: `npx tsc`
Expected: No errors

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): add source filter param and improve tool descriptions"
```

---

### Task 5: Rebuild Database and Verify

**Step 1: Delete old database to force full re-crawl**

```bash
rm -f ~/.claude/mcp-data/anthropic-docs/docs.db
```

**Step 2: Build the project**

```bash
npx tsc
```

**Step 3: Run the server for ~6 minutes to crawl all sources**

```bash
node dist/index.js 2>&1 >/dev/null & PID=$!; sleep 360; kill $PID 2>/dev/null; wait $PID 2>/dev/null; true
```

**Step 4: Verify database contents**

```bash
sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT source, COUNT(DISTINCT path) as pages, COUNT(*) as sections FROM pages GROUP BY source;"
```

Expected: Three sources listed — `platform`, `code`, and `api-reference` with substantially more pages than before (was 245 total).

**Step 5: Verify no stub sections leaked through**

```bash
sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT COUNT(*) FROM pages WHERE LENGTH(content) < 50;"
```

Expected: `0`

**Step 6: Verify large section splitting worked**

```bash
sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT COUNT(*) FROM pages WHERE LENGTH(content) > 6000;"
```

Expected: Significantly fewer than the original 50 oversized sections.

**Step 7: Test search with source filter (via MCP JSON-RPC)**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_anthropic_docs","arguments":{"query":"tool use","source":"api-reference","limit":3}}}\n' | timeout 10 node dist/index.js 2>/dev/null
```

Expected: JSON response with results filtered to api-reference source.

**Step 8: Commit verification results as metadata update**

No code to commit — this is a verification-only task.
