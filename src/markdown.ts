import TurndownService from "turndown";
import { MAX_SECTION_SIZE, MIN_SECTION_SIZE } from "./config.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Remove images (they don't help in text search)
turndown.addRule("removeImages", {
  filter: "img",
  replacement: () => "",
});

// Keep code blocks clean
turndown.addRule("codeBlocks", {
  filter: (node) => {
    return (
      node.nodeName === "PRE" &&
      node.querySelector("code") !== null
    );
  },
  replacement: (_content, node) => {
    const codeEl = (node as HTMLElement).querySelector("code");
    if (!codeEl) return _content;
    const lang = codeEl.className?.match(/language-(\w+)/)?.[1] || "";
    const code = codeEl.textContent || "";
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  },
});

export interface Section {
  heading: string | null;
  anchor: string | null;
  content: string;
  order: number;
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    // Filter out stub sections with less than MIN_SECTION_SIZE chars of real content
    if (content.length < MIN_SECTION_SIZE) return;
    sections.push({
      heading: currentHeading,
      anchor: currentAnchor,
      content,
      order: order++,
    });
  }

  for (const line of lines) {
    // Split at ## and ### headings
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
    // Try splitting at #### headings
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
        subAnchor = h4Match[2].trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-");
        subContent = [subLine];
      } else {
        subContent.push(subLine);
      }
    }
    // Flush remaining
    const remaining = subContent.join("\n").trim();
    if (remaining.length >= MIN_SECTION_SIZE) {
      result.push({
        heading: didSplit ? subHeading : section.heading,
        anchor: didSplit ? subAnchor : section.anchor,
        content: remaining,
        order: subOrder,
      });
    }
    if (!didSplit) {
      // Couldn't split at h4 — keep the original large section
      // (already pushed via the remaining flush above)
    }
  }

  // Re-number order sequentially
  for (let i = 0; i < result.length; i++) {
    result[i].order = i;
  }

  return result;
}
