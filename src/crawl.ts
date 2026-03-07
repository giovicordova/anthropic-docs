import type Database from "better-sqlite3";
import type { Statements, ContentSource, CrawlState, ParsedPage } from "./types.js";
import {
  getCurrentGeneration,
  insertPageSections,
  finalizeGeneration,
  getMetadata,
  setMetadata,
  getIndexedBlogUrlsWithTimestamps,
  getIndexedUrlsWithTimestamps,
  deleteBlogPages,
  deletePagesBySource,
  prepareStatements,
} from "./database.js";
import { pagesToSections, fetchAndParse } from "./parser.js";
import type { FetchAndParseOptions } from "./parser.js";
import { fetchSitemapEntries, fetchSitemapEntriesForPrefix, fetchBlogPages, parseHtmlPage } from "./blog-parser.js";
import { fetchWithTimeout } from "./fetch.js";
import {
  STALE_DAYS,
  BLOG_STALE_DAYS,
  MODEL_STALE_DAYS,
  MODEL_PAGE_URLS,
  RESEARCH_STALE_DAYS,
  RESEARCH_PATH_PREFIX,
  MAX_RESEARCH_PAGES,
  MIN_PAGE_RATIO,
} from "./config.js";

// --- ContentSource implementations ---

export const docSource: ContentSource = {
  name: "docs",
  staleDays: STALE_DAYS,
  metaTimestampKey: "last_crawl_timestamp",
  metaCountKey: "page_count",
  usesGeneration: true,
  async fetch(db: Database.Database) {
    const stmts = prepareStatements(db);
    const options: FetchAndParseOptions = {
      platformEtag: getMetadata(stmts, "platform_etag"),
      platformLastModified: getMetadata(stmts, "platform_last_modified"),
      platformContentHash: getMetadata(stmts, "platform_content_hash"),
      codeEtag: getMetadata(stmts, "code_etag"),
      codeLastModified: getMetadata(stmts, "code_last_modified"),
      codeContentHash: getMetadata(stmts, "code_content_hash"),
    };

    const result = await fetchAndParse(options);

    // Store new conditional headers/hashes
    if (result.platformEtag) setMetadata(stmts, "platform_etag", result.platformEtag);
    if (result.platformLastModified) setMetadata(stmts, "platform_last_modified", result.platformLastModified);
    if (result.platformContentHash) setMetadata(stmts, "platform_content_hash", result.platformContentHash);
    if (result.codeEtag) setMetadata(stmts, "code_etag", result.codeEtag);
    if (result.codeLastModified) setMetadata(stmts, "code_last_modified", result.codeLastModified);
    if (result.codeContentHash) setMetadata(stmts, "code_content_hash", result.codeContentHash);

    // If both sources were skipped (304/hash match), return empty array
    // The caller (crawlSource) will treat empty + no error as "no changes"
    return result.pages;
  },
};

export const blogSource: ContentSource = {
  name: "blog",
  staleDays: BLOG_STALE_DAYS,
  metaTimestampKey: "last_blog_crawl_timestamp",
  metaCountKey: "blog_page_count",
  usesGeneration: false,
  async fetch(db: Database.Database) {
    // 1. Fetch sitemap entries (url + lastmod)
    const sitemapEntries = await fetchSitemapEntries();
    if (sitemapEntries.length === 0) return [];

    // 2. Get indexed blog URLs with crawled_at timestamps
    const indexedMap = getIndexedBlogUrlsWithTimestamps(db);
    const sitemapUrlSet = new Set(sitemapEntries.map((e) => e.url));

    // 3. Categorize each sitemap entry
    const newUrls: string[] = [];
    const updatedUrls: string[] = [];
    let unchangedCount = 0;

    for (const entry of sitemapEntries) {
      const crawledAt = indexedMap.get(entry.url);
      if (!crawledAt) {
        // NEW: not in index
        newUrls.push(entry.url);
      } else if (entry.lastmod && entry.lastmod > crawledAt) {
        // UPDATED: lastmod newer than crawled_at
        updatedUrls.push(entry.url);
      } else {
        // UNCHANGED: lastmod <= crawled_at or lastmod is null
        unchangedCount++;
      }
    }

    // 4. Detect DELETED: in index but not in sitemap
    const deletedUrls: string[] = [];
    for (const url of indexedMap.keys()) {
      if (!sitemapUrlSet.has(url)) {
        deletedUrls.push(url);
      }
    }

    // 5. Safety check: skip deletions if sitemap appears incomplete
    if (deletedUrls.length > 0) {
      if (sitemapEntries.length < indexedMap.size * MIN_PAGE_RATIO) {
        console.error(
          `[blog] Safety: sitemap has ${sitemapEntries.length} entries vs ${indexedMap.size} indexed. Skipping ${deletedUrls.length} deletions.`
        );
        deletedUrls.length = 0;
      }
    }

    // 6. Delete removed posts
    if (deletedUrls.length > 0) {
      deleteBlogPages(db, deletedUrls);
      console.error(`[blog] Deleted ${deletedUrls.length} removed posts.`);
    }

    // 7. Delete old rows for updated posts (will be re-inserted)
    if (updatedUrls.length > 0) {
      deleteBlogPages(db, updatedUrls);
    }

    console.error(
      `[blog] Diff: ${newUrls.length} new, ${updatedUrls.length} updated, ${deletedUrls.length} deleted, ${unchangedCount} unchanged.`
    );

    // 8. Fetch new + updated URLs
    const urlsToFetch = [...newUrls, ...updatedUrls];
    if (urlsToFetch.length === 0) return [];

    return fetchBlogPages(urlsToFetch);
  },
};

export const modelSource: ContentSource = {
  name: "model",
  staleDays: MODEL_STALE_DAYS,
  metaTimestampKey: "last_model_crawl_timestamp",
  metaCountKey: "model_page_count",
  usesGeneration: false,
  async fetch(_db) {
    const pages: ParsedPage[] = [];
    for (const url of MODEL_PAGE_URLS) {
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) continue;
        const html = await response.text();
        const page = parseHtmlPage(url, html, "model");
        if (page) pages.push(page);
      } catch (err) {
        console.error(`[model] Failed to fetch ${url}: ${(err as Error).message}`);
      }
    }
    return pages;
  },
};

export const researchSource: ContentSource = {
  name: "research",
  staleDays: RESEARCH_STALE_DAYS,
  metaTimestampKey: "last_research_crawl_timestamp",
  metaCountKey: "research_page_count",
  usesGeneration: false,
  async fetch(db) {
    // 1. Fetch sitemap entries filtered by research prefix
    const sitemapEntries = await fetchSitemapEntriesForPrefix(RESEARCH_PATH_PREFIX);
    if (sitemapEntries.length === 0) return [];

    // 2. Get indexed research URLs with crawled_at timestamps
    const indexedMap = getIndexedUrlsWithTimestamps(db, "research");
    const sitemapUrlSet = new Set(sitemapEntries.map((e) => e.url));

    // 3. Categorize each sitemap entry
    const newUrls: string[] = [];
    const updatedUrls: string[] = [];
    let unchangedCount = 0;

    for (const entry of sitemapEntries) {
      const crawledAt = indexedMap.get(entry.url);
      if (!crawledAt) {
        newUrls.push(entry.url);
      } else if (entry.lastmod && entry.lastmod > crawledAt) {
        updatedUrls.push(entry.url);
      } else {
        unchangedCount++;
      }
    }

    // 4. Detect DELETED: in index but not in sitemap
    const deletedUrls: string[] = [];
    for (const url of indexedMap.keys()) {
      if (!sitemapUrlSet.has(url)) {
        deletedUrls.push(url);
      }
    }

    // 5. Safety check: skip deletions if sitemap appears incomplete
    if (deletedUrls.length > 0) {
      if (sitemapEntries.length < indexedMap.size * MIN_PAGE_RATIO) {
        console.error(
          `[research] Safety: sitemap has ${sitemapEntries.length} entries vs ${indexedMap.size} indexed. Skipping ${deletedUrls.length} deletions.`
        );
        deletedUrls.length = 0;
      }
    }

    // 6. Delete removed research pages
    if (deletedUrls.length > 0) {
      deletePagesBySource(db, "research", deletedUrls);
      console.error(`[research] Deleted ${deletedUrls.length} removed research pages.`);
    }

    // 7. Delete old rows for updated pages (will be re-inserted)
    if (updatedUrls.length > 0) {
      deletePagesBySource(db, "research", updatedUrls);
    }

    console.error(
      `[research] Diff: ${newUrls.length} new, ${updatedUrls.length} updated, ${deletedUrls.length} deleted, ${unchangedCount} unchanged.`
    );

    // 8. Fetch new + updated URLs (capped)
    let urlsToFetch = [...newUrls, ...updatedUrls];
    if (urlsToFetch.length === 0) return [];

    if (urlsToFetch.length > MAX_RESEARCH_PAGES) {
      console.error(`[research] Warning: ${urlsToFetch.length} URLs exceeds cap of ${MAX_RESEARCH_PAGES}. Truncating.`);
      urlsToFetch = urlsToFetch.slice(0, MAX_RESEARCH_PAGES);
    }

    return fetchBlogPages(urlsToFetch, "research");
  },
};

// --- CrawlManager ---

export class CrawlManager {
  private db: Database.Database;
  private stmts: Statements;
  private sources: ContentSource[];
  private states: Map<string, CrawlState> = new Map();
  private errors: Map<string, { message: string; timestamp: string }> = new Map();

  constructor(db: Database.Database, stmts: Statements, sources: ContentSource[]) {
    this.db = db;
    this.stmts = stmts;
    this.sources = sources;
    for (const source of sources) {
      this.states.set(source.name, "idle");
    }
  }

  getState(name: string): CrawlState {
    return this.states.get(name) || "idle";
  }

  getLastError(name: string): { message: string; timestamp: string } | null {
    return this.errors.get(name) || null;
  }

  isAnyCrawling(): boolean {
    for (const state of this.states.values()) {
      if (state === "crawling") return true;
    }
    return false;
  }

  async crawlSource(source: ContentSource): Promise<number> {
    if (this.states.get(source.name) === "crawling") {
      console.error(`[server] ${source.name} crawl already in progress, skipping.`);
      return -1;
    }

    this.states.set(source.name, "crawling");
    try {
      const pages = await source.fetch(this.db);

      if (source.usesGeneration) {
        // Zero pages + no error = conditional skip (304 or hash match)
        if (pages.length === 0) {
          console.error(`[server] ${source.name}: no changes detected (conditional skip).`);
          setMetadata(this.stmts, source.metaTimestampKey, new Date().toISOString());
          this.states.set(source.name, "idle");
          return 0;
        }

        const currentGen = getCurrentGeneration(this.stmts);
        const newGen = currentGen + 1;

        // Safety threshold: reject crawl if page count dropped drastically
        const previousCount = parseInt(getMetadata(this.stmts, source.metaCountKey) || "0", 10);
        if (previousCount > 0 && pages.length < previousCount * MIN_PAGE_RATIO) {
          const msg = `Crawl rejected: ${pages.length}/${previousCount} pages (below ${MIN_PAGE_RATIO * 100}% safety threshold)`;
          console.error(`[server] ${source.name}: ${msg}`);
          this.states.set(source.name, "failed");
          this.errors.set(source.name, { message: msg, timestamp: new Date().toISOString() });
          return 0;
        }

        console.error(`[server] Starting ${source.name} crawl (generation ${newGen})...`);
        let totalSections = 0;
        for (const page of pages) {
          const sections = pagesToSections(page);
          insertPageSections(this.db, this.stmts, sections, newGen);
          totalSections += sections.length;
        }

        finalizeGeneration(this.db, this.stmts, newGen);
        setMetadata(this.stmts, source.metaTimestampKey, new Date().toISOString());
        setMetadata(this.stmts, source.metaCountKey, String(pages.length));

        console.error(`[server] ${source.name} done. ${pages.length} pages, ${totalSections} sections indexed.`);
      } else {
        // Non-generation source (blog pattern): insert at current generation
        if (pages.length > 0) {
          const currentGen = getCurrentGeneration(this.stmts);
          console.error(`[server] Starting ${source.name} crawl (${pages.length} new)...`);
          let totalSections = 0;
          for (const page of pages) {
            const sections = pagesToSections(page);
            insertPageSections(this.db, this.stmts, sections, currentGen);
            totalSections += sections.length;
          }
          console.error(`[server] ${source.name} done. ${pages.length} new, ${totalSections} sections indexed.`);
        } else {
          console.error(`[server] ${source.name} index up to date.`);
        }

        // Always update timestamp (even when no new pages -- matches original behavior)
        setMetadata(this.stmts, source.metaTimestampKey, new Date().toISOString());

        // For non-generation sources, query total count from DB
        const countRow = this.db
          .prepare("SELECT COUNT(DISTINCT url) as cnt FROM pages WHERE source = ?")
          .get(source.name) as { cnt: number };
        setMetadata(this.stmts, source.metaCountKey, String(countRow.cnt));
      }

      this.states.set(source.name, "idle");
      return pages.length;
    } catch (err) {
      this.errors.set(source.name, { message: (err as Error).message, timestamp: new Date().toISOString() });
      this.states.set(source.name, "failed");
      if (source.usesGeneration) {
        throw err;
      }
      // Blog crawl errors are caught and logged (matches original behavior)
      console.error(`[server] ${source.name} crawl failed: ${(err as Error).message}`);
      return 0;
    }
  }

  async crawlAll(): Promise<void> {
    for (const source of this.sources) {
      await this.crawlSource(source);
    }
  }

  checkAndCrawlAll(): void {
    for (const source of this.sources) {
      const lastCrawl = getMetadata(this.stmts, source.metaTimestampKey);

      if (!lastCrawl) {
        console.error(`[server] No ${source.name} index found. Starting initial crawl...`);
        this.crawlAll().catch((err) =>
          console.error(`[server] Crawl failed: ${(err as Error).message}`)
        );
        return; // crawlAll handles all sources sequentially
      }

      const age = Date.now() - new Date(lastCrawl).getTime();
      const staleDays = age / (1000 * 60 * 60 * 24);

      if (staleDays > source.staleDays) {
        console.error(
          `[server] ${source.name} index is ${Math.round(staleDays)} days old. Refreshing...`
        );
        this.crawlAll().catch((err) =>
          console.error(`[server] Crawl failed: ${(err as Error).message}`)
        );
        return; // crawlAll handles all sources sequentially
      }

      console.error(
        `[server] ${source.name} index is ${staleDays.toFixed(1)} days old. Fresh enough.`
      );
    }
  }

  firstRunBuildingResponse(): {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  } | null {
    if (
      !getMetadata(this.stmts, "last_crawl_timestamp") &&
      this.getState("docs") === "crawling"
    ) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Index is being built for the first time (~10s). Try again shortly.",
          },
        ],
        isError: true,
      };
    }
    return null;
  }
}
