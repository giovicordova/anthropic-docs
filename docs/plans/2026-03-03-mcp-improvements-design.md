# MCP Improvements Design

Date: 2026-03-03
Approach: A — Polish What We Have (complete coverage + search quality within SQLite FTS5)

## Current State

- 245 pages indexed (186 platform, 59 Claude Code)
- 1,653 sections in FTS5 search index
- 4 tools: search, get page, list sections, refresh index
- API reference pages (733) are skipped entirely
- 199 near-empty sections, 50 oversized sections (up to 78KB), 13 duplicates

## Design

### 1. Complete Coverage — Index API Reference Pages

API reference pages (e.g., `/docs/en/api/messages`) use `stldocs-*` classes instead of `<article id="content-container">`. Add a second content extractor:

- Target `<div class="stldocs-root">` (exclude the one that also has `stldocs-sidebar`)
- Parse `stldocs-method-summary`, `stldocs-property`, `stldocs-resource-content-group` into markdown
- Tag as `source: "api-reference"` for filtering

### 2. Data Quality — Clean Sections

- Filter out sections with <50 chars content (noise from empty headers)
- Split sections >6KB at sub-headings (h3/h4) for tighter search chunks
- Deduplicate by `(path, section_heading, content_hash)` before inserting

### 3. Search Quality — Source Filter + Query Preprocessing

- Add `source` filter parameter to `search_anthropic_docs`: `"platform"`, `"code"`, `"api-reference"`, or `"all"` (default)
- Preprocess FTS5 queries: escape special chars, handle phrases
- Tighten snippet window from 40 to 25 tokens

### 4. Better Tool Descriptions

Expand all tool descriptions to 3-4+ sentences per Anthropic's own best practices. Explain what each tool does, when to use it, what it returns, and edge cases.

## Out of Scope

- Semantic/vector search
- RAG/answer synthesis
- MCP resources
- Multi-language support
