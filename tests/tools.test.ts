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
  getSourceCounts,
  getPageOutline,
  getPageSections,
} from "../src/database.js";
import type { PageSection, SearchResult, GetDocPageResult, SectionRow, SourceCount, OutlineResult, SectionContent } from "../src/types.js";
import type Database from "better-sqlite3";
import type { Statements } from "../src/types.js";
import { STALE_DAYS, BLOG_STALE_DAYS, MODEL_STALE_DAYS, RESEARCH_STALE_DAYS, MODEL_STALE_HOURS, RESEARCH_STALE_HOURS } from "../src/config.js";
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
      (r) => {
        const heading = r.sectionHeading ? ` > ${r.sectionHeading}` : "";
        const path = new URL(r.url).pathname;
        return `${r.title}${heading} | ${path}\n${r.snippet}`;
      }
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

function formatSourceSummary(counts: SourceCount[]): string {
  const labels: Record<string, string> = {
    platform: "pages", code: "pages", "api-reference": "pages",
    blog: "posts", model: "pages", research: "papers",
  };
  const lines = counts.map((c) => `${c.source}: ${c.count} ${labels[c.source] || "pages"}`);
  return lines.join("\n") + "\n\nUse source filter to list pages for a specific source.";
}

function formatCompactList(sections: SectionRow[], source: string): string {
  const labels: Record<string, string> = {
    platform: "Anthropic Platform Docs",
    code: "Claude Code Docs",
    "api-reference": "API Reference",
    blog: "Anthropic Blog",
    model: "Model Pages",
    research: "Research Papers",
  };
  let output = `${labels[source] || source} (${sections.length} pages)\n\n`;
  for (const s of sections) {
    output += `${s.path} — ${s.title}\n`;
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

  it("returns compact results with title, path, snippet (no markdown)", () => {
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
    // Verify compact format: no numbered list, no bold, no "URL:" label
    expect(formatted).not.toMatch(/^\d+\. \*\*/);
    expect(formatted).not.toContain("URL:");
    expect(formatted).not.toContain("**");
    // Verify path-only (no full URL)
    expect(formatted).toContain(" | /docs/en/");
    // Verify section heading separator
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

  it("returns summary counts when source is all", () => {
    insertPageSections(db, stmts, [makeSection({ source: "platform" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/api/messages", title: "Messages API", source: "api-reference" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/mcp", url: "https://code.claude.com/docs/en/mcp", title: "MCP", source: "code" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/news/post", url: "https://www.anthropic.com/news/post", title: "Post", source: "blog" })], 1);
    finalizeGeneration(db, stmts, 1);

    const counts = getSourceCounts(stmts);
    const formatted = formatSourceSummary(counts);

    expect(formatted).toMatch(/platform: \d+ pages/);
    expect(formatted).toMatch(/code: \d+ pages/);
    expect(formatted).toMatch(/blog: \d+ posts/);
    expect(formatted).toContain("Use source filter");
    // Should NOT contain markdown links or category grouping
    expect(formatted).not.toContain("[");
    expect(formatted).not.toContain("##");
  });

  it("returns compact list when specific source selected", () => {
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/mcp", url: "https://code.claude.com/docs/en/mcp", title: "MCP", source: "code" })], 1);
    finalizeGeneration(db, stmts, 1);

    const sections = listSections(stmts, "code");
    const formatted = formatCompactList(sections, "code");

    expect(formatted).toContain("Claude Code Docs (1 pages)");
    expect(formatted).toContain("/docs/en/mcp — MCP");
    expect(formatted).not.toContain("[");
    expect(formatted).not.toContain("##");
  });
});

// --- Format helpers for get_doc_page section modes ---

function formatOutline(outline: OutlineResult): string {
  const headings = outline.headings
    .map((h, i) => `${i + 1}. ${h ?? "(intro)"}`)
    .join("\n");
  return `${outline.title}\n${outline.path}\n\nSections:\n${headings}`;
}

function formatSectionResult(result: { type: "page"; title: string; url: string; path: string; sections: SectionContent[] }): string {
  return result.sections
    .map((s) => {
      const heading = s.heading ? `${result.title} > ${s.heading}` : result.title;
      return `${heading}\n${result.path}\n\n${s.content}`;
    })
    .join("\n\n---\n\n");
}

describe("tool response format: get_doc_page (section modes)", () => {
  let db: Database.Database;
  let stmts: Statements;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("outline mode returns title, path, and section headings", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: null, content: "Intro" }),
      makeSection({ sectionOrder: 1, sectionHeading: "Authentication", content: "Auth stuff" }),
      makeSection({ sectionOrder: 2, sectionHeading: "Error Handling", content: "Error stuff" }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const outline = getPageOutline(stmts, "/docs/en/test");
    expect(outline).not.toBeNull();
    expect(outline!.type).toBe("outline");
    if (outline!.type === "outline") {
      const text = formatOutline(outline);
      expect(text).toContain("Test Page");
      expect(text).toContain("/docs/en/test");
      expect(text).toContain("1. (intro)");
      expect(text).toContain("2. Authentication");
      expect(text).toContain("3. Error Handling");
      expect(text).not.toContain("Auth stuff");
    }
  });

  it("section filter returns only matching sections", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: null, content: "Intro" }),
      makeSection({ sectionOrder: 1, sectionHeading: "Authentication", content: "Auth details" }),
      makeSection({ sectionOrder: 2, sectionHeading: "Error Handling", content: "Error details" }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getPageSections(stmts, "/docs/en/test", "auth");
    expect(result).not.toBeNull();
    if (result!.type === "page") {
      const text = formatSectionResult(result);
      expect(text).toContain("Test Page > Authentication");
      expect(text).toContain("Auth details");
      expect(text).not.toContain("Error details");
    }
  });

  it("section=all returns full page (current behavior)", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: null, content: "Intro content" }),
      makeSection({ sectionOrder: 1, sectionHeading: "Details", content: "Detail content" }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getDocPage(stmts, "/docs/en/test");
    expect(result).not.toBeNull();
    if (result!.type === "page") {
      expect(result!.content).toContain("Intro content");
      expect(result!.content).toContain("Detail content");
    }
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

  it("model source uses its own timestamp in footer", () => {
    const modelTs = "2026-03-05T14:00:00Z";
    setMetadata(stmts, "last_model_crawl_timestamp", modelTs);

    const footer = buildMetadataFooter(stmts, ["model"]);

    expect(footer).toContain(`model: last crawled ${modelTs}`);
    expect(footer).not.toContain("platform");
    expect(footer).not.toContain("code");
  });

  it("research source uses its own timestamp in footer", () => {
    const researchTs = "2026-03-05T15:00:00Z";
    setMetadata(stmts, "last_research_crawl_timestamp", researchTs);

    const footer = buildMetadataFooter(stmts, ["research"]);

    expect(footer).toContain(`research: last crawled ${researchTs}`);
    expect(footer).not.toContain("platform");
    expect(footer).not.toContain("code");
  });

  it("warns when model index is stale", () => {
    const staleTs = new Date(Date.now() - (MODEL_STALE_DAYS + 1) * 86400000).toISOString();
    setMetadata(stmts, "last_model_crawl_timestamp", staleTs);

    const footer = buildMetadataFooter(stmts, ["model"]);

    expect(footer).toContain("**Warning: stale data**");
    expect(footer).toContain("model");
  });

  it("warns when research index is stale", () => {
    const staleTs = new Date(Date.now() - (RESEARCH_STALE_DAYS + 1) * 86400000).toISOString();
    setMetadata(stmts, "last_research_crawl_timestamp", staleTs);

    const footer = buildMetadataFooter(stmts, ["research"]);

    expect(footer).toContain("**Warning: stale data**");
    expect(footer).toContain("research");
  });

  it("model and research not grouped with doc sources", () => {
    const docTs = "2026-03-05T10:00:00Z";
    const modelTs = "2026-03-05T14:00:00Z";
    const researchTs = "2026-03-05T15:00:00Z";
    setMetadata(stmts, "last_crawl_timestamp", docTs);
    setMetadata(stmts, "last_model_crawl_timestamp", modelTs);
    setMetadata(stmts, "last_research_crawl_timestamp", researchTs);

    const footer = buildMetadataFooter(stmts, ["platform", "model", "research"]);

    // Three separate entries
    expect(footer).toContain(`platform: last crawled ${docTs}`);
    expect(footer).toContain(`model: last crawled ${modelTs}`);
    expect(footer).toContain(`research: last crawled ${researchTs}`);
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
