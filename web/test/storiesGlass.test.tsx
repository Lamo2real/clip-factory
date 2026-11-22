// Clip Factory Stories' liquid-glass contract (web/src/stories/styles/GLASS-CONTRACT.md): the shared figures
// (stories/glass) render with their final props and stay accessible; the background is Stories' own setting
// (cf.stories.prefs, never Clip Factory's cf.prefs), Colours › Ember by default; every look's veils keep every word
// at 4.5:1 over the lightest pixel it can show, the measured ones over a white desktop or photo; the radius scale
// is one scale, concentric, about 30 % less round.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcDial, CreamCard, Glass, GlassPill, GlassToggle, MediaRow, PhoneTabHighlight, RoundGlassButton, StatNumeral, Stepper, dialFraction, knobAt } from "../src/stories/glass/index.ts";
import {
  AA,
  EMBER,
  FROSTED,
  INKS,
  MEASURED,
  WHITE,
  applyStoriesLook,
  contrast,
  hexToRgb,
  holdWindowGlass,
  lookKind,
  minVeil,
  mix,
  readNativeGlass,
  setStoriesLook,
  storiesLook,
  useStoriesBackground,
  veilsFor,
  VEIL,
  type StoriesLook,
} from "../src/stories/look.ts";
import { LookSection } from "../src/stories/settings/LookSection.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.classList.remove("see-through");
});
const render = (el: React.ReactNode) => act(() => root.render(el));
const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);

describe("the figures", () => {
  it("Glass: the recipe as a component, its kind as a modifier, a tone for tinted", () => {
    render(
      <Glass variant="tinted" tone="111 217 164" as="section" aria-label="t">
        x
      </Glass>,
    );
    const el = $("section")!;
    expect(el.className).toBe("st-glass st-glass--tinted");
    expect(el.style.getPropertyValue("--st-tone-rgb")).toBe("111 217 164");
  });

  it("GlassPill: the chosen one is cream (is-on), a button by default", () => {
    const click = vi.fn();
    render(
      <>
        <GlassPill active onClick={click}>
          Living
        </GlassPill>
        <GlassPill as="span">Kitchen</GlassPill>
      </>,
    );
    const btn = $<HTMLButtonElement>("button.st-pill")!;
    expect(btn.classList.contains("is-on")).toBe(true);
    expect(btn.type).toBe("button");
    act(() => btn.click());
    expect(click).toHaveBeenCalledOnce();
    expect($("span.st-pill")?.classList.contains("is-on")).toBe(false);
  });

  it("RoundGlassButton: named by its label, the icon hidden, a dot when asked", () => {
    render(
      <RoundGlassButton label="Back" dot tone="accent">
        <svg />
      </RoundGlassButton>,
    );
    const b = $("button")!;
    expect(b.getAttribute("aria-label")).toBe("Back");
    expect(b.title).toBe("Back");
    expect(b.className).toContain("st-round-btn--accent");
    expect($(".st-round-btn__dot")).not.toBeNull();
  });

  it("StatNumeral: a big numeral, a small unit, a label", () => {
    render(<StatNumeral value={1234} unit="k" label="Views" hint="+3 this week" />);
    expect($(".st-stat__num")?.textContent).toBe("1,234");
    expect($(".st-stat__unit")?.textContent).toBe("k");
    expect($(".st-stat__label")?.textContent).toBe("Views");
  });

  it("ArcDial: a progress bar with its value and words, the knob on the arc", () => {
    render(<ArcDial value={3} max={5} label="Setup" valueText="3 of 5 steps done" />);
    const d = $("[role=progressbar]")!;
    expect(d.getAttribute("aria-label")).toBe("Setup");
    expect(d.getAttribute("aria-valuenow")).toBe("3");
    expect(d.getAttribute("aria-valuemax")).toBe("5");
    expect(d.getAttribute("aria-valuetext")).toBe("3 of 5 steps done");
    expect($(".st-dial__value")?.textContent).toBe("60%");
    expect(dialFraction(7, 5)).toBe(1);
    expect(dialFraction(Number.NaN)).toBe(0);
    // 240° open at the bottom: empty at the lower left, full at the lower right, half at the top.
    expect(knobAt(0.5)).toEqual({ x: 50, y: 8 });
    expect(knobAt(0).x).toBeLessThan(50);
    expect(knobAt(1).x).toBeGreaterThan(50);
  });

  it("Stepper: − and + change the value, never disabled, a tap past the end calls onLimit", () => {
    const change = vi.fn();
    const limit = vi.fn();
    render(<Stepper value={1} min={1} max={3} label="Scenes at a time" onChange={change} onLimit={limit} />);
    const [less, more] = Array.from(host.querySelectorAll<HTMLButtonElement>(".st-stepper__btn"));
    expect(host.querySelector("[disabled]")).toBeNull();
    expect(less!.getAttribute("aria-disabled")).toBe("true");
    act(() => less!.click());
    expect(limit).toHaveBeenCalledOnce();
    act(() => more!.click());
    expect(change).toHaveBeenCalledWith(2);
    expect($("[role=group]")?.getAttribute("aria-label")).toBe("Scenes at a time");
  });

  it("GlassToggle and CreamCard: a switch in the cream card's toggle slot", () => {
    const change = vi.fn();
    render(<CreamCard eyebrow="Next video" title="Bunny's big day" toggle={<GlassToggle checked label="Post it by itself" onChange={change} />} />);
    const sw = $("[role=switch]")!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    act(() => (sw as HTMLButtonElement).click());
    expect(change).toHaveBeenCalledWith(false);
    const card = $("section.st-cream.st-cream-card")!;
    expect(document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent).toBe("Bunny's big day");
  });

  it("MediaRow: a thumbnail, a progress bar and controls", () => {
    render(<MediaRow thumb="/x.jpg" title="Bunny's big day" meta="0:42" progress={0.25} progressText="0:10" controls={<RoundGlassButton label="Play">▶</RoundGlassButton>} />);
    expect($<HTMLImageElement>(".st-media__thumb img")?.getAttribute("src")).toBe("/x.jpg");
    expect($("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("25");
    expect($<HTMLElement>(".st-media__fill")?.style.width).toBe("25%");
    expect($(".st-media__controls button")).not.toBeNull();
    render(<MediaRow title="No bar" progress={null} />);
    expect($("[role=progressbar]")).toBeNull();
  });

  it("Stepper: its − and + are drawn signs (the same in every font), named for screen readers", () => {
    render(<Stepper value={2} label="Scenes at a time" onChange={() => undefined} />);
    const btns = Array.from(host.querySelectorAll<HTMLButtonElement>(".st-stepper__btn"));
    expect(btns.map((b) => b.querySelector("svg.st-stepper__sign")?.getAttribute("aria-hidden"))).toEqual(["true", "true"]);
    expect(btns.map((b) => b.textContent)).toEqual(["", ""]);
    expect(btns.map((b) => b.getAttribute("aria-label"))).toEqual(["Less: Scenes at a time", "More: Scenes at a time"]);
  });

  it("ArcDial: a warm gradient along the arc under an id that is safe in url(#…), and a shaded white knob", () => {
    render(<ArcDial value={0.4} label="Making the video" />);
    const grad = $("linearGradient")!;
    expect(grad.id).toMatch(/^st-dial-[A-Za-z0-9_-]+-arc$/);
    expect($(".st-dial__arc")?.getAttribute("stroke")).toBe(`url(#${grad.id})`);
    expect($(".st-dial__knob-shade")).not.toBeNull();
    expect($(".st-dial__knob")?.getAttribute("cx")).toBe(String(knobAt(0.4).x));
  });

  it("PhoneTabHighlight: the round highlight, decorative", () => {
    render(<PhoneTabHighlight />);
    expect($(".st-tab-orb")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the background is Stories' own", () => {
  it("defaults to Colours › Ember and keeps a choice in cf.stories.prefs only", () => {
    expect(storiesLook()).toMatchObject({ mode: "colours", strength: "clear", colours: [...EMBER] });
    setStoriesLook({ mode: "see-through", strength: "frosted" });
    expect(storiesLook()).toMatchObject({ mode: "see-through", strength: "frosted" });
    expect(localStorage.getItem("cf.prefs")).toBeNull();
    expect(localStorage.getItem("cf.stories.prefs")).toContain("look.mode");
  });

  it("See-through shows the window only in the desktop app; elsewhere the colours", () => {
    expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: "liquid" })).toBe("liquid");
    expect(readNativeGlass({ __CF_GLASS__: "liquid" })).toBe("none");
    expect(lookKind({ mode: "see-through", picture: null }, "none")).toBe("colours");
    expect(lookKind({ mode: "see-through", picture: null }, "mica")).toBe("window");
    expect(lookKind({ mode: "picture", picture: null }, "none")).toBe("colours");
  });

  it("the hook puts data-look and the veils on .stories-app, and see-through on the page only while it is shown", () => {
    setStoriesLook({ mode: "see-through", strength: "frosted" });
    (window as unknown as { __CF_DESKTOP__?: boolean; __CF_GLASS__?: string }).__CF_DESKTOP__ = true;
    (window as unknown as { __CF_GLASS__?: string }).__CF_GLASS__ = "vibrancy";
    function App({ active }: { active: boolean }) {
      const r = useRef<HTMLDivElement>(null);
      useStoriesBackground(r, active);
      return <div ref={r} className="stories-app" />;
    }
    try {
      render(<App active />);
      const el = $(".stories-app")!;
      expect(el.dataset.look).toBe("window");
      expect(el.dataset.strength).toBe("frosted");
      expect(el.style.getPropertyValue("--st-veil-page")).toBe("0.3");
      expect(el.style.getPropertyValue("--st-veil-card")).toBe("0.89");
      expect(document.documentElement.classList.contains("see-through")).toBe(true);
      render(<App active={false} />);
      expect(document.documentElement.classList.contains("see-through")).toBe(false);
    } finally {
      delete (window as unknown as { __CF_DESKTOP__?: boolean }).__CF_DESKTOP__;
      delete (window as unknown as { __CF_GLASS__?: string }).__CF_GLASS__;
    }
  });

  it("never takes away a see-through that Clip Factory put there itself", () => {
    const html = document.documentElement;
    html.classList.add("see-through");
    holdWindowGlass(true);
    holdWindowGlass(false);
    expect(html.classList.contains("see-through")).toBe(true);
  });

  it("Picture puts the owner's picture on the stage", () => {
    const el = document.createElement("div");
    const look: StoriesLook = { mode: "picture", strength: "clear", colours: [...EMBER], picture: "data:image/png;base64,AAAA" };
    expect(applyStoriesLook(el, look, "none", "simple")).toBe("picture");
    expect(el.style.getPropertyValue("--st-picture")).toContain("data:image/png");
    expect(el.dataset.glass).toBe("simple");
  });

  it("Settings › Look picks a background and keeps it", () => {
    render(<LookSection />);
    const opts = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=radiogroup] [role=radio]"));
    expect(opts.map((o) => o.querySelector(".st-stg-pick__label")?.textContent).slice(0, 3)).toEqual(["See-through", "Picture", "Colours"]);
    act(() => opts[0]!.click());
    expect(storiesLook().mode).toBe("see-through");
    expect(host.textContent).toContain("Frosted");
    expect(host.querySelector("[disabled]")).toBeNull();
    for (const bar of Array.from(host.querySelectorAll("[role=radiogroup]"))) expect(bar.querySelector(":scope > .glide")).not.toBeNull();
  });

  it("Settings › Look shows what each choice gives, Ember first among the colours, a picture row in Picture", () => {
    setStoriesLook({ mode: "colours", colours: [...EMBER] });
    render(<LookSection />);
    const art = Array.from(host.querySelectorAll(".st-look__art"));
    expect(art.map((a) => a.className.replace("st-look__art ", ""))).toEqual(["st-look__art--window", "st-look__art--picture", "st-look__art--colours"]);
    expect(art.every((a) => a.getAttribute("aria-hidden") === "true")).toBe(true);
    // Colours (the default): the presets, Ember chosen, each with its three swatches
    const presets = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Colours"] [role=radio]'));
    expect(presets.map((p) => p.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Ember", "Rose", "Lagoon"]);
    expect(presets[0]!.getAttribute("aria-checked")).toBe("true");
    expect(presets[0]!.querySelectorAll(".st-look__swatch")).toHaveLength(3);
    act(() => presets[1]!.click());
    expect(storiesLook().colours).toEqual(["#21121a", "#c8546a", "#f59a7a"]);
    // Picture: until one is chosen, a preview of Ember and the button to choose one (never disabled)
    act(() => host.querySelectorAll<HTMLButtonElement>('[aria-label="Background"] [role=radio]')[1]!.click());
    expect(storiesLook().mode).toBe("picture");
    expect($(".st-look__thumb")).not.toBeNull();
    expect(host.textContent).toContain("Choose a picture");
    expect(host.querySelector("[disabled]")).toBeNull();
    expect(localStorage.getItem("cf.prefs")).toBeNull();
  });
});

describe("every word stays readable", () => {
  const inks = Object.values(INKS).map(hexToRgb);
  const worst = (v: number) => Math.min(...inks.map((t) => contrast(t, mix(VEIL, WHITE, v))));

  it("the measured veils hold over a white desktop or photo", () => {
    for (const k of ["card", "hero", "rail", "bar", "float", "plate"] as const) expect(worst(MEASURED[k]), k).toBeGreaterThanOrEqual(AA);
    expect(MEASURED).toMatchObject({ card: 0.74, tinted: 0.8, hero: 0.76, rail: 0.78 });
    expect(minVeil(WHITE)).toBeLessThanOrEqual(MEASURED.card);
    // Frosted: a 0.30 frost over the desktop, then the panels at 0.89.
    expect(worst(FROSTED.card)).toBeGreaterThanOrEqual(AA);
    expect(FROSTED.page).toBe(0.3);
  });

  it("every look's veils keep every word at 4.5:1 (Ember, the other presets, the owner's own colours)", () => {
    for (const colours of [[...EMBER], ["#21121a", "#c8546a", "#ffae86"], ["#ffffff"], ["#fff000", "#00ffff", "#ff00ff"]]) {
      const v = veilsFor({ mode: "colours", strength: "clear", colours, picture: null }, "none");
      expect(v.card, colours.join()).toBeGreaterThanOrEqual(0.58);
      expect(v.card, colours.join()).toBeLessThanOrEqual(1);
    }
    const ember = veilsFor({ mode: "colours", strength: "clear", colours: [...EMBER], picture: null }, "none");
    expect(ember.page).toBe(0);
  });
});

describe("the tokens", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "glass-tokens.css"), "utf8");
  const px = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)?.[1]);

  it("are one radius scale, concentric, about 30 % less round than before (26 / 18 / 12 / 10 → 20 / 14 / 10 / 6)", () => {
    expect(px("--st-r-surface") - px("--st-gap-surface")).toBe(px("--st-r-control"));
    expect(px("--st-r-control") - px("--st-gap-control")).toBe(px("--st-r-inner"));
    expect(px("--st-r-inner") - px("--st-gap-control")).toBe(px("--st-r-tiny"));
    expect(px("--st-r-surface") - px("--st-bezel-pad")).toBe(px("--st-r-inner"));
    expect(px("--st-r-surface") / 26).toBeLessThan(0.8);
    expect(px("--st-r-control") / 18).toBeLessThan(0.8);
  });

  it("set headings in Playfair's display optical size, a little condensed, and numerals light", () => {
    const glass = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "glass.css"), "utf8");
    expect(/\.st-display \{[^}]*font-variation-settings: "opsz" var\(--st-opsz-display\)/.test(glass)).toBe(true);
    expect(css).toMatch(/--st-fs-min: 0\.8125rem/);
    expect(css).toMatch(/--st-weight-num: 300/);
  });

  it("define the four logo tokens and the warm palette", () => {
    for (const name of ["--st-mark-tile", "--st-mark-letter", "--st-mark-dot", "--st-wordmark", "--st-accent", "--st-cream", "--st-on-cream-orange", "--st-base"]) expect(css, name).toMatch(new RegExp(`${name}:`));
  });

  it("are the only place --st-* design tokens are defined (screens keep one-offs under their own prefix)", () => {
    const frame = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "st-frame.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(frame).not.toMatch(/--st-(ink|stage|panel|sun|font|shadow)[a-z0-9-]*\s*:/);
  });
});
