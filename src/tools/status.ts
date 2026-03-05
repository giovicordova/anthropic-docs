import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMetadata } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { STALE_DAYS, BLOG_STALE_DAYS } from "../config.js";

/** Minimal interface for status text building (testable without full CrawlManager) */
export interface StatusCrawlInfo {
  getState(name: string): string;
  getLastError(name: string): { message: string; timestamp: string } | null;
}

export function buildStatusText(stmts: Statements, crawl: StatusCrawlInfo): string {
  const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
  const pageCount = getMetadata(stmts, "page_count") || "0";
  const blogPageCount = getMetadata(stmts, "blog_page_count") || "0";
  const lastBlogCrawl = getMetadata(stmts, "last_blog_crawl_timestamp");

  let ageDays = "unknown";
  if (lastCrawl) {
    const age = Date.now() - new Date(lastCrawl).getTime();
    ageDays = (age / (1000 * 60 * 60 * 24)).toFixed(1);
  }

  const lines = [
    `**Index Status**`,
    `- Pages indexed: ${pageCount}`,
    `- Last crawl: ${lastCrawl || "never"}`,
    `- Age: ${ageDays} days`,
    `- Crawl state: ${crawl.getState("docs")}`,
    `- Stale threshold: ${STALE_DAYS} day(s)`,
    `- Blog posts indexed: ${blogPageCount}`,
    `- Last blog crawl: ${lastBlogCrawl || "never"}`,
    `- Blog crawl state: ${crawl.getState("blog")}`,
    `- Blog stale threshold: ${BLOG_STALE_DAYS} day(s)`,
  ];

  const docsError = crawl.getLastError("docs");
  if (docsError) {
    lines.push(`- Last docs failure: ${docsError.message} at ${docsError.timestamp}`);
  }

  const blogError = crawl.getLastError("blog");
  if (blogError) {
    lines.push(`- Last blog failure: ${blogError.message} at ${blogError.timestamp}`);
  }

  return lines.join("\n");
}

export function registerStatusTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "index_status",
    {
      description:
        "Check the current status of the documentation index: page count, last crawl time, index age, and crawl state. Lightweight — does not trigger a crawl.",
      inputSchema: {},
    },
    async () => {
      const status = buildStatusText(stmts, crawl);

      return {
        content: [{ type: "text" as const, text: status }],
      };
    }
  );
}
