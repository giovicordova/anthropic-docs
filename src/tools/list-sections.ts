import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSections } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";
import { logger } from "../logger.js";

export function registerListSectionsTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "list_doc_sections",
    {
      description:
        "List all indexed documentation pages with their paths, grouped by source. Use this to discover what documentation is available or find the correct path for get_doc_page.",
      inputSchema: {
        source: z
          .enum(["all", "platform", "code", "api-reference", "blog", "model", "research"])
          .default("all")
          .describe("Filter by source: 'platform', 'code', 'api-reference', 'blog', or 'all' (default)."),
      },
    },
    async ({ source }) => {
      const _toolStart = Date.now();
      const building = crawl.firstRunBuildingResponse();
      if (building) {
        logger.toolCall("list_doc_sections", { source }, Date.now() - _toolStart, { success: true, resultSummary: "building" });
        return building;
      }

      const sections = listSections(stmts, source);

      if (sections.length === 0) {
        logger.toolCall("list_doc_sections", { source }, Date.now() - _toolStart, { success: true, resultSummary: "no sections" });
        return {
          content: [
            {
              type: "text" as const,
              text: "No pages indexed yet. The index may still be building — try again in a minute, or use refresh_index.",
            },
          ],
        };
      }

      const platformPages = sections.filter((s) => s.source === "platform");
      const codePages = sections.filter((s) => s.source === "code");
      const apiRefPages = sections.filter((s) => s.source === "api-reference");

      let output = `# Documentation Index\n\n${sections.length} pages indexed.\n\n`;

      if (platformPages.length > 0) {
        output += `## Anthropic Platform Docs (${platformPages.length} pages)\n\n`;
        const grouped: Record<string, { path: string; title: string }[]> = {};
        for (const s of platformPages) {
          const parts = s.path.split("/").filter(Boolean);
          const category = parts.length > 2 ? parts[2] : "root";
          if (!grouped[category]) grouped[category] = [];
          grouped[category].push(s);
        }
        for (const [category, pages] of Object.entries(grouped).sort()) {
          output += `### ${category.replace(/-/g, " ")}\n\n`;
          for (const p of pages) {
            output += `- [${p.title}](${p.path})\n`;
          }
          output += "\n";
        }
      }

      if (apiRefPages.length > 0) {
        output += `## API Reference (${apiRefPages.length} pages)\n\n`;
        for (const p of apiRefPages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }

      if (codePages.length > 0) {
        output += `## Claude Code Docs (${codePages.length} pages)\n\n`;
        for (const p of codePages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }

      const blogPages = sections.filter((s) => s.source === "blog");

      if (blogPages.length > 0) {
        output += `## Anthropic Blog (${blogPages.length} posts)\n\n`;
        for (const p of blogPages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }

      const modelPages = sections.filter((s) => s.source === "model");

      if (modelPages.length > 0) {
        output += `## Model Pages (${modelPages.length} pages)\n\n`;
        for (const p of modelPages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }

      const researchPages = sections.filter((s) => s.source === "research");

      if (researchPages.length > 0) {
        output += `## Research Papers (${researchPages.length} papers)\n\n`;
        for (const p of researchPages) {
          output += `- [${p.title}](${p.path})\n`;
        }
        output += "\n";
      }

      logger.toolCall("list_doc_sections", { source }, Date.now() - _toolStart, { success: true, resultSummary: `${sections.length} sections` });
      return {
        content: [{ type: "text" as const, text: output }],
      };
    }
  );
}
