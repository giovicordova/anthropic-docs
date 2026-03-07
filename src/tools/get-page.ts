import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDocPage, getPageOutline, getPageSections } from "../database.js";
import type { Statements, OutlineResult, SectionContent } from "../types.js";
import type { CrawlManager } from "../crawl.js";

function formatOutline(outline: OutlineResult): string {
  const headings = outline.headings
    .map((h, i) => `${i + 1}. ${h ?? "(intro)"}`)
    .join("\n");
  return `${outline.title}\n${outline.path}\n\nSections:\n${headings}`;
}

function formatSectionResult(result: { title: string; path: string; sections: SectionContent[] }): string {
  return result.sections
    .map((s) => {
      const heading = s.heading ? `${result.title} > ${s.heading}` : result.title;
      return `${heading}\n${result.path}\n\n${s.content}`;
    })
    .join("\n\n---\n\n");
}

export function registerGetPageTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "get_doc_page",
    {
      description:
        'Fetch documentation page content by URL path. Supports fuzzy matching on path suffix. Three modes:\n- No section param: returns page outline (title + section headings list)\n- section="all": returns full page content\n- section="<text>": returns sections whose heading matches the text (substring match)',
      inputSchema: {
        path: z
          .string()
          .describe('URL path of the doc page, e.g., "/docs/en/build-with-claude/tool-use"'),
        section: z
          .string()
          .optional()
          .describe('Section filter. Omit for outline. "all" for full page. Any text for substring heading match.'),
      },
    },
    async ({ path: docPath, section }) => {
      const building = crawl.firstRunBuildingResponse();
      if (building) return building;

      const notFound = {
        content: [{
          type: "text" as const,
          text: `Page not found: "${docPath}". Use search_anthropic_docs to find the correct path, or list_doc_sections to browse available pages.`,
        }],
      };

      // Full page mode
      if (section === "all") {
        const result = getDocPage(stmts, docPath);
        if (!result) return notFound;

        if (result.type === "disambiguation") {
          const list = result.matches.map((m) => `${m.path} — ${m.title}`).join("\n");
          return {
            content: [{ type: "text" as const, text: `Multiple pages match "${docPath}". Use the exact path:\n\n${list}` }],
          };
        }

        return {
          content: [{ type: "text" as const, text: `${result.title}\n${new URL(result.url).pathname}\n\n${result.content}` }],
        };
      }

      // Section filter mode
      if (section) {
        const result = getPageSections(stmts, docPath, section);
        if (!result) return notFound;

        if (result.type === "disambiguation") {
          const list = result.matches.map((m) => `${m.path} — ${m.title}`).join("\n");
          return {
            content: [{ type: "text" as const, text: `Multiple pages match "${docPath}". Use the exact path:\n\n${list}` }],
          };
        }

        if (result.sections.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No sections matching "${section}" found on this page. Use get_doc_page without section param to see available sections.` }],
          };
        }

        return {
          content: [{ type: "text" as const, text: formatSectionResult(result) }],
        };
      }

      // Outline mode (default)
      const outline = getPageOutline(stmts, docPath);
      if (!outline) return notFound;

      if (outline.type === "disambiguation") {
        const list = outline.matches.map((m) => `${m.path} — ${m.title}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `Multiple pages match "${docPath}". Use the exact path:\n\n${list}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: formatOutline(outline) }],
      };
    }
  );
}
