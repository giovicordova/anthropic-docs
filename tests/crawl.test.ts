import { describe, it, expect, beforeEach, vi } from "vitest";
import { STALE_DAYS, BLOG_STALE_DAYS, MODEL_STALE_DAYS, RESEARCH_STALE_DAYS, MODEL_PAGE_URLS, MAX_RESEARCH_PAGES } from "../src/config.js";
import { CrawlManager, docSource, blogSource, modelSource, researchSource } from "../src/crawl.js";
import { initDatabase, prepareStatements, setMetadata, insertPageSections, finalizeGeneration, getIndexedBlogUrls } from "../src/database.js";
import type { ContentSource, ParsedPage, SitemapEntry } from "../src/types.js";
import type { PageSection } from "../src/types.js";
import type Database from "better-sqlite3";

/**
 * Crawl state tests.
 *
 * The crawl functions (startCrawl, startBlogCrawl, checkAndCrawl, checkAndCrawlBlog)
 * are private to index.ts. Plan 02 will extract them into a CrawlManager class.
 *
 * These tests define the BEHAVIORAL CONTRACT that the future CrawlManager must satisfy.
 * They test the patterns/logic directly rather than importing private functions.
 */

// --- CrawlState state machine (mirrors index.ts pattern) ---

type CrawlState = "idle" | "crawling" | "failed";

function createCrawlStateMachine() {
  let state: CrawlState = "idle";

  return {
    getState: () => state,
    startCrawl: async (crawlFn: () => Promise<number>): Promise<number> => {
      if (state === "crawling") {
        return -1; // skip guard
      }
      state = "crawling";
      try {
        const result = await crawlFn();
        state = "idle";
        return result;
      } catch (err) {
        state = "failed";
        throw err;
      }
    },
  };
}

describe("crawl state transitions", () => {
  it("returns -1 (skip guard) when startCrawl called while already crawling", async () => {
    const machine = createCrawlStateMachine();

    // Start a crawl that never resolves
    const neverResolve = new Promise<number>(() => {});
    const firstCrawl = machine.startCrawl(() => neverResolve);

    // Try to start another crawl while the first is in progress
    const result = await machine.startCrawl(async () => 42);
    expect(result).toBe(-1);

    // State should still be "crawling" from the first
    expect(machine.getState()).toBe("crawling");
  });

  it("returns to idle after successful crawl", async () => {
    const machine = createCrawlStateMachine();

    await machine.startCrawl(async () => 10);

    expect(machine.getState()).toBe("idle");
  });

  it("transitions to failed after crawl error", async () => {
    const machine = createCrawlStateMachine();

    await expect(
      machine.startCrawl(async () => {
        throw new Error("Network failure");
      })
    ).rejects.toThrow("Network failure");

    expect(machine.getState()).toBe("failed");
  });

  it("blog crawl returns -1 (skip guard) when already crawling", async () => {
    // Same state machine pattern applies to blog crawl
    const blogMachine = createCrawlStateMachine();

    const neverResolve = new Promise<number>(() => {});
    blogMachine.startCrawl(() => neverResolve);

    const result = await blogMachine.startCrawl(async () => 5);
    expect(result).toBe(-1);
  });
});

describe("staleness calculation", () => {
  function calculateStaleDays(lastCrawlTimestamp: string | null): number | null {
    if (!lastCrawlTimestamp) return null;
    const age = Date.now() - new Date(lastCrawlTimestamp).getTime();
    return age / (1000 * 60 * 60 * 24);
  }

  function shouldCrawl(lastCrawlTimestamp: string | null, threshold: number): boolean {
    const staleDays = calculateStaleDays(lastCrawlTimestamp);
    if (staleDays === null) return true; // No timestamp = must crawl
    return staleDays > threshold;
  }

  it("triggers crawl when no last_crawl_timestamp exists", () => {
    expect(shouldCrawl(null, STALE_DAYS)).toBe(true);
  });

  it("triggers crawl when age exceeds STALE_DAYS (~3 hours)", () => {
    // 4 hours ago -- exceeds 3h threshold
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(fourHoursAgo, STALE_DAYS)).toBe(true);
  });

  it("does NOT trigger crawl when age is below STALE_DAYS (~3 hours)", () => {
    // 1 hour ago -- within 3h threshold
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(oneHourAgo, STALE_DAYS)).toBe(false);
  });

  it("uses BLOG_STALE_DAYS (~8 hours) for blog staleness", () => {
    // 5 hours ago -- should NOT trigger blog crawl (within 8h)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(fiveHoursAgo, BLOG_STALE_DAYS)).toBe(false);

    // 10 hours ago -- SHOULD trigger blog crawl (exceeds 8h)
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(tenHoursAgo, BLOG_STALE_DAYS)).toBe(true);
  });
});

// --- CrawlManager integration tests (real DB, mock fetch) ---

function makePage(overrides: Partial<ParsedPage> = {}): ParsedPage {
  return {
    title: "Test Page",
    url: "https://platform.claude.com/docs/en/test",
    path: "/docs/en/test",
    content: "This is test content for the search index with enough words to be meaningful.",
    source: "platform",
    ...overrides,
  };
}

function makeGenSource(pages: ParsedPage[]): ContentSource {
  return {
    name: "docs",
    staleDays: STALE_DAYS,
    metaTimestampKey: "last_crawl_timestamp",
    metaCountKey: "page_count",
    usesGeneration: true,
    async fetch() { return pages; },
  };
}

describe("page count threshold", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("rejects crawl when page count below 50% of previous", async () => {
    // Simulate previous crawl with 100 pages
    setMetadata(stmts, "page_count", "100");

    const source = makeGenSource(Array.from({ length: 40 }, (_, i) =>
      makePage({ path: `/docs/en/page-${i}`, url: `https://platform.claude.com/docs/en/page-${i}` })
    ));

    const manager = new CrawlManager(db, stmts, [source]);
    const result = await manager.crawlSource(source);

    expect(result).toBe(0);
    expect(manager.getState("docs")).toBe("failed");
    expect(manager.getLastError("docs")).not.toBeNull();
    expect(manager.getLastError("docs")!.message).toContain("Crawl rejected");
  });

  it("allows crawl on first run (previousCount=0)", async () => {
    // No previous page_count metadata = first crawl
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage({ path: `/docs/en/page-${i}`, url: `https://platform.claude.com/docs/en/page-${i}` })
    );
    const source = makeGenSource(pages);
    const manager = new CrawlManager(db, stmts, [source]);

    const result = await manager.crawlSource(source);

    expect(result).toBe(5);
    expect(manager.getState("docs")).toBe("idle");
  });

  it("allows crawl when page count >= 50% of previous", async () => {
    setMetadata(stmts, "page_count", "100");

    const pages = Array.from({ length: 60 }, (_, i) =>
      makePage({ path: `/docs/en/page-${i}`, url: `https://platform.claude.com/docs/en/page-${i}` })
    );
    const source = makeGenSource(pages);
    const manager = new CrawlManager(db, stmts, [source]);

    const result = await manager.crawlSource(source);

    expect(result).toBe(60);
    expect(manager.getState("docs")).toBe("idle");
  });
});

describe("conditional skip (304/hash match)", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("treats zero pages with no error as conditional skip (not threshold failure)", async () => {
    // Simulate previous crawl with 100 pages
    setMetadata(stmts, "page_count", "100");

    // Source returns 0 pages (simulating 304 conditional skip)
    const source = makeGenSource([]);
    const manager = new CrawlManager(db, stmts, [source]);
    const result = await manager.crawlSource(source);

    // Should succeed (idle), not fail
    expect(result).toBe(0);
    expect(manager.getState("docs")).toBe("idle");
    expect(manager.getLastError("docs")).toBeNull();
  });

  it("updates timestamp on conditional skip", async () => {
    setMetadata(stmts, "page_count", "100");

    const source = makeGenSource([]);
    const manager = new CrawlManager(db, stmts, [source]);
    await manager.crawlSource(source);

    // Timestamp should be updated even though no pages changed
    const timestamp = db
      .prepare("SELECT value FROM metadata WHERE key = 'last_crawl_timestamp'")
      .get() as { value: string } | undefined;
    expect(timestamp).toBeDefined();
  });
});

describe("error tracking", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("getLastError returns null when no error has occurred", () => {
    const source = makeGenSource([]);
    const manager = new CrawlManager(db, stmts, [source]);
    expect(manager.getLastError("docs")).toBeNull();
  });

  it("stores error on crawl failure", async () => {
    const failingSource: ContentSource = {
      name: "docs",
      staleDays: STALE_DAYS,
      metaTimestampKey: "last_crawl_timestamp",
      metaCountKey: "page_count",
      usesGeneration: true,
      async fetch() { throw new Error("Network timeout"); },
    };

    const manager = new CrawlManager(db, stmts, [failingSource]);

    await expect(manager.crawlSource(failingSource)).rejects.toThrow("Network timeout");

    const error = manager.getLastError("docs");
    expect(error).not.toBeNull();
    expect(error!.message).toBe("Network timeout");
    expect(error!.timestamp).toBeTruthy();
  });

  it("stores error on blog crawl failure (non-generation)", async () => {
    const failingBlog: ContentSource = {
      name: "blog",
      staleDays: 7,
      metaTimestampKey: "last_blog_crawl_timestamp",
      metaCountKey: "blog_page_count",
      usesGeneration: false,
      async fetch() { throw new Error("Sitemap fetch failed"); },
    };

    const manager = new CrawlManager(db, stmts, [failingBlog]);
    const result = await manager.crawlSource(failingBlog);

    expect(result).toBe(0);
    const error = manager.getLastError("blog");
    expect(error).not.toBeNull();
    expect(error!.message).toBe("Sitemap fetch failed");
  });
});

describe("CrawlManager parameterized count query", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
  });

  it("non-generation source count query uses source name, not hardcoded blog", async () => {
    // Create a non-generation source named "model"
    const modelSource: ContentSource = {
      name: "model",
      staleDays: 0.33,
      metaTimestampKey: "last_model_crawl_timestamp",
      metaCountKey: "model_page_count",
      usesGeneration: false,
      async fetch() {
        return [
          makePage({ url: "https://www.anthropic.com/claude/opus", path: "/claude/opus", source: "model", title: "Claude Opus" }),
        ];
      },
    };

    const manager = new CrawlManager(db, stmts, [modelSource]);
    await manager.crawlSource(modelSource);

    // The count metadata should reflect the model source count, not blog count
    const count = db.prepare("SELECT value FROM metadata WHERE key = 'model_page_count'").get() as { value: string } | undefined;
    expect(count).toBeDefined();
    expect(count!.value).toBe("1");
  });
});

// --- Blog diff tests (mock HTTP, real DB) ---

// We mock fetchSitemapEntries, fetchBlogPages, fetchSitemapEntriesForPrefix, and fetchWithTimeout to avoid real HTTP
vi.mock("../src/blog-parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog-parser.js")>();
  return {
    ...actual,
    fetchSitemapEntries: vi.fn(async () => [] as SitemapEntry[]),
    fetchBlogPages: vi.fn(async () => [] as ParsedPage[]),
    fetchSitemapEntriesForPrefix: vi.fn(async () => [] as SitemapEntry[]),
  };
});

vi.mock("../src/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetch.js")>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async () => new Response("", { status: 404 })),
  };
});

import { fetchSitemapEntries, fetchBlogPages, fetchSitemapEntriesForPrefix } from "../src/blog-parser.js";
import { fetchWithTimeout } from "../src/fetch.js";

const mockFetchSitemapEntries = vi.mocked(fetchSitemapEntries);
const mockFetchBlogPages = vi.mocked(fetchBlogPages);
const mockFetchSitemapEntriesForPrefix = vi.mocked(fetchSitemapEntriesForPrefix);
const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

function makeBlogSection(overrides: Partial<PageSection> = {}): PageSection {
  return {
    url: "https://www.anthropic.com/news/test-post",
    path: "/news/test-post",
    title: "Test Blog Post",
    sectionHeading: null,
    sectionAnchor: null,
    content: "Blog content about test topics with enough words to be meaningful.",
    sectionOrder: 0,
    source: "blog",
    ...overrides,
  };
}

describe("blogSource sitemap diff", () => {
  let db: Database.Database;
  let stmts: ReturnType<typeof prepareStatements>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = prepareStatements(db);
    vi.clearAllMocks();
  });

  it("fetches all URLs when index is empty (all new)", async () => {
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/post-a", lastmod: "2026-01-01" },
      { url: "https://www.anthropic.com/news/post-b", lastmod: "2026-01-02" },
    ]);
    mockFetchBlogPages.mockResolvedValue([
      makePage({ url: "https://www.anthropic.com/news/post-a", path: "/news/post-a", source: "blog", title: "Post A" }),
      makePage({ url: "https://www.anthropic.com/news/post-b", path: "/news/post-b", source: "blog", title: "Post B" }),
    ]);

    const pages = await blogSource.fetch(db);
    expect(pages).toHaveLength(2);
    expect(mockFetchBlogPages).toHaveBeenCalledOnce();
    // All URLs should be passed to fetchBlogPages
    const calledUrls = mockFetchBlogPages.mock.calls[0][0];
    expect(calledUrls).toContain("https://www.anthropic.com/news/post-a");
    expect(calledUrls).toContain("https://www.anthropic.com/news/post-b");
  });

  it("detects updated URLs (lastmod > crawled_at) and re-fetches them", async () => {
    // Insert a blog post indexed 2 days ago
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/updated-post",
      path: "/news/updated-post",
      title: "Old Title",
      content: "Old blog content that should be replaced after update.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    // Sitemap says this post was updated more recently than when we crawled it
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/updated-post", lastmod: futureDate },
    ]);
    mockFetchBlogPages.mockResolvedValue([
      makePage({ url: "https://www.anthropic.com/news/updated-post", path: "/news/updated-post", source: "blog", title: "Updated Title" }),
    ]);

    const pages = await blogSource.fetch(db);

    // Should return the updated page for re-insertion
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Updated Title");

    // Old rows should have been deleted before returning new pages
    const remainingUrls = getIndexedBlogUrls(db);
    expect(remainingUrls).not.toContain("https://www.anthropic.com/news/updated-post");
  });

  it("skips unchanged URLs (lastmod <= crawled_at)", async () => {
    // Insert a blog post
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/old-post",
      path: "/news/old-post",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    // Sitemap has same post with lastmod in the past
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/old-post", lastmod: "2020-01-01T00:00:00Z" },
    ]);

    const pages = await blogSource.fetch(db);

    // No pages to fetch -- everything unchanged
    expect(pages).toHaveLength(0);
    expect(mockFetchBlogPages).not.toHaveBeenCalled();
  });

  it("skips URLs with null lastmod when already indexed", async () => {
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/null-mod",
      path: "/news/null-mod",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/null-mod", lastmod: null },
    ]);

    const pages = await blogSource.fetch(db);
    expect(pages).toHaveLength(0);
    expect(mockFetchBlogPages).not.toHaveBeenCalled();
  });

  it("detects deleted URLs (in index, not in sitemap) and removes them", async () => {
    // Insert two blog posts
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/keep-post",
      path: "/news/keep-post",
      content: "Blog content for post that should remain in the index.",
    })], 1);
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/deleted-post",
      path: "/news/deleted-post",
      content: "Blog content for post that will be removed from sitemap.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    // Sitemap only contains keep-post (deleted-post is gone)
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/keep-post", lastmod: "2020-01-01T00:00:00Z" },
    ]);

    await blogSource.fetch(db);

    const remainingUrls = getIndexedBlogUrls(db);
    expect(remainingUrls).toContain("https://www.anthropic.com/news/keep-post");
    expect(remainingUrls).not.toContain("https://www.anthropic.com/news/deleted-post");
  });

  it("skips deletions when sitemap entries below safety threshold", async () => {
    // Insert 10 blog posts
    for (let i = 0; i < 10; i++) {
      insertPageSections(db, stmts, [makeBlogSection({
        url: `https://www.anthropic.com/news/post-${i}`,
        path: `/news/post-${i}`,
        content: `Blog content for post number ${i} with enough words to index.`,
      })], 1);
    }
    finalizeGeneration(db, stmts, 1);

    // Sitemap returns only 2 entries (below 50% of 10)
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/post-0", lastmod: "2020-01-01T00:00:00Z" },
      { url: "https://www.anthropic.com/news/post-1", lastmod: "2020-01-01T00:00:00Z" },
    ]);

    await blogSource.fetch(db);

    // All 10 posts should still be in the index (deletions skipped)
    const remainingUrls = getIndexedBlogUrls(db);
    expect(remainingUrls).toHaveLength(10);
  });

  it("handles mixed scenario: new + updated + deleted + unchanged", async () => {
    // Insert existing posts
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/unchanged",
      path: "/news/unchanged",
      content: "Unchanged blog post content that stays the same.",
    })], 1);
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/to-update",
      path: "/news/to-update",
      content: "Old content of blog post that will be updated.",
    })], 1);
    insertPageSections(db, stmts, [makeBlogSection({
      url: "https://www.anthropic.com/news/to-delete",
      path: "/news/to-delete",
      content: "Content of blog post that will be deleted from sitemap.",
    })], 1);
    finalizeGeneration(db, stmts, 1);

    const futureDate = new Date(Date.now() + 86400000).toISOString();
    mockFetchSitemapEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/news/unchanged", lastmod: "2020-01-01T00:00:00Z" },
      { url: "https://www.anthropic.com/news/to-update", lastmod: futureDate },
      { url: "https://www.anthropic.com/news/brand-new", lastmod: "2026-03-01" },
      // to-delete is NOT in sitemap
    ]);

    mockFetchBlogPages.mockResolvedValue([
      makePage({ url: "https://www.anthropic.com/news/to-update", path: "/news/to-update", source: "blog", title: "Updated" }),
      makePage({ url: "https://www.anthropic.com/news/brand-new", path: "/news/brand-new", source: "blog", title: "Brand New" }),
    ]);

    const pages = await blogSource.fetch(db);

    // Should return updated + new pages
    expect(pages).toHaveLength(2);
    const urls = pages.map(p => p.url);
    expect(urls).toContain("https://www.anthropic.com/news/to-update");
    expect(urls).toContain("https://www.anthropic.com/news/brand-new");

    // Deleted post should be gone
    const remainingUrls = getIndexedBlogUrls(db);
    expect(remainingUrls).not.toContain("https://www.anthropic.com/news/to-delete");

    // Unchanged post should still exist
    expect(remainingUrls).toContain("https://www.anthropic.com/news/unchanged");
  });
});

// --- modelSource tests ---

describe("modelSource", () => {
  it("has correct metadata keys and usesGeneration=false", () => {
    expect(modelSource.name).toBe("model");
    expect(modelSource.staleDays).toBe(MODEL_STALE_DAYS);
    expect(modelSource.metaTimestampKey).toBe("last_model_crawl_timestamp");
    expect(modelSource.metaCountKey).toBe("model_page_count");
    expect(modelSource.usesGeneration).toBe(false);
  });

  it("fetch returns ParsedPage[] with source=model for mocked HTML", async () => {
    const db = initDatabase(":memory:");

    // Mock fetchWithTimeout to return valid HTML for each model URL
    mockFetchWithTimeout.mockImplementation(async (url: string) => {
      return new Response(
        `<article><h1>Claude Model</h1><p>Model description for ${url}.</p></article>`,
        { status: 200 }
      );
    });

    const pages = await modelSource.fetch(db);

    expect(pages.length).toBe(MODEL_PAGE_URLS.length);
    for (const page of pages) {
      expect(page.source).toBe("model");
      expect(page.title).toBe("Claude Model");
    }
  });

  it("fetch skips URLs that return non-OK status", async () => {
    const db = initDatabase(":memory:");

    let callCount = 0;
    mockFetchWithTimeout.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 404 });
      return new Response(
        `<article><h1>Model Page</h1><p>Content here for this model page.</p></article>`,
        { status: 200 }
      );
    });

    const pages = await modelSource.fetch(db);

    // First URL fails, rest succeed
    expect(pages.length).toBe(MODEL_PAGE_URLS.length - 1);
  });
});

// --- researchSource tests ---

describe("researchSource", () => {
  it("has correct metadata keys and usesGeneration=false", () => {
    expect(researchSource.name).toBe("research");
    expect(researchSource.staleDays).toBe(RESEARCH_STALE_DAYS);
    expect(researchSource.metaTimestampKey).toBe("last_research_crawl_timestamp");
    expect(researchSource.metaCountKey).toBe("research_page_count");
    expect(researchSource.usesGeneration).toBe(false);
  });

  it("fetch does incremental diff: new research pages fetched", async () => {
    const db = initDatabase(":memory:");
    const stmts = prepareStatements(db);

    mockFetchSitemapEntriesForPrefix.mockResolvedValue([
      { url: "https://www.anthropic.com/research/paper-a", lastmod: "2026-01-01" },
      { url: "https://www.anthropic.com/research/paper-b", lastmod: "2026-01-02" },
    ]);
    mockFetchBlogPages.mockResolvedValue([
      makePage({ url: "https://www.anthropic.com/research/paper-a", path: "/research/paper-a", source: "research", title: "Paper A" }),
      makePage({ url: "https://www.anthropic.com/research/paper-b", path: "/research/paper-b", source: "research", title: "Paper B" }),
    ]);

    const pages = await researchSource.fetch(db);

    expect(pages).toHaveLength(2);
    expect(pages[0].source).toBe("research");
    expect(mockFetchBlogPages).toHaveBeenCalledOnce();
  });

  it("fetch respects MAX_RESEARCH_PAGES cap", async () => {
    const db = initDatabase(":memory:");

    // Create entries exceeding cap
    const entries = Array.from({ length: MAX_RESEARCH_PAGES + 50 }, (_, i) => ({
      url: `https://www.anthropic.com/research/paper-${i}`,
      lastmod: "2026-01-01",
    }));
    mockFetchSitemapEntriesForPrefix.mockResolvedValue(entries);
    mockFetchBlogPages.mockResolvedValue([]);

    await researchSource.fetch(db);

    // fetchBlogPages should receive at most MAX_RESEARCH_PAGES URLs
    const calledUrls = mockFetchBlogPages.mock.calls[0][0];
    expect(calledUrls.length).toBeLessThanOrEqual(MAX_RESEARCH_PAGES);
  });

  it("CrawlManager with 4 sources initializes all states to idle", () => {
    const db = initDatabase(":memory:");
    const stmts = prepareStatements(db);

    const manager = new CrawlManager(db, stmts, [docSource, blogSource, modelSource, researchSource]);

    expect(manager.getState("docs")).toBe("idle");
    expect(manager.getState("blog")).toBe("idle");
    expect(manager.getState("model")).toBe("idle");
    expect(manager.getState("research")).toBe("idle");
  });
});
