import { MAX_SECTION_SIZE, MIN_SECTION_SIZE, PLATFORM_DOCS_URL, CLAUDE_CODE_DOCS_URL } from "./config.js";
import { fetchWithTimeout } from "./fetch.js";
import type { Section, ParsedPage, DocSource, PageSection } from "./types.js";

export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    if (content.length < MIN_SECTION_SIZE) return;
    sections.push({
      heading: currentHeading,
      anchor: currentAnchor,
      content,
      order: order++,
    });
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
      currentAnchor = currentHeading
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-");
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  // Post-process: split oversized sections at h4 boundaries
  const result: Section[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_SECTION_SIZE) {
      result.push(section);
      continue;
    }

    const subLines = section.content.split("\n");
    let subHeading = section.heading;
    let subAnchor = section.anchor;
    let subContent: string[] = [];
    let subOrder = section.order;
    let didSplit = false;

    for (const subLine of subLines) {
      const h4Match = subLine.match(/^(####)\s+(.+)$/);
      if (h4Match && subContent.join("\n").trim().length >= 200) {
        const chunk = subContent.join("\n").trim();
        if (chunk.length >= MIN_SECTION_SIZE) {
          result.push({
            heading: subHeading,
            anchor: subAnchor,
            content: chunk,
            order: subOrder++,
          });
          didSplit = true;
        }
        subHeading = `${section.heading} > ${h4Match[2].trim()}`;
        subAnchor = h4Match[2]
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-");
        subContent = [subLine];
      } else {
        subContent.push(subLine);
      }
    }

    const remaining = subContent.join("\n").trim();
    if (remaining.length >= MIN_SECTION_SIZE) {
      result.push({
        heading: didSplit ? subHeading : section.heading,
        anchor: didSplit ? subAnchor : section.anchor,
        content: remaining,
        order: subOrder,
      });
    }
  }

  // Re-number order sequentially
  for (let i = 0; i < result.length; i++) {
    result[i].order = i;
  }

  return result;
}

export function parsePages(text: string, defaultSource: "platform" | "code"): ParsedPage[] {
  const pages: ParsedPage[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith("# ")) {
      let urlLine: string | null = null;
      let urlLineIndex = -1;

      // Look ahead for URL: or Source: within the next 3 lines
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].startsWith("URL: ") || lines[j].startsWith("Source: ")) {
          urlLine = lines[j];
          urlLineIndex = j;
          break;
        }
      }

      if (!urlLine) {
        i++;
        continue;
      }

      const title = lines[i].slice(2).trim();
      const url = urlLine.replace(/^(URL|Source): /, "").trim();
      let urlPath: string;
      try {
        urlPath = new URL(url).pathname;
      } catch {
        i++;
        continue;
      }

      // Collect content until the next page delimiter
      const contentLines: string[] = [];
      i = urlLineIndex + 1;

      while (i < lines.length) {
        if (lines[i].startsWith("# ")) {
          let isNewPage = false;
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            if (lines[j].startsWith("URL: ") || lines[j].startsWith("Source: ")) {
              isNewPage = true;
              break;
            }
          }
          if (isNewPage) break;
        }
        contentLines.push(lines[i]);
        i++;
      }

      const content = contentLines.join("\n").trim();
      if (content.length === 0) continue;

      // Determine source
      let source: DocSource = defaultSource;
      if (defaultSource === "platform" && urlPath.match(/^\/docs\/en\/api\//)) {
        source = "api-reference";
      }

      pages.push({ title, url, path: urlPath, content, source });
    } else {
      i++;
    }
  }

  return pages;
}

export async function fetchAndParse(): Promise<ParsedPage[]> {
  const results: ParsedPage[] = [];

  const [platformResponse, codeResponse] = await Promise.allSettled([
    fetchWithTimeout(PLATFORM_DOCS_URL),
    fetchWithTimeout(CLAUDE_CODE_DOCS_URL),
  ]);

  if (platformResponse.status === "fulfilled" && platformResponse.value.ok) {
    const text = await platformResponse.value.text();
    const pages = parsePages(text, "platform");
    results.push(...pages);
    console.error(`[parser] Platform docs: parsed ${pages.length} pages`);
  } else {
    const reason = platformResponse.status === "rejected"
      ? platformResponse.reason?.message
      : `HTTP ${(platformResponse as PromiseFulfilledResult<Response>).value.status}`;
    console.error(`[parser] Failed to fetch platform docs: ${reason}`);
  }

  if (codeResponse.status === "fulfilled" && codeResponse.value.ok) {
    const text = await codeResponse.value.text();
    const pages = parsePages(text, "code");
    results.push(...pages);
    console.error(`[parser] Claude Code docs: parsed ${pages.length} pages`);
  } else {
    const reason = codeResponse.status === "rejected"
      ? codeResponse.reason?.message
      : `HTTP ${(codeResponse as PromiseFulfilledResult<Response>).value.status}`;
    console.error(`[parser] Failed to fetch code docs: ${reason}`);
  }

  console.error(`[parser] Total: ${results.length} pages`);
  return results;
}

export function pagesToSections(page: ParsedPage): PageSection[] {
  const sections = splitIntoSections(page.content);
  return sections.map((section) => ({
    url: page.url,
    path: page.path,
    title: page.title,
    sectionHeading: section.heading,
    sectionAnchor: section.anchor,
    content: section.content,
    sectionOrder: section.order,
    source: page.source,
  }));
}
