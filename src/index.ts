#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  initDatabase,
  prepareStatements,
  cleanupOrphanedGenerations,
  retagResearchPages,
} from "./database.js";
import { CrawlManager, docSource, blogSource, modelSource, researchSource } from "./crawl.js";
import { registerTools } from "./tools/index.js";
import { POLL_INTERVAL_MS } from "./config.js";

const server = new McpServer({ name: "anthropic-docs", version: "2.0.0" });
const db = initDatabase();
const stmts = prepareStatements(db);

const orphans = cleanupOrphanedGenerations(db, stmts);
if (orphans > 0) {
  console.error(`[server] Cleaned up ${orphans} orphaned rows from failed crawl.`);
}

const retagged = retagResearchPages(db);
if (retagged > 0) {
  console.error(`[server] Re-tagged ${retagged} research pages from blog source.`);
}

const crawl = new CrawlManager(db, stmts, [docSource, blogSource, modelSource, researchSource]);
registerTools(server, stmts, crawl);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function main() {
  crawl.checkAndCrawlAll();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");

  pollTimer = setInterval(() => {
    console.error("[server] Scheduled poll triggered.");
    crawl.checkAndCrawlAll();
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
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
  if (pollTimer) clearInterval(pollTimer);
  server.close().catch(() => {});
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
