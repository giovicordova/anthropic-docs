import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMetadata } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { STALE_HOURS, BLOG_STALE_HOURS, MODEL_STALE_HOURS, RESEARCH_STALE_HOURS } from "../config.js";

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
  const modelPageCount = getMetadata(stmts, "model_page_count") || "0";
  const lastModelCrawl = getMetadata(stmts, "last_model_crawl_timestamp");
  const researchPageCount = getMetadata(stmts, "research_page_count") || "0";
  const lastResearchCrawl = getMetadata(stmts, "last_research_crawl_timestamp");

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
    `- Stale threshold: ${STALE_HOURS} hour(s)`,
    `- Blog posts indexed: ${blogPageCount}`,
    `- Last blog crawl: ${lastBlogCrawl || "never"}`,
    `- Blog crawl state: ${crawl.getState("blog")}`,
    `- Blog stale threshold: ${BLOG_STALE_HOURS} hour(s)`,
    `- Model pages indexed: ${modelPageCount}`,
    `- Last model crawl: ${lastModelCrawl || "never"}`,
    `- Model crawl state: ${crawl.getState("model")}`,
    `- Model stale threshold: ${MODEL_STALE_HOURS} hour(s)`,
    `- Research papers indexed: ${researchPageCount}`,
    `- Last research crawl: ${lastResearchCrawl || "never"}`,
    `- Research crawl state: ${crawl.getState("research")}`,
    `- Research stale threshold: ${RESEARCH_STALE_HOURS} hour(s)`,
  ];

  const docsError = crawl.getLastError("docs");
  if (docsError) {
    lines.push(`- Last docs failure: ${docsError.message} at ${docsError.timestamp}`);
  }

  const blogError = crawl.getLastError("blog");
  if (blogError) {
    lines.push(`- Last blog failure: ${blogError.message} at ${blogError.timestamp}`);
  }

  const modelError = crawl.getLastError("model");
  if (modelError) {
    lines.push(`- Last model failure: ${modelError.message} at ${modelError.timestamp}`);
  }

  const researchError = crawl.getLastError("research");
  if (researchError) {
    lines.push(`- Last research failure: ${researchError.message} at ${researchError.timestamp}`);
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
