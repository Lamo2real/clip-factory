// The page's own glass is the shell's (app/shell.ts; request 2: "The only shared element should be the application
// shell", "These two applications must not depend on each other's internal functionality"): each app states its wish
// for a transparent page (html.see-through: the desktop window's glass shows the desktop) and only the shell writes the
// class, from the wish of the app on screen. While Lamo Stories is switched off it is exactly Clip Factory's own toggle.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { appOnScreen, setAppOnScreen, setPageGlass, useAppOnScreen } from "../src/app/shell.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = document.documentElement;
const on = () => html.classList.contains("see-through");
afterEach(() => {
  setAppOnScreen("clips");
  setPageGlass("stories", false);
  setPageGlass("clips", false);
});

/** How often <html>'s class attribute was written while `fn` ran. */
async function writes(fn: () => void): Promise<number> {
  const seen: MutationRecord[] = [];
  const watch = new MutationObserver((r) => seen.push(...r));
  watch.observe(html, { attributes: true, attributeFilter: ["class"] });
  fn();
  await new Promise((r) => setTimeout(r, 0));
  seen.push(...watch.takeRecords());
  watch.disconnect();
  return seen.length;
}

describe("the shell's wish store for the page's glass", () => {
  it("with no panes (Lamo Stories off) Clip Factory's wish is the page's, at once, every time", () => {
    expect(appOnScreen()).toBe("clips");
    setPageGlass("clips", true);
    expect(on()).toBe(true);
    setPageGlass("clips", false);
    expect(on()).toBe(false);
    setPageGlass("clips", true);
    expect(on()).toBe(true);
  });

  it("the app on screen decides; the other one's wish waits, and is the page's the moment its app is back", () => {
    setPageGlass("clips", true);
    setPageGlass("stories", false);
    expect(on()).toBe(true);
    setAppOnScreen("stories");
    expect(on()).toBe(false);
    setPageGlass("stories", true);
    expect(on()).toBe(true);
    // Clip Factory's Look changes while Stories is on screen (synced from another device): the page stays Stories'.
    setPageGlass("clips", false);
    expect(on()).toBe(true);
    setPageGlass("clips", true);
    expect(on()).toBe(true);
    // Back in Clip Factory: its own latest wish, whatever Stories wanted.
    setAppOnScreen("clips");
    expect(on()).toBe(true);
    setPageGlass("clips", false);
    setAppOnScreen("stories");
    expect(on()).toBe(true);
    setAppOnScreen("clips");
    expect(on()).toBe(false);
    // Stories' wish changing while Clip Factory is on screen never touches the page.
    setPageGlass("stories", false);
    setPageGlass("stories", true);
    expect(on()).toBe(false);
  });

  it("the app hidden behind the other one never writes the page: no change of <html>'s class at all", async () => {
    setPageGlass("stories", true);
    setAppOnScreen("stories");
    expect(
      await writes(() => {
        for (const v of [false, true, false, true, false]) setPageGlass("clips", v);
      }),
    ).toBe(0);
    setAppOnScreen("clips");
    expect(
      await writes(() => {
        for (const v of [false, true, false]) setPageGlass("stories", v);
      }),
    ).toBe(0);
  });

  it("a wish for another root (a test's own <html>) is written there", () => {
    const other = document.createElement("html");
    setPageGlass("clips", true, other);
    expect(other.classList.contains("see-through")).toBe(true);
    setPageGlass("clips", false, other);
    expect(other.classList.contains("see-through")).toBe(false);
  });

  it("useAppOnScreen follows the shell as it switches", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const shown: string[] = [];
    function Probe() {
      shown.push(useAppOnScreen());
      return null;
    }
    act(() => root.render(<Probe />));
    act(() => setAppOnScreen("stories"));
    act(() => setAppOnScreen("stories"));
    act(() => setAppOnScreen("clips"));
    act(() => root.unmount());
    host.remove();
    expect(shown).toEqual(["clips", "stories", "clips"]);
  });
});

describe("only the shell writes html.see-through, and Stories never reaches into Clip Factory's page", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no file but app/shell.ts adds, removes or toggles the see-through class", () => {
    const writers = files(SRC)
      .filter((f) => /classList\.(add|remove|toggle)\(\s*["']see-through["']/.test(code(f)))
      .map((f) => relative(SRC, f));
    expect(writers).toEqual(["app/shell.ts"]);
  });

  it("no Stories file reads or changes Clip Factory's backdrop or <html>'s see-through", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "stories"))) {
      const text = code(f);
      if (/querySelector(All)?\([^)]*\.backdrop\b/.test(text)) bad.push(`${relative(SRC, f)}: finds Clip Factory's .backdrop`);
      if (/classList\.\w+\(\s*["']see-through["']/.test(text) || /\.see-through\b/.test(text)) bad.push(`${relative(SRC, f)}: reads or writes the see-through class`);
      if (/MutationObserver/.test(text) && /documentElement/.test(text)) bad.push(`${relative(SRC, f)}: watches <html>`);
    }
    // nor do Stories' style sheets style them
    const sheets = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return sheets(p);
        return name.endsWith(".css") ? [p] : [];
      });
    for (const f of sheets(join(SRC, "stories"))) {
      const text = code(f);
      if (/(^|[^\w-])\.backdrop\b/m.test(text) || /\.see-through\b/.test(text)) bad.push(`${relative(SRC, f)}: styles Clip Factory's backdrop or see-through`);
    }
    expect(bad).toEqual([]);
  });

  it("Stories' look.ts reaches outside Stories only for the shell", () => {
    const look = readFileSync(join(SRC, "stories", "look.ts"), "utf8");
    const outside = [...look.matchAll(/\bfrom\s*["'](\.\.\/[^"']+)["']/g)].map((m) => m[1]);
    expect(outside).toEqual(["../app/shell.ts"]);
  });
});
