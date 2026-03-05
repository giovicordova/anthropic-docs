import { createHash } from "node:crypto";
import { FETCH_TIMEOUT_MS } from "./config.js";
import type { ConditionalFetchResult } from "./types.js";

export function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "anthropic-docs-mcp/2.0 (local indexer)" },
  }).finally(() => clearTimeout(timeout));
}

export async function conditionalFetch(
  url: string,
  storedEtag?: string | null,
  storedLastModified?: string | null,
): Promise<ConditionalFetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": "anthropic-docs-mcp/2.0 (local indexer)",
  };
  if (storedEtag) headers["If-None-Match"] = storedEtag;
  if (storedLastModified) headers["If-Modified-Since"] = storedLastModified;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (response.status === 304) return { modified: false };
    return {
      modified: true,
      response,
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
