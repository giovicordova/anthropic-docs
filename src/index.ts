#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  initDatabase,
  prepareStatements,
  cleanupOrphanedGenerations,
} from "./database.js";
import { CrawlManager, docSource, blogSource } from "./crawl.js";
import { registerTools } from "./tools/index.js";

const server = new McpServer({ name: "anthropic-docs", version: "2.0.0" });
const db = initDatabase();
const stmts = prepareStatements(db);

const orphans = cleanupOrphanedGenerations(db, stmts);
if (orphans > 0) {
  console.error(`[server] Cleaned up ${orphans} orphaned rows from failed crawl.`);
}

const crawl = new CrawlManager(db, stmts, [docSource, blogSource]);
registerTools(server, stmts, crawl);

async function main() {
  crawl.checkAndCrawlAll();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("[server] Shutting down gracefully...");
  server.close().catch(() => {});
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
