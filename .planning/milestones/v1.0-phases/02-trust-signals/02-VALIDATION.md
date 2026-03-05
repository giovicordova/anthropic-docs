---
phase: 2
slug: trust-signals
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 |
| **Config file** | none (vitest defaults, `vitest run` in package.json) |
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
| 02-01-01 | 01 | 1 | TRST-01 | unit | `npx vitest run tests/tools.test.ts -t "staleness metadata"` | No — W0 | pending |
| 02-01-02 | 01 | 1 | TRST-02 | unit | `npx vitest run tests/tools.test.ts -t "staleness warning"` | No — W0 | pending |
| 02-01-03 | 01 | 1 | TRST-03 | unit | `npx vitest run tests/tools.test.ts -t "failure info"` | No — W0 | pending |
| 02-02-01 | 02 | 1 | TRST-04 | unit | `npx vitest run tests/shutdown.test.ts` | No — W0 | pending |
| 02-02-02 | 02 | 1 | TRST-05 | unit | `npx vitest run tests/crawl.test.ts -t "page count threshold"` | No — W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/tools.test.ts` — add tests for TRST-01 (timestamp footer), TRST-02 (staleness warning), TRST-03 (failure display)
- [ ] `tests/crawl.test.ts` — add test for TRST-05 (page count threshold rejection)
- [ ] `tests/shutdown.test.ts` — new file for TRST-04 (signal handler wiring, db.close called)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SIGTERM clean exit in production | TRST-04 | Requires actual signal delivery to running process | Start server via `npm start`, send `kill -TERM <pid>`, verify no crash output and process exits cleanly |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
