# Roadmap: Anthropic Docs MCP

## Overview

Evolve the working MCP server from a functional monolith into a maintainable, trustworthy, always-fresh documentation index. The path is: decompose the codebase and add safety tests, then surface trust signals and protect against crawl failures, then enable frequent polling with change detection, and finally expand to new content sources. Each phase builds on the previous -- the architecture unlocks testability, tests unlock reliability, reliability unlocks frequent polling, and the ContentSource interface unlocks new sources.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Architecture and Safety** - Decompose index.ts monolith, unify crawl pipeline, add safety tests
- [ ] **Phase 2: Trust Signals** - Surface freshness metadata, stale warnings, failure details, graceful shutdown
- [ ] **Phase 3: Freshness** - Content change detection, frequent polling, blog update/deletion detection
- [ ] **Phase 4: Content Expansion** - Index model/product pages and research papers

## Phase Details

### Phase 1: Architecture and Safety
**Goal**: Codebase is decomposed into testable components with a unified crawl pipeline and comprehensive safety tests protecting against known data integrity pitfalls
**Depends on**: Nothing (first phase)
**Requirements**: ARCH-01, ARCH-02, ARCH-03, ARCH-04, TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. index.ts is under 50 lines of wiring -- tool handlers, crawl orchestration, and state management live in separate modules
  2. A single ContentSource interface is used by both doc and blog crawl paths -- no duplicated crawl logic
  3. All 5 MCP tools return identical results before and after the refactor (no behavior change)
  4. Test suite covers tool handler state transitions, network error handling, and blog-exclusion during orphan cleanup
  5. npm test passes with no failures
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md -- Write safety tests before refactor (TEST-01, TEST-02, TEST-03)
- [x] 01-02-PLAN.md -- Decompose index.ts into modules (ARCH-01, ARCH-02, ARCH-03, ARCH-04)

### Phase 2: Trust Signals
**Goal**: Users can see how fresh the index is, get warned about stale data, and the server handles failures and shutdowns gracefully
**Depends on**: Phase 1
**Requirements**: TRST-01, TRST-02, TRST-03, TRST-04, TRST-05
**Success Criteria** (what must be TRUE):
  1. Search results include a last-crawl timestamp for each source that contributed results
  2. Search results include a warning when any contributing source exceeds its staleness threshold
  3. index_status tool shows the reason and timestamp of the last crawl failure (if any)
  4. Sending SIGTERM to the server process results in clean timer teardown and DB close (no crash, no leaked handles)
  5. A crawl that returns fewer pages than 50% of the previous crawl is rejected (index preserved)
**Plans**: 2 plans

Plans:
- [ ] 02-01-PLAN.md -- Foundation: types, error tracking, page count threshold, graceful shutdown (TRST-03, TRST-04, TRST-05)
- [ ] 02-02-PLAN.md -- Surface trust metadata in search and status tools (TRST-01, TRST-02, TRST-03)

### Phase 3: Freshness
**Goal**: Index stays current within hours instead of days, without wasting resources re-parsing unchanged content
**Depends on**: Phase 2
**Requirements**: FRSH-01, FRSH-02, FRSH-03
**Success Criteria** (what must be TRUE):
  1. Unchanged content is skipped during re-crawl (verified via ETag, Last-Modified, or content hash)
  2. Background polling triggers automatically every 1-2 hours without blocking tool responses
  3. Blog posts that are updated or deleted on anthropic.com are detected and updated/removed from the index
**Plans**: TBD

Plans:
- [ ] 03-01: TBD

### Phase 4: Content Expansion
**Goal**: Claude Code can search model/product information and research papers alongside existing docs and blog
**Depends on**: Phase 1
**Requirements**: CONT-01, CONT-02
**Success Criteria** (what must be TRUE):
  1. Searching for "claude opus" or "claude sonnet" returns indexed model/product page content (not just blog mentions)
  2. Research papers from anthropic.com/research are indexed and searchable
  3. New content sources appear correctly in source-filtered searches and index_status output
**Plans**: TBD

Plans:
- [ ] 04-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Architecture and Safety | 2/2 | Complete | 2026-03-05 |
| 2. Trust Signals | 0/2 | Not started | - |
| 3. Freshness | 0/? | Not started | - |
| 4. Content Expansion | 0/? | Not started | - |
