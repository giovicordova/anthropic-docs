import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config.js";
import type { PageSection, SearchResult, GetDocPageResult, Statements, SearchRow, PageRow, SectionRow } from "./types.js";

const DB_PATH = path.join(DB_DIR, "docs.db");

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || DB_PATH;

  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

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

  // FTS5 virtual table
  const ftsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_fts'")
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
    CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source);
    CREATE INDEX IF NOT EXISTS idx_pages_generation ON pages(generation);
  `);

  return db;
}

export function prepareStatements(db: Database.Database): Statements {
  return {
    insertPage: db.prepare(`
      INSERT INTO pages (url, path, title, section_heading, section_anchor, content, section_order, source, generation, crawled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertFts: db.prepare(`
      INSERT INTO pages_fts (rowid, title, section_heading, content)
      VALUES (?, ?, ?, ?)
    `),
    deleteOldGen: db.prepare("DELETE FROM pages WHERE generation != ? AND source NOT IN ('blog', 'model', 'research')"),
    rebuildFts: "INSERT INTO pages_fts(pages_fts) VALUES('rebuild')",
    setGeneration: db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('current_generation', ?)"
    ),
    search: db.prepare(`
      SELECT
        p.title, p.url, p.section_heading, p.source,
        snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
        bm25(pages_fts, 10.0, 5.0, 1.0) as rank
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    searchWithSource: db.prepare(`
      SELECT
        p.title, p.url, p.section_heading, p.source,
        snippet(pages_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
        bm25(pages_fts, 10.0, 5.0, 1.0) as rank
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      AND p.source = ?
      ORDER BY rank
      LIMIT ?
    `),
    exactPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path = ? ORDER BY section_order"
    ),
    suffixPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
    ),
    segmentPath: db.prepare(
      "SELECT title, url, path, content FROM pages WHERE path LIKE ? ORDER BY section_order"
    ),
    listAll: db.prepare(
      "SELECT DISTINCT path, title, source FROM pages ORDER BY source, path"
    ),
    listBySource: db.prepare(
      "SELECT DISTINCT path, title, source FROM pages WHERE source = ? ORDER BY source, path"
    ),
    getMetadata: db.prepare("SELECT value FROM metadata WHERE key = ?"),
    setMetadata: db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
    ),
    getCurrentGen: db.prepare(
      "SELECT value FROM metadata WHERE key = 'current_generation'"
    ),
  };
}

export function getCurrentGeneration(stmts: Statements): number {
  const row = stmts.getCurrentGen.get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function insertPageSections(
  db: Database.Database,
  stmts: Statements,
  sections: PageSection[],
  generation: number
): void {
  const batch = db.transaction(() => {
    for (const page of sections) {
      const result = stmts.insertPage.run(
        page.url, page.path, page.title, page.sectionHeading, page.sectionAnchor,
        page.content, page.sectionOrder, page.source, generation, new Date().toISOString()
      );
      stmts.insertFts.run(result.lastInsertRowid, page.title, page.sectionHeading || "", page.content);
    }
  });
  batch();
}

export function finalizeGeneration(
  db: Database.Database,
  stmts: Statements,
  keepGeneration: number
): void {
  const finalize = db.transaction(() => {
    stmts.deleteOldGen.run(keepGeneration);
    db.exec(stmts.rebuildFts);
    stmts.setGeneration.run(String(keepGeneration));
  });
  finalize();
}

export function cleanupOrphanedGenerations(
  db: Database.Database,
  stmts: Statements
): number {
  const currentGen = getCurrentGeneration(stmts);
  const result = db.prepare("DELETE FROM pages WHERE generation != ? AND source NOT IN ('blog', 'model', 'research')").run(currentGen);
  if (result.changes > 0) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
  }
  return result.changes;
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
  stmts: Statements,
  query: string,
  limit: number = 10,
  source?: string
): SearchResult[] {
  const ftsQuery = preprocessQuery(query);
  const useSourceFilter = source && source !== "all";

  try {
    const rows: SearchRow[] = useSourceFilter
      ? stmts.searchWithSource.all(ftsQuery, source, limit) as SearchRow[]
      : stmts.search.all(ftsQuery, limit) as SearchRow[];

    return rows.map((row) => ({
      title: row.title,
      url: row.url,
      sectionHeading: row.section_heading,
      snippet: row.snippet,
      relevanceScore: Math.abs(row.rank),
      source: row.source,
    }));
  } catch (err) {
    console.error(`[database] FTS5 query error for "${query}": ${(err as Error).message}`);
    return [];
  }
}

export function getDocPage(
  stmts: Statements,
  searchPath: string
): GetDocPageResult | null {
  let rows = stmts.exactPath.all(searchPath) as PageRow[];

  if (rows.length === 0) {
    rows = stmts.suffixPath.all(`%${searchPath}`) as PageRow[];
  }

  if (rows.length === 0) {
    rows = stmts.segmentPath.all(`%${searchPath}/%`) as PageRow[];
  }

  if (rows.length === 0) return null;

  const distinctPaths = [...new Set(rows.map((r) => r.path))];

  if (distinctPaths.length === 1) {
    return {
      type: "page",
      title: rows[0].title,
      url: rows[0].url,
      content: rows.map((r) => r.content).join("\n\n"),
    };
  }

  const matches = distinctPaths.map((p) => {
    const row = rows.find((r) => r.path === p)!;
    return { path: p, title: row.title, url: row.url };
  });

  return { type: "disambiguation", matches };
}

export function listSections(
  stmts: Statements,
  source?: string
): SectionRow[] {
  if (source && source !== "all") {
    return stmts.listBySource.all(source) as SectionRow[];
  }
  return stmts.listAll.all() as SectionRow[];
}

export function getMetadata(stmts: Statements, key: string): string | null {
  const row = stmts.getMetadata.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(stmts: Statements, key: string, value: string): void {
  stmts.setMetadata.run(key, value);
}

export function getIndexedBlogUrls(db: Database.Database): string[] {
  const rows = db.prepare("SELECT DISTINCT url FROM pages WHERE source = 'blog'").all() as { url: string }[];
  return rows.map((r) => r.url);
}

export function getIndexedBlogUrlsWithTimestamps(db: Database.Database): Map<string, string> {
  const rows = db.prepare(
    "SELECT DISTINCT url, MIN(crawled_at) as crawled_at FROM pages WHERE source = 'blog' GROUP BY url"
  ).all() as { url: string; crawled_at: string }[];
  return new Map(rows.map((r) => [r.url, r.crawled_at]));
}

export function retagResearchPages(db: Database.Database): number {
  const result = db.prepare("UPDATE pages SET source = 'research' WHERE source = 'blog' AND path LIKE '/research/%'").run();
  return result.changes;
}

export function deletePagesBySource(db: Database.Database, source: string, urls: string[]): number {
  if (urls.length === 0) return 0;
  let deleted = 0;
  for (const url of urls) {
    const result = db.prepare("DELETE FROM pages WHERE url = ? AND source = ?").run(url, source);
    deleted += result.changes;
  }
  if (deleted > 0) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
  }
  return deleted;
}

export function deleteBlogPages(db: Database.Database, urls: string[]): number {
  if (urls.length === 0) return 0;
  let deleted = 0;
  for (const url of urls) {
    const result = db.prepare("DELETE FROM pages WHERE url = ? AND source = 'blog'").run(url);
    deleted += result.changes;
  }
  if (deleted > 0) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
  }
  return deleted;
}
