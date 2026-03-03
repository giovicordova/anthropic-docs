# anthropic-docs-mcp

A local MCP server that indexes Anthropic's documentation into a searchable SQLite database. Gives Claude Code instant access to platform docs, API reference, and Claude Code docs — no web fetching needed.

## What It Does

Crawls three documentation sources, splits pages into sections, and stores them in a SQLite FTS5 full-text search index. Exposes four tools over the Model Context Protocol:

| Tool | Purpose |
|------|---------|
| `search_anthropic_docs` | Full-text search with BM25 ranking across all indexed docs |
| `get_doc_page` | Fetch the full markdown content of a specific page by path |
| `list_doc_sections` | Browse all indexed pages grouped by source and category |
| `refresh_index` | Trigger a background re-crawl of all documentation sources |

## Setup

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/giovicordova/anthropic-docs.git
cd anthropic-docs-mcp
npm install
npm run build
```

### Configure Claude Code

Add to your `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "anthropic-docs": {
      "command": "node",
      "args": ["/absolute/path/to/anthropic-docs-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Code. The server will automatically crawl and index docs on first run.

## How It Works

```
Claude Code ↔ stdio ↔ MCP Server ↔ SQLite FTS5 Database
                           ↑
                      Background crawler
                           ↑
            platform.claude.com/sitemap.xml
            code.claude.com/docs/llms-full.txt
```

- **Platform docs** are extracted from `platform.claude.com` via sitemap
- **API reference** pages are detected and extracted from the same sitemap
- **Claude Code docs** come from `code.claude.com/docs/llms-full.txt`

Pages are split into sections at h2/h3 headings for fine-grained search results. The database auto-refreshes when older than 7 days.

## Search Features

- **Weighted BM25 ranking** — title matches score 10x, section headings 5x, content 1x
- **Source filtering** — search across all docs or limit to `platform`, `code`, or `api-reference`
- **Fuzzy path matching** — `get_doc_page` finds pages by suffix when exact path doesn't match
- **Context snippets** — search results include 25-token snippets around the match

## License

ISC
