import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { conditionalFetch, contentHash } from "../src/fetch.js";

describe("conditionalFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends If-None-Match when storedEtag provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return new Response("body", { status: 200 });
    }) as unknown as typeof fetch;

    await conditionalFetch("https://example.com", '"abc123"');
    expect(capturedHeaders["If-None-Match"]).toBe('"abc123"');
  });

  it("sends If-Modified-Since when storedLastModified provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return new Response("body", { status: 200 });
    }) as unknown as typeof fetch;

    await conditionalFetch("https://example.com", null, "Wed, 01 Jan 2025 00:00:00 GMT");
    expect(capturedHeaders["If-Modified-Since"]).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  it("returns {modified: false} on 304", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const result = await conditionalFetch("https://example.com", '"abc123"');
    expect(result.modified).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it("returns {modified: true, response, etag, lastModified} on 200", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("content", {
        status: 200,
        headers: {
          etag: '"new-etag"',
          "last-modified": "Thu, 02 Jan 2025 00:00:00 GMT",
        },
      });
    }) as unknown as typeof fetch;

    const result = await conditionalFetch("https://example.com", '"old-etag"');
    expect(result.modified).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.etag).toBe('"new-etag"');
    expect(result.lastModified).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
  });

  it("sends no conditional headers when none stored", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return new Response("body", { status: 200 });
    }) as unknown as typeof fetch;

    await conditionalFetch("https://example.com");
    expect(capturedHeaders["If-None-Match"]).toBeUndefined();
    expect(capturedHeaders["If-Modified-Since"]).toBeUndefined();
    expect(capturedHeaders["User-Agent"]).toBeDefined();
  });
});

describe("contentHash", () => {
  it("returns consistent SHA-256 hex for same input", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash for different input", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("hello world!");
    expect(hash1).not.toBe(hash2);
  });
});
