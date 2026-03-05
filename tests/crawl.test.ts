import { describe, it, expect } from "vitest";
import { STALE_DAYS, BLOG_STALE_DAYS } from "../src/config.js";

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
