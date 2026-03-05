import type Database from "better-sqlite3";
import { type Statements, insertPage, getCurrentGeneration, finalizeGeneration, setMetadata } from "./database.js";
import { htmlToMarkdown, splitIntoSections } from "./markdown.js";
import { SITEMAP_URL, CLAUDE_CODE_DOCS_URL, CONCURRENCY, FETCH_TIMEOUT_MS } from "./config.js";

interface SitemapEntry {
  url: string;
  path: string;
}

function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeout)
  );
}

export async function parseSitemap(): Promise<SitemapEntry[]> {
  console.error("[crawler] Fetching sitemap...");
  const response = await fetchWithTimeout(SITEMAP_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status}`);
  }

  const xml = await response.text();

  const urls: SitemapEntry[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;

  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
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
    const response = await fetchWithTimeout(url, {
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

function extractArticleContent(html: string): { html: string; isApiRef: boolean } | null {
  const articleMatch = html.match(
    /<article[^>]*id=["']content-container["'][^>]*>([\s\S]*?)<\/article>/
  );
  if (articleMatch) return { html: articleMatch[1], isApiRef: false };

  const fallbackMatch = html.match(
    /<article[^>]*>([\s\S]*?)<\/article>/
  );
  if (fallbackMatch) return { html: fallbackMatch[1], isApiRef: false };

  const stldocsMatches = html.match(
    /<div[^>]*class="[^"]*stldocs-root(?![^"]*stldocs-sidebar)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*stldocs-root|$)/g
  );

  if (stldocsMatches) {
    for (const match of stldocsMatches) {
      if (!match.includes("stldocs-sidebar")) {
        const innerMatch = match.match(/<div[^>]*>([\s\S]*)/);
        if (innerMatch) return { html: innerMatch[1], isApiRef: true };
      }
    }
  }

  return null;
}

function extractPageTitle(html: string): string {
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/s);
  if (h1Match) {
    return h1Match[1].replace(/<[^>]+>/g, "").trim();
  }

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

interface ParsedPage {
  title: string;
  url: string;
  path: string;
  content: string;
}

function parseLlmsFullTxt(text: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("# ") && i + 1 < lines.length && lines[i + 1].startsWith("Source: https://code.claude.com/")) {
      const title = lines[i].slice(2).trim();
      const url = lines[i + 1].slice("Source: ".length).trim();
      const path = new URL(url).pathname;

      const contentLines: string[] = [];
      i += 2;
      while (i < lines.length) {
        if (lines[i].startsWith("# ") && i + 1 < lines.length && lines[i + 1].startsWith("Source: https://code.claude.com/")) {
          break;
        }
        contentLines.push(lines[i]);
        i++;
      }

      const content = contentLines.join("\n").trim();
      if (content.length > 0) {
        pages.push({ title, url, path, content });
      }
    } else {
      i++;
    }
  }

  return pages;
}

async function crawlClaudeCodeDocs(db: Database.Database, stmts: Statements, generation: number): Promise<number> {
  console.error("[crawler] Fetching Claude Code docs from llms-full.txt...");

  const response = await fetchWithTimeout(CLAUDE_CODE_DOCS_URL, {
    headers: {
      "User-Agent": "anthropic-docs-mcp/1.0 (local indexer)",
    },
  });

  if (!response.ok) {
    console.error(`[crawler] Failed to fetch Claude Code docs: HTTP ${response.status}`);
    return 0;
  }

  const text = await response.text();
  const pages = parseLlmsFullTxt(text);
  let indexed = 0;

  for (const page of pages) {
    const sections = splitIntoSections(page.content);

    for (const section of sections) {
      insertPage(db, stmts, {
        url: page.url,
        path: page.path,
        title: page.title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
        source: "code",
      }, generation);
    }

    indexed++;
    console.error(`[crawler] [code] Indexed: ${page.path}`);
  }

  console.error(`[crawler] Claude Code docs: indexed ${indexed} pages.`);
  return indexed;
}

export async function crawlDocs(db: Database.Database, stmts: Statements): Promise<number> {
  const currentGen = getCurrentGeneration(stmts);
  const newGen = currentGen + 1;

  const entries = await parseSitemap();
  const total = entries.length;
  let indexed = 0;

  console.error(`[crawler] Starting crawl of ${total} pages (generation ${newGen})...`);

  await processInBatches(entries, CONCURRENCY, async (entry) => {
    const html = await fetchPageContent(entry.url);
    if (!html) return;

    const extracted = extractArticleContent(html);
    if (!extracted) {
      console.error(`[crawler] SKIP ${entry.path}: no content found`);
      return;
    }

    const title = extractPageTitle(html);
    const markdown = htmlToMarkdown(extracted.html);
    const sections = splitIntoSections(markdown);
    const source = extracted.isApiRef ? "api-reference" : "platform";

    for (const section of sections) {
      insertPage(db, stmts, {
        url: entry.url,
        path: entry.path,
        title,
        sectionHeading: section.heading,
        sectionAnchor: section.anchor,
        content: section.content,
        sectionOrder: section.order,
        source,
      }, newGen);
    }

    indexed++;
    console.error(`[crawler] [${indexed}/${total}] Indexed: ${entry.path} (${source})`);
  });

  const codeIndexed = await crawlClaudeCodeDocs(db, stmts, newGen);

  // Atomically swap to new generation — delete old rows, rebuild FTS
  finalizeGeneration(db, stmts, newGen);

  const totalIndexed = indexed + codeIndexed;
  setMetadata(stmts, "last_crawl_timestamp", new Date().toISOString());
  setMetadata(stmts, "page_count", String(totalIndexed));

  console.error(`[crawler] Done. Indexed ${indexed} platform + ${codeIndexed} code = ${totalIndexed} total pages.`);
  return totalIndexed;
}
