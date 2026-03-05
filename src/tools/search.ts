import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchDocs, getMetadata } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { STALE_DAYS, BLOG_STALE_DAYS } from "../config.js";

const ALL_SOURCES = ["platform", "code", "api-reference", "blog"];

export function buildMetadataFooter(stmts: Statements, sources: string[]): string {
  const docSources = sources.filter((s) => s !== "blog");
  const hasBlog = sources.includes("blog");

  const parts: string[] = [];
  const staleNames: string[] = [];

  if (docSources.length > 0) {
    const ts = getMetadata(stmts, "last_crawl_timestamp");
    const ageDays = ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : null;
    parts.push(`${docSources.join(", ")}: last crawled ${ts || "never"}`);
    if (ageDays !== null && ageDays > STALE_DAYS) staleNames.push(...docSources);
  }

  if (hasBlog) {
    const ts = getMetadata(stmts, "last_blog_crawl_timestamp");
    const ageDays = ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : null;
    parts.push(`blog: last crawled ${ts || "never"}`);
    if (ageDays !== null && ageDays > BLOG_STALE_DAYS) staleNames.push("blog");
  }

  let footer = "\n\n---\n" + parts.join(" | ");

  if (staleNames.length > 0) {
    footer =
      "\n\n**Warning: stale data** -- " +
      staleNames.join(", ") +
      " index exceeds freshness threshold. Run refresh_index to update." +
      footer;
  }

  return footer;
}

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

        // Determine sources for metadata footer
        const footerSources =
          results.length > 0
            ? [...new Set(results.map((r) => r.source))]
            : source !== "all"
              ? [source]
              : ALL_SOURCES;
        const footer = buildMetadataFooter(stmts, footerSources);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}"${source !== "all" ? ` in ${source} docs` : ""}. Try different terms, or use refresh_index to re-crawl if the index is stale.${footer}`,
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
          content: [{ type: "text" as const, text: formatted + footer }],
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
