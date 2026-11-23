// Clip Factory Stories' logo (the owner, 22 Nov 2026: "the same logo as clip factory but with the colors in clip
// factory stories"): Clip Factory's own mark, the very same markup (components/ClipMark.tsx), recoloured only by the
// four Stories tokens (--st-mark-tile, --st-mark-letter, --st-mark-dot, --st-wordmark) with today's Stories colours as
// fallbacks, beside "Clip Factory Stories", in the rail and the top bar; the round toggle that goes to Stories shows it
// too. Clip Factory's own mark stays exactly as it was. A workspace stored with the old default name shows today's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipMark } from "../src/components/ClipMark.tsx";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { setStoriesApi } from "../src/stories/api/client.ts";
import type { StoriesApi, Workspace } from "../src/stories/api/types.ts";
import { StoriesMark, StoriesWordmark } from "../src/stories/brand/StoriesMark.tsx";
import { resetWorkspaceMemory, switcherName } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { StoriesApp } = await import("../src/stories/StoriesApp.tsx");
const { WorkspaceMark } = await import("../src/app/WorkspaceDock.tsx");

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** st-mark.css without its comments, one `selector { body }` per rule. */
const css = read("stories/styles/st-mark.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const m = new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1]!.replace(/\s+/g, " ");
};

/** Clip Factory's mark exactly as App.tsx always drew it. */
const CLIPS_MARK = '<span class="brand__mark" aria-hidden="true">C<span class="brand__dot"></span></span>';

describe("the Stories mark is Clip Factory's own mark", () => {
  it("uses the shared markup: the same C and dot, only with st-mark added", () => {
    expect(renderToStaticMarkup(<ClipMark />)).toBe(CLIPS_MARK);
    expect(renderToStaticMarkup(<StoriesMark />)).toBe(CLIPS_MARK.replace('class="brand__mark"', 'class="brand__mark st-mark"'));
    // The start-up card's big breathing one is Clip Factory's boot mark, in Stories' colours.
    expect(renderToStaticMarkup(<StoriesMark boot />)).toBe(CLIPS_MARK.replace('class="brand__mark"', 'class="brand__mark st-mark brand__mark--boot"'));
  });

  it("is coloured only by the four Stories tokens, today's Stories colours as fallbacks, and defines none of them", () => {
    expect(rule(".st-mark.brand__mark")).toContain("background: var(--st-mark-tile, #ffc94a)");
    expect(rule(".st-mark.brand__mark")).toContain("color: var(--st-mark-letter, #1c1842)");
    expect(rule(".st-mark > .brand__dot")).toContain("background: var(--st-mark-dot, #ff6f61)");
    expect(rule(".st-wordmark")).toContain("color: var(--st-wordmark, var(--st-ink, #fff6e5))");
    // Stories' own palette defines them (the redesign's tokens): never here.
    expect(css).not.toMatch(/--st-(mark-tile|mark-letter|mark-dot|wordmark)\s*:/);
    // The mark brings its own styles, wherever it is drawn (also before Stories' own styles load).
    expect(read("stories/brand/StoriesMark.tsx")).toContain('import "../styles/st-mark.css";');
  });

  it("says Clip Factory Stories in Clip Factory's wordmark type", () => {
    // "Clip Factory" exactly as Clip Factory's own wordmark, with "Stories" under it.
    expect(renderToStaticMarkup(<StoriesWordmark />)).toBe(
      '<span class="st-wordmark"><span class="st-wordmark__main">Clip <em>Factory</em></span> <span class="st-wordmark__sub">Stories</span></span>',
    );
    expect(rule(".st-wordmark")).toContain("font-family: var(--font-display)");
  });
});

describe("where Stories shows its logo", () => {
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

  it("the rail and the phone top bar: the shared mark and Clip Factory Stories, no smiley left", async () => {
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    for (const where of [".st-rail", ".st-top"]) {
      const brand = host.querySelector<HTMLElement>(`${where} .st-brand`);
      expect(brand, where).not.toBeNull();
      expect(brand!.getAttribute("aria-label")).toBe("Clip Factory Stories dashboard");
      const mark = brand!.querySelector(".brand__mark.st-mark.st-brand__mark");
      expect(mark?.textContent, where).toBe("C");
      expect(mark?.querySelectorAll(".brand__dot")).toHaveLength(1);
      expect(brand!.querySelector(".st-wordmark.st-brand__name")?.textContent).toBe("Clip Factory Stories");
      expect(brand!.querySelector("svg"), where).toBeNull();
    }
    expect(host.textContent).not.toMatch(/Lamo Stories/);
  });

  it("the round toggle that goes to Stories shows the same mark; the one back to Clip Factory keeps Clip Factory's C", async () => {
    await act(async () => root.render(<><WorkspaceMark type="stories" size={24} /><WorkspaceMark type="clips" size={24} /></>));
    const [stories, clips] = Array.from(host.children) as HTMLElement[];
    expect(stories!.matches(".st-mark.st-mark--sized.ws-mark")).toBe(true);
    expect(stories!.textContent).toBe("C");
    expect(stories!.querySelectorAll(".st-mark__dot")).toHaveLength(1);
    expect(stories!.style.getPropertyValue("--st-mark-size")).toBe("21px");
    // Never Clip Factory's own brand classes: Clip Factory's top bar, where this toggle sits, keeps one brand mark.
    expect(stories!.matches(".brand__mark") || stories!.querySelector(".brand__dot") !== null).toBe(false);
    expect(rule(".st-mark.st-mark--sized")).toContain("background: var(--st-mark-tile, #ffc94a)");
    expect(rule(".st-mark.st-mark--sized")).toContain("color: var(--st-mark-letter, #1c1842)");
    expect(rule(".st-mark--sized > .st-mark__dot")).toContain("background: var(--st-mark-dot, #ff6f61)");
    expect(clips!.matches("svg.ws-mark")).toBe(true);
  });
});

describe("a workspace stored with the old default name", () => {
  it("shows as Clip Factory Stories, and the stored record stays as it is", () => {
    const stored: Workspace = { workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {}, version: 3 };
    expect(switcherName(stored)).toBe("Clip Factory Stories");
    expect(stored.workspaceName).toBe("Lamo Stories");
    // Any other name is the owner's own and stays.
    expect(switcherName({ ...stored, workspaceName: "Lamo Cars" })).toBe("Lamo Cars");
    expect(switcherName({ ...stored, workspaceName: "Clip Factory Stories" })).toBe("Clip Factory Stories");
  });
});
