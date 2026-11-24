import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A class named inside a :has() makes Chromium (WebView2, the Windows app) check every :has() above any element whose
// class changes: html:has(…) and :root:has(…) included, so it matches those against the whole document, both apps'
// panes, and restyles what hangs on them. .is-on moves on every tap of the workspace switch, every tab and every menu:
// named in one :has() (st-library.css's chosen pill on hover), it cost the switch's tap 4 to 7 ms of restyle under a 4x
// CPU throttle, in the tap's own task, and the slide no longer started on the tap's own frame on CI (§45.38, PR #185).
// Such a rule finds the element by an attribute that does not move on a tap instead (aria-selected there).

const SRC = join(import.meta.dirname, "..", "src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

/** Every :has(…) argument in a stylesheet, its own parentheses kept (comments taken out first). */
function hasArguments(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (let at = text.indexOf(":has("); at !== -1; at = text.indexOf(":has(", at + 1)) {
    let depth = 0;
    for (let i = at + 4; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        out.push(text.slice(at + 5, i));
        break;
      }
    }
  }
  return out;
}

describe("no :has() names a class a tap moves", () => {
  it("the stylesheets are found", () => {
    expect(cssFiles(SRC).length).toBeGreaterThan(20);
  });

  it("no :has() argument names .is-on", () => {
    const found = cssFiles(SRC).flatMap((file) =>
      hasArguments(readFileSync(file, "utf8"))
        .filter((arg) => /\.is-on(?![\w-])/.test(arg))
        .map((arg) => `${file.slice(SRC.length + 1)}: :has(${arg.trim()})`),
    );
    expect(found).toEqual([]);
  });
});
