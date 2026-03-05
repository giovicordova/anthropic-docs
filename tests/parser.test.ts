import { describe, it, expect } from "vitest";
import { splitIntoSections } from "../src/parser.js";

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
