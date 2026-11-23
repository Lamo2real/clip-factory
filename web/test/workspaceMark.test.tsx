// Clips Funded's logo (the owner, 22 Nov 2026: "the same logo as clip factory but with the colors in clip
// factory stories"): Clip Factory's own mark, the very same markup (components/ClipMark.tsx), recoloured only by the
// four tokens (--ws-mark-tile, --ws-mark-letter, --ws-mark-dot, --ws-wordmark), beside "Clips Funded", in the rail and
// the top bar; the round toggle that goes to Clips Funded shows it too, in Clips Funded's warm colours outside its app as
// well (the fallbacks are the very same colours its own stylesheet sets: the owner, 23 Nov). It is an element of the
// shell (components/WorkspaceMark.tsx, styles/ws-mark.css), so it carries nothing of Clips Funded's own look into Clip
// Factory's main bundle. The round toggle back to Clip Factory shows Clip Factory's real mark (its serif "C", bone tile
// and vermilion dot) in either app. Clip Factory's own mark stays exactly as it was. A workspace stored with the old
// default name shows today's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipMark } from "../src/components/ClipMark.tsx";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { WorkspaceMark, WorkspaceWordmark } from "../src/components/WorkspaceMark.tsx";
import { setStoriesApi } from "../src/stories/api/client.ts";
import type { StoriesApi, Workspace } from "../src/stories/api/types.ts";
import { resetWorkspaceMemory, switcherName } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { StoriesApp } = await import("../src/stories/StoriesApp.tsx");
const { ToggleMark } = await import("../src/app/WorkspaceDock.tsx");

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** ws-mark.css without its comments, one `selector { body }` per rule. */
const css = read("styles/ws-mark.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const m = new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1]!.replace(/\s+/g, " ");
};
/** The one rule whose selector is exactly `selector` (no list), in `from` (ws-mark.css by default). */
const only = (selector: string, from = css) => {
  const m = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(from);
  expect(m, selector).not.toBeNull();
  return m![1]!.replace(/\s+/g, " ");
};
/** Clip Factory's own brand styles (layout.css), without comments. */
const layout = read("styles/layout.css").replace(/\/\*[\s\S]*?\*\//g, "");
/** Clips Funded's own logo colours (glass-tokens.css §13, on .stories-app), as its stylesheet writes them. */
const warm = (name: string) => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(read("stories/styles/glass-tokens.css").replace(/\/\*[\s\S]*?\*\//g, ""));
  expect(m, name).not.toBeNull();
  return m![1]!.trim();
};
/** A colour as plain hex (#rrggbb), whether written as hex or rgb(r g b). */
const hex = (c: string) => {
  const rgb = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(c);
  return rgb ? `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : c.toLowerCase();
};

/** Clip Factory's mark exactly as App.tsx always drew it. */
const CLIPS_MARK = '<span class="brand__mark" aria-hidden="true">C<span class="brand__dot"></span></span>';

describe("the Clips Funded mark is Clip Factory's own mark", () => {
  it("uses the shared markup: the same C and dot, only with ws-mark added", () => {
    expect(renderToStaticMarkup(<ClipMark />)).toBe(CLIPS_MARK);
    expect(renderToStaticMarkup(<WorkspaceMark />)).toBe(CLIPS_MARK.replace('class="brand__mark"', 'class="brand__mark ws-mark"'));
    // The start-up card's big breathing one is Clip Factory's boot mark, in Clips Funded's colours.
    expect(renderToStaticMarkup(<WorkspaceMark boot />)).toBe(CLIPS_MARK.replace('class="brand__mark"', 'class="brand__mark ws-mark brand__mark--boot"'));
  });

  it("is coloured only by the four tokens, Clips Funded's own warm colours as fallbacks, and defines none of them", () => {
    // the warm logo (the owner, 23 Nov): the cream tile, the espresso "C", the orange dot, the cream words
    expect(rule(".ws-mark.brand__mark")).toContain("background: var(--ws-mark-tile, linear-gradient(150deg, #fff3e4, #f2dcc2))");
    expect(rule(".ws-mark.brand__mark")).toContain("color: var(--ws-mark-letter, #2a160b)");
    expect(rule(".ws-mark > .brand__dot")).toContain("background: var(--ws-mark-dot, #ff8a3d)");
    expect(rule(".ws-wordmark.ws-wordmark")).toContain("color: var(--ws-wordmark, #fff6ea)");
    // every fallback, on every rule, is exactly the colour Clips Funded's own stylesheet sets (glass-tokens.css §13)
    const fallbacks = [...css.matchAll(/var\((--ws-(?:mark-tile|mark-letter|mark-dot|wordmark)), ((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))+)\)/g)];
    expect(fallbacks.length).toBeGreaterThanOrEqual(7);
    for (const [, name, fallback] of fallbacks) expect(hex(fallback!.trim()), name).toBe(hex(warm(name!)));
    // and no old colour is left anywhere in the file (the sunshine tile, the indigo "C", the coral dot)
    expect(css).not.toMatch(/#ffc94a|#1c1842|#ff6f61|#fff6e5/i);
    // Clips Funded's own palette defines them (the redesign's tokens): never here.
    expect(css).not.toMatch(/--ws-(mark-tile|mark-letter|mark-dot|wordmark)\s*:/);
    // The mark brings its own styles, wherever it is drawn (also before Clips Funded's own styles load).
    expect(read("components/WorkspaceMark.tsx")).toContain('import "../styles/ws-mark.css";');
  });

  it("is a shell element: nothing of Clips Funded's own look or code rides into Clip Factory's main bundle", () => {
    // The markers of ci.yml's main-bundle check (--st- tokens, .st- classes, .stories-app), in the code and the styles,
    // comments too.
    for (const f of ["components/WorkspaceMark.tsx", "styles/ws-mark.css"]) expect(read(f), f).not.toMatch(/st-|stories-app/);
    expect(read("components/WorkspaceMark.tsx")).not.toMatch(/from "\.\.\/stories\//);
  });

  it("says Clips Funded in Clip Factory's wordmark type", () => {
    // One line, "Clips *Funded*", exactly as Clip Factory's own wordmark reads "Clip *Factory*".
    expect(renderToStaticMarkup(<WorkspaceWordmark />)).toBe(
      '<span class="ws-wordmark"><span class="ws-wordmark__main">Clips <em>Funded</em></span></span>',
    );
    expect(rule(".ws-wordmark.ws-wordmark")).toContain("font-family: var(--font-display)");
  });
});

describe("where Clips Funded shows its logo", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
    resetWorkspaceMemory();
    // The server has not answered yet: the frame (rail and top bar) is drawn all the same.
    setStoriesApi({ listWorkspaces: () => new Promise<Workspace[]>(() => undefined) } as Partial<StoriesApi> as StoriesApi);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    localStorage.clear();
  });

  it("the rail and the phone top bar: the shared mark and Clips Funded, no smiley left", async () => {
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    for (const where of [".st-rail", ".st-top"]) {
      const brand = host.querySelector<HTMLElement>(`${where} .st-brand`);
      expect(brand, where).not.toBeNull();
      expect(brand!.getAttribute("aria-label")).toBe("Clips Funded dashboard");
      const mark = brand!.querySelector(".brand__mark.ws-mark.st-brand__mark");
      expect(mark?.textContent, where).toBe("C");
      expect(mark?.querySelectorAll(".brand__dot")).toHaveLength(1);
      expect(brand!.querySelector(".ws-wordmark.st-brand__name")?.textContent).toBe("Clips Funded");
      expect(brand!.querySelector("svg"), where).toBeNull();
    }
    expect(host.textContent).not.toMatch(/Lamo Stories|Clip Factory Stories|Clip Stories|Funded Clips/);
  });

  it("the round toggle that goes to Clips Funded shows the same mark; the one back to Clip Factory keeps Clip Factory's C", async () => {
    await act(async () => root.render(<><ToggleMark type="stories" size={24} /><ToggleMark type="clips" size={24} /></>));
    const [stories, clips] = Array.from(host.children) as HTMLElement[];
    expect(stories!.matches(".ws-mark.ws-mark--sized.ws-round__mark")).toBe(true);
    expect(stories!.textContent).toBe("C");
    expect(stories!.querySelectorAll(".ws-mark__dot")).toHaveLength(1);
    expect(stories!.style.getPropertyValue("--ws-mark-size")).toBe("21px");
    // Never Clip Factory's own brand classes: Clip Factory's top bar, where this toggle sits, keeps one brand mark.
    expect(stories!.matches(".brand__mark") || stories!.querySelector(".brand__dot") !== null).toBe(false);
    expect(only(".ws-mark.ws-mark--sized")).toContain("background: var(--ws-mark-tile, linear-gradient(150deg, #fff3e4, #f2dcc2))");
    expect(only(".ws-mark.ws-mark--sized")).toContain("color: var(--ws-mark-letter, #2a160b)");
    expect(only(".ws-mark.ws-mark--sized > .ws-mark__dot")).toContain("background: var(--ws-mark-dot, #ff8a3d)");
    // The way back to Clip Factory: Clip Factory's real mark, the same small mark (its "C" and its dot, no picture of
    // a C drawn in lines), in Clip Factory's own colours: exactly .brand__mark's and .brand__dot's.
    expect(clips!.matches("span.ws-clipmark.ws-mark--sized.ws-round__mark")).toBe(true);
    expect(clips!.tagName).toBe("SPAN");
    expect(host.querySelector("svg")).toBeNull();
    expect(clips!.textContent).toBe("C");
    expect(clips!.querySelectorAll(".ws-mark__dot")).toHaveLength(1);
    expect(clips!.style.getPropertyValue("--ws-mark-size")).toBe("21px");
    expect(clips!.matches(".brand__mark") || clips!.querySelector(".brand__dot") !== null).toBe(false);
    const brand = only(".brand__mark", layout);
    const brandDot = only(".brand__dot", layout);
    const own = only(".ws-clipmark.ws-mark--sized");
    for (const prop of ["color", "background"]) {
      const want = new RegExp(`(?:^|; |\\s)${prop}: ([^;]+);`).exec(brand)![1]!;
      expect(own, prop).toContain(`${prop}: ${want};`);
    }
    expect(only(".ws-clipmark.ws-mark--sized > .ws-mark__dot")).toContain(`background: ${/background: ([^;]+);/.exec(brandDot)![1]!};`);
    // the same type as .brand__mark: the display serif, in italic (both small marks share the shape)
    const shape = rule(".ws-clipmark.ws-mark--sized");
    for (const decl of ["font-family: var(--font-display);", "font-style: italic;"]) {
      expect(brand, decl).toContain(decl);
      expect(shape, decl).toContain(decl);
    }
    // Clip Factory's own C on the toggle never carries the Clips Funded mark's class (nor its colours).
    expect(clips!.matches(".ws-mark")).toBe(false);
  });
});

describe("a workspace stored with the old default name", () => {
  it("shows as Clips Funded, and the stored record stays as it is", () => {
    const stored: Workspace = { workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {}, version: 3 };
    expect(switcherName(stored)).toBe("Clips Funded");
    expect(stored.workspaceName).toBe("Lamo Stories");
    // Any other name is the owner's own and stays.
    expect(switcherName({ ...stored, workspaceName: "Lamo Cars" })).toBe("Lamo Cars");
    expect(switcherName({ ...stored, workspaceName: "Clips Funded" })).toBe("Clips Funded");
    expect(switcherName({ ...stored, workspaceName: "Clip Factory" })).toBe("Clip Factory");
    // The default names between the renames (22-23 Nov 2026) show as today's too.
    expect(switcherName({ ...stored, workspaceName: "Clip Factory Stories" })).toBe("Clips Funded");
    expect(switcherName({ ...stored, workspaceName: "Clip Stories" })).toBe("Clips Funded");
    expect(switcherName({ ...stored, workspaceName: "Funded Clips" })).toBe("Clips Funded");
  });
});
