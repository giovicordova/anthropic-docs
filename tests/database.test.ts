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
  getIndexedBlogUrls,
  getIndexedBlogUrlsWithTimestamps,
  deleteBlogPages,
  retagResearchPages,
  getPageOutline,
  getPageSections,
  getSourceCounts,
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

  it("generation swap preserves blog rows", () => {
    insertPageSections(db, stmts, [makeSection({
      path: "/news/test-post",
      url: "https://www.anthropic.com/news/test-post",
      title: "Blog Post",
      source: "blog",
      content: "Blog content that should survive generation swaps and remain searchable.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    insertPageSections(db, stmts, [makeSection({
      content: "New docs content from the second generation crawl cycle.",
    })], 2);
    finalizeGeneration(db, stmts, 2);

    const blogResults = searchDocs(stmts, "survive generation", 10, "blog");
    expect(blogResults).toHaveLength(1);
    expect(blogResults[0].title).toBe("Blog Post");
  });

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

  it("getIndexedBlogUrlsWithTimestamps returns Map with url to crawled_at", () => {
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
    finalizeGeneration(db, stmts, 1);

    const map = getIndexedBlogUrlsWithTimestamps(db);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(2);
    expect(map.has("https://www.anthropic.com/news/post-a")).toBe(true);
    expect(map.has("https://www.anthropic.com/research/post-b")).toBe(true);
    // crawled_at should be an ISO timestamp string
    const ts = map.get("https://www.anthropic.com/news/post-a")!;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getIndexedBlogUrlsWithTimestamps returns empty Map when no blog pages", () => {
    const map = getIndexedBlogUrlsWithTimestamps(db);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("deleteBlogPages removes rows and rebuilds FTS", () => {
    insertPageSections(db, stmts, [makeSection({
      path: "/news/post-a",
      url: "https://www.anthropic.com/news/post-a",
      source: "blog",
      content: "Content of blog post A about artificial intelligence news.",
    })], 1);
    insertPageSections(db, stmts, [makeSection({
      path: "/news/post-b",
      url: "https://www.anthropic.com/news/post-b",
      source: "blog",
      content: "Content of blog post B about machine learning research.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    const deleted = deleteBlogPages(db, ["https://www.anthropic.com/news/post-a"]);
    expect(deleted).toBeGreaterThan(0);

    // post-a should be gone
    const blogUrls = getIndexedBlogUrls(db);
    expect(blogUrls).not.toContain("https://www.anthropic.com/news/post-a");
    expect(blogUrls).toContain("https://www.anthropic.com/news/post-b");

    // FTS should still work after rebuild
    const results = searchDocs(stmts, "machine learning");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Page");
  });

  it("deleteBlogPages with empty array returns 0 and does not error", () => {
    const deleted = deleteBlogPages(db, []);
    expect(deleted).toBe(0);
  });

  it("stores and retrieves metadata", () => {
    setMetadata(stmts, "test_key", "test_value");
    expect(getMetadata(stmts, "test_key")).toBe("test_value");
    expect(getMetadata(stmts, "missing")).toBeNull();
  });

  it("generation swap preserves model and research rows", () => {
    // Insert model row at gen 1
    insertPageSections(db, stmts, [makeSection({
      path: "/claude/opus",
      url: "https://www.anthropic.com/claude/opus",
      title: "Claude Opus",
      source: "model",
      content: "Claude Opus is the most capable model for complex reasoning tasks.",
    })], 1);
    // Insert research row at gen 1
    insertPageSections(db, stmts, [makeSection({
      path: "/research/scaling-laws",
      url: "https://www.anthropic.com/research/scaling-laws",
      title: "Scaling Laws",
      source: "research",
      content: "Research paper on scaling laws for neural language models.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    // New generation 2 with doc content only
    insertPageSections(db, stmts, [makeSection({
      content: "New docs content from the second generation crawl cycle.",
    })], 2);
    finalizeGeneration(db, stmts, 2);

    // Model and research rows should survive
    const modelResults = searchDocs(stmts, "most capable model", 10, "model");
    expect(modelResults).toHaveLength(1);
    expect(modelResults[0].title).toBe("Claude Opus");

    const researchResults = searchDocs(stmts, "scaling laws neural", 10, "research");
    expect(researchResults).toHaveLength(1);
    expect(researchResults[0].title).toBe("Scaling Laws");
  });

  it("cleanupOrphanedGenerations preserves model and research rows", () => {
    // Insert doc rows at gen 1
    insertPageSections(db, stmts, [makeSection({
      path: "/docs/en/old-doc",
      url: "https://platform.claude.com/docs/en/old-doc",
      title: "Old Doc",
      source: "platform",
      content: "Old documentation content from generation one that should be removed.",
    })], 1);
    // Insert model row at gen 1
    insertPageSections(db, stmts, [makeSection({
      path: "/claude/opus",
      url: "https://www.anthropic.com/claude/opus",
      title: "Claude Opus",
      source: "model",
      content: "Model page content that must survive orphan cleanup regardless of gen.",
    })], 1);
    // Insert research row at gen 1
    insertPageSections(db, stmts, [makeSection({
      path: "/research/paper",
      url: "https://www.anthropic.com/research/paper",
      title: "Research Paper",
      source: "research",
      content: "Research content that must survive orphan cleanup regardless of gen.",
    })], 1);
    // New generation 2
    insertPageSections(db, stmts, [makeSection({
      path: "/docs/en/new-doc",
      url: "https://platform.claude.com/docs/en/new-doc",
      title: "New Doc",
      source: "platform",
      content: "New documentation content from generation two that should be kept alive.",
    })], 2);
    finalizeGeneration(db, stmts, 2);

    cleanupOrphanedGenerations(db, stmts);

    // Model and research rows from gen 1 should survive
    const modelResult = getDocPage(stmts, "/claude/opus");
    expect(modelResult).not.toBeNull();
    const researchResult = getDocPage(stmts, "/research/paper");
    expect(researchResult).not.toBeNull();

    // Old doc from gen 1 should be gone
    const oldDocResult = getDocPage(stmts, "/docs/en/old-doc");
    expect(oldDocResult).toBeNull();
  });

  it("getPageOutline returns section headings for a path", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: null, content: "Intro content for the page." }),
      makeSection({ sectionOrder: 1, sectionHeading: "Authentication", content: "Auth section content here." }),
      makeSection({ sectionOrder: 2, sectionHeading: "Error Handling", content: "Error section content here." }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const outline = getPageOutline(stmts, "/docs/en/test");
    expect(outline).not.toBeNull();
    expect(outline!.title).toBe("Test Page");
    expect(outline!.url).toBe("https://platform.claude.com/docs/en/test");
    expect(outline!.headings).toEqual([null, "Authentication", "Error Handling"]);
  });

  it("getPageOutline returns null for missing path", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const outline = getPageOutline(stmts, "/nonexistent");
    expect(outline).toBeNull();
  });

  it("getPageOutline fuzzy-matches by path suffix", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const outline = getPageOutline(stmts, "/test");
    expect(outline).not.toBeNull();
  });

  it("getPageOutline returns disambiguation for multiple path matches", () => {
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/a/test", url: "https://platform.claude.com/docs/en/a/test", title: "A Test" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/b/test", url: "https://platform.claude.com/docs/en/b/test", title: "B Test" })], 1);
    finalizeGeneration(db, stmts, 1);

    const outline = getPageOutline(stmts, "/test");
    expect(outline).not.toBeNull();
    expect(outline!.type).toBe("disambiguation");
  });

  it("getPageSections filters by section heading substring", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: null, content: "Intro" }),
      makeSection({ sectionOrder: 1, sectionHeading: "Authentication", content: "Auth details here." }),
      makeSection({ sectionOrder: 2, sectionHeading: "Error Handling", content: "Error details here." }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getPageSections(stmts, "/docs/en/test", "auth");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("page");
    if (result!.type === "page") {
      expect(result!.sections).toHaveLength(1);
      expect(result!.sections[0].heading).toBe("Authentication");
      expect(result!.sections[0].content).toBe("Auth details here.");
    }
  });

  it("getPageSections returns multiple matching sections", () => {
    insertPageSections(db, stmts, [
      makeSection({ sectionOrder: 0, sectionHeading: "Tool basics", content: "Basics content." }),
      makeSection({ sectionOrder: 1, sectionHeading: "Tool advanced", content: "Advanced content." }),
      makeSection({ sectionOrder: 2, sectionHeading: "Unrelated", content: "Other content." }),
    ], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getPageSections(stmts, "/docs/en/test", "tool");
    expect(result).not.toBeNull();
    if (result!.type === "page") {
      expect(result!.sections).toHaveLength(2);
    }
  });

  it("getPageSections returns null for missing path", () => {
    insertPageSections(db, stmts, [makeSection()], 1);
    finalizeGeneration(db, stmts, 1);

    const result = getPageSections(stmts, "/nonexistent", "anything");
    expect(result).toBeNull();
  });

  it("getSourceCounts returns page count per source", () => {
    insertPageSections(db, stmts, [makeSection({ source: "platform" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/mcp", url: "https://code.claude.com/docs/en/mcp", title: "MCP", source: "code" })], 1);
    insertPageSections(db, stmts, [makeSection({ path: "/docs/en/mcp2", url: "https://code.claude.com/docs/en/mcp2", title: "MCP2", source: "code" })], 1);
    finalizeGeneration(db, stmts, 1);

    const counts = getSourceCounts(stmts);
    expect(counts).toEqual([
      { source: "code", count: 2 },
      { source: "platform", count: 1 },
    ]);
  });

  it("retagResearchPages converts blog /research/ rows to source research", () => {
    insertPageSections(db, stmts, [makeSection({
      path: "/research/scaling-laws",
      url: "https://www.anthropic.com/research/scaling-laws",
      title: "Scaling Laws",
      source: "blog",
      content: "A research paper that was incorrectly tagged as blog source.",
    })], 1);
    insertPageSections(db, stmts, [makeSection({
      path: "/news/claude-4",
      url: "https://www.anthropic.com/news/claude-4",
      title: "Claude 4 Announcement",
      source: "blog",
      content: "A news blog post that should remain tagged as blog source.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    const changed = retagResearchPages(db);
    expect(changed).toBe(1);

    // Research row should now be source='research'
    const researchResults = searchDocs(stmts, "scaling laws", 10, "research");
    expect(researchResults).toHaveLength(1);

    // Blog news row should still be source='blog'
    const blogResults = searchDocs(stmts, "claude announcement", 10, "blog");
    expect(blogResults).toHaveLength(1);
  });

  it("blog rows survive cleanupOrphanedGenerations (blog-exclusion)", () => {
    // Insert doc rows at generation 1
    insertPageSections(db, stmts, [makeSection({
      path: "/docs/en/old-doc",
      url: "https://platform.claude.com/docs/en/old-doc",
      title: "Old Doc",
      source: "platform",
      content: "Old documentation content from generation one that should be removed.",
    })], 1);

    // Insert blog rows at generation 1
    insertPageSections(db, stmts, [makeSection({
      path: "/news/blog-post",
      url: "https://www.anthropic.com/news/blog-post",
      title: "Blog Post",
      source: "blog",
      content: "Blog content that must survive orphan cleanup regardless of generation number.",
    })], 1);

    // Insert doc rows at generation 2 (simulating a new crawl)
    insertPageSections(db, stmts, [makeSection({
      path: "/docs/en/new-doc",
      url: "https://platform.claude.com/docs/en/new-doc",
      title: "New Doc",
      source: "platform",
      content: "New documentation content from generation two that should be kept alive.",
    })], 2);
    finalizeGeneration(db, stmts, 2);

    // Now cleanup orphaned generations
    const removed = cleanupOrphanedGenerations(db, stmts);

    // Blog rows from gen 1 should survive (source='blog' excluded from cleanup)
    const blogUrls = getIndexedBlogUrls(db);
    expect(blogUrls).toContain("https://www.anthropic.com/news/blog-post");

    // Doc rows from gen 1 should be gone (orphaned)
    const oldDocResult = getDocPage(stmts, "/docs/en/old-doc");
    expect(oldDocResult).toBeNull();

    // Doc rows from gen 2 should survive (current generation)
    const newDocResult = getDocPage(stmts, "/docs/en/new-doc");
    expect(newDocResult).not.toBeNull();
  });

});
