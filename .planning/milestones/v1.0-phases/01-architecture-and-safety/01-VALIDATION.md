---
phase: 1
slug: architecture-and-safety
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | none — vitest auto-detects from package.json |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run && npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 0 | TEST-01 | unit | `npx vitest run tests/crawl.test.ts` | No — W0 | pending |
| 1-01-02 | 01 | 0 | TEST-02 | unit | `npx vitest run tests/network.test.ts` | No — W0 | pending |
| 1-01-03 | 01 | 0 | TEST-03 | unit | `npx vitest run tests/database.test.ts` | No — W0 | pending |
| 1-01-04 | 01 | 0 | TEST-01 | unit | `npx vitest run tests/tools.test.ts` | No — W0 | pending |
| 1-02-01 | 02 | 1 | ARCH-01 | snapshot | `npx vitest run tests/tools.test.ts` | No — W0 | pending |
| 1-02-02 | 02 | 1 | ARCH-02, ARCH-03 | unit | `npx vitest run tests/crawl.test.ts` | No — W0 | pending |
| 1-02-03 | 02 | 1 | ARCH-04 | lint | `wc -l src/index.ts` | Yes | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/crawl.test.ts` — stubs for TEST-01a, TEST-01b (crawl state transitions, staleness)
- [ ] `tests/tools.test.ts` — stubs for TEST-01c (tool response formatting)
- [ ] `tests/network.test.ts` — stubs for TEST-02a, TEST-02b, TEST-02c (fetch error handling)
- [ ] `tests/database.test.ts` — stubs for TEST-03 (blog-exclusion orphan cleanup)
- [ ] `vitest.config.ts` — configure test file patterns if needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP tools return identical results before/after refactor | ARCH-01-04 | Requires running server against live DB | 1. Build before refactor, run 5 tool calls, save output. 2. Build after, run same calls, diff output. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
