# anthropic-docs-mcp

MCP server that indexes Anthropic's documentation into a searchable SQLite database. Gives Claude Code instant access to platform docs, API reference, and Claude Code docs — no web fetching needed.

## Install

### Prerequisites

- Node.js 18+
- [Claude Code](https://claude.ai/code)

### 1. Clone and build

```bash
git clone https://github.com/giovicordova/anthropic-docs.git
cd anthropic-docs
npm install
npm run build
```

### 2. Add to Claude Code

Open your Claude Code MCP config:

```bash
code ~/.claude/.mcp.json
# or: nano ~/.claude/.mcp.json
```

Add the server (replace `/path/to/` with where you cloned the repo):

```json
{
  "mcpServers": {
    "anthropic-docs": {
      "command": "node",
      "args": ["/path/to/anthropic-docs/dist/index.js"]
    }
  }
}
```

### 3. Restart Claude Code

The server will automatically crawl and index all docs on first run. This takes about a minute. After that, the index refreshes daily in the background.

## Tools

| Tool | What it does |
|------|-------------|
| `search_anthropic_docs` | Full-text search across all docs with BM25 ranking |
| `get_doc_page` | Get the full markdown of a specific page by path |
| `list_doc_sections` | Browse all indexed pages grouped by source |
| `refresh_index` | Trigger a manual re-crawl if you need the latest |

## How it works

```
Claude Code <-> stdio <-> MCP Server <-> SQLite FTS5 Database
                              |
                         Background crawler
                              |
               platform.claude.com/sitemap.xml
               code.claude.com/docs/llms-full.txt
```

- **Platform docs** and **API reference** are crawled from `platform.claude.com` via its sitemap
- **Claude Code docs** come from `code.claude.com/docs/llms-full.txt`
- Pages are split into sections at h2/h3 headings for precise search results
- BM25 ranking weights title matches 10x and headings 5x over content
- The index auto-refreshes daily on startup; call `refresh_index` anytime for an immediate update
- Database lives at `~/.claude/mcp-data/anthropic-docs/docs.db`

## License

ISC
