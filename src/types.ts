import type Database from "better-sqlite3";

// --- Crawl orchestration ---

export type CrawlState = "idle" | "crawling" | "failed";

export interface ContentSource {
  name: string;
  staleDays: number;
  metaTimestampKey: string;
  metaCountKey: string;
  usesGeneration: boolean;
  fetch(db: Database.Database): Promise<ParsedPage[]>;
}

// --- Source tagging ---

export type DocSource = "platform" | "code" | "api-reference" | "blog" | "model" | "research";

// --- Parser output ---

export interface ParsedPage {
  title: string;
  url: string;
  path: string;
  content: string;
  source: DocSource;
}

export interface Section {
  heading: string | null;
  anchor: string | null;
  content: string;
  order: number;
}

// --- Database types ---

export interface PageSection {
  url: string;
  path: string;
  title: string;
  sectionHeading: string | null;
  sectionAnchor: string | null;
  content: string;
  sectionOrder: number;
  source: DocSource;
}

export interface SearchResult {
  title: string;
  url: string;
  sectionHeading: string | null;
  snippet: string;
  relevanceScore: number;
  source: string;
}

export type GetDocPageResult =
  | { type: "page"; title: string; url: string; content: string }
  | { type: "disambiguation"; matches: { path: string; title: string; url: string }[] };

// --- Database row types ---

export interface SearchRow {
  title: string;
  url: string;
  section_heading: string | null;
  snippet: string;
  rank: number;
  source: string;
}

export interface PageRow {
  title: string;
  url: string;
  path: string;
  content: string;
}

export interface SectionRow {
  path: string;
  title: string;
  source: string;
}

// --- Sitemap entry ---

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

// --- Conditional fetch ---

export interface ConditionalFetchResult {
  modified: boolean;
  response?: Response;
  etag?: string;
  lastModified?: string;
}

// --- Cached prepared statements ---

export interface Statements {
  insertPage: Database.Statement;
  insertFts: Database.Statement;
  deleteOldGen: Database.Statement;
  rebuildFts: string;
  setGeneration: Database.Statement;
  search: Database.Statement;
  searchWithSource: Database.Statement;
  exactPath: Database.Statement;
  suffixPath: Database.Statement;
  segmentPath: Database.Statement;
  listAll: Database.Statement;
  listBySource: Database.Statement;
  getMetadata: Database.Statement;
  setMetadata: Database.Statement;
  getCurrentGen: Database.Statement;
}
