---
phase: 3
slug: freshness
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 |
| **Config file** | implied via package.json `"test": "vitest run"` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 0 | FRSH-01 | unit | `npx vitest run tests/fetch.test.ts -x` | No - Wave 0 | ⬜ pending |
| 03-01-02 | 01 | 0 | FRSH-03 | unit | `npx vitest run tests/blog-parser.test.ts -x` | No - extend | ⬜ pending |
| 03-01-03 | 01 | 0 | FRSH-01 | unit | `npx vitest run tests/crawl.test.ts -x` | No - extend | ⬜ pending |
| 03-01-04 | 01 | 0 | FRSH-03 | unit | `npx vitest run tests/database.test.ts -x` | No - extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/fetch.test.ts` — new file for conditionalFetch tests (mock fetch to return 304/200)
- [ ] Extend `tests/blog-parser.test.ts` — add parseSitemapWithLastmod tests
- [ ] Extend `tests/crawl.test.ts` — add conditional crawl skip, blog diff categorization tests
- [ ] Extend `tests/database.test.ts` — add deleteBlogPages, getIndexedBlogUrlsWithTimestamps tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Poll timer fires on schedule | FRSH-02 | Requires real time passage | Start server, wait >interval, check stderr for poll log |
| Process exits cleanly with .unref() | FRSH-02 | Requires real process lifecycle | Start server, send SIGTERM, verify exit without hang |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
