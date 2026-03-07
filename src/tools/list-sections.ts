import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSections, getSourceCounts } from "../database.js";
import type { Statements, SectionRow, SourceCount } from "../types.js";
import type { CrawlManager } from "../crawl.js";

const SOURCE_LABELS: Record<string, string> = {
  platform: "pages", code: "pages", "api-reference": "pages",
  blog: "posts", model: "pages", research: "papers",
};

const SOURCE_NAMES: Record<string, string> = {
  platform: "Anthropic Platform Docs",
  code: "Claude Code Docs",
  "api-reference": "API Reference",
  blog: "Anthropic Blog",
  model: "Model Pages",
  research: "Research Papers",
};

function formatSummary(counts: SourceCount[]): string {
  const lines = counts.map((c) => `${c.source}: ${c.count} ${SOURCE_LABELS[c.source] || "pages"}`);
  return lines.join("\n") + "\n\nUse source filter to list pages for a specific source.";
}

function formatCompactList(sections: SectionRow[], source: string): string {
  let output = `${SOURCE_NAMES[source] || source} (${sections.length} pages)\n\n`;
  for (const s of sections) {
    output += `${s.path} — ${s.title}\n`;
  }
  return output;
}

export function registerListSectionsTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "list_doc_sections",
    {
      description:
        "List indexed documentation pages. With no source filter, returns page counts per source. With a specific source filter, returns the full page listing for that source.",
      inputSchema: {
        source: z
          .enum(["all", "platform", "code", "api-reference", "blog", "model", "research"])
          .default("all")
          .describe("Filter by source. 'all' (default) returns summary counts. Specific source returns full page list."),
      },
    },
    async ({ source }) => {
      const building = crawl.firstRunBuildingResponse();
      if (building) return building;

      if (source === "all") {
        const counts = getSourceCounts(stmts);
        if (counts.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No pages indexed yet. The index may still be building — try again in a minute, or use refresh_index." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: formatSummary(counts) }],
        };
      }

      const sections = listSections(stmts, source);
      if (sections.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No ${source} pages indexed yet. The index may still be building — try again in a minute, or use refresh_index.` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: formatCompactList(sections, source) }],
      };
    }
  );
}
