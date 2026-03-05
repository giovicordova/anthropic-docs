import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchDocs } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";

export function registerSearchTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "search_anthropic_docs",
    {
      description:
        "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet. Use this tool when you need to find documentation about a specific topic, API endpoint, SDK method, or concept. Results are ranked by relevance using BM25 with title matches weighted highest. For broad queries, increase the limit; for precise lookups, use get_doc_page instead.",
      inputSchema: {
        query: z.string().describe("Search query string. Use specific terms for best results."),
        source: z
          .enum(["all", "platform", "code", "api-reference", "blog"])
          .default("all")
          .describe("Filter by source: 'platform', 'code', 'api-reference', 'blog', or 'all' (default)."),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of results (default 10)"),
      },
    },
    async ({ query, source, limit }) => {
      const building = crawl.firstRunBuildingResponse();
      if (building) return building;

      try {
        const results = searchDocs(stmts, query, limit, source);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}"${source !== "all" ? ` in ${source} docs` : ""}. Try different terms, or use refresh_index to re-crawl if the index is stale.`,
              },
            ],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**${r.sectionHeading ? ` > ${r.sectionHeading}` : ""}\n   URL: ${r.url}\n   ${r.snippet}`
          )
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${(err as Error).message}. Try simpler search terms.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
