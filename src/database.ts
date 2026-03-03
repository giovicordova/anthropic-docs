import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface PageSection {
  url: string;
  path: string;
  title: string;
  sectionHeading: string | null;
  sectionAnchor: string | null;
  content: string;
  sectionOrder: number;
  source: "platform" | "code" | "api-reference";
}

export interface SearchResult {
  title: string;
  url: string;
  sectionHeading: string | null;
  snippet: string;
  relevanceScore: number;
}

const DB_DIR = path.join(os.homedir(), ".claude", "mcp-data", "anthropic-docs");
const DB_PATH = path.join(DB_DIR, "docs.db");

export function initDatabase(): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      section_heading TEXT,
      section_anchor TEXT,
      content TEXT NOT NULL,
      section_order INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'platform',
      crawled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: add source column if missing (for existing DBs)
  const hasSource = db
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('pages') WHERE name='source'")
    .get() as { cnt: number };

  if (hasSource.cnt === 0) {
    db.exec("ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'");
  }

  // FTS5 virtual table — check if it exists first
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pages_fts'"
    )
    .get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title,
        section_heading,
        content,
        content='pages',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);
  }

  return db;
}

export function insertPage(db: Database.Database, page: PageSection): void {
  const stmt = db.prepare(`
    INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, source, crawled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    page.url,
    page.path,
    page.title,
    page.sectionHeading,
    page.sectionAnchor,
    page.content,
    page.sectionOrder,
    page.source,
    new Date().toISOString()
  );

  // Insert into FTS index
  db.prepare(`
    INSERT INTO pages_fts (rowid, title, section_heading, content)
    VALUES (?, ?, ?, ?)
  `).run(
    result.lastInsertRowid,
    page.title,
    page.sectionHeading || "",
    page.content
  );
}

export function clearPages(db: Database.Database): void {
  db.exec("DELETE FROM pages");
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
}

function preprocessQuery(query: string): string {
  // Remove characters that break FTS5 syntax
  let cleaned = query
    .replace(/[*"():^~{}[\]]/g, " ")  // Remove FTS5 special chars
    .replace(/\s+/g, " ")              // Collapse whitespace
    .trim();

  if (cleaned.length === 0) return '""';

  // Split into terms, filter empties
  const terms = cleaned.split(" ").filter((t) => t.length > 0);

  // If multiple terms, wrap each in quotes to avoid FTS5 operator conflicts
  // (words like "OR", "AND", "NOT" are FTS5 operators)
  if (terms.length > 1) {
    return terms.map((t) => `"${t}"`).join(" ");
  }

  return terms[0];
}

export function searchDocs(
  db: Database.Database,
  query: string,
  limit: number = 10,
  source?: string
): SearchResult[] {
  const ftsQuery = preprocessQuery(query);

  const sourceFilter = source && source !== "all"
    ? "AND p.source = ?"
    : "";

  const stmt = db.prepare(`
    SELECT
      p.title,
      p.url,
      p.section_heading,
      p.source,
      snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
      bm25(pages_fts, 10.0, 5.0, 1.0) as rank
    FROM pages_fts
    JOIN pages p ON p.id = pages_fts.rowid
    WHERE pages_fts MATCH ?
    ${sourceFilter}
    ORDER BY rank
    LIMIT ?
  `);

  const params: any[] = [ftsQuery];
  if (source && source !== "all") params.push(source);
  params.push(limit);

  return stmt.all(...params).map((row: any) => ({
    title: row.title,
    url: row.url,
    sectionHeading: row.section_heading,
    snippet: row.snippet,
    relevanceScore: Math.abs(row.rank),
  }));
}

export function getDocPage(
  db: Database.Database,
  searchPath: string
): { title: string; url: string; content: string } | null {
  // Try exact match first
  let rows = db
    .prepare(
      "SELECT title, url, content FROM pages WHERE path = ? ORDER BY section_order"
    )
    .all(searchPath) as any[];

  // Fuzzy: try matching the end of the path
  if (rows.length === 0) {
    rows = db
      .prepare(
        "SELECT title, url, content FROM pages WHERE path LIKE ? ORDER BY section_order"
      )
      .all(`%${searchPath}`) as any[];
  }

  if (rows.length === 0) return null;

  return {
    title: rows[0].title,
    url: rows[0].url,
    content: rows.map((r: any) => r.content).join("\n\n"),
  };
}

export function listSections(
  db: Database.Database
): { path: string; title: string; source: string }[] {
  return db
    .prepare(
      "SELECT DISTINCT path, title, source FROM pages ORDER BY source, path"
    )
    .all() as { path: string; title: string; source: string }[];
}

export function getMetadata(
  db: Database.Database,
  key: string
): string | null {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(
  db: Database.Database,
  key: string,
  value: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
  ).run(key, value);
}
