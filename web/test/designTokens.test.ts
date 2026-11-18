// The design system doc and the CSS can't drift apart (audit F055): every token the doc's tables name exists in
// web/src/styles with the same value, every :root token in tokens.css is in the doc, and corner radii come from the
// --r-* scale.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = join(import.meta.dirname, "..", "src", "styles");
const DOC = readFileSync(join(import.meta.dirname, "..", "..", "docs", "UX_DESIGN_SYSTEM.md"), "utf8");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8");
const all = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .map((f) => [f, css(f)] as const);

/** Custom properties declared on :root in tokens.css (and :root blocks elsewhere, such as --green-text). */
function rootTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, text] of all)
    for (const block of text.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g))
      for (const m of block[1]!.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** Rows `| \`--token\` | \`value\` | ...` of the doc's token tables. */
function docRows(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of DOC.matchAll(/^\| `(--[a-z0-9-]+)` \| `([^`]+)` \|/gm)) out.set(m[1]!, m[2]!);
  return out;
}

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ");

describe("docs/UX_DESIGN_SYSTEM.md matches tokens.css", () => {
  const tokens = rootTokens();
  const rows = docRows();

  it("finds the doc's token tables", () => {
    expect(rows.size).toBeGreaterThanOrEqual(12);
  });

  it("every token in a doc table exists with the same value", () => {
    const wrong: string[] = [];
    for (const [name, value] of rows) {
      const real = tokens.get(name);
      if (real === undefined) wrong.push(`${name}: in the doc but not in web/src/styles`);
      else if (norm(real) !== norm(value)) wrong.push(`${name}: doc ${value}, css ${real}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every colour and radius token in tokens.css is in a doc table", () => {
    const tokensCss = css("tokens.css");
    const missing = [...tokensCss.matchAll(/(--(?:green|bone|vermilion|ink|on|r)(?:-[a-z0-9]+)*):/g)]
      .map((m) => m[1]!)
      .filter((n) => !n.endsWith("-rgb") && !rows.has(n));
    expect(missing).toEqual([]);
  });

  it("every --token the doc's prose names exists in the CSS", () => {
    const defined = new Set<string>();
    for (const [, text] of all) for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]!);
    // `.glass--green` style modifiers are class names, not tokens.
    const named = [...DOC.matchAll(/(?<![\w-])`(--[a-z][a-z0-9-]*)`/g)].map((m) => m[1]!);
    expect([...new Set(named)].filter((n) => !defined.has(n))).toEqual([]);
  });
});

describe("corner radii use the --r-* scale", () => {
  it("no border-radius is a hard-coded length of 8px or more", () => {
    const loose: string[] = [];
    for (const [file, text] of all) {
      if (file === "tokens.css") continue;
      for (const m of text.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+);/g))
        // A nested corner (`calc(var(--r-lg) - 6px)`, the inner radius of a padded box) follows the scale too.
        for (const part of m[1]!.replace(/calc\(var\(--r-[a-z]+\)[^)]*\)/g, "var(--r-sm)").split(/\s+/)) {
          if (/^var\(--r-(xs|sm|md|lg|xl|pill)\)$/.test(part) || /^(0|50%|inherit)$/.test(part)) continue;
          // Hairline bars and tiny thumbs (2-6px) may stay literal: they are below the smallest token on purpose.
          const px = /^(\d+(?:\.\d+)?)px$/.exec(part);
          if (px && Number(px[1]) < 8) continue;
          loose.push(`${file}: ${m[0]}`);
        }
    }
    expect(loose).toEqual([]);
  });
});
