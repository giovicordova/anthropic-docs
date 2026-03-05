# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-05
**Phases:** 5 | **Plans:** 9 | **Sessions:** ~5

### What Was Built
- Modular architecture: 480-line monolith decomposed into ContentSource interface, CrawlManager, tool handlers
- Trust layer: per-source freshness timestamps, stale warnings, crawl failure reporting, graceful shutdown
- Freshness engine: 2h background polling, conditional fetch (ETag/hash), full blog lifecycle (new/updated/deleted)
- Content expansion: 4 indexed sources (platform docs, blog, model pages, research papers)
- Test suite: 0 to 124 tests covering crawl state, network errors, tool responses

### What Worked
- Tests-first approach: writing safety tests before the architecture refactor caught regressions early
- ContentSource interface: made adding model and research sources trivial (Phase 4 was fast)
- Sequential phase dependencies: each phase built cleanly on the previous one
- Yolo mode: no unnecessary confirmation pauses — plans executed in ~4 min average

### What Was Inefficient
- Nyquist validation was partial across all phases (draft status, not fully compliant) — didn't block shipping but validation quality could improve
- Phase 5 was a gap-closure phase that could have been avoided by catching tool-layer integration during Phase 4 planning

### Patterns Established
- ContentSource interface for all crawl sources (fetch → parse → insert pipeline)
- buildMetadataFooter / buildStatusText as pure functions for testable tool output
- Per-source staleness tracking with independent thresholds
- Generation-based atomic swap for doc sources, persist-across-crawl for non-doc sources

### Key Lessons
1. Plan tool-layer integration alongside content expansion — adding sources means updating search filters, metadata, and listing tools
2. Fractional constants (STALE_DAYS=3/24) avoid cascading renames when switching time units
3. Small plans (~2 tasks each) execute faster and have lower error rates than large plans

### Cost Observations
- Model mix: primarily Opus for planning/execution, Sonnet for verification
- Sessions: ~5 total
- Notable: 9 plans in ~35 min total execution time (~4 min/plan average)

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | ~5 | 5 | Initial milestone — established ContentSource pattern |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 124 | High (crawl, tools, network) | 1 (node:crypto) |

### Top Lessons (Verified Across Milestones)

1. Tests-first before refactors catches regressions that would otherwise compound
2. Small plans (~2 tasks) execute faster than large plans
