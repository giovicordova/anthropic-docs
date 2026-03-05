import { describe, it, expect } from "vitest";
import { splitIntoSections, parsePages } from "../src/parser.js";

describe("splitIntoSections", () => {
  it("splits markdown at ## and ### headings", () => {
    const markdown = [
      "Some intro text that is long enough to pass the minimum size filter for sections.",
      "",
      "## Getting Started",
      "",
      "This section has content about getting started with the tool and configuration.",
      "",
      "### Installation",
      "",
      "Install the package using npm install command and follow the setup instructions.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].order).toBe(0);
    expect(sections[1].heading).toBe("Getting Started");
    expect(sections[1].anchor).toBe("getting-started");
    expect(sections[2].heading).toBe("Installation");
  });

  it("filters out stub sections below MIN_SECTION_SIZE", () => {
    const markdown = [
      "## Real Section",
      "",
      "This section has enough content to pass the minimum size filter for sections easily.",
      "",
      "## Stub",
      "",
      "Tiny.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Real Section");
  });

  it("splits oversized sections at #### headings", () => {
    const longContent = "A".repeat(7000);
    const markdown = [
      "## Big Section",
      "",
      longContent.slice(0, 3000),
      "",
      "#### Sub Heading",
      "",
      longContent.slice(0, 3000),
      "",
      "#### Another Sub",
      "",
      "This is the final sub-section with enough content to survive the minimum size filter.",
    ].join("\n");

    const sections = splitIntoSections(markdown);

    expect(sections.length).toBeGreaterThan(1);
  });
});

describe("parsePages", () => {
  it("parses platform llms-full.txt format", () => {
    const text = [
      "# Some Header",
      "",
      "Preamble text to skip.",
      "",
      "---",
      "",
      "# Tool Use",
      "",
      "URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use",
      "",
      "# Tool Use",
      "",
      "Claude can interact with external tools and APIs.",
      "",
      "## Overview",
      "",
      "Tool use lets Claude call functions you define.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Tool Use");
    expect(pages[0].url).toBe("https://platform.claude.com/docs/en/agents-and-tools/tool-use");
    expect(pages[0].path).toBe("/docs/en/agents-and-tools/tool-use");
    expect(pages[0].source).toBe("platform");
    expect(pages[0].content).toContain("Claude can interact");
  });

  it("parses code llms-full.txt format", () => {
    const text = [
      "# Connect Claude Code to tools via MCP",
      "Source: https://code.claude.com/docs/en/mcp",
      "",
      "Claude Code supports the Model Context Protocol.",
      "",
      "## Configuration",
      "",
      "Configure MCP servers in your settings.",
      "",
      "# Best Practices",
      "Source: https://code.claude.com/docs/en/best-practices",
      "",
      "Follow these best practices for effective usage of Claude Code in projects.",
    ].join("\n");

    const pages = parsePages(text, "code");
    expect(pages).toHaveLength(2);
    expect(pages[0].title).toBe("Connect Claude Code to tools via MCP");
    expect(pages[0].path).toBe("/docs/en/mcp");
    expect(pages[0].source).toBe("code");
    expect(pages[1].title).toBe("Best Practices");
  });

  it("tags api-reference pages by path", () => {
    const text = [
      "---",
      "",
      "# Create a Message",
      "",
      "URL: https://platform.claude.com/docs/en/api/messages/create",
      "",
      "# Create a Message",
      "",
      "Send a structured list of input messages.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].source).toBe("api-reference");
  });

  it("skips preamble content without URL/Source lines", () => {
    const text = [
      "# Anthropic Developer Documentation - Full Content",
      "",
      "This file provides comprehensive documentation.",
      "",
      "---",
      "",
      "# Real Page",
      "",
      "URL: https://platform.claude.com/docs/en/get-started",
      "",
      "# Real Page",
      "",
      "Real content that should be indexed in the database for search.",
    ].join("\n");

    const pages = parsePages(text, "platform");
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Real Page");
  });
});
