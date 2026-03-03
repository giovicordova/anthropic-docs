import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { DB_DIR } from "./config.js";

const DB_PATH = path.join(DB_DIR, "docs.db");

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

export type GetDocPageResult =
  | { type: "page"; title: string; url: string; content: string }
  | { type: "disambiguation"; matches: { path: string; title: string; url: string }[] };

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
      generation INTEGER NOT NULL DEFAULT 0,
      crawled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrations for existing DBs
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('pages')")
    .all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("source")) {
    db.exec("ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'");
  }
  if (!columnNames.has("generation")) {
    db.exec("ALTER TABLE pages ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  }

  // FTS5 virtual table
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

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
    CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source);
    CREATE INDEX IF NOT EXISTS idx_pages_generation ON pages(generation);
  `);

  return db;
}

export function getCurrentGeneration(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'current_generation'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function insertPage(db: Database.Database, page: PageSection, generation: number): void {
  const doInsert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, source, generation, crawled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      page.url,
      page.path,
      page.title,
      page.sectionHeading,
      page.sectionAnchor,
      page.content,
      page.sectionOrder,
      page.source,
      generation,
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO pages_fts (rowid, title, section_heading, content)
      VALUES (?, ?, ?, ?)
    `).run(
      result.lastInsertRowid,
      page.title,
      page.sectionHeading || "",
      page.content
    );
  });

  doInsert();
}

export function finalizeGeneration(db: Database.Database, keepGeneration: number): void {
  const finalize = db.transaction(() => {
    db.prepare("DELETE FROM pages WHERE generation != ?").run(keepGeneration);
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('current_generation', ?)"
    ).run(String(keepGeneration));
  });
  finalize();
}

function preprocessQuery(query: string): string {
  let cleaned = query
    .replace(/[*"():^~{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return '""';

  const terms = cleaned.split(" ").filter((t) => t.length > 0);

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
): GetDocPageResult | null {
  // 1. Exact match
  let rows = db
    .prepare(
      "SELECT title, url, path, content FROM pages WHERE path = ? ORDER BY section_order"
    )
    .all(searchPath) as any[];

  // 2. Suffix match (path ends with search term)
  if (rows.length === 0) {
    rows = db
      .prepare(
        "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
      )
      .all(`%${searchPath}`) as any[];
  }

  // 3. Segment match (search term appears as a directory segment)
  if (rows.length === 0) {
    rows = db
      .prepare(
        "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
      )
      .all(`%${searchPath}/%`) as any[];
  }

  if (rows.length === 0) return null;

  // Check if results span multiple distinct pages
  const distinctPaths = [...new Set(rows.map((r: any) => r.path))];

  if (distinctPaths.length === 1) {
    return {
      type: "page",
      title: rows[0].title,
      url: rows[0].url,
      content: rows.map((r: any) => r.content).join("\n\n"),
    };
  }

  // Multiple pages matched — return disambiguation list
  const matches = distinctPaths.map((p) => {
    const row = rows.find((r: any) => r.path === p);
    return { path: p, title: row.title, url: row.url };
  });

  return { type: "disambiguation", matches };
}

export function listSections(
  db: Database.Database,
  source?: string
): { path: string; title: string; source: string }[] {
  if (source && source !== "all") {
    return db
      .prepare(
        "SELECT DISTINCT path, title, source FROM pages WHERE source = ? ORDER BY source, path"
      )
      .all(source) as { path: string; title: string; source: string }[];
  }
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
