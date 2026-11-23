// Stories' See-through and Glass strength follow Stories' own Look (Settings › Look, cf.stories.prefs), never Clip
// Factory's Look or Glass strength (the owner, 23 Nov): with Clip Factory on Colours (no html.see-through) Stories
// still makes the page see-through while it is on screen, keeps it so when Clip Factory's look takes the class away
// again, and hides Clip Factory's own backdrop (its colours, picture or Frosted frost) so it draws nothing under it;
// with Clip Factory on Frosted, Stories' Clear is clear (only Stories' own --st-veil-page frosts). Clip Factory on
// screen: everything is as Clip Factory's settings left it.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdWindowGlass, setStoriesLook, useStoriesBackground } from "../src/stories/look.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Win = { __CF_DESKTOP__?: boolean; __CF_GLASS__?: string };
let host: HTMLDivElement;
let root: Root;
const html = document.documentElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  (window as unknown as Win).__CF_DESKTOP__ = true;
  (window as unknown as Win).__CF_GLASS__ = "vibrancy";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  html.classList.remove("see-through");
  delete html.dataset.strength;
  delete (window as unknown as Win).__CF_DESKTOP__;
  delete (window as unknown as Win).__CF_GLASS__;
});
const render = (el: React.ReactNode) => act(() => root.render(el));
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

function App({ active }: { active: boolean }) {
  const r = useRef<HTMLDivElement>(null);
  useStoriesBackground(r, active);
  return <div ref={r} className="stories-app" />;
}

/** What Clip Factory's own applyLook does for its Colours look (web/src/lib/look.ts): no see-through class. */
const clipFactoryColours = () => html.classList.toggle("see-through", false);

describe("See-through is Stories' own", () => {
  it("Clip Factory on Colours: Stories still shows the desktop while it is on screen, and keeps it", async () => {
    setStoriesLook({ mode: "see-through", strength: "clear" });
    clipFactoryColours();
    render(<App active />);
    expect(host.querySelector<HTMLElement>(".stories-app")!.dataset.look).toBe("window");
    expect(html.classList.contains("see-through")).toBe(true);
    expect(html.dataset.stWindow).toBe("1");
    // Clip Factory's look applies itself again (its prefs or the system's scheme changed): Stories' choice holds.
    clipFactoryColours();
    await settle();
    expect(html.classList.contains("see-through")).toBe(true);
    // Clip Factory on screen: its own look, exactly as its settings left it.
    render(<App active={false} />);
    await settle();
    expect(html.classList.contains("see-through")).toBe(false);
    expect(html.dataset.stWindow).toBeUndefined();
  });

  it("Clip Factory on See-through Frosted: Stories' Clear is clear and its Frosted is its own frost", () => {
    html.classList.add("see-through");
    html.dataset.strength = "frosted";
    setStoriesLook({ mode: "see-through", strength: "clear" });
    render(<App active />);
    const el = host.querySelector<HTMLElement>(".stories-app")!;
    expect(el.dataset.strength).toBe("clear");
    expect(el.style.getPropertyValue("--st-veil-page")).toBe("0");
    expect(html.dataset.stWindow).toBe("1");
    act(() => setStoriesLook({ mode: "see-through", strength: "frosted" }));
    expect(el.dataset.strength).toBe("frosted");
    expect(el.style.getPropertyValue("--st-veil-page")).toBe("0.3");
    // Clip Factory's own see-through is never taken away by Stories.
    render(<App active={false} />);
    expect(html.classList.contains("see-through")).toBe(true);
    expect(html.dataset.stWindow).toBeUndefined();
  });

  it("Stories' Colours or Picture never touch the page: no mark, no class", () => {
    setStoriesLook({ mode: "colours", strength: "clear" });
    render(<App active />);
    expect(html.classList.contains("see-through")).toBe(false);
    expect(html.dataset.stWindow).toBeUndefined();
    holdWindowGlass(false);
    expect(html.dataset.stWindow).toBeUndefined();
  });

  it("while Stories holds the window glass, Clip Factory's own backdrop draws nothing under it, even redrawn", async () => {
    // Clip Factory's Backdrop (components/Backdrop.tsx) as App.tsx draws it, beside the panes.
    const shell = document.createElement("div");
    const colours = document.createElement("div");
    colours.className = "backdrop backdrop--colours";
    shell.append(colours);
    document.body.append(shell);
    try {
      setStoriesLook({ mode: "see-through", strength: "clear" });
      clipFactoryColours();
      render(<App active />);
      expect(colours.style.display).toBe("none");
      // Clip Factory's look changes kind: its Backdrop is drawn anew in its place, and is hidden too.
      const frosted = document.createElement("div");
      frosted.className = "backdrop backdrop--frosted";
      colours.replaceWith(frosted);
      await settle();
      expect(frosted.style.display).toBe("none");
      // Clip Factory on screen: its backdrop is shown exactly as it draws it.
      render(<App active={false} />);
      expect(frosted.style.display).toBe("");
      expect(frosted.dataset.stHidden).toBeUndefined();
      // Stories' Colours never hides it.
      setStoriesLook({ mode: "colours", strength: "clear" });
      render(<App active />);
      expect(frosted.style.display).toBe("");
    } finally {
      shell.remove();
    }
  });
});
