import { FETCH_TIMEOUT_MS } from "./config.js";

export function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "anthropic-docs-mcp/2.0 (local indexer)" },
  }).finally(() => clearTimeout(timeout));
}
