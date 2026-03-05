---
phase: 04
slug: content-expansion
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | none (uses vitest defaults, config in package.json) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | CONT-01 | unit | `npx vitest run tests/blog-parser.test.ts -t "parseHtmlPage"` | No (Wave 0) | pending |
| 04-01-01 | 01 | 1 | CONT-01 | unit | `npx vitest run tests/crawl.test.ts -t "model"` | No (Wave 0) | pending |
| 04-01-02 | 01 | 1 | CONT-02 | unit | `npx vitest run tests/crawl.test.ts -t "research"` | No (Wave 0) | pending |
| 04-01-02 | 01 | 1 | CONT-02 | unit | `npx vitest run tests/database.test.ts -t "deleteOldGen"` | Partial | pending |
| 04-02-01 | 02 | 2 | CONT-01, CONT-02 | unit | `npx vitest run tests/crawl.test.ts -t "count"` | No (Wave 0) | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/blog-parser.test.ts` — add parseHtmlPage tests
- [ ] `tests/crawl.test.ts` — add modelSource and researchSource test stubs
- [ ] `tests/database.test.ts` — update deleteOldGen test for new source exclusions
- [ ] `tests/blog-parser.test.ts` — update parseSitemap tests for removed /research/ prefix

*Existing test infrastructure covers framework and fixtures.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Model page HTML extraction quality | CONT-01 | Depends on live HTML structure | Fetch model page, inspect markdown for nav/footer noise |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
