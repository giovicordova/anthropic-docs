import type Database from "better-sqlite3";
import type { Statements, ContentSource, CrawlState, ParsedPage } from "./types.js";
import {
  getCurrentGeneration,
  insertPageSections,
  finalizeGeneration,
  getMetadata,
  setMetadata,
  getIndexedBlogUrls,
} from "./database.js";
import { pagesToSections } from "./parser.js";
import { fetchAndParse } from "./parser.js";
import { fetchSitemapUrls, fetchBlogPages } from "./blog-parser.js";
import { STALE_DAYS, BLOG_STALE_DAYS } from "./config.js";

// --- ContentSource implementations ---

export const docSource: ContentSource = {
  name: "docs",
  staleDays: STALE_DAYS,
  metaTimestampKey: "last_crawl_timestamp",
  metaCountKey: "page_count",
  usesGeneration: true,
  async fetch() {
    return fetchAndParse();
  },
};

export const blogSource: ContentSource = {
  name: "blog",
  staleDays: BLOG_STALE_DAYS,
  metaTimestampKey: "last_blog_crawl_timestamp",
  metaCountKey: "blog_page_count",
  usesGeneration: false,
  async fetch(db: Database.Database) {
    const sitemapUrls = await fetchSitemapUrls();
    if (sitemapUrls.length === 0) return [];
    const indexedSet = new Set(getIndexedBlogUrls(db));
    const newUrls = sitemapUrls.filter((url) => !indexedSet.has(url));
    if (newUrls.length === 0) return [];
    return fetchBlogPages(newUrls);
  },
};

// --- CrawlManager ---

export class CrawlManager {
  private db: Database.Database;
  private stmts: Statements;
  private sources: ContentSource[];
  private states: Map<string, CrawlState> = new Map();

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
        const currentGen = getCurrentGeneration(this.stmts);
        const newGen = currentGen + 1;

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
          .prepare("SELECT COUNT(DISTINCT url) as cnt FROM pages WHERE source = 'blog'")
          .get() as { cnt: number };
        setMetadata(this.stmts, source.metaCountKey, String(countRow.cnt));
      }

      this.states.set(source.name, "idle");
      return pages.length;
    } catch (err) {
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
