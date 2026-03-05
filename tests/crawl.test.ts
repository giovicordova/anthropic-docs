import { describe, it, expect, beforeEach } from "vitest";
import { STALE_DAYS, BLOG_STALE_DAYS } from "../src/config.js";
import { CrawlManager } from "../src/crawl.js";
import { initDatabase, prepareStatements, setMetadata } from "../src/database.js";
import type { ContentSource, ParsedPage } from "../src/types.js";
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

  it("triggers crawl when age exceeds STALE_DAYS", () => {
    // 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(twoDaysAgo, STALE_DAYS)).toBe(true);
  });

  it("does NOT trigger crawl when age is below STALE_DAYS", () => {
    // 1 hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(oneHourAgo, STALE_DAYS)).toBe(false);
  });

  it("uses BLOG_STALE_DAYS (7) for blog staleness", () => {
    // 3 days ago -- should NOT trigger blog crawl
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(threeDaysAgo, BLOG_STALE_DAYS)).toBe(false);

    // 8 days ago -- SHOULD trigger blog crawl
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldCrawl(eightDaysAgo, BLOG_STALE_DAYS)).toBe(true);
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
