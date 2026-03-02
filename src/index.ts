import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDatabase,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
} from "./database.js";
import { crawlDocs } from "./crawler.js";

const server = new McpServer({
  name: "anthropic-docs",
  version: "1.0.0",
});

const db = initDatabase();

// Check if we need to crawl on startup
const STALE_DAYS = 7;

function checkAndCrawl() {
  const lastCrawl = getMetadata(db, "last_crawl_timestamp");

  if (!lastCrawl) {
    console.error("[server] No index found. Starting initial crawl...");
    crawlDocs(db).catch((err) =>
      console.error("[server] Crawl failed:", err.message)
    );
    return;
  }

  const age = Date.now() - new Date(lastCrawl).getTime();
  const staleDays = age / (1000 * 60 * 60 * 24);

  if (staleDays > STALE_DAYS) {
    console.error(
      `[server] Index is ${Math.round(staleDays)} days old. Refreshing in background...`
    );
    crawlDocs(db).catch((err) =>
      console.error("[server] Background crawl failed:", err.message)
    );
  } else {
    console.error(
      `[server] Index is ${Math.round(staleDays)} days old. Fresh enough.`
    );
  }
}

// --- Tool: search_anthropic_docs ---
server.registerTool(
  "search_anthropic_docs",
  {
    description:
      "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet.",
    inputSchema: {
      query: z.string().describe("Search query string"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (default 10)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = searchDocs(db, query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}". The index may still be building — try again in a minute, or use refresh_index to re-crawl.`,
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
            text: `Search error: ${(err as Error).message}. The query syntax may be invalid for FTS5 — try simpler terms.`,
          },
        ],
      };
    }
  }
);

// --- Tool: get_doc_page ---
server.registerTool(
  "get_doc_page",
  {
    description:
      "Fetch the full markdown content of a specific documentation page by its URL path. Supports both platform.claude.com and code.claude.com docs. Supports fuzzy matching.",
    inputSchema: {
      path: z
        .string()
        .describe(
          'URL path of the doc page, e.g., "/docs/en/build-with-claude/tool-use"'
        ),
    },
  },
  async ({ path: docPath }) => {
    const result = getDocPage(db, docPath);

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

// --- Tool: list_doc_sections ---
server.registerTool(
  "list_doc_sections",
  {
    description:
      "List all indexed documentation pages with their paths, grouped by source (Anthropic platform docs and Claude Code docs). Useful for discovering what documentation is available.",
    inputSchema: {},
  },
  async () => {
    const sections = listSections(db);

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No pages indexed yet. The index may still be building — try again in a minute, or use refresh_index.",
          },
        ],
      };
    }

    // Group by source first, then by category within source
    const platformPages = sections.filter((s) => s.source === "platform");
    const codePages = sections.filter((s) => s.source === "code");

    let output = `# Documentation Index\n\n${sections.length} pages indexed.\n\n`;

    if (platformPages.length > 0) {
      output += `## Anthropic API & Platform Docs\n\n`;
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

    if (codePages.length > 0) {
      output += `## Claude Code Docs\n\n`;
      for (const p of codePages) {
        output += `- [${p.title}](${p.path})\n`;
      }
      output += "\n";
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// --- Tool: refresh_index ---
server.registerTool(
  "refresh_index",
  {
    description:
      "Re-crawl and update the local documentation index for both Anthropic platform docs and Claude Code docs. Runs in the background — returns immediately.",
    inputSchema: {},
  },
  async () => {
    const lastCrawl = getMetadata(db, "last_crawl_timestamp");
    const pageCount = getMetadata(db, "page_count") || "unknown";

    // Start crawl in background (don't await)
    crawlDocs(db).catch((err) =>
      console.error("[server] Refresh crawl failed:", err.message)
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Refresh started. Previous index: ${pageCount} pages, last crawled ${lastCrawl || "never"}. Crawling in background — search results will update as pages are re-indexed.`,
        },
      ],
    };
  }
);

// --- Start server ---
async function main() {
  checkAndCrawl();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server running on stdio");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
