import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { describe, expect, it } from "vitest";
import { drawBlocks, MAX_SHOWN_CHARS, parseInline, parseMarkdown, safeHref, splitFrontmatter } from "../src/lib/markdown.ts";

const html = (md: string) => renderToStaticMarkup(createElement(Fragment, null, ...drawBlocks(parseMarkdown(md).blocks)));

describe("markdown: the skill's words, never HTML (§18.3)", () => {
  it("draws headings (one level down), paragraphs, lists, quotes, bold, italic and code", () => {
    const out = html("# Title\n\nSome **bold** and *soft* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```\nlet x = 1;\n```\n");
    expect(out).toContain('<h2 class="md__h md__h1">Title</h2>');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>soft</em>");
    expect(out).toContain('<code class="md__code">code</code>');
    expect(out).toMatch(/<ul class="md__list"><li><p class="md__p">one<\/p><\/li><li><p class="md__p">two<\/p><\/li><\/ul>/);
    expect(out).toContain('<ol class="md__list" start="1">');
    expect(out).toContain('<blockquote class="md__quote"><p class="md__p">quoted</p></blockquote>');
    expect(out).toContain("<pre");
    expect(out).toContain("let x = 1;");
  });

  it("shows raw HTML as text: <script> and <img onerror> stay letters", () => {
    const out = html("<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("links only http, https and mailto, opening safely in a new tab", () => {
    const out = html("[help](https://example.com/help) [mail](mailto:a@b.co) [bad](javascript:alert(1)) [rel](/settings)");
    expect(out).toContain('<a href="https://example.com/help" target="_blank" rel="noopener noreferrer nofollow" class="md__link">help</a>');
    expect(out).toContain('href="mailto:a@b.co"');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('href="/settings"');
    expect(out).toContain("bad");
    expect(out).toContain("rel");
  });

  it("never loads a picture and never prints its address: only what it shows", () => {
    const out = html("![a cat](https://example.com/cat.png) ![x](javascript:alert(1)) ![](https://example.com/y.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("Picture: a cat");
    expect(out).toContain("Picture: no description");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("javascript");
  });

  it("reads headings with closing #s the old way", () => {
    expect(html("# Title ##")).toContain('<h2 class="md__h md__h1">Title</h2>');
    expect(html("## C#")).toContain(">C#</h3>");
    expect(html("#")).toContain('<h2 class="md__h md__h1"></h2>');
    expect(html("#nospace")).toContain('<p class="md__p">#nospace</p>');
    expect(html("   ### Three   ###   ")).toContain(">Three</h4>");
  });

  it("stays quick on a crafted heading line that used to freeze the page", () => {
    const n = 8000;
    const line = "# a" + " ".repeat(n) + "#" + " ".repeat(n) + " x";
    const t = performance.now();
    const doc = parseMarkdown(`${line}\nplain words\n${line}`);
    expect(performance.now() - t).toBeLessThan(50);
    expect(doc.blocks[0]).toMatchObject({ t: "h", level: 1 });
  });

  it("refuses sneaky schemes", () => {
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.com", "file:///etc/passwd", ""])
      expect(safeHref(bad)).toBeNull();
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("HTTP://example.com")).toBe("HTTP://example.com");
  });

  it("reads the frontmatter apart, never into the text", () => {
    const doc = parseMarkdown('---\nname: funny\ndescription: "Every \\"time\\"."\nlicense: mine\n---\n\n# Funny\n');
    expect(doc.front?.fields).toEqual({ name: "funny", description: 'Every "time".', license: "mine" });
    expect(doc.blocks[0]).toMatchObject({ t: "h", level: 1 });
    expect(JSON.stringify(doc.blocks)).not.toContain("license");
    expect(splitFrontmatter("# no front")).toBeNull();
    expect(splitFrontmatter("---\nname: x\n")).toBeNull();
    expect(splitFrontmatter("---\ndescription: >\n  one\n  two\n---\n")?.front.fields.description).toBe("one two");
  });

  it("keeps escapes, unmatched stars and nested lists", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    const out = html("- top\n  - inner\n- next");
    expect(out).toMatch(/<li><p class="md__p">top<\/p><ul class="md__list"><li><p class="md__p">inner<\/p><\/li><\/ul><\/li>/);
  });

  it("stays quick on a long line of unmatched stars", () => {
    const start = performance.now();
    parseInline("*a ".repeat(60_000));
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("shows only the first 200,000 characters of a very long skill", () => {
    const doc = parseMarkdown("x".repeat(MAX_SHOWN_CHARS + 10));
    expect(doc.truncated).toBe(true);
    expect(JSON.stringify(doc.blocks).length).toBeLessThan(MAX_SHOWN_CHARS + 200);
    expect(parseMarkdown("short").truncated).toBe(false);
  });
});
