import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMetadata } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { logger } from "../logger.js";

export function registerRefreshTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "refresh_index",
    {
      description:
        "Re-fetch and update the local documentation index. Runs in the background — returns immediately. Use this if search results seem stale. The index auto-refreshes daily on startup.",
      inputSchema: {},
    },
    async () => {
      const _toolStart = Date.now();
      if (crawl.isAnyCrawling()) {
        logger.toolCall("refresh_index", {}, Date.now() - _toolStart, { success: true, resultSummary: "already crawling" });
        return {
          content: [
            {
              type: "text" as const,
              text: "A crawl is already in progress. Please wait for it to complete.",
            },
          ],
        };
      }

      const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
      const pageCount = getMetadata(stmts, "page_count") || "unknown";

      crawl
        .crawlAll()
        .catch((err) => console.error("[server] Refresh failed:", (err as Error).message));

      logger.toolCall("refresh_index", {}, Date.now() - _toolStart, { success: true, resultSummary: "started" });
      return {
        content: [
          {
            type: "text" as const,
            text: `Refresh started. Previous index: ${pageCount} pages, last crawled ${lastCrawl || "never"}.`,
          },
        ],
      };
    }
  );
}
