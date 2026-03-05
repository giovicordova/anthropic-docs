import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDocPage } from "../database.js";
import type { Statements } from "../types.js";
import type { CrawlManager } from "../crawl.js";

export function registerGetPageTool(
  server: McpServer,
  stmts: Statements,
  crawl: CrawlManager
): void {
  server.registerTool(
    "get_doc_page",
    {
      description:
        "Fetch the full markdown content of a specific documentation page by its URL path. Supports fuzzy matching on the path suffix, so '/tool-use' will match '/docs/en/agents-and-tools/tool-use/overview'. Returns the complete page content concatenated from all sections.",
      inputSchema: {
        path: z
          .string()
          .describe('URL path of the doc page, e.g., "/docs/en/build-with-claude/tool-use"'),
      },
    },
    async ({ path: docPath }) => {
      const building = crawl.firstRunBuildingResponse();
      if (building) return building;

      const result = getDocPage(stmts, docPath);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Page not found: "${docPath}". Use search_anthropic_docs to find the correct path, or list_doc_sections to browse available pages.`,
            },
          ],
        };
      }

      if (result.type === "disambiguation") {
        const list = result.matches
          .map((m) => `- **${m.title}** — \`${m.path}\``)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Multiple pages match "${docPath}". Use the exact path:\n\n${list}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n${result.content}`,
          },
        ],
      };
    }
  );
}
