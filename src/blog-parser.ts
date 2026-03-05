import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  BLOG_SITEMAP_URL,
  BLOG_CONCURRENCY,
  BLOG_PATH_PREFIXES,
  MAX_BLOG_PAGES,
} from "./config.js";
import { fetchWithTimeout } from "./fetch.js";
import type { ParsedPage, SitemapEntry, DocSource } from "./types.js";

// --- Pure functions (exported for testing) ---

export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  const locRegex = /<loc>\s*(.*?)\s*<\/loc>/g;
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    try {
      const pathname = new URL(url).pathname;
      if (BLOG_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        urls.push(url);
      }
    } catch {
      // skip invalid URLs
    }
  }

  return urls;
}

export function parseSitemapWithLastmod(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlBlockRegex = /<url>\s*([\s\S]*?)\s*<\/url>/g;
  let block: RegExpExecArray | null;

  while ((block = urlBlockRegex.exec(xml)) !== null) {
    const locMatch = block[1].match(/<loc>\s*(.*?)\s*<\/loc>/);
    if (!locMatch) continue;

    const url = locMatch[1];
    try {
      const pathname = new URL(url).pathname;
      if (!BLOG_PATH_PREFIXES.some((p) => pathname.startsWith(p))) continue;
    } catch {
      continue;
    }

    const lastmodMatch = block[1].match(/<lastmod>\s*(.*?)\s*<\/lastmod>/);
    entries.push({
      url,
      lastmod: lastmodMatch ? lastmodMatch[1] : null,
    });
  }

  return entries;
}

const nhm = new NodeHtmlMarkdown();

export function htmlToMarkdown(html: string): string {
  // Try <article> first, then <main>, fall back to full HTML
  const articleMatch = html.match(/<article[\s>][\s\S]*?<\/article>/i);
  if (articleMatch) {
    return nhm.translate(articleMatch[0]).trim();
  }

  const mainMatch = html.match(/<main[\s>][\s\S]*?<\/main>/i);
  if (mainMatch) {
    return nhm.translate(mainMatch[0]).trim();
  }

  return nhm.translate(html).trim();
}

export function parseHtmlPage(url: string, html: string, source: DocSource): ParsedPage | null {
  const content = htmlToMarkdown(html);
  if (!content) return null;

  // Extract title from first # heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  let title: string;
  if (h1Match) {
    title = h1Match[1].trim();
  } else {
    // Fall back to last URL path segment
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    title = segments[segments.length - 1] || "Untitled";
  }

  const path = new URL(url).pathname;

  return { title, url, path, content, source };
}

export function parseBlogPage(url: string, html: string): ParsedPage | null {
  return parseHtmlPage(url, html, "blog");
}

// --- Fetch functions ---

export async function fetchSitemapUrls(): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(BLOG_SITEMAP_URL);
    if (!response.ok) {
      console.error(`[blog-parser] Sitemap fetch failed: HTTP ${response.status}`);
      return [];
    }
    const xml = await response.text();
    const urls = parseSitemap(xml);
    console.error(`[blog-parser] Sitemap: found ${urls.length} blog URLs`);
    return urls;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[blog-parser] Sitemap fetch error: ${message}`);
    return [];
  }
}

export async function fetchSitemapEntries(): Promise<SitemapEntry[]> {
  try {
    const response = await fetchWithTimeout(BLOG_SITEMAP_URL);
    if (!response.ok) {
      console.error(`[blog-parser] Sitemap fetch failed: HTTP ${response.status}`);
      return [];
    }
    const xml = await response.text();
    const entries = parseSitemapWithLastmod(xml);
    console.error(`[blog-parser] Sitemap: found ${entries.length} blog URLs`);
    return entries;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[blog-parser] Sitemap fetch error: ${message}`);
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBlogPages(urls: string[]): Promise<ParsedPage[]> {
  if (urls.length > MAX_BLOG_PAGES) {
    console.error(`[blog-parser] Warning: ${urls.length} URLs exceeds cap of ${MAX_BLOG_PAGES}. Truncating.`);
    urls = urls.slice(0, MAX_BLOG_PAGES);
  }

  const pages: ParsedPage[] = [];
  const totalBatches = Math.ceil(urls.length / BLOG_CONCURRENCY);

  for (let i = 0; i < urls.length; i += BLOG_CONCURRENCY) {
    const batch = urls.slice(i, i + BLOG_CONCURRENCY);
    const batchNum = Math.floor(i / BLOG_CONCURRENCY) + 1;
    console.error(`[blog-parser] Fetching batch ${batchNum}/${totalBatches} (${batch.length} URLs)`);

    const results = await Promise.allSettled(
      batch.map(async (url) => {
        const response = await fetchWithTimeout(url);
        if (!response.ok) return null;
        const html = await response.text();
        return parseBlogPage(url, html);
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        pages.push(result.value);
      }
    }

    // Delay between batches (skip after last batch)
    if (i + BLOG_CONCURRENCY < urls.length) {
      await delay(200);
    }
  }

  console.error(`[blog-parser] Fetched ${pages.length}/${urls.length} blog pages`);
  return pages;
}
