# Audit Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the MCP server with 6 improvements from the audit: error flags, batched inserts, orphan cleanup, prepared statement caching, status tool, and concurrency bump.

**Architecture:** All changes stay within the existing 5-file structure. No new files. Database gets cached prepared statements and a cleanup function. Crawler batches writes per page. Server gets `isError` flags and a new `index_status` tool. Config gets a concurrency bump.

**Tech Stack:** TypeScript, better-sqlite3, @modelcontextprotocol/sdk, zod

---

### Task 1: Bump Concurrency to 10

**Files:**
- Modify: `src/config.ts:5`

**Step 1: Change the concurrency value**

In `src/config.ts`, change line 5 from:
```typescript
export const CONCURRENCY = 5;
```
to:
```typescript
export const CONCURRENCY = 10;
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

Message: `perf: bump crawl concurrency from 5 to 10`
Files: `src/config.ts`

---

### Task 2: Add `isError` Flag to Error Responses

The MCP protocol supports `isError: true` on tool results so the model knows something actually failed (vs. "no results found"). Currently all errors return as plain text.

**Files:**
- Modify: `src/index.ts:104-142` (search tool handler)
- Modify: `src/index.ts:42-54` (firstRunBuildingResponse)

**Step 1: Add `isError: true` to the search tool's catch block**

In `src/index.ts`, find the catch block inside the `search_anthropic_docs` handler (around line 132). Change the return to include `isError: true`:
```typescript
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${(err as Error).message}. Try simpler search terms.`,
          },
        ],
        isError: true,
      };
    }
```

**Step 2: Add `isError: true` to the first-run building response**

In `src/index.ts`, update `firstRunBuildingResponse` return type and add `isError: true`:
```typescript
function firstRunBuildingResponse(): { content: { type: "text"; text: string }[]; isError?: boolean } | null {
  if (!getMetadata(db, "last_crawl_timestamp") && crawlState === "crawling") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Index is being built for the first time (~30-60s). Try again shortly.",
        },
      ],
      isError: true,
    };
  }
  return null;
}
```

**Step 3: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors

**Step 4: Commit**

Message: `fix: add isError flag to MCP error responses`
Files: `src/index.ts`

---

### Task 3: Cache Prepared Statements in database.ts

Currently `db.prepare()` is called on every function invocation. Caching avoids re-parsing SQL on every call.

**Files:**
- Modify: `src/database.ts`
- Modify: `src/index.ts`
- Modify: `src/crawler.ts`

**Step 1: Add a `Statements` interface and `prepareStatements` function**

After the existing `initDatabase` function (after line 99 in database.ts), add:

```typescript
export interface Statements {
  insertPage: Database.Statement;
  insertFts: Database.Statement;
  deleteOldGen: Database.Statement;
  rebuildFts: string; // exec, not prepare
  setGeneration: Database.Statement;
  search: Database.Statement;
  searchWithSource: Database.Statement;
  exactPath: Database.Statement;
  suffixPath: Database.Statement;
  segmentPath: Database.Statement;
  listAll: Database.Statement;
  listBySource: Database.Statement;
  getMetadata: Database.Statement;
  setMetadata: Database.Statement;
  getCurrentGen: Database.Statement;
}

export function prepareStatements(db: Database.Database): Statements {
  return {
    insertPage: db.prepare(`
      INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, source, generation, crawled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertFts: db.prepare(`
      INSERT INTO pages_fts (rowid, title, section_heading, content)
      VALUES (?, ?, ?, ?)
    `),
    deleteOldGen: db.prepare("DELETE FROM pages WHERE generation != ?"),
    rebuildFts: "INSERT INTO pages_fts(pages_fts) VALUES('rebuild')",
    setGeneration: db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('current_generation', ?)"
    ),
    search: db.prepare(`
      SELECT
        p.title, p.url, p.section_heading, p.source,
        snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
        bm25(pages_fts, 10.0, 5.0, 1.0) as rank
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    searchWithSource: db.prepare(`
      SELECT
        p.title, p.url, p.section_heading, p.source,
        snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
        bm25(pages_fts, 10.0, 5.0, 1.0) as rank
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      AND p.source = ?
      ORDER BY rank
      LIMIT ?
    `),
    exactPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path = ? ORDER BY section_order"
    ),
    suffixPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
    ),
    segmentPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
    ),
    listAll: db.prepare(
      "SELECT DISTINCT path, title, source FROM pages ORDER BY source, path"
    ),
    listBySource: db.prepare(
      "SELECT DISTINCT path, title, source FROM pages WHERE source = ? ORDER BY source, path"
    ),
    getMetadata: db.prepare("SELECT value FROM metadata WHERE key = ?"),
    setMetadata: db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
    ),
    getCurrentGen: db.prepare(
      "SELECT value FROM metadata WHERE key = 'current_generation'"
    ),
  };
}
```

**Step 2: Refactor all existing functions to accept `Statements`**

Replace function signatures and bodies:

`getCurrentGeneration`:
```typescript
export function getCurrentGeneration(stmts: Statements): number {
  const row = stmts.getCurrentGen.get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}
```

`insertPage`:
```typescript
export function insertPage(db: Database.Database, stmts: Statements, page: PageSection, generation: number): void {
  const doInsert = db.transaction(() => {
    const result = stmts.insertPage.run(
      page.url, page.path, page.title, page.sectionHeading, page.sectionAnchor,
      page.content, page.sectionOrder, page.source, generation, new Date().toISOString()
    );
    stmts.insertFts.run(result.lastInsertRowid, page.title, page.sectionHeading || "", page.content);
  });
  doInsert();
}
```

`finalizeGeneration`:
```typescript
export function finalizeGeneration(db: Database.Database, stmts: Statements, keepGeneration: number): void {
  const finalize = db.transaction(() => {
    stmts.deleteOldGen.run(keepGeneration);
    db.exec(stmts.rebuildFts);
    stmts.setGeneration.run(String(keepGeneration));
  });
  finalize();
}
```

`searchDocs`:
```typescript
export function searchDocs(stmts: Statements, query: string, limit: number = 10, source?: string): SearchResult[] {
  const ftsQuery = preprocessQuery(query);
  const rows = source && source !== "all"
    ? stmts.searchWithSource.all(ftsQuery, source, limit)
    : stmts.search.all(ftsQuery, limit);
  return (rows as any[]).map((row) => ({
    title: row.title,
    url: row.url,
    sectionHeading: row.section_heading,
    snippet: row.snippet,
    relevanceScore: Math.abs(row.rank),
  }));
}
```

`getDocPage`:
```typescript
export function getDocPage(stmts: Statements, searchPath: string): GetDocPageResult | null {
  let rows = stmts.exactPath.all(searchPath) as any[];
  if (rows.length === 0) {
    rows = stmts.suffixPath.all(`%${searchPath}`) as any[];
  }
  if (rows.length === 0) {
    rows = stmts.segmentPath.all(`%${searchPath}/%`) as any[];
  }
  if (rows.length === 0) return null;

  const distinctPaths = [...new Set(rows.map((r: any) => r.path))];
  if (distinctPaths.length === 1) {
    return {
      type: "page",
      title: rows[0].title,
      url: rows[0].url,
      content: rows.map((r: any) => r.content).join("\n\n"),
    };
  }
  const matches = distinctPaths.map((p) => {
    const row = rows.find((r: any) => r.path === p);
    return { path: p, title: row.title, url: row.url };
  });
  return { type: "disambiguation", matches };
}
```

`listSections`:
```typescript
export function listSections(stmts: Statements, source?: string): { path: string; title: string; source: string }[] {
  if (source && source !== "all") {
    return stmts.listBySource.all(source) as { path: string; title: string; source: string }[];
  }
  return stmts.listAll.all() as { path: string; title: string; source: string }[];
}
```

`getMetadata`:
```typescript
export function getMetadata(stmts: Statements, key: string): string | null {
  const row = stmts.getMetadata.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
```

`setMetadata`:
```typescript
export function setMetadata(stmts: Statements, key: string, value: string): void {
  stmts.setMetadata.run(key, value);
}
```

**Step 3: Update index.ts callers**

Add `prepareStatements` and `Statements` to the import from `./database.js`.

After `const db = initDatabase();` add:
```typescript
const stmts = prepareStatements(db);
```

Replace all calls:
- `getMetadata(db, ...)` becomes `getMetadata(stmts, ...)`
- `searchDocs(db, ...)` becomes `searchDocs(stmts, ...)`
- `getDocPage(db, ...)` becomes `getDocPage(stmts, ...)`
- `listSections(db, ...)` becomes `listSections(stmts, ...)`
- `crawlDocs(db)` becomes `crawlDocs(db, stmts)`

**Step 4: Update crawler.ts callers**

Change `crawlDocs` signature:
```typescript
export async function crawlDocs(db: Database.Database, stmts: Statements): Promise<number> {
```

Change `crawlClaudeCodeDocs` signature:
```typescript
async function crawlClaudeCodeDocs(db: Database.Database, stmts: Statements, generation: number): Promise<number> {
```

Update all internal calls to use `stmts` parameter:
- `getCurrentGeneration(db)` becomes `getCurrentGeneration(stmts)`
- `insertPage(db, {...}, gen)` becomes `insertPage(db, stmts, {...}, gen)`
- `finalizeGeneration(db, newGen)` becomes `finalizeGeneration(db, stmts, newGen)`
- `setMetadata(db, ...)` becomes `setMetadata(stmts, ...)`
- `crawlClaudeCodeDocs(db, newGen)` becomes `crawlClaudeCodeDocs(db, stmts, newGen)`

Update imports in crawler.ts to include `Statements` type.

**Step 5: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors

**Step 6: Commit**

Message: `perf: cache prepared statements for all DB queries`
Files: `src/database.ts`, `src/index.ts`, `src/crawler.ts`

---

### Task 4: Batch Inserts Per Page in a Single Transaction

Currently each section insert is its own transaction. Wrap all sections of one page in a single transaction.

**Files:**
- Modify: `src/database.ts`
- Modify: `src/crawler.ts`

**Step 1: Add a `insertPageSections` batch function to database.ts**

Add after `insertPage`:
```typescript
export function insertPageSections(db: Database.Database, stmts: Statements, sections: PageSection[], generation: number): void {
  const batch = db.transaction(() => {
    for (const page of sections) {
      const result = stmts.insertPage.run(
        page.url, page.path, page.title, page.sectionHeading, page.sectionAnchor,
        page.content, page.sectionOrder, page.source, generation, new Date().toISOString()
      );
      stmts.insertFts.run(result.lastInsertRowid, page.title, page.sectionHeading || "", page.content);
    }
  });
  batch();
}
```

**Step 2: Update platform crawl loop in crawler.ts**

In the `processInBatches` callback, replace the per-section `insertPage` loop with:
```typescript
    const pageSections: PageSection[] = sections.map((section) => ({
      url: entry.url,
      path: entry.path,
      title,
      sectionHeading: section.heading,
      sectionAnchor: section.anchor,
      content: section.content,
      sectionOrder: section.order,
      source,
    }));

    insertPageSections(db, stmts, pageSections, newGen);
```

**Step 3: Update Claude Code docs loop in crawler.ts**

In `crawlClaudeCodeDocs`, replace the per-section loop with the same pattern:
```typescript
    const pageSections: PageSection[] = sections.map((section) => ({
      url: page.url,
      path: page.path,
      title: page.title,
      sectionHeading: section.heading,
      sectionAnchor: section.anchor,
      content: section.content,
      sectionOrder: section.order,
      source: "code" as const,
    }));

    insertPageSections(db, stmts, pageSections, generation);
```

**Step 4: Update imports in crawler.ts**

Add `insertPageSections` and `PageSection` to the import from `./database.js`.

**Step 5: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors

**Step 6: Commit**

Message: `perf: batch all section inserts per page in single transaction`
Files: `src/database.ts`, `src/crawler.ts`

---

### Task 5: Clean Up Orphaned Generations on Startup

If a crawl fails mid-way, rows from the incomplete generation stay in the DB forever. Clean them up on startup.

**Files:**
- Modify: `src/database.ts`
- Modify: `src/index.ts`

**Step 1: Add `cleanupOrphanedGenerations` to database.ts**

Add after `finalizeGeneration`:
```typescript
export function cleanupOrphanedGenerations(db: Database.Database, stmts: Statements): number {
  const currentGen = getCurrentGeneration(stmts);
  const result = db.prepare("DELETE FROM pages WHERE generation != ?").run(currentGen);
  if (result.changes > 0) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
  }
  return result.changes;
}
```

**Step 2: Call it on startup in index.ts**

Add `cleanupOrphanedGenerations` to the import from `./database.js`.

Right after `const stmts = prepareStatements(db);`, add:
```typescript
const orphansRemoved = cleanupOrphanedGenerations(db, stmts);
if (orphansRemoved > 0) {
  console.error(`[server] Cleaned up ${orphansRemoved} orphaned rows from failed crawl.`);
}
```

**Step 3: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors

**Step 4: Commit**

Message: `fix: clean up orphaned generation rows on startup`
Files: `src/database.ts`, `src/index.ts`

---

### Task 6: Add `index_status` Tool

A lightweight tool that reports crawl state, index age, and page count without triggering a refresh.

**Files:**
- Modify: `src/index.ts`

**Step 1: Register the new tool**

In `src/index.ts`, before the `// --- Start server ---` comment, add:

```typescript
// --- Tool: index_status ---
server.registerTool(
  "index_status",
  {
    description:
      "Check the current status of the documentation index: page count, last crawl time, index age, and whether a crawl is in progress. Use this before refresh_index to decide if a refresh is needed. Lightweight — does not trigger a crawl.",
    inputSchema: {},
  },
  async () => {
    const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
    const pageCount = getMetadata(stmts, "page_count") || "0";

    let ageDays = "unknown";
    if (lastCrawl) {
      const age = Date.now() - new Date(lastCrawl).getTime();
      ageDays = (age / (1000 * 60 * 60 * 24)).toFixed(1);
    }

    const status = [
      `**Index Status**`,
      `- Pages indexed: ${pageCount}`,
      `- Last crawl: ${lastCrawl || "never"}`,
      `- Age: ${ageDays} days`,
      `- Crawl state: ${crawlState}`,
      `- Stale threshold: ${STALE_DAYS} day(s)`,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: status }],
    };
  }
);
```

**Step 2: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors

**Step 3: Commit**

Message: `feat: add index_status tool for lightweight health check`
Files: `src/index.ts`

---

### Task 7: Final Verification

**Step 1: Clean build**

Delete `dist/` and rebuild from scratch to confirm everything compiles.

**Step 2: Smoke test**

Start the server and send a `tools/list` JSON-RPC request via stdin to confirm 5 tools are registered: `search_anthropic_docs`, `get_doc_page`, `list_doc_sections`, `refresh_index`, `index_status`.

**Step 3: Update CLAUDE.md**

Update the Architecture section to mention:
- Cached prepared statements
- `index_status` tool (5 tools total, was 4)
- Orphan cleanup on startup
- Concurrency now 10

**Step 4: Commit**

Message: `docs: update CLAUDE.md with audit improvements`
Files: `CLAUDE.md`
