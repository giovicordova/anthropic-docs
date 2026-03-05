# Stack Research

**Domain:** MCP documentation server with background polling, SQLite FTS, comprehensive testing
**Researched:** 2026-03-05
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | ^5.9.3 | Language | Already in use. Strict mode enabled. No reason to change. |
| Node.js | 22.x LTS | Runtime | Current LTS. Native fetch, ES2022+, stable timers API. Project already targets this. |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP server framework | Official SDK, 30K+ dependents. v2 expected Q1 2026 but not shipped yet -- stay on v1.x. When v2 lands, v1 gets 6 months of maintenance. No action needed now. |
| `better-sqlite3` | ^12.6.2 | SQLite with FTS5 | Synchronous API is ideal for this use case (no async overhead for local DB). Fastest Node.js SQLite driver. WAL mode for concurrent reads during crawl writes. No alternative worth considering. |
| `zod` | ^4.3.6 | Input validation | Already on Zod 4. 14x faster parsing than v3. MCP SDK uses Zod for tool schemas. Keep. |
| `node-html-markdown` | ^2.0.0 | HTML-to-markdown | Does one job well. Alternative (Turndown) has more features but this project needs simple extraction only. Keep. |
| `vitest` | ^4.0.18 | Testing | Native ESM support, built-in mocking, fake timers. No config file needed for this project's simplicity. Jest would require ESM workarounds. |

### Supporting Libraries (New Additions)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` (fake timers) | built-in | Test polling intervals | Use `vi.useFakeTimers()` and `vi.advanceTimersByTime()` to test polling logic without real delays. No extra dependency. |
| `@modelcontextprotocol/inspector` | latest | MCP server debugging | Use during development to visually test tool calls and schemas. Dev-only, not a dependency. Run with `npx @modelcontextprotocol/inspector`. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `tsc` | Type checking and compilation | No bundler needed -- this is a CLI tool, not a browser app. Direct `tsc` to `dist/` is correct. |
| `vitest` | Test runner | `vitest run` for CI, `vitest --watch` for dev. Coverage via `vitest run --coverage`. |
| MCP Inspector | Manual testing | `npx @modelcontextprotocol/inspector` -- connects to stdio server, lets you call tools interactively. |

## No New Runtime Dependencies Needed

The current 4 runtime dependencies are correct and minimal. The evolution goals (simplify architecture, add polling, improve tests) are structural changes -- they do not require new libraries.

- **Background polling**: Use Node.js built-in `setInterval` with `.unref()` so the timer does not keep the process alive when stdin closes. No library needed.
- **Graceful shutdown**: Use Node.js built-in `process.on('SIGTERM')` and `process.on('SIGINT')`. No library needed.
- **Test mocking**: Use Vitest's built-in `vi.mock()`, `vi.fn()`, `vi.useFakeTimers()`. No library needed.
- **In-memory MCP testing**: Use `@modelcontextprotocol/sdk`'s `InMemoryTransport` or spawn subprocess for integration tests. No extra library.

## Installation

```bash
# No changes to runtime deps
npm install @modelcontextprotocol/sdk better-sqlite3 node-html-markdown zod

# No changes to dev deps
npm install -D @types/better-sqlite3 @types/node typescript vitest
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `better-sqlite3` (sync) | `sql.js` (WASM) | Only if you need to run in browser or avoid native compilation. Slower. Not relevant here. |
| `better-sqlite3` (sync) | `node:sqlite` (built-in) | Node.js 22.5+ includes experimental `node:sqlite`. Not stable yet, no FTS5 guarantees, API is less mature. Revisit when it leaves experimental. |
| `node-html-markdown` | `turndown` | If you need custom rules for complex HTML structures. This project extracts article content -- simple case. `node-html-markdown` is smaller and faster. |
| `vitest` | `jest` | Never for this project. Jest requires ESM transform workarounds. Vitest is native ESM, zero-config for TypeScript. |
| `setInterval` + `.unref()` | `cron` libraries (`node-cron`, `croner`) | If polling needs calendar-aware scheduling (e.g., "every day at 3am"). This project needs simple interval polling (every 1-2 hours). `setInterval` is simpler and dependency-free. |
| In-process testing | `execa` subprocess testing | For true end-to-end stdio integration tests. Start with in-process testing (faster, simpler). Add subprocess tests later if needed. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `node-cron` / `croner` | Overkill for simple interval polling. Adds dependency for no benefit. | `setInterval` with `.unref()` |
| `jest` | Requires `ts-jest` or `@swc/jest` for TypeScript, ESM transform config, slower. | `vitest` (already in use) |
| `node:sqlite` (built-in) | Experimental in Node 22. No guaranteed FTS5 support. API surface is thin. | `better-sqlite3` (already in use) |
| `@modelcontextprotocol/sdk` v2 | Not released yet (expected Q1 2026). Do not preemptively migrate. | Stay on ^1.27.1, migrate when v2 is stable |
| `tsx` / `ts-node` for runtime | Adds startup latency and complexity. Pre-compile with `tsc` is faster and more predictable for a server. | `tsc` build step, run `node dist/index.js` |
| Separate ORM (Drizzle, Prisma) | This project runs ~10 distinct SQL queries. An ORM adds abstraction over something that's already simple. Raw `better-sqlite3` with prepared statements is more performant and transparent. | Direct `better-sqlite3` with prepared statements |

## Stack Patterns for Evolution Goals

**For background polling (every 1-2 hours):**
- Use `setInterval(checkAndCrawl, POLL_INTERVAL_MS)` with the returned timer's `.unref()` called
- `.unref()` ensures the interval does not prevent Node.js from exiting when stdin/stdout close
- Store interval reference for cleanup in graceful shutdown handler
- Test with `vi.useFakeTimers()` and `vi.advanceTimersByTime(POLL_INTERVAL_MS)`

**For unified crawl pipeline:**
- No new dependencies. This is an architectural refactor -- extract a generic `CrawlSource` interface that both doc and blog sources implement
- Keep `better-sqlite3` synchronous transactions for atomic writes

**For comprehensive test coverage:**
- Use `vi.mock()` to mock `better-sqlite3` and `fetch` in unit tests
- Use real in-memory SQLite (`:memory:`) for integration tests of database.ts
- Use `vi.useFakeTimers()` to test staleness checks and polling intervals
- Use Vitest's `beforeEach`/`afterEach` for test isolation
- Test MCP tool handlers by instantiating `McpServer` with in-memory transport (no subprocess needed)

**For graceful shutdown:**
- `process.on('SIGTERM', cleanup)` and `process.on('SIGINT', cleanup)`
- Cleanup: clear polling interval, close SQLite database, exit cleanly
- No library needed

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@modelcontextprotocol/sdk` ^1.27.1 | `zod` ^4.x | SDK uses Zod for tool input schemas. Both already on compatible versions. |
| `better-sqlite3` ^12.6.2 | Node.js 22.x | Native addon compiles cleanly on Node 22. Tested and stable. |
| `vitest` ^4.0.18 | TypeScript ^5.9 | Vitest 4 natively supports TypeScript 5.x without additional config. |
| `zod` ^4.3.6 | `@modelcontextprotocol/sdk` ^1.27.1 | MCP SDK works with Zod 4. The SDK's `inputSchema` accepts Zod schemas directly. |

## Sources

- [npm: @modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- v1.27.1 confirmed current, v2 expected Q1 2026
- [GitHub: modelcontextprotocol/typescript-sdk releases](https://github.com/modelcontextprotocol/typescript-sdk/releases) -- release history verified
- [npm: better-sqlite3](https://www.npmjs.com/package/better-sqlite3) -- v12.6.2 confirmed current (Jan 2026)
- [npm: vitest](https://www.npmjs.com/package/vitest) -- v4.0.18 confirmed current
- [Vitest 4.0 announcement](https://vitest.dev/blog/vitest-4) -- fake timers, mocking capabilities verified
- [Zod v4 release notes](https://zod.dev/v4) -- migration from v3, performance improvements
- [Node.js Timers API](https://nodejs.org/api/timers.html) -- `.unref()` behavior for background intervals
- [MCP server testing guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/) -- in-memory transport and subprocess testing patterns
- [npm: node-html-markdown](https://www.npmjs.com/package/node-html-markdown) -- v2.0.0 confirmed current

---
*Stack research for: anthropic-docs-mcp evolution*
*Researched: 2026-03-05*
