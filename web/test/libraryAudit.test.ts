// Library, This week, public pages and typography fixes from the UI audit (F038, F039, F054, F056, F063, F082, F083,
// F085, F089). Layout checks that need a real browser live in e2e/library-audit.spec.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { titleFor } from "../src/app/App.tsx";
import { isoWeek } from "../src/lib/week.ts";
import { postStatusLabel, STATUS_LABEL } from "../src/lib/metrics.ts";
import { libraryEmptyCopy } from "../src/screens/library/Library.tsx";
import { weekTitle } from "../src/screens/library/WeekView.tsx";

const WEB = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

describe("light-only app (F054)", () => {
  it("no stylesheet changes colours for a dark OS setting", () => {
    const dir = join(WEB, "src", "styles");
    const dark = readdirSync(dir).filter((f) => f.endsWith(".css") && /prefers-color-scheme:\s*dark/.test(read("src", "styles", f)));
    expect(dark).toEqual([]);
  });
});

describe("tab title for This week (F083)", () => {
  it("names the current week 'This week' and any other week by its dates, like the heading", () => {
    expect(titleFor({ name: "library", view: "week", week: null })).toBe("This week · Library");
    expect(titleFor({ name: "library", view: "week", week: isoWeek(new Date()) })).toBe("This week · Library");
    expect(titleFor({ name: "library", view: "week", week: "2026-W40" })).toBe("Week of 28 Sep–4 Oct · Library");
    expect(titleFor({ name: "library", view: "week", week: "2020-W01" })).toBe("Week of 30 Dec–5 Jan · Library");
    // A week that does not exist shows the current week's page ("That week does not look right").
    expect(titleFor({ name: "library", view: "week", week: "2026-W99" })).toBe("This week · Library");
    expect(weekTitle("2026-W47", new Date("2026-11-18T12:00:00"))).toBe("This week");
  });
});

describe("Library empty list (F082)", () => {
  it("only asks to keep clips when nothing is kept", () => {
    expect(libraryEmptyCopy("all", false)).toMatchObject({ title: "Nothing kept yet", action: "review" });
    expect(libraryEmptyCopy("waiting", false)).toMatchObject({ title: "Nothing kept yet", action: "review" });
    expect(libraryEmptyCopy("posted", false)).toMatchObject({ title: "Nothing posted yet", action: "review" });
  });
  it("says everything is posted when 'Not posted yet' is empty but clips are kept", () => {
    const c = libraryEmptyCopy("waiting", true);
    expect(c).toMatchObject({ title: "Everything is posted!", action: "all" });
    expect(c.body).not.toMatch(/Keep/);
  });
  it("says kept clips are coming when 'Posted' is empty", () => {
    const c = libraryEmptyCopy("posted", true);
    expect(c).toMatchObject({ title: "Nothing posted yet", action: "all" });
    expect(c.body).toMatch(/Tap Show all/);
  });
});

describe("one name per post state (F085)", () => {
  it("Library rows use the clip page's chip words", () => {
    expect(postStatusLabel({ status: "queued" })).toBe(STATUS_LABEL.posting);
    expect(postStatusLabel({ status: "queued" })).toBe("Posting");
    expect(postStatusLabel({ status: "pending_integration" })).toBe("Waiting for connection");
    expect(postStatusLabel({ status: "posted" })).toBe("Posted");
    expect(postStatusLabel({ status: "posted", privacy: "private" })).toBe("Posted privately");
    expect(postStatusLabel({ status: "failed" })).toBe("Failed");
  });
  it("Library no longer has its own status words", () => {
    const src = read("src", "screens", "library", "Library.tsx");
    expect(src).not.toMatch(/"Queued"|Waiting for the account/);
  });
});

describe("Get the app menu picture (F038)", () => {
  it("never cuts the menu label with an ellipsis; the menu is as wide as its words", () => {
    const css = read("src", "styles", "system.css");
    const label = /\.art__label\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(label).not.toMatch(/text-overflow:\s*ellipsis|white-space:\s*nowrap/);
    const menu = /\.art--menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(menu).toMatch(/width:\s*max-content/);
    expect(menu).toMatch(/max-width:\s*100%/);
  });
});

describe("public pages (F039, F056, F063)", () => {
  const pages = ["public/about.html", "public/legal/privacy.html", "public/legal/terms.html"];
  it.each(pages)("%s shows the app's logo and groups the page links", (page) => {
    const html = read(page);
    expect(html).toContain('<a class="brand" href="/about.html">Clip <em>Factory</em></a>');
    expect(html).toMatch(/<span class="links">\s*<a [^>]*>[^<]+<\/a>\s*<a [^>]*>[^<]+<\/a>\s*<\/span>/);
  });
  it("site.css: regular-weight logo with italic Factory, app font stacks, 44 px link targets", () => {
    const css = read("public", "legal", "site.css");
    const tokens = read("src", "styles", "tokens.css");
    const brand = /nav \.brand\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(brand).toMatch(/font-weight:\s*400/);
    expect(brand).not.toMatch(/font-style:\s*italic/);
    // Flex would drop the space between "Clip" and <em>Factory</em>: the logo stays an inline box.
    expect(brand).toMatch(/display:\s*inline-block/);
    expect(css).toMatch(/nav \.brand em\s*\{\s*font-style:\s*italic;/);
    expect(css).toMatch(/nav a,\s*footer a\s*\{[^}]*min-height:\s*44px/);
    for (const name of ["--font-ui", "--font-display"]) {
      const want = new RegExp(`${name}:\\s*([^;]+);`);
      expect(want.exec(css)?.[1]).toBe(want.exec(tokens)?.[1]);
    }
  });
});

describe("typography doc matches the code (F089)", () => {
  const doc = readFileSync(join(WEB, "..", "docs", "UX_DESIGN_SYSTEM.md"), "utf8");
  const typography = doc.slice(doc.indexOf("## Typography"), doc.indexOf("## Layout and spacing"));
  it("says the fonts are bundled, not loaded from Google Fonts", () => {
    expect(typography).not.toMatch(/loads from Google Fonts/);
    expect(typography).toMatch(/@fontsource-variable\/inter/);
    const main = read("src", "main.tsx");
    expect(main).toContain("@fontsource-variable/inter");
    expect(main).toContain("@fontsource/tinos");
  });
  it("every size in the table is the token's real value", () => {
    const tokens = read("src", "styles", "tokens.css");
    const pairs = [...typography.matchAll(/`(--fs-[a-z0-9-]+)` = `?([^`|]+?)`?(?: \(|\s*\|)/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(7);
    for (const [, name, value] of pairs) {
      const real = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1];
      expect(`${name} ${value!.trim()}`).toBe(`${name} ${real}`);
    }
  });
});
