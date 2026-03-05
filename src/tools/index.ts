import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { registerSearchTool } from "./search.js";
import { registerGetPageTool } from "./get-page.js";
import { registerListSectionsTool } from "./list-sections.js";
import { registerRefreshTool } from "./refresh.js";
import { registerStatusTool } from "./status.js";

export function registerTools(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  registerSearchTool(server, stmts, crawl);
  registerGetPageTool(server, stmts, crawl);
  registerListSectionsTool(server, stmts, crawl);
  registerRefreshTool(server, stmts, crawl);
  registerStatusTool(server, stmts, crawl);
}
