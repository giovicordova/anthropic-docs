#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDatabase,
  prepareStatements,
  cleanupOrphanedGenerations,
  getCurrentGeneration,
  insertPageSections,
  finalizeGeneration,
  searchDocs,
  getDocPage,
  listSections,
  getMetadata,
  setMetadata,
} from "./database.js";
import { fetchAndParse, pagesToSections } from "./parser.js";
import { STALE_DAYS } from "./config.js";

const server = new McpServer({
  name: "anthropic-docs",
  version: "2.0.0",
});

const db = initDatabase();
const stmts = prepareStatements(db);

const orphansRemoved = cleanupOrphanedGenerations(db, stmts);
if (orphansRemoved > 0) {
  console.error(`[server] Cleaned up ${orphansRemoved} orphaned rows from failed crawl.`);
}

// --- Crawl state management ---
type CrawlState = "idle" | "crawling" | "failed";
let crawlState: CrawlState = "idle";

async function startCrawl(): Promise<number> {
  if (crawlState === "crawling") {
    console.error("[server] Crawl already in progress, skipping.");
    return -1;
  }
  crawlState = "crawling";
  try {
    const currentGen = getCurrentGeneration(stmts);
    const newGen = currentGen + 1;

    console.error(`[server] Starting crawl (generation ${newGen})...`);
    const pages = await fetchAndParse();

    let totalSections = 0;
    for (const page of pages) {
      const sections = pagesToSections(page);
      insertPageSections(db, stmts, sections, newGen);
      totalSections += sections.length;
    }

    finalizeGeneration(db, stmts, newGen);
    setMetadata(stmts, "last_crawl_timestamp", new Date().toISOString());
    setMetadata(stmts, "page_count", String(pages.length));

    console.error(`[server] Done. ${pages.length} pages, ${totalSections} sections indexed.`);
    crawlState = "idle";
    return pages.length;
  } catch (err) {
    crawlState = "failed";
    throw err;
  }
}

function firstRunBuildingResponse(): { content: { type: "text"; text: string }[]; isError?: boolean } | null {
  if (!getMetadata(stmts, "last_crawl_timestamp") && crawlState === "crawling") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Index is being built for the first time (~10s). Try again shortly.",
        },
      ],
      isError: true,
    };
  }
  return null;
}

function checkAndCrawl() {
  const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");

  if (!lastCrawl) {
    console.error("[server] No index found. Starting initial crawl...");
    startCrawl().catch((err) =>
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
    startCrawl().catch((err) =>
      console.error("[server] Background crawl failed:", err.message)
    );
  } else {
    console.error(
      `[server] Index is ${staleDays.toFixed(1)} days old. Fresh enough.`
    );
  }
}

// --- Tool: search_anthropic_docs ---
server.registerTool(
  "search_anthropic_docs",
  {
    description:
      "Full-text search across all indexed Anthropic documentation (API/platform docs and Claude Code docs). Returns ranked results with page title, URL, section heading, and content snippet. Use this tool when you need to find documentation about a specific topic, API endpoint, SDK method, or concept. Results are ranked by relevance using BM25 with title matches weighted highest. For broad queries, increase the limit; for precise lookups, use get_doc_page instead.",
    inputSchema: {
      query: z.string().describe("Search query string. Use specific terms for best results."),
      source: z
        .enum(["all", "platform", "code", "api-reference"])
        .default("all")
        .describe("Filter by source: 'platform', 'code', 'api-reference', or 'all' (default)."),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results (default 10)"),
    },
  },
  async ({ query, source, limit }) => {
    const building = firstRunBuildingResponse();
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

// --- Tool: get_doc_page ---
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
    const building = firstRunBuildingResponse();
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

// --- Tool: list_doc_sections ---
server.registerTool(
  "list_doc_sections",
  {
    description:
      "List all indexed documentation pages with their paths, grouped by source. Use this to discover what documentation is available or find the correct path for get_doc_page.",
    inputSchema: {
      source: z
        .enum(["all", "platform", "code", "api-reference"])
        .default("all")
        .describe("Filter by source: 'platform', 'code', 'api-reference', or 'all' (default)."),
    },
  },
  async ({ source }) => {
    const building = firstRunBuildingResponse();
    if (building) return building;

    const sections = listSections(stmts, source);

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
      "Re-fetch and update the local documentation index. Runs in the background — returns immediately. Use this if search results seem stale. The index auto-refreshes daily on startup.",
    inputSchema: {},
  },
  async () => {
    if (crawlState === "crawling") {
      return {
        content: [
          {
            type: "text" as const,
            text: "A crawl is already in progress. Please wait for it to complete.",
          },
        ],
      };
    }

    const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
    const pageCount = getMetadata(stmts, "page_count") || "unknown";

    startCrawl().catch((err) =>
      console.error("[server] Refresh crawl failed:", err.message)
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Refresh started. Previous index: ${pageCount} pages, last crawled ${lastCrawl || "never"}.`,
        },
      ],
    };
  }
);

// --- Tool: index_status ---
server.registerTool(
  "index_status",
  {
    description:
      "Check the current status of the documentation index: page count, last crawl time, index age, and crawl state. Lightweight — does not trigger a crawl.",
    inputSchema: {},
  },
  async () => {
    const lastCrawl = getMetadata(stmts, "last_crawl_timestamp");
    const pageCount = getMetadata(stmts, "page_count") || "0";

    let ageDays = "unknown";
    if (lastCrawl) {
      const age = Date.now() - new Date(lastCrawl).getTime();
      ageDays = (age / (1000 * 60 * 60 * 24)).toFixed(1);
    }

    const status = [
      `**Index Status**`,
      `- Pages indexed: ${pageCount}`,
      `- Last crawl: ${lastCrawl || "never"}`,
      `- Age: ${ageDays} days`,
      `- Crawl state: ${crawlState}`,
      `- Stale threshold: ${STALE_DAYS} day(s)`,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: status }],
    };
  }
);

// --- Start server ---
async function main() {
  checkAndCrawl();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Anthropic Docs MCP server v2 running on stdio");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
