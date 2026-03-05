import path from "node:path";
import os from "node:os";

export const STALE_DAYS = 1;
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_SECTION_SIZE = 6_000;
export const MIN_SECTION_SIZE = 50;

export const PLATFORM_DOCS_URL = "https://platform.claude.com/llms-full.txt";
export const CLAUDE_CODE_DOCS_URL = "https://code.claude.com/docs/llms-full.txt";

export const DB_DIR = path.join(os.homedir(), ".claude", "mcp-data", "anthropic-docs");
