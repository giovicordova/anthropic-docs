import { describe, it, expect } from "vitest";
import { parseSitemap, parseSitemapWithLastmod, htmlToMarkdown, parseBlogPage, parseHtmlPage } from "../src/blog-parser.js";

describe("parseSitemap", () => {
  it("extracts blog URLs matching BLOG_PATH_PREFIXES (excludes /research/)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.anthropic.com/news/claude-4</loc></url>
  <url><loc>https://www.anthropic.com/research/scaling-laws</loc></url>
  <url><loc>https://www.anthropic.com/engineering/mcp-launch</loc></url>
</urlset>`;

    const urls = parseSitemap(xml);
    expect(urls).toHaveLength(2);
    expect(urls).toContain("https://www.anthropic.com/news/claude-4");
    expect(urls).not.toContain("https://www.anthropic.com/research/scaling-laws");
    expect(urls).toContain("https://www.anthropic.com/engineering/mcp-launch");
  });

  it("filters out non-blog URLs", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.anthropic.com/news/claude-4</loc></url>
  <url><loc>https://www.anthropic.com/about</loc></url>
  <url><loc>https://www.anthropic.com/careers/engineer</loc></url>
  <url><loc>https://www.anthropic.com/</loc></url>
</urlset>`;

    const urls = parseSitemap(xml);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://www.anthropic.com/news/claude-4");
  });

  it("handles invalid XML gracefully", () => {
    const urls = parseSitemap("this is not xml at all");
    expect(urls).toEqual([]);
  });

  it("handles empty string", () => {
    const urls = parseSitemap("");
    expect(urls).toEqual([]);
  });
});

describe("parseSitemapWithLastmod", () => {
  it("extracts url and lastmod from well-formed sitemap XML (excludes /research/)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.anthropic.com/news/claude-4</loc>
    <lastmod>2026-01-15T10:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://www.anthropic.com/research/scaling-laws</loc>
    <lastmod>2026-02-20T08:30:00Z</lastmod>
  </url>
</urlset>`;

    const entries = parseSitemapWithLastmod(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ url: "https://www.anthropic.com/news/claude-4", lastmod: "2026-01-15T10:00:00Z" });
  });

  it("returns null lastmod when lastmod tag is missing", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.anthropic.com/news/no-date</loc>
  </url>
</urlset>`;

    const entries = parseSitemapWithLastmod(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ url: "https://www.anthropic.com/news/no-date", lastmod: null });
  });

  it("filters to blog path prefixes only", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.anthropic.com/news/post</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://www.anthropic.com/about</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://www.anthropic.com/careers/engineer</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
</urlset>`;

    const entries = parseSitemapWithLastmod(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe("https://www.anthropic.com/news/post");
  });

  it("handles empty sitemap", () => {
    const entries = parseSitemapWithLastmod("");
    expect(entries).toEqual([]);
  });
});

describe("htmlToMarkdown", () => {
  it("extracts content from article tag", () => {
    const html = `<html><body>
      <nav>Navigation menu</nav>
      <article><h1>Blog Title</h1><p>Blog content here.</p></article>
      <footer>Footer stuff</footer>
    </body></html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain("Blog Title");
    expect(md).toContain("Blog content here.");
    expect(md).not.toContain("Navigation menu");
    expect(md).not.toContain("Footer stuff");
  });

  it("falls back to main tag when no article", () => {
    const html = `<html><body>
      <nav>Navigation menu</nav>
      <main><h1>Main Title</h1><p>Main content.</p></main>
      <footer>Footer stuff</footer>
    </body></html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain("Main Title");
    expect(md).toContain("Main content.");
    expect(md).not.toContain("Navigation menu");
    expect(md).not.toContain("Footer stuff");
  });

  it("falls back to full HTML when no article or main", () => {
    const html = `<html><body><p>Just some content in body.</p></body></html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain("Just some content in body.");
  });

  it("returns trimmed result", () => {
    const html = `<article>  <p>Content</p>  </article>`;

    const md = htmlToMarkdown(html);
    expect(md).toBe(md.trim());
  });
});

describe("parseBlogPage", () => {
  it("produces correct ParsedPage with source blog", () => {
    const html = `<article><h1>Introducing Claude 4</h1><p>We are excited to announce Claude 4.</p></article>`;
    const url = "https://www.anthropic.com/news/claude-4";

    const page = parseBlogPage(url, html);

    expect(page).not.toBeNull();
    expect(page!.title).toBe("Introducing Claude 4");
    expect(page!.url).toBe(url);
    expect(page!.path).toBe("/news/claude-4");
    expect(page!.source).toBe("blog");
    expect(page!.content).toContain("Claude 4");
  });

  it("extracts h1 title from markdown", () => {
    const html = `<article><h1>My Great Post</h1><p>Content goes here for the post.</p></article>`;
    const url = "https://www.anthropic.com/research/my-post";

    const page = parseBlogPage(url, html);

    expect(page).not.toBeNull();
    expect(page!.title).toBe("My Great Post");
  });

  it("falls back to URL path segment for title", () => {
    const html = `<article><p>No heading here, just paragraph content for the blog.</p></article>`;
    const url = "https://www.anthropic.com/news/some-announcement";

    const page = parseBlogPage(url, html);

    expect(page).not.toBeNull();
    expect(page!.title).toBe("some-announcement");
  });

  it("returns null for empty content", () => {
    const html = `<article></article>`;
    const url = "https://www.anthropic.com/news/empty-post";

    const page = parseBlogPage(url, html);

    expect(page).toBeNull();
  });

  it("returns null for whitespace-only content", () => {
    const html = `<article>   </article>`;
    const url = "https://www.anthropic.com/news/blank";

    const page = parseBlogPage(url, html);

    expect(page).toBeNull();
  });
});

describe("parseHtmlPage", () => {
  it("returns ParsedPage with correct source for model", () => {
    const html = `<article><h1>Claude Opus</h1><p>The most capable model in the Claude family.</p></article>`;
    const url = "https://www.anthropic.com/claude/opus";

    const page = parseHtmlPage(url, html, "model");

    expect(page).not.toBeNull();
    expect(page!.title).toBe("Claude Opus");
    expect(page!.url).toBe(url);
    expect(page!.path).toBe("/claude/opus");
    expect(page!.source).toBe("model");
    expect(page!.content).toContain("most capable model");
  });

  it("returns null for empty HTML content", () => {
    const html = `<article></article>`;
    const url = "https://www.anthropic.com/claude/opus";

    const page = parseHtmlPage(url, html, "model");

    expect(page).toBeNull();
  });

  it("uses URL path segment as title when no h1", () => {
    const html = `<article><p>No heading here, just paragraph content for the page.</p></article>`;
    const url = "https://www.anthropic.com/research/some-paper";

    const page = parseHtmlPage(url, html, "research");

    expect(page).not.toBeNull();
    expect(page!.title).toBe("some-paper");
    expect(page!.source).toBe("research");
  });
});
