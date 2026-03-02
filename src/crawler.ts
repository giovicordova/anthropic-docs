import type Database from "better-sqlite3";
import { insertPage, clearPages, setMetadata } from "./database.js";
import { htmlToMarkdown, splitIntoSections } from "./markdown.js";

const SITEMAP_URL = "https://platform.claude.com/sitemap.xml";
const CONCURRENCY = 5;

interface SitemapEntry {
  url: string;
  path: string;
}

export async function parseSitemap(): Promise<SitemapEntry[]> {
  console.error("[crawler] Fetching sitemap...");
  const response = await fetch(SITEMAP_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status}`);
  }

  const xml = await response.text();

  // Simple XML parsing — extract <loc> tags
  const urls: SitemapEntry[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;

  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    // Filter to English docs only
    if (url.includes("/docs/en/")) {
      const urlObj = new URL(url);
      urls.push({ url, path: urlObj.pathname });
    }
  }

  console.error(`[crawler] Found ${urls.length} English doc pages`);
  return urls;
}

async function fetchPageContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "anthropic-docs-mcp/1.0 (local indexer)",
      },
    });
    if (!response.ok) {
      console.error(`[crawler] SKIP ${url}: HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.error(`[crawler] SKIP ${url}: ${(err as Error).message}`);
    return null;
  }
}

function extractArticleContent(html: string): string | null {
  // Extract content inside <article id="content-container">...</article>
  // Used by standard documentation pages (guides, tutorials, concepts)
  const articleMatch = html.match(
    /<article[^>]*id=["']content-container["'][^>]*>([\s\S]*?)<\/article>/
  );
  if (articleMatch) return articleMatch[1];

  // Fallback: try any <article> tag
  const fallbackMatch = html.match(
    /<article[^>]*>([\s\S]*?)<\/article>/
  );
  if (fallbackMatch) return fallbackMatch[1];

  // API reference pages (/api/*) use a different structure (stldocs-method-content-column)
  // and contain massive auto-generated schema content. We intentionally skip them
  // to keep the search index focused on actual documentation.
  return null;
}

function extractPageTitle(html: string): string {
  // Try <h1> first
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/s);
  if (h1Match) {
    // Strip HTML tags from the h1 content
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }

  // Fallback to <title>
  const titleMatch = html.match(/<title>(.*?)<\/title>/);
  if (titleMatch) return titleMatch[1].replace(/ \|.*$/, "").trim();

  return "Untitled";
}

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;

  async function nextBatch() {
    const batch: Promise<void>[] = [];
    while (batch.length < concurrency && index < items.length) {
      const currentIndex = index++;
      batch.push(handler(items[currentIndex], currentIndex));
    }
    await Promise.all(batch);
  }

  while (index < items.length) {
    await nextBatch();
  }
}

export async function crawlDocs(db: Database.Database): Promise<number> {
  const entries = await parseSitemap();
  const total = entries.length;
  let indexed = 0;

  console.error(`[crawler] Starting crawl of ${total} pages...`);
  clearPages(db);

  await processInBatches(entries, CONCURRENCY, async (entry, i) => {
    const html = await fetchPageContent(entry.url);
    if (!html) return;

    const articleHtml = extractArticleContent(html);
    if (!articleHtml) {
      console.error(`[crawler] SKIP ${entry.path}: no article content found`);
      return;
    }

    const title = extractPageTitle(html);
    const markdown = htmlToMarkdown(articleHtml);
    const sections = splitIntoSections(markdown);

    for (const section of sections) {
      insertPage(db, {
        url: entry.url,
        path: entry.path,
        title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
      });
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${total}] Indexed: ${entry.path}`);
  });

  setMetadata(db, "last_crawl_timestamp", new Date().toISOString());
  setMetadata(db, "page_count", String(indexed));

  console.error(`[crawler] Done. Indexed ${indexed}/${total} pages.`);
  return indexed;
}
