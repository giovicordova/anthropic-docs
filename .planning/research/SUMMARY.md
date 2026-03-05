# Project Research Summary

**Project:** anthropic-docs-mcp evolution
**Domain:** MCP documentation indexing server (stdio, SQLite FTS5, background crawling)
**Researched:** 2026-03-05
**Confidence:** HIGH

## Executive Summary

This project is a working MCP server that indexes Anthropic documentation into a local SQLite FTS5 database. The core functionality -- search, page retrieval, section-level granularity, source filtering -- is solid and already competitive with vendor-specific doc MCP servers from Google, AWS, and Microsoft. The evolution goal is not to add features from scratch but to restructure the codebase for maintainability, improve freshness and reliability, and expand content coverage. The existing stack (TypeScript, better-sqlite3, MCP SDK v1, Vitest) is correct and requires zero new runtime dependencies.

The recommended approach is a structural refactor first, features second. The current `index.ts` is a 480-line monolith containing tool handlers, crawl logic, and state management. Research shows this should decompose into: a thin entry point, extracted tool handlers (testable without MCP server), a unified crawl orchestrator with a `ContentSource` interface, and source adapters wrapping existing parsers. This architecture directly enables the feature goals -- background polling, content change detection, new content sources -- without touching the well-structured database layer.

The primary risks are data integrity during the crawl pipeline refactor. Three pitfalls are critical: FTS5 external content table desync (silent search corruption), blog row deletion during generation swap refactoring (a bug that already happened once), and partial crawl failures treated as success (which can wipe 90% of the index). All three are preventable with specific tests and threshold checks that should be written before the refactoring begins.

## Key Findings

### Recommended Stack

The current 4 runtime dependencies are correct and minimal. No new libraries are needed. The evolution goals (architecture cleanup, polling, testing) are structural changes that use Node.js built-ins (`setInterval` with `.unref()`, `process.on('SIGTERM')`) and Vitest's built-in mocking (`vi.useFakeTimers()`, `vi.mock()`).

**Core technologies (no changes):**
- **TypeScript 5.9 + Node.js 22 LTS**: Already in use, strict mode, native fetch
- **better-sqlite3 12.x**: Synchronous API ideal for local DB, WAL mode for concurrent reads. `node:sqlite` is still experimental -- do not switch
- **@modelcontextprotocol/sdk 1.27.x**: Stay on v1. v2 expected but not shipped. No preemptive migration
- **Vitest 4.x**: Native ESM, built-in fake timers and mocking. Jest would require workarounds
- **zod 4.x**: Already integrated with MCP SDK for tool schemas. 14x faster than v3

**What NOT to add:** node-cron (overkill for interval polling), ORMs (10 SQL queries don't need abstraction), vector/embedding libraries (FTS5 is sufficient for ~1000 pages), HTTP transport (stdio-only is correct for local tool)

### Expected Features

**Must have (table stakes -- missing or partial):**
- Freshness metadata in search results (MISSING -- users need to know index age)
- Stale data warnings when index exceeds threshold (MISSING -- silent staleness erodes trust)
- Better error surfacing for crawl failures (PARTIAL -- tracks "failed" but no reason/timestamp)
- Content change detection via ETag/hash (MISSING -- prerequisite for frequent polling)
- Increased polling frequency to 1-2 hours (PARTIAL -- currently daily/weekly)

**Should have (differentiators):**
- Blog update/deletion detection (currently only detects new URLs)
- Model/product page indexing (/claude/opus, /claude/sonnet)
- Richer `index_status` output (crawl history, errors, next scheduled crawl)
- Graceful shutdown handler (SIGTERM/SIGINT cleanup)

**Defer:**
- Research paper indexing -- high complexity (PDF parsing), unclear ROI
- Semantic/vector search -- FTS5 is sufficient for current corpus size
- Polling frequency configuration -- hardcode a good default first

### Architecture Approach

Decompose the monolithic `index.ts` into five component groups: thin entry point (wiring only), tool handlers (`tools/`), crawl orchestrator (`crawl.ts`), source adapters (`sources/`), and the existing database/types/config leaf modules (unchanged). The key pattern is a `ContentSource` interface that both doc and blog sources implement, with the orchestrator owning crawl lifecycle, state management, and database writes. Source adapters are pure fetch+parse -- they return `ParsedPage[]` and never touch the database.

**Major components:**
1. **Entry point** (`index.ts`) -- 40 lines of wiring: init DB, register tools, connect transport
2. **Tool handlers** (`tools/`) -- isolated, testable functions receiving dependencies via factory pattern
3. **Crawl orchestrator** (`crawl.ts`) -- state machine for all sources, scheduling, sequencing, generation management
4. **Source adapters** (`sources/`) -- one per content source, uniform interface, extensible for new sources
5. **Database layer** (`database.ts`) -- unchanged, already well-structured

### Critical Pitfalls

1. **FTS5 external content desync** -- Silent search corruption if rows are deleted from `pages` without rebuilding FTS. Prevention: keep delete+rebuild in single transaction, add `integrity-check` test assertion after any crawl pipeline change.
2. **Blog row deletion during generation swap** -- Already happened once. The `source != 'blog'` guard in SQL is invisible to the type system. Prevention: write a dedicated test (insert blog rows, run finalizeGeneration, assert blog rows survive) before refactoring.
3. **Partial crawl failure treated as success** -- If one doc source fails, the other succeeds, and generation swap wipes 90% of content. Prevention: add minimum page count threshold; abort swap if count drops below 50% of previous.
4. **stdout corruption** -- Any `console.log` or stdout-writing library kills the stdio transport silently. Prevention: add a startup guard that patches `console.log` to throw.
5. **Generation swap race under frequent polling** -- FTS rebuild blocks event loop, causing tool handler timeouts. Prevention: use incremental FTS operations instead of full rebuild, or gate crawls on handler activity.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Architecture Refactor

**Rationale:** Every subsequent feature (polling, change detection, new sources) depends on clean component boundaries. The monolithic index.ts blocks testability and extensibility. This phase has no user-visible changes but unlocks everything else.
**Delivers:** Decomposed codebase with `ContentSource` interface, extracted tool handlers, crawl orchestrator, thin entry point. Comprehensive test suite for each component.
**Addresses:** Testability gap, code maintainability
**Avoids:** FTS5 desync (Pitfall 1), blog row deletion (Pitfall 4), stdout corruption (Pitfall 2) -- by adding safety tests and guards during the refactor
**Build order:** ContentSource interface -> source adapters (thin wrappers around existing parsers) -> crawl orchestrator -> tool handler extraction -> thin entry point

### Phase 2: Crawl Reliability and Trust Signals

**Rationale:** Before increasing crawl frequency, the pipeline must handle failures gracefully. Users need to trust the index. This phase builds on the orchestrator from Phase 1.
**Delivers:** Freshness metadata in results, stale data warnings, better error surfacing in `index_status`, partial crawl failure protection (page count threshold), graceful shutdown handler
**Addresses:** Freshness metadata (MISSING), stale warnings (MISSING), error surfacing (PARTIAL), graceful shutdown (MISSING)
**Avoids:** Partial crawl failure (Pitfall 8), timer leaks (Pitfall 6)

### Phase 3: Freshness -- Change Detection and Frequent Polling

**Rationale:** Depends on Phase 2's failure handling. Without change detection, frequent polling wastes resources re-parsing identical content. Without failure protection, frequent polling increases the window for data loss.
**Delivers:** ETag/Last-Modified/hash-based change detection for docs, polling frequency increase to 1-2 hours, WAL checkpoint after finalization, blog update/deletion detection
**Addresses:** Content change detection (MISSING), polling frequency (PARTIAL), blog update detection (MISSING)
**Avoids:** Generation swap race (Pitfall 3), WAL growth (Pitfall 5)

### Phase 4: Content Expansion

**Rationale:** New content sources plug into the `ContentSource` interface from Phase 1 without touching existing code. Model/product pages use the same HTML-to-markdown pipeline as blog.
**Delivers:** Model/product page indexing (/claude/opus, /claude/sonnet), potentially research page indexing
**Addresses:** Model page indexing (MISSING from features), research indexing (stretch goal)
**Avoids:** Selector drift (Pitfall 7) -- add content quality checks for new HTML sources

### Phase Ordering Rationale

- **Phase 1 first** because the monolith blocks testing, and Phases 2-4 all need the orchestrator and source adapter pattern
- **Phase 2 before Phase 3** because increasing crawl frequency without failure protection amplifies every data integrity pitfall
- **Phase 3 before Phase 4** because new content sources need the polling infrastructure to stay fresh
- **Phase 4 last** because it is additive (new sources) rather than structural, and the interface from Phase 1 makes it low-risk

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Change Detection):** HTTP caching behavior of llms-full.txt endpoints is unknown. Need to verify whether platform.claude.com and code.claude.com return ETag or Last-Modified headers. If not, fall back to content hashing.
- **Phase 4 (Content Expansion):** Model/product page HTML structure needs investigation. Blog parser pattern may not apply directly. Research paper indexing (if attempted) requires PDF parsing -- entirely new dependency and content structure.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Architecture Refactor):** Well-documented patterns. The architecture research already provides the exact interfaces, file structure, and build order.
- **Phase 2 (Reliability):** Standard error handling, HTTP headers, SIGTERM handling. No unknowns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Existing stack is verified correct. No changes needed. Sources include npm registry, official docs, and release notes. |
| Features | HIGH | Competitive analysis against 5 comparable tools. Clear separation of table stakes vs differentiators. |
| Architecture | HIGH | Patterns derived from MCP SDK docs, community guides, and analysis of existing codebase structure. Build order is dependency-validated. |
| Pitfalls | HIGH | Pitfalls reference specific code (line-level), documented SQLite behaviors, and one bug that already occurred in this codebase. |

**Overall confidence:** HIGH

### Gaps to Address

- **ETag/Last-Modified support on Anthropic endpoints:** Unknown whether llms-full.txt URLs return caching headers. Must test during Phase 3 planning. Fallback: SHA-256 hash of response body.
- **Model/product page HTML structure:** Not yet analyzed. Need to inspect /claude/opus page structure before Phase 4 implementation.
- **MCP SDK v2 migration path:** v2 expected but not shipped. No action needed now, but Phase 1's architecture should not create patterns that conflict with known v2 changes.
- **FTS rebuild duration at scale:** Current rebuild is ~500ms for 1000 pages. If content expansion pushes past 5000 pages, incremental FTS operations become necessary. Monitor during Phase 4.

## Sources

### Primary (HIGH confidence)
- [npm: @modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- version, compatibility
- [SQLite FTS5 documentation](https://sqlite.org/fts5.html) -- external content sync, integrity checks
- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture) -- server structure patterns
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) -- WAL, checkpoints
- [MCP Transports specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) -- stdio constraints

### Secondary (MEDIUM confidence)
- [Google Developer Knowledge API](https://developers.googleblog.com/introducing-the-developer-knowledge-api-and-mcp-server/) -- competitive analysis
- [Microsoft Learn MCP Server](https://github.com/MicrosoftDocs/mcp) -- competitive analysis
- [Context7 MCP Server](https://github.com/upstash/context7) -- competitive analysis
- [MCP server testing guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/) -- test patterns

### Tertiary (LOW confidence)
- MCP SDK v2 timeline (Q1 2026 expected, not confirmed) -- monitor but do not act on

---
*Research completed: 2026-03-05*
*Ready for roadmap: yes*
