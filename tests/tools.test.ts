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
  setMetadata,
} from "../src/database.js";
import type { PageSection, SearchResult, GetDocPageResult, SectionRow } from "../src/types.js";
import type Database from "better-sqlite3";
import type { Statements } from "../src/types.js";
import { STALE_DAYS, BLOG_STALE_DAYS, MODEL_STALE_HOURS, RESEARCH_STALE_HOURS } from "../src/config.js";
import { buildMetadataFooter } from "../src/tools/search.js";
import { buildStatusText } from "../src/tools/status.js";

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

describe("staleness metadata", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("search results include per-source crawl timestamp footer", () => {
    const docTs = "2026-03-05T10:00:00Z";
    const blogTs = "2026-03-04T10:00:00Z";
    setMetadata(stmts, "last_crawl_timestamp", docTs);
    setMetadata(stmts, "last_blog_crawl_timestamp", blogTs);

    const sources = ["platform", "blog"];
    const footer = buildMetadataFooter(stmts, sources);

    expect(footer).toContain("---");
    expect(footer).toContain(`platform: last crawled ${docTs}`);
    expect(footer).toContain(`blog: last crawled ${blogTs}`);
  });

  it("search results include stale warning when source exceeds threshold", () => {
    // Set doc timestamp older than STALE_DAYS (1 day)
    const staleTs = new Date(Date.now() - (STALE_DAYS + 1) * 86400000).toISOString();
    setMetadata(stmts, "last_crawl_timestamp", staleTs);

    const footer = buildMetadataFooter(stmts, ["platform"]);

    expect(footer).toContain("**Warning: stale data**");
    expect(footer).toContain("platform");
    expect(footer).toContain("refresh_index");
  });

  it("no warning when all sources are fresh", () => {
    const freshTs = new Date().toISOString();
    setMetadata(stmts, "last_crawl_timestamp", freshTs);
    setMetadata(stmts, "last_blog_crawl_timestamp", freshTs);

    const footer = buildMetadataFooter(stmts, ["platform", "blog"]);

    expect(footer).not.toContain("Warning");
    expect(footer).toContain("---");
  });

  it("footer appears even on no-results response", () => {
    const freshTs = new Date().toISOString();
    setMetadata(stmts, "last_crawl_timestamp", freshTs);
    setMetadata(stmts, "last_blog_crawl_timestamp", freshTs);

    // Simulate no-results: all sources
    const footer = buildMetadataFooter(stmts, ["platform", "code", "api-reference", "blog"]);

    expect(footer).toContain("---");
    expect(footer).toContain("last crawled");
  });

  it("groups non-blog sources under shared doc timestamp", () => {
    const docTs = "2026-03-05T10:00:00Z";
    setMetadata(stmts, "last_crawl_timestamp", docTs);

    const footer = buildMetadataFooter(stmts, ["platform", "code", "api-reference"]);

    // All three should appear together with one timestamp
    expect(footer).toContain("platform, code, api-reference: last crawled");
    expect(footer).toContain(docTs);
  });

  it("multiple stale sources listed together in warning", () => {
    const staleDocTs = new Date(Date.now() - (STALE_DAYS + 1) * 86400000).toISOString();
    const staleBlogTs = new Date(Date.now() - (BLOG_STALE_DAYS + 1) * 86400000).toISOString();
    setMetadata(stmts, "last_crawl_timestamp", staleDocTs);
    setMetadata(stmts, "last_blog_crawl_timestamp", staleBlogTs);

    const footer = buildMetadataFooter(stmts, ["platform", "blog"]);

    expect(footer).toContain("**Warning: stale data**");
    expect(footer).toContain("platform");
    expect(footer).toContain("blog");
  });
});

describe("failure info", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("index_status shows failure reason and timestamp", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");

    const crawlState = {
      getState: (name: string) => "idle" as const,
      getLastError: (name: string) => {
        if (name === "docs") return { message: "Connection timeout", timestamp: "2026-03-05T10:00:00Z" };
        return null;
      },
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).toContain("Last docs failure: Connection timeout at 2026-03-05T10:00:00Z");
  });

  it("index_status shows nothing extra when no failures", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");

    const crawlState = {
      getState: (_name: string) => "idle" as const,
      getLastError: (_name: string) => null,
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).not.toContain("failure");
  });

  it("shows both docs and blog failure info independently", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");

    const crawlState = {
      getState: (_name: string) => "failed" as const,
      getLastError: (name: string) => {
        if (name === "docs") return { message: "Connection timeout", timestamp: "2026-03-05T10:00:00Z" };
        if (name === "blog") return { message: "Sitemap unavailable", timestamp: "2026-03-05T11:00:00Z" };
        return null;
      },
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).toContain("Last docs failure: Connection timeout at 2026-03-05T10:00:00Z");
    expect(status).toContain("Last blog failure: Sitemap unavailable at 2026-03-05T11:00:00Z");
  });
});

describe("status: model and research sources", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("buildStatusText includes model page count, timestamp, and stale threshold", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");
    setMetadata(stmts, "model_page_count", "3");
    setMetadata(stmts, "last_model_crawl_timestamp", "2026-03-05T12:00:00Z");

    const crawlState = {
      getState: (_name: string) => "idle" as const,
      getLastError: (_name: string) => null,
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).toContain("Model pages indexed: 3");
    expect(status).toContain("Last model crawl: 2026-03-05T12:00:00Z");
    expect(status).toContain(`Model stale threshold: ${MODEL_STALE_HOURS} hour(s)`);
    expect(status).toContain("Model crawl state: idle");
  });

  it("buildStatusText includes research page count, timestamp, and stale threshold", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");
    setMetadata(stmts, "research_page_count", "144");
    setMetadata(stmts, "last_research_crawl_timestamp", "2026-03-05T11:00:00Z");

    const crawlState = {
      getState: (_name: string) => "idle" as const,
      getLastError: (_name: string) => null,
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).toContain("Research papers indexed: 144");
    expect(status).toContain("Last research crawl: 2026-03-05T11:00:00Z");
    expect(status).toContain(`Research stale threshold: ${RESEARCH_STALE_HOURS} hour(s)`);
    expect(status).toContain("Research crawl state: idle");
  });

  it("buildStatusText shows model and research errors when present", () => {
    setMetadata(stmts, "last_crawl_timestamp", "2026-03-05T10:00:00Z");
    setMetadata(stmts, "page_count", "100");
    setMetadata(stmts, "blog_page_count", "50");
    setMetadata(stmts, "last_blog_crawl_timestamp", "2026-03-04T10:00:00Z");

    const crawlState = {
      getState: (_name: string) => "failed" as const,
      getLastError: (name: string) => {
        if (name === "model") return { message: "Model fetch timeout", timestamp: "2026-03-05T13:00:00Z" };
        if (name === "research") return { message: "Research sitemap error", timestamp: "2026-03-05T14:00:00Z" };
        return null;
      },
    };

    const status = buildStatusText(stmts, crawlState);

    expect(status).toContain("Last model failure: Model fetch timeout at 2026-03-05T13:00:00Z");
    expect(status).toContain("Last research failure: Research sitemap error at 2026-03-05T14:00:00Z");
  });
});
