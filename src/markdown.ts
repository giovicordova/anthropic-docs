import TurndownService from "turndown";

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
  // Split at ## and ### headings
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentAnchor: string | null = null;
  let currentLines: string[] = [];
  let order = 0;

  function flushSection() {
    const content = currentLines.join("\n").trim();
    if (content.length > 0) {
      sections.push({
        heading: currentHeading,
        anchor: currentAnchor,
        content,
        order: order++,
      });
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
      // Generate anchor from heading text
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

  return sections;
}
