import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch utilities before importing modules that use them
vi.mock("../src/fetch.js", () => ({
  fetchWithTimeout: vi.fn(),
  conditionalFetch: vi.fn(),
  contentHash: vi.fn(() => "mock-hash"),
}));

import { fetchWithTimeout, conditionalFetch } from "../src/fetch.js";
import { fetchAndParse } from "../src/parser.js";
import { fetchBlogPages } from "../src/blog-parser.js";
import { MAX_BLOG_PAGES } from "../src/config.js";

const mockFetch = vi.mocked(fetchWithTimeout);
const mockConditionalFetch = vi.mocked(conditionalFetch);

function mockResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

// Valid llms-full.txt content for a single page
const VALID_PLATFORM_TEXT = [
  "# Test Page",
  "",
  "URL: https://platform.claude.com/docs/en/test-page",
  "",
  "# Test Page",
  "",
  "This is test content with enough words to be meaningful in the search index for testing purposes.",
  "",
  "## Overview",
  "",
  "This section provides an overview of the test page content for verification in tests.",
].join("\n");

const VALID_CODE_TEXT = [
  "# Code Doc",
  "Source: https://code.claude.com/docs/en/code-doc",
  "",
  "This is a code documentation page with enough content to pass the minimum section size filter.",
  "",
  "## Usage",
  "",
  "Usage instructions for the code documentation page that are long enough for indexing.",
].join("\n");

// Suppress console.error from parser logging during tests
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAndParse network error handling", () => {
  it("returns empty pages when both sources timeout", async () => {
    mockConditionalFetch.mockRejectedValue(new Error("The operation was aborted"));

    const result = await fetchAndParse();

    expect(result.pages).toEqual([]);
  });

  it("returns partial results when one source fails and the other succeeds", async () => {
    // Platform fails, code succeeds
    mockConditionalFetch
      .mockRejectedValueOnce(new Error("The operation was aborted"))
      .mockResolvedValueOnce({
        modified: true,
        response: mockResponse(VALID_CODE_TEXT),
        etag: undefined,
        lastModified: undefined,
      });

    const result = await fetchAndParse();

    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.every((p) => p.source === "code")).toBe(true);
  });

  it("returns partial results when one source returns HTTP 500", async () => {
    // Platform returns 500, code succeeds
    mockConditionalFetch
      .mockResolvedValueOnce({
        modified: true,
        response: mockResponse("Internal Server Error", false, 500),
        etag: undefined,
        lastModified: undefined,
      })
      .mockResolvedValueOnce({
        modified: true,
        response: mockResponse(VALID_CODE_TEXT),
        etag: undefined,
        lastModified: undefined,
      });

    const result = await fetchAndParse();

    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.every((p) => p.source === "code")).toBe(true);
  });
});

describe("fetchBlogPages network error handling", () => {
  it("handles individual page fetch failures gracefully", async () => {
    const urls = [
      "https://www.anthropic.com/news/post-1",
      "https://www.anthropic.com/news/post-2",
      "https://www.anthropic.com/news/post-3",
    ];

    // First succeeds, second fails, third succeeds
    mockFetch
      .mockResolvedValueOnce(
        mockResponse("<article><h1>Post 1</h1><p>Content of post one is here.</p></article>")
      )
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce(
        mockResponse("<article><h1>Post 3</h1><p>Content of post three is here.</p></article>")
      );

    const result = await fetchBlogPages(urls);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Post 1");
    expect(result[1].title).toBe("Post 3");
  });

  it("respects MAX_BLOG_PAGES cap", async () => {
    // Use a small number above cap to verify truncation logic.
    // We can't use the real MAX_BLOG_PAGES (1000) because of batch delays.
    // Instead, verify that URLs beyond the cap are never fetched.
    const cap = 15; // Small cap for test speed
    const extraUrls = 5;
    const urls = Array.from(
      { length: cap + extraUrls },
      (_, i) => `https://www.anthropic.com/news/post-${i}`
    );

    // Track which URLs are actually fetched
    const fetchedUrls: string[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      fetchedUrls.push(url);
      return mockResponse("<article><h1>Post</h1><p>Content of the blog post here.</p></article>");
    });

    // Temporarily override MAX_BLOG_PAGES for this test by calling with pre-sliced array
    // The function truncates at MAX_BLOG_PAGES internally, so we verify the real behavior
    // by checking that with MAX_BLOG_PAGES + 50 URLs, only MAX_BLOG_PAGES are fetched
    await fetchBlogPages(urls.slice(0, MAX_BLOG_PAGES + 50));

    // fetchBlogPages truncates to MAX_BLOG_PAGES (1000). Since our array is only 20,
    // all 20 are under the cap. To truly test truncation, we verify the contract:
    // the function should never fetch more than MAX_BLOG_PAGES URLs.
    expect(fetchedUrls.length).toBeLessThanOrEqual(MAX_BLOG_PAGES);
    // And all 20 of our URLs should have been fetched (they're under the cap)
    expect(fetchedUrls.length).toBe(cap + extraUrls);
  }, 30000);

  it("truncates URLs array to MAX_BLOG_PAGES when exceeded", async () => {
    // Directly verify truncation: pass array longer than MAX_BLOG_PAGES
    // and check that console.error logs the truncation warning
    const oversizedUrls = Array.from(
      { length: MAX_BLOG_PAGES + 10 },
      (_, i) => `https://www.anthropic.com/news/post-${i}`
    );

    // We only need to verify the truncation happens, not process all 1000
    // Use mockImplementation that resolves instantly
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      return mockResponse("<article><h1>Post</h1><p>Blog content here.</p></article>");
    });

    // Run with fake timers to skip batch delays
    vi.useFakeTimers();
    const promise = fetchBlogPages(oversizedUrls);
    // Advance timers to resolve all batch delays
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }
    await promise;
    vi.useRealTimers();

    // Should have fetched exactly MAX_BLOG_PAGES (truncated the extra 10)
    expect(callCount).toBe(MAX_BLOG_PAGES);
  }, 60000);
});
