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

  it("stores and retrieves metadata", () => {
    setMetadata(stmts, "test_key", "test_value");
    expect(getMetadata(stmts, "test_key")).toBe("test_value");
    expect(getMetadata(stmts, "missing")).toBeNull();
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
