# Technology Stack

**Analysis Date:** 2026-03-05

## Languages

**Primary:**
- TypeScript 5.9.3 - All source code (`src/*.ts`) and tests (`tests/*.test.ts`)

**Secondary:**
- SQL - Inline SQLite queries in `src/database.ts`

## Runtime

**Environment:**
- Node.js 22.x (v22.16.0 detected on dev machine)
- ES2022 target (configured in `tsconfig.json`)
- ESM modules (`"type": "module"` in `package.json`, `"module": "Node16"` in tsconfig)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- `@modelcontextprotocol/sdk` ^1.27.1 - MCP server framework (stdio transport). Provides `McpServer` and `StdioServerTransport` classes.

**Testing:**
- `vitest` ^4.0.18 - Test runner. No vitest config file; uses defaults. Run with `npm test` (`vitest run`).

**Build/Dev:**
- `tsc` (TypeScript compiler) - Compiles `src/` to `dist/`. No bundler.

## Key Dependencies

**Critical (4 runtime):**
- `@modelcontextprotocol/sdk` ^1.27.1 - MCP protocol server implementation. Entry point uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- `better-sqlite3` ^12.6.2 - Synchronous SQLite3 driver with native bindings. Used for all database operations in `src/database.ts`. WAL mode enabled.
- `node-html-markdown` ^2.0.0 - HTML-to-markdown converter. Used in `src/blog-parser.ts` to convert fetched blog HTML into indexable markdown.
- `zod` ^4.3.6 - Schema validation for MCP tool input parameters. Used in `src/index.ts` for `inputSchema` definitions on all 5 tools.

**Dev Dependencies (4):**
- `@types/better-sqlite3` ^7.6.13 - Type definitions for better-sqlite3
- `@types/node` ^25.3.3 - Node.js type definitions
- `typescript` ^5.9.3 - TypeScript compiler
- `vitest` ^4.0.18 - Test framework

## Configuration

**TypeScript (`tsconfig.json`):**
- `target`: ES2022
- `module`: Node16
- `moduleResolution`: Node16
- `strict`: true
- `declaration`: true
- `outDir`: `./dist`
- `rootDir`: `./src`

**Environment:**
- No `.env` files. No environment variables required.
- All configuration is hardcoded constants in `src/config.ts`:
  - `STALE_DAYS`: 1 (doc re-crawl threshold)
  - `BLOG_STALE_DAYS`: 7 (blog re-crawl threshold)
  - `FETCH_TIMEOUT_MS`: 30,000ms
  - `MAX_SECTION_SIZE`: 6,000 chars
  - `MIN_SECTION_SIZE`: 50 chars
  - `BLOG_CONCURRENCY`: 10 concurrent fetches
  - `DB_DIR`: `~/.claude/mcp-data/anthropic-docs/`

**Build:**
- `npm run build` runs `tsc`, outputs to `dist/`
- Entry point: `dist/index.js` (declared as `"main"` and `"bin"` in `package.json`)
- Published files: `dist/` only (`"files": ["dist"]`)

## Platform Requirements

**Development:**
- Node.js 22+ (uses native `fetch`, ES2022 features)
- npm for package management
- C++ toolchain for `better-sqlite3` native compilation

**Production:**
- Runs as a local stdio MCP server (not deployed to cloud)
- Database stored at `~/.claude/mcp-data/anthropic-docs/docs.db`
- No network ports opened; communicates via stdin/stdout JSON-RPC
- Requires internet access to fetch docs from `platform.claude.com`, `code.claude.com`, and `anthropic.com`

---

*Stack analysis: 2026-03-05*
