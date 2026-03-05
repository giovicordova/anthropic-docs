# anthropic-docs-mcp v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the MCP server from scratch. Replace HTML crawling with `llms-full.txt` parsing. Same 5 tools, same DB schema, fewer dependencies, zero HTML parsing.

**Architecture:** 5 source files — `config.ts` (constants), `types.ts` (shared interfaces), `parser.ts` (fetch + parse llms-full.txt), `database.ts` (SQLite FTS5), `index.ts` (MCP server + tools). Two data sources: `platform.claude.com/llms-full.txt` and `code.claude.com/docs/llms-full.txt`. Both are plain markdown. Parser splits them into pages and sections, database indexes them with FTS5.

**Tech Stack:** TypeScript (ES2022, Node16 modules), better-sqlite3, @modelcontextprotocol/sdk, zod, vitest

---

### Task 0: Create Branch and Clean Source Directory

**Files:**
- Delete: `src/crawler.ts`, `src/markdown.ts`
- Keep: `src/` directory (will be rewritten)

**Step 1: Create the v2 branch**

Run: `git checkout -b v2-rewrite`

**Step 2: Remove v1 source files**

Run: `rm src/config.ts src/index.ts src/crawler.ts src/database.ts src/markdown.ts`

**Step 3: Remove Turndown dependency**

Run: `npm uninstall turndown @types/turndown`

**Step 4: Add vitest**

Run: `npm install -D vitest`

**Step 5: Commit**

Message: `chore: clear v1 source files, add vitest, remove turndown`
Files: `src/`, `package.json`, `package-lock.json`

---

### Task 1: Types (`src/types.ts`)

**Files:**
- Create: `src/types.ts`

**Step 1: Write the types file**

This file holds every shared interface. No logic, no imports beyond `better-sqlite3` for the `Statements` type.

```typescript
import type Database from "better-sqlite3";

// --- Source tagging ---

export type DocSource = "platform" | "code" | "api-reference";

// --- Parser output ---

export interface ParsedPage {
  title: string;
  url: string;
  path: string;
  content: string;
  source: DocSource;
}

export interface Section {
  heading: string | null;
  anchor: string | null;
  content: string;
  order: number;
}

// --- Database types ---

export interface PageSection {
  url: string;
  path: string;
  title: string;
  sectionHeading: string | null;
  sectionAnchor: string | null;
  content: string;
  sectionOrder: number;
  source: DocSource;
}

export interface SearchResult {
  title: string;
  url: string;
  sectionHeading: string | null;
  snippet: string;
  relevanceScore: number;
}

export type GetDocPageResult =
  | { type: "page"; title: string; url: string; content: string }
  | { type: "disambiguation"; matches: { path: string; title: string; url: string }[] };

// --- Cached prepared statements ---

export interface Statements {
  insertPage: Database.Statement;
  insertFts: Database.Statement;
  deleteOldGen: Database.Statement;
  rebuildFts: string;
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
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

**Step 3: Commit**

Message: `feat(types): add shared interfaces for v2`
Files: `src/types.ts`

---

### Task 2: Config (`src/config.ts`)

**Files:**
- Create: `src/config.ts`

**Step 1: Write the config file**

```typescript
import path from "node:path";
import os from "node:os";

export const STALE_DAYS = 1;
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_SECTION_SIZE = 6_000;
export const MIN_SECTION_SIZE = 50;

export const PLATFORM_DOCS_URL = "https://platform.claude.com/llms-full.txt";
export const CLAUDE_CODE_DOCS_URL = "https://code.claude.com/docs/llms-full.txt";

export const DB_DIR = path.join(os.homedir(), ".claude", "mcp-data", "anthropic-docs");
```

Note: `CONCURRENCY` and `SITEMAP_URL` are gone — no longer needed. `FETCH_TIMEOUT_MS` bumped from 15s to 30s because the full-text files are large (10MB+).

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

Message: `feat(config): add v2 constants with llms-full.txt URLs`
Files: `src/config.ts`

---

### Task 3: Parser — Section Splitting (`src/parser.ts`, part 1)

Build the parser bottom-up. Start with section splitting (pure function, easy to test), then page parsing, then fetching on top.

**Files:**
- Create: `src/parser.ts`
- Create: `tests/parser.test.ts`

**Step 1: Write the failing test for `splitIntoSections`**

```typescript
import { describe, it, expect } from "vitest";
import { splitIntoSections } from "../src/parser.js";

describe("splitIntoSections", () => {
  it("splits markdown at ## and ### headings", () => {
    const markdown = [
      "Some intro text that is long enough to pass the minimum size filter for sections.",
      "",
      "## Getting Started",
      "",
      "This section has content about getting started with the tool and configuration.",
      "",
      "### Installation",
      "",
      "Install the package using npm install command and follow the setup instructions.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].order).toBe(0);
    expect(sections[1].heading).toBe("Getting Started");
    expect(sections[1].anchor).toBe("getting-started");
    expect(sections[2].heading).toBe("Installation");
  });

  it("filters out stub sections below MIN_SECTION_SIZE", () => {
    const markdown = [
      "## Real Section",
      "",
      "This section has enough content to pass the minimum size filter for sections easily.",
      "",
      "## Stub",
      "",
      "Tiny.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Real Section");
  });

  it("splits oversized sections at #### headings", () => {
    const longContent = "A".repeat(7000);
    const markdown = [
      "## Big Section",
      "",
      longContent.slice(0, 3000),
      "",
      "#### Sub Heading",
      "",
      longContent.slice(0, 3000),
      "",
      "#### Another Sub",
      "",
      "This is the final sub-section with enough content to survive the minimum size filter.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections.length).toBeGreaterThan(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parser.test.ts`
Expected: FAIL — `splitIntoSections` not exported from `../src/parser.js`

**Step 3: Write `splitIntoSections` in `src/parser.ts`**

```typescript
import { MAX_SECTION_SIZE, MIN_SECTION_SIZE } from "./config.js";
import type { Section } from "./types.js";

export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    if (content.length < MIN_SECTION_SIZE) return;
    sections.push({
      heading: currentHeading,
      anchor: currentAnchor,
      content,
      order: order++,
    });
  }

  for (const line of lines) {
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

  // Post-process: split oversized sections at h4 boundaries
  const result: Section[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_SECTION_SIZE) {
      result.push(section);
      continue;
    }

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
        if (chunk.length >= MIN_SECTION_SIZE) {
          result.push({
            heading: subHeading,
            anchor: subAnchor,
            content: chunk,
            order: subOrder++,
          });
          didSplit = true;
        }
        subHeading = `${section.heading} > ${h4Match[2].trim()}`;
        subAnchor = h4Match[2]
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-");
        subContent = [subLine];
      } else {
        subContent.push(subLine);
      }
    }

    const remaining = subContent.join("\n").trim();
    if (remaining.length >= MIN_SECTION_SIZE) {
      result.push({
        heading: didSplit ? subHeading : section.heading,
        anchor: didSplit ? subAnchor : section.anchor,
        content: remaining,
        order: subOrder,
      });
    }
  }

  // Re-number order sequentially
  for (let i = 0; i < result.length; i++) {
    result[i].order = i;
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parser.test.ts`
Expected: PASS

**Step 5: Commit**

Message: `feat(parser): add section splitting with tests`
Files: `src/parser.ts`, `tests/parser.test.ts`

---

### Task 4: Parser — Page Parsing (`src/parser.ts`, part 2)

**Files:**
- Modify: `src/parser.ts`
- Modify: `tests/parser.test.ts`

**Step 1: Write the failing tests for `parsePages`**

Add to `tests/parser.test.ts`:

```typescript
import { splitIntoSections, parsePages } from "../src/parser.js";

describe("parsePages", () => {
  it("parses platform llms-full.txt format", () => {
    const text = [
      "# Some Header",
      "",
      "Preamble text to skip.",
      "",
      "---",
      "",
      "# Tool Use",
      "",
      "URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use",
      "",
      "# Tool Use",
      "",
      "Claude can interact with external tools and APIs.",
      "",
      "## Overview",
      "",
      "Tool use lets Claude call functions you define.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Tool Use");
    expect(pages[0].url).toBe("https://platform.claude.com/docs/en/agents-and-tools/tool-use");
    expect(pages[0].path).toBe("/docs/en/agents-and-tools/tool-use");
    expect(pages[0].source).toBe("platform");
    expect(pages[0].content).toContain("Claude can interact");
  });

  it("parses code llms-full.txt format", () => {
    const text = [
      "# Connect Claude Code to tools via MCP",
      "Source: https://code.claude.com/docs/en/mcp",
      "",
      "Claude Code supports the Model Context Protocol.",
      "",
      "## Configuration",
      "",
      "Configure MCP servers in your settings.",
      "",
      "# Best Practices",
      "Source: https://code.claude.com/docs/en/best-practices",
      "",
      "Follow these best practices for effective usage of Claude Code in projects.",
    ].join("\n");

    const pages = parsePages(text, "code");
    expect(pages).toHaveLength(2);
    expect(pages[0].title).toBe("Connect Claude Code to tools via MCP");
    expect(pages[0].path).toBe("/docs/en/mcp");
    expect(pages[0].source).toBe("code");
    expect(pages[1].title).toBe("Best Practices");
  });

  it("tags api-reference pages by path", () => {
    const text = [
      "---",
      "",
      "# Create a Message",
      "",
      "URL: https://platform.claude.com/docs/en/api/messages/create",
      "",
      "# Create a Message",
      "",
      "Send a structured list of input messages.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].source).toBe("api-reference");
  });

  it("skips preamble content without URL/Source lines", () => {
    const text = [
      "# Anthropic Developer Documentation - Full Content",
      "",
      "This file provides comprehensive documentation.",
      "",
      "---",
      "",
      "# Real Page",
      "",
      "URL: https://platform.claude.com/docs/en/get-started",
      "",
      "# Real Page",
      "",
      "Real content that should be indexed in the database for search.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Real Page");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parser.test.ts`
Expected: FAIL — `parsePages` not exported

**Step 3: Implement `parsePages` in `src/parser.ts`**

Update the imports at the top of `parser.ts` to include `ParsedPage` and `DocSource`:

```typescript
import type { Section, ParsedPage, DocSource } from "./types.js";
```

Add the function:

```typescript
export function parsePages(text: string, defaultSource: "platform" | "code"): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith("# ")) {
      let urlLine: string | null = null;
      let urlLineIndex = -1;

      // Look ahead for URL: or Source: within the next 3 lines
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].startsWith("URL: ") || lines[j].startsWith("Source: ")) {
          urlLine = lines[j];
          urlLineIndex = j;
          break;
        }
      }

      if (!urlLine) {
        i++;
        continue;
      }

      const title = lines[i].slice(2).trim();
      const url = urlLine.replace(/^(URL|Source): /, "").trim();
      let urlPath: string;
      try {
        urlPath = new URL(url).pathname;
      } catch {
        i++;
        continue;
      }

      // Collect content until the next page delimiter
      const contentLines: string[] = [];
      i = urlLineIndex + 1;

      while (i < lines.length) {
        if (lines[i].startsWith("# ")) {
          let isNewPage = false;
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            if (lines[j].startsWith("URL: ") || lines[j].startsWith("Source: ")) {
              isNewPage = true;
              break;
            }
          }
          if (isNewPage) break;
        }
        contentLines.push(lines[i]);
        i++;
      }

      const content = contentLines.join("\n").trim();
      if (content.length === 0) continue;

      // Determine source
      let source: DocSource = defaultSource;
      if (defaultSource === "platform" && urlPath.match(/^\/docs\/en\/api\//)) {
        source = "api-reference";
      }

      pages.push({ title, url, path: urlPath, content, source });
    } else {
      i++;
    }
  }

  return pages;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parser.test.ts`
Expected: PASS

**Step 5: Commit**

Message: `feat(parser): add page parsing for both llms-full.txt formats`
Files: `src/parser.ts`, `tests/parser.test.ts`

---

### Task 5: Parser — Fetch and Orchestration (`src/parser.ts`, part 3)

**Files:**
- Modify: `src/parser.ts`

**Step 1: Add the fetch and orchestration functions**

These are thin wrappers around `parsePages` that add network I/O. No unit tests — covered by the smoke test at the end.

Add to `src/parser.ts` (update imports at the top to include all needed config values and types):

```typescript
import { MAX_SECTION_SIZE, MIN_SECTION_SIZE, PLATFORM_DOCS_URL, CLAUDE_CODE_DOCS_URL, FETCH_TIMEOUT_MS } from "./config.js";
import type { Section, ParsedPage, DocSource, PageSection } from "./types.js";

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "anthropic-docs-mcp/2.0 (local indexer)" },
  }).finally(() => clearTimeout(timeout));
}

export async function fetchAndParse(): Promise<ParsedPage[]> {
  const results: ParsedPage[] = [];

  const [platformResponse, codeResponse] = await Promise.allSettled([
    fetchWithTimeout(PLATFORM_DOCS_URL),
    fetchWithTimeout(CLAUDE_CODE_DOCS_URL),
  ]);

  if (platformResponse.status === "fulfilled" && platformResponse.value.ok) {
    const text = await platformResponse.value.text();
    const pages = parsePages(text, "platform");
    results.push(...pages);
    console.error(`[parser] Platform docs: parsed ${pages.length} pages`);
  } else {
    const reason = platformResponse.status === "rejected"
      ? platformResponse.reason?.message
      : `HTTP ${(platformResponse as PromiseFulfilledResult<Response>).value.status}`;
    console.error(`[parser] Failed to fetch platform docs: ${reason}`);
  }

  if (codeResponse.status === "fulfilled" && codeResponse.value.ok) {
    const text = await codeResponse.value.text();
    const pages = parsePages(text, "code");
    results.push(...pages);
    console.error(`[parser] Claude Code docs: parsed ${pages.length} pages`);
  } else {
    const reason = codeResponse.status === "rejected"
      ? codeResponse.reason?.message
      : `HTTP ${(codeResponse as PromiseFulfilledResult<Response>).value.status}`;
    console.error(`[parser] Failed to fetch code docs: ${reason}`);
  }

  console.error(`[parser] Total: ${results.length} pages`);
  return results;
}

export function pagesToSections(page: ParsedPage): PageSection[] {
  const sections = splitIntoSections(page.content);
  return sections.map((section) => ({
    url: page.url,
    path: page.path,
    title: page.title,
    sectionHeading: section.heading,
    sectionAnchor: section.anchor,
    content: section.content,
    sectionOrder: section.order,
    source: page.source,
  }));
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

Message: `feat(parser): add fetch and page-to-sections orchestration`
Files: `src/parser.ts`

---

### Task 6: Database (`src/database.ts`)

This is largely carried over from v1 with types moved to `types.ts`.

**Files:**
- Create: `src/database.ts`
- Create: `tests/database.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initDatabase,
  prepareStatements,
  insertPageSections,
  finalizeGeneration,
  getCurrentGeneration,
  cleanupOrphanedGenerations,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
  setMetadata,
} from "../src/database.js";
import type { PageSection } from "../src/types.js";

function makeSection(overrides: Partial<PageSection> = {}): PageSection {
  return {
    url: "https://platform.claude.com/docs/en/test",
    path: "/docs/en/test",
    title: "Test Page",
    sectionHeading: "Overview",
    sectionAnchor: "overview",
    content: "This is test content for the search index with enough words to be meaningful.",
    sectionOrder: 0,
    source: "platform",
    ...overrides,
  };
}

describe("database", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("inserts and searches sections", () => {
    const sections = [makeSection()];
    insertPageSections(db, stmts, sections, 1);
    finalizeGeneration(db, stmts, 1);

    const results = searchDocs(stmts, "test content");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Page");
  });

  it("gets a doc page by exact path", () => {
    const sections = [
      makeSection({ sectionOrder: 0, content: "First section content that is long enough to pass filters." }),
      makeSection({ sectionOrder: 1, sectionHeading: "Details", content: "Second section with more details about the topic." }),
    ];
    insertPageSections(db, stmts, sections, 1);
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/docs/en/test");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("page");
    if (result!.type === "page") {
      expect(result!.content).toContain("First section");
      expect(result!.content).toContain("Second section");
    }
  });

  it("fuzzy matches by path suffix", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/test");
    expect(result).not.toBeNull();
  });

  it("returns disambiguation for multiple path matches", () => {
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/a/test", url: "https://platform.claude.com/docs/en/a/test", title: "A Test" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/b/test", url: "https://platform.claude.com/docs/en/b/test", title: "B Test" })], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/test");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("disambiguation");
  });

  it("lists sections filtered by source", () => {
    insertPageSections(db, stmts, [makeSection({ source: "platform" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/mcp", url: "https://code.claude.com/docs/en/mcp", title: "MCP", source: "code" })], 1);
    finalizeGeneration(db, stmts, 1);

    const all = listSections(stmts);
    expect(all).toHaveLength(2);

    const codeOnly = listSections(stmts, "code");
    expect(codeOnly).toHaveLength(1);
    expect(codeOnly[0].source).toBe("code");
  });

  it("atomic generation swap removes old data", () => {
    insertPageSections(db, stmts, [makeSection({ content: "Old content from the previous generation of the crawl." })], 1);
    finalizeGeneration(db, stmts, 1);

    insertPageSections(db, stmts, [makeSection({ content: "New content from the latest generation of the crawl." })], 2);
    finalizeGeneration(db, stmts, 2);

    const results = searchDocs(stmts, "Old content previous");
    expect(results).toHaveLength(0);

    const newResults = searchDocs(stmts, "New content latest");
    expect(newResults).toHaveLength(1);
  });

  it("cleans up orphaned generations", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);
    // Simulate a failed crawl that left gen 2 rows
    insertPageSections(db, stmts, [makeSection({ content: "Orphaned row from failed crawl generation two." })], 2);

    const removed = cleanupOrphanedGenerations(db, stmts);
    expect(removed).toBeGreaterThan(0);
  });

  it("stores and retrieves metadata", () => {
    setMetadata(stmts, "test_key", "test_value");
    expect(getMetadata(stmts, "test_key")).toBe("test_value");
    expect(getMetadata(stmts, "missing")).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/database.test.ts`
Expected: FAIL — module not found

**Step 3: Write `src/database.ts`**

```typescript
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config.js";
import type { PageSection, SearchResult, GetDocPageResult, Statements } from "./types.js";

const DB_PATH = path.join(DB_DIR, "docs.db");

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || DB_PATH;

  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
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
      source TEXT NOT NULL DEFAULT 'platform',
      generation INTEGER NOT NULL DEFAULT 0,
      crawled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // FTS5 virtual table
  const ftsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_fts'")
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
    CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source);
    CREATE INDEX IF NOT EXISTS idx_pages_generation ON pages(generation);
  `);

  return db;
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

export function getCurrentGeneration(stmts: Statements): number {
  const row = stmts.getCurrentGen.get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function insertPageSections(
  db: Database.Database,
  stmts: Statements,
  sections: PageSection[],
  generation: number
): void {
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

export function finalizeGeneration(
  db: Database.Database,
  stmts: Statements,
  keepGeneration: number
): void {
  const finalize = db.transaction(() => {
    stmts.deleteOldGen.run(keepGeneration);
    db.exec(stmts.rebuildFts);
    stmts.setGeneration.run(String(keepGeneration));
  });
  finalize();
}

export function cleanupOrphanedGenerations(
  db: Database.Database,
  stmts: Statements
): number {
  const currentGen = getCurrentGeneration(stmts);
  const result = db.prepare("DELETE FROM pages WHERE generation != ?").run(currentGen);
  if (result.changes > 0) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
  }
  return result.changes;
}

function preprocessQuery(query: string): string {
  let cleaned = query
    .replace(/[*"():^~{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return '""';

  const terms = cleaned.split(" ").filter((t) => t.length > 0);

  if (terms.length > 1) {
    return terms.map((t) => `"${t}"`).join(" ");
  }

  return terms[0];
}

export function searchDocs(
  stmts: Statements,
  query: string,
  limit: number = 10,
  source?: string
): SearchResult[] {
  const ftsQuery = preprocessQuery(query);
  const useSourceFilter = source && source !== "all";

  const rows = useSourceFilter
    ? stmts.searchWithSource.all(ftsQuery, source, limit)
    : stmts.search.all(ftsQuery, limit);

  return (rows as any[]).map((row: any) => ({
    title: row.title,
    url: row.url,
    sectionHeading: row.section_heading,
    snippet: row.snippet,
    relevanceScore: Math.abs(row.rank),
  }));
}

export function getDocPage(
  stmts: Statements,
  searchPath: string
): GetDocPageResult | null {
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

export function listSections(
  stmts: Statements,
  source?: string
): { path: string; title: string; source: string }[] {
  if (source && source !== "all") {
    return stmts.listBySource.all(source) as { path: string; title: string; source: string }[];
  }
  return stmts.listAll.all() as { path: string; title: string; source: string }[];
}

export function getMetadata(stmts: Statements, key: string): string | null {
  const row = stmts.getMetadata.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(stmts: Statements, key: string, value: string): void {
  stmts.setMetadata.run(key, value);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/database.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Commit**

Message: `feat(database): add SQLite FTS5 database with tests`
Files: `src/database.ts`, `tests/database.test.ts`

---

### Task 7: MCP Server (`src/index.ts`)

**Files:**
- Create: `src/index.ts`

**Step 1: Write the full server file**

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDatabase,
  prepareStatements,
  cleanupOrphanedGenerations,
  getCurrentGeneration,
  insertPageSections,
  finalizeGeneration,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
  setMetadata,
} from "./database.js";
import { fetchAndParse, pagesToSections } from "./parser.js";
import { STALE_DAYS } from "./config.js";

const server = new McpServer({
  name: "anthropic-docs",
  version: "2.0.0",
});

const db = initDatabase();
const stmts = prepareStatements(db);

const orphansRemoved = cleanupOrphanedGenerations(db, stmts);
if (orphansRemoved > 0) {
  console.error(`[server] Cleaned up ${orphansRemoved} orphaned rows from failed crawl.`);
}

// --- Crawl state management ---
type CrawlState = "idle" | "crawling" | "failed";
let crawlState: CrawlState = "idle";

async function startCrawl(): Promise<number> {
  if (crawlState === "crawling") {
    console.error("[server] Crawl already in progress, skipping.");
    return -1;
  }
  crawlState = "crawling";
  try {
    const currentGen = getCurrentGeneration(stmts);
    const newGen = currentGen + 1;

    console.error(`[server] Starting crawl (generation ${newGen})...`);
    const pages = await fetchAndParse();

    let totalSections = 0;
    for (const page of pages) {
      const sections = pagesToSections(page);
      insertPageSections(db, stmts, sections, newGen);
      totalSections += sections.length;
    }

    finalizeGeneration(db, stmts, newGen);
    setMetadata(stmts, "last_crawl_timestamp", new Date().toISOString());
    setMetadata(stmts, "page_count", String(pages.length));

    console.error(`[server] Done. ${pages.length} pages, ${totalSections} sections indexed.`);
    crawlState = "idle";
    return pages.length;
  } catch (err) {
    crawlState = "failed";
    throw err;
  }
}

function firstRunBuildingResponse(): { content: { type: "text"; text: string }[]; isError?: boolean } | null {
  if (!getMetadata(stmts, "last_crawl_timestamp") && crawlState === "crawling") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Index is being built for the first time (~10s). Try again shortly.",
        },
      ],
      isError: true,
    };
  }
  return null;
}

function checkAndCrawl() {
  const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");

  if (!lastCrawl) {
    console.error("[server] No index found. Starting initial crawl...");
    startCrawl().catch((err) =>
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
    startCrawl().catch((err) =>
      console.error("[server] Background crawl failed:", err.message)
    );
  } else {
    console.error(
      `[server] Index is ${staleDays.toFixed(1)} days old. Fresh enough.`
    );
  }
}

// --- Tool: search_anthropic_docs ---
server.registerTool(
  "search_anthropic_docs",
  {
    description:
      "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet. Use this tool when you need to find documentation about a specific topic, API endpoint, SDK method, or concept. Results are ranked by relevance using BM25 with title matches weighted highest. For broad queries, increase the limit; for precise lookups, use get_doc_page instead.",
    inputSchema: {
      query: z.string().describe("Search query string. Use specific terms for best results."),
      source: z
        .enum(["all", "platform", "code", "api-reference"])
        .default("all")
        .describe("Filter by source: 'platform', 'code', 'api-reference', or 'all' (default)."),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (default 10)"),
    },
  },
  async ({ query, source, limit }) => {
    const building = firstRunBuildingResponse();
    if (building) return building;

    try {
      const results = searchDocs(stmts, query, limit, source);

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
        isError: true,
      };
    }
  }
);

// --- Tool: get_doc_page ---
server.registerTool(
  "get_doc_page",
  {
    description:
      "Fetch the full markdown content of a specific documentation page by its URL path. Supports fuzzy matching on the path suffix, so '/tool-use' will match '/docs/en/agents-and-tools/tool-use/overview'. Returns the complete page content concatenated from all sections.",
    inputSchema: {
      path: z
        .string()
        .describe('URL path of the doc page, e.g., "/docs/en/build-with-claude/tool-use"'),
    },
  },
  async ({ path: docPath }) => {
    const building = firstRunBuildingResponse();
    if (building) return building;

    const result = getDocPage(stmts, docPath);

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

    if (result.type === "disambiguation") {
      const list = result.matches
        .map((m) => `- **${m.title}** — \`${m.path}\``)
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Multiple pages match "${docPath}". Use the exact path:\n\n${list}`,
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
      "List all indexed documentation pages with their paths, grouped by source. Use this to discover what documentation is available or find the correct path for get_doc_page.",
    inputSchema: {
      source: z
        .enum(["all", "platform", "code", "api-reference"])
        .default("all")
        .describe("Filter by source: 'platform', 'code', 'api-reference', or 'all' (default)."),
    },
  },
  async ({ source }) => {
    const building = firstRunBuildingResponse();
    if (building) return building;

    const sections = listSections(stmts, source);

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

// --- Tool: refresh_index ---
server.registerTool(
  "refresh_index",
  {
    description:
      "Re-fetch and update the local documentation index. Runs in the background — returns immediately. Use this if search results seem stale. The index auto-refreshes daily on startup.",
    inputSchema: {},
  },
  async () => {
    if (crawlState === "crawling") {
      return {
        content: [
          {
            type: "text" as const,
            text: "A crawl is already in progress. Please wait for it to complete.",
          },
        ],
      };
    }

    const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
    const pageCount = getMetadata(stmts, "page_count") || "unknown";

    startCrawl().catch((err) =>
      console.error("[server] Refresh crawl failed:", err.message)
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Refresh started. Previous index: ${pageCount} pages, last crawled ${lastCrawl || "never"}.`,
        },
      ],
    };
  }
);

// --- Tool: index_status ---
server.registerTool(
  "index_status",
  {
    description:
      "Check the current status of the documentation index: page count, last crawl time, index age, and crawl state. Lightweight — does not trigger a crawl.",
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

// --- Start server ---
async function main() {
  checkAndCrawl();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
```

**Step 2: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS

**Step 3: Commit**

Message: `feat(server): add MCP server with 5 tools for v2`
Files: `src/index.ts`

---

### Task 8: Update package.json

**Files:**
- Modify: `package.json`

**Step 1: Update version and add test script**

Change `"version": "1.0.0"` to `"version": "2.0.0"`.

Add test script so scripts section reads:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "vitest run"
}
```

Verify `turndown` and `@types/turndown` are gone. Verify `vitest` is in devDependencies.

**Step 2: Build and run all tests**

Run: `npm run build && npm test`
Expected: All tests pass, build succeeds

**Step 3: Commit**

Message: `chore: bump version to 2.0.0, add test script`
Files: `package.json`

---

### Task 9: Smoke Test — Live Crawl

**Step 1: Delete existing database to force a fresh crawl**

Run: `rm -f ~/.claude/mcp-data/anthropic-docs/docs.db`

**Step 2: Build and start the server, capture stderr**

Run: `npm run build && timeout 30 node dist/index.js 2>smoke_stderr.txt || true`

**Step 3: Check stderr output**

Run: `cat smoke_stderr.txt`

Expected output should contain:
- `[parser] Platform docs: parsed XXX pages` (expect ~488)
- `[parser] Claude Code docs: parsed XX pages` (expect ~59)
- `[server] Done. XXX pages, XXXX sections indexed.`
- No errors

**Step 4: Verify the database**

Run: `sqlite3 ~/.claude/mcp-data/anthropic-docs/docs.db "SELECT source, COUNT(DISTINCT path) FROM pages GROUP BY source;"`
Expected: three rows — api-reference, code, platform

**Step 5: No commit needed — just verification**

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update CLAUDE.md to reflect v2**

Key updates:
- Architecture diagram: replace `Crawler` with `Parser`, show `llms-full.txt` sources
- File list: `parser.ts` replaces `crawler.ts` + `markdown.ts`, add `types.ts`
- Remove all references to HTML parsing, Turndown, sitemap, concurrency
- Note: 3 runtime deps instead of 4
- Add test command: `npm test`
- Data sources: `platform.claude.com/llms-full.txt` and `code.claude.com/docs/llms-full.txt`

**Step 2: Commit**

Message: `docs: update CLAUDE.md for v2 architecture`
Files: `CLAUDE.md`
