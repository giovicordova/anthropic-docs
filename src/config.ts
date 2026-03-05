import path from "node:path";
import os from "node:os";

export const STALE_DAYS = 3 / 24; // ~3 hours (fractional days)
export const FETCH_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_SECTION_SIZE = 6_000;
export const MIN_SECTION_SIZE = 50;

export const PLATFORM_DOCS_URL = "https://platform.claude.com/llms-full.txt";
export const CLAUDE_CODE_DOCS_URL = "https://code.claude.com/docs/llms-full.txt";

export const DB_DIR = path.join(os.homedir(), ".claude", "mcp-data", "anthropic-docs");

export const BLOG_SITEMAP_URL = "https://www.anthropic.com/sitemap.xml";
export const BLOG_CONCURRENCY = 10;
export const BLOG_STALE_DAYS = 8 / 24; // ~8 hours (fractional days)
export const BLOG_PATH_PREFIXES = ["/news/", "/research/", "/engineering/"];
export const MAX_BLOG_PAGES = 1000;

export const MIN_PAGE_RATIO = 0.5;
