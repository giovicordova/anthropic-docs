import { describe, it, expect, beforeEach } from "vitest";
import {
  initDatabase,
  prepareStatements,
  insertPageSections,
  finalizeGeneration,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
} from "../src/database.js";
import type { PageSection, SearchResult, GetDocPageResult, SectionRow } from "../src/types.js";
import type Database from "better-sqlite3";
import type { Statements } from "../src/types.js";

/**
 * Tool response format tests.
 *
 * The MCP tool handlers in index.ts format results from searchDocs, getDocPage,
 * and listSections into text responses. These tests capture the exact formatting
 * logic so the refactor in Plan 02 must preserve it.
 *
 * We test the formatting as pure functions (extracted from index.ts patterns)
 * against real database results.
 */

// --- Format helpers (replicate index.ts tool handler logic) ---

function formatSearchResults(results: SearchResult[]): string {
  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**${r.sectionHeading ? ` > ${r.sectionHeading}` : ""}\n   URL: ${r.url}\n   ${r.snippet}`
    )
    .join("\n\n");
}

function formatNoResults(query: string, source: string): string {
  return `No results found for "${query}"${source !== "all" ? ` in ${source} docs` : ""}. Try different terms, or use refresh_index to re-crawl if the index is stale.`;
}

function formatDisambiguation(
  searchPath: string,
  matches: { path: string; title: string; url: string }[]
): string {
  const list = matches.map((m) => `- **${m.title}** — \`${m.path}\``).join("\n");
  return `Multiple pages match "${searchPath}". Use the exact path:\n\n${list}`;
}

function formatPageNotFound(docPath: string): string {
  return `Page not found: "${docPath}". Use search_anthropic_docs to find the correct path, or list_doc_sections to browse available pages.`;
}

function formatListSections(sections: SectionRow[]): string {
  const platformPages = sections.filter((s) => s.source === "platform");
  const codePages = sections.filter((s) => s.source === "code");
  const apiRefPages = sections.filter((s) => s.source === "api-reference");
  const blogPages = sections.filter((s) => s.source === "blog");

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

  if (blogPages.length > 0) {
    output += `## Anthropic Blog (${blogPages.length} posts)\n\n`;
    for (const p of blogPages) {
      output += `- [${p.title}](${p.path})\n`;
    }
    output += "\n";
  }

  return output;
}

type FirstRunState = { hasTimestamp: boolean; crawlState: string };

function firstRunBuildingResponse(state: FirstRunState): string | null {
  if (!state.hasTimestamp && state.crawlState === "crawling") {
    return "Index is being built for the first time (~10s). Try again shortly.";
  }
  return null;
}

// --- Test data helpers ---

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

describe("tool response format: search_anthropic_docs", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("returns 'Index is being built' when first run + crawling", () => {
    const msg = firstRunBuildingResponse({
      hasTimestamp: false,
      crawlState: "crawling",
    });
    expect(msg).toBe("Index is being built for the first time (~10s). Try again shortly.");
  });

  it("returns null (no building message) when timestamp exists", () => {
    const msg = firstRunBuildingResponse({
      hasTimestamp: true,
      crawlState: "crawling",
    });
    expect(msg).toBeNull();
  });

  it("returns formatted numbered results with title, URL, snippet", () => {
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          title: "Tool Use Guide",
          url: "https://platform.claude.com/docs/en/tool-use",
          path: "/docs/en/tool-use",
          sectionHeading: "Overview",
          content: "Claude can interact with external tools and APIs for enhanced functionality.",
        }),
        makeSection({
          title: "Messages API",
          url: "https://platform.claude.com/docs/en/api/messages",
          path: "/docs/en/api/messages",
          sectionHeading: "Create",
          source: "api-reference",
          content: "Send a structured list of input messages to create a response from Claude model.",
          sectionOrder: 1,
        }),
      ],
      1
    );
    finalizeGeneration(db, stmts, 1);

    const results = searchDocs(stmts, "Claude tools");
    expect(results.length).toBeGreaterThan(0);

    const formatted = formatSearchResults(results);
    // Verify numbered format
    expect(formatted).toMatch(/^1\. \*\*/);
    // Verify URL line
    expect(formatted).toContain("URL: https://");
    // Verify section heading appears
    expect(formatted).toContain(" > ");
  });

  it("returns 'No results found' message for empty results", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const results = searchDocs(stmts, "xyznonexistent");
    expect(results).toHaveLength(0);

    const msg = formatNoResults("xyznonexistent", "all");
    expect(msg).toContain('No results found for "xyznonexistent"');
    expect(msg).toContain("Try different terms");
  });

  it("includes source filter in 'No results' message", () => {
    const msg = formatNoResults("test", "blog");
    expect(msg).toContain("in blog docs");
  });
});

describe("tool response format: get_doc_page", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("returns disambiguation list when multiple matches", () => {
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/docs/en/a/overview",
          url: "https://platform.claude.com/docs/en/a/overview",
          title: "Feature A Overview",
        }),
      ],
      1
    );
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/docs/en/b/overview",
          url: "https://platform.claude.com/docs/en/b/overview",
          title: "Feature B Overview",
        }),
      ],
      1
    );
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/overview");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("disambiguation");

    if (result!.type === "disambiguation") {
      const formatted = formatDisambiguation("/overview", result!.matches);
      expect(formatted).toContain('Multiple pages match "/overview"');
      expect(formatted).toContain("**Feature A Overview**");
      expect(formatted).toContain("**Feature B Overview**");
      expect(formatted).toContain("`/docs/en/a/overview`");
      expect(formatted).toContain("`/docs/en/b/overview`");
    }
  });

  it("returns 'Page not found' for missing path", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/nonexistent-page-xyz");
    expect(result).toBeNull();

    const msg = formatPageNotFound("/nonexistent-page-xyz");
    expect(msg).toContain('Page not found: "/nonexistent-page-xyz"');
    expect(msg).toContain("search_anthropic_docs");
    expect(msg).toContain("list_doc_sections");
  });
});

describe("tool response format: list_doc_sections", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("groups pages by source (platform, code, api-reference, blog)", () => {
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/docs/en/get-started/intro",
          title: "Getting Started",
          source: "platform",
        }),
      ],
      1
    );
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/docs/en/api/messages",
          title: "Messages API",
          source: "api-reference",
        }),
      ],
      1
    );
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/docs/en/mcp",
          url: "https://code.claude.com/docs/en/mcp",
          title: "MCP Integration",
          source: "code",
        }),
      ],
      1
    );
    insertPageSections(
      db,
      stmts,
      [
        makeSection({
          path: "/news/claude-release",
          url: "https://www.anthropic.com/news/claude-release",
          title: "Claude Release",
          source: "blog",
        }),
      ],
      1
    );
    finalizeGeneration(db, stmts, 1);

    const sections = listSections(stmts);
    expect(sections).toHaveLength(4);

    const formatted = formatListSections(sections);

    // Verify all source groups appear
    expect(formatted).toContain("## Anthropic Platform Docs (1 pages)");
    expect(formatted).toContain("## API Reference (1 pages)");
    expect(formatted).toContain("## Claude Code Docs (1 pages)");
    expect(formatted).toContain("## Anthropic Blog (1 posts)");

    // Verify page listings
    expect(formatted).toContain("[Getting Started]");
    expect(formatted).toContain("[Messages API]");
    expect(formatted).toContain("[MCP Integration]");
    expect(formatted).toContain("[Claude Release]");
  });
});
