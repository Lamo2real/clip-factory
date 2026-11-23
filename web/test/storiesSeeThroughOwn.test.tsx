// Stories' See-through and Glass strength follow Stories' own Look (Settings › Look, cf.stories.prefs), never Clip
// Factory's Look or Glass strength (the owner, 23 Nov), and neither app touches the other's page (request 2: "The only
// shared element should be the application shell", "These two applications must not depend on each other's internal
// functionality"). The shell owns it: it draws Clip Factory's own backdrop (components/Backdrop.tsx) only while Clip
// Factory is on screen (app/ClipsBackdrop.tsx), and it alone writes html.see-through, from the wish of the app on screen
// (app/shell.ts setPageGlass: Clip Factory's applyLook states Clip Factory's, Stories' look.ts states Stories').
//
// Everything here is the real thing, put together as App.tsx does: Clip Factory's real Backdrop drawn by the shell's
// ClipsBackdrop, the shell's real panes (stories/pane.tsx AppPanes), Stories' real useStoriesBackground (as StoriesApp
// calls it), and Clip Factory's Look changed with its real setPrefs (what Settings › Look and the session's refresh
// from another device both call). In the desktop app (window.__CF_GLASS__ = "vibrancy"), for Clip Factory on Colours,
// a Picture, See-through Clear and See-through Frosted, each with Stories' See-through Clear and Frosted, switching both
// ways and starting in either app; with Clip Factory's Look changed while Stories is on screen (the review's case:
// See-through, then Colours, then See-through again, synced from another device); and with Stories switched off.
import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipsBackdrop } from "../src/app/ClipsBackdrop.tsx";
import { appOnScreen, setPageGlass } from "../src/app/shell.ts";
import { Backdrop } from "../src/components/Backdrop.tsx";
import { setPrefs, type Prefs } from "../src/lib/prefs.ts";
import { AppPanes, useAppActive } from "../src/stories/pane.tsx";
import { setStoriesLook, useStoriesBackground, type GlassStrength } from "../src/stories/look.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Win = { __CF_DESKTOP__?: boolean; __CF_GLASS__?: string };
let host: HTMLDivElement;
let root: Root;
const html = document.documentElement;
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

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
  // Clip Factory's look as it was before: no wish of its own, nothing of it on <html>.
  setPageGlass("clips", false);
  for (const k of ["backdrop", "glass", "strength"]) delete html.dataset[k];
  for (const p of ["--backdrop-veil", "--panel-veil"]) html.style.removeProperty(p);
  delete (window as unknown as Win).__CF_DESKTOP__;
  delete (window as unknown as Win).__CF_GLASS__;
});
const render = (el: ReactNode) => act(() => root.render(el));

/** Lamo Stories' shell as StoriesApp is, for its background: the one call, with its pane's `active`. */
function StoriesPane() {
  const r = useRef<HTMLDivElement>(null);
  useStoriesBackground(r, useAppActive());
  return <div ref={r} className="stories-app" />;
}

/** The application shell as App.tsx draws it: Clip Factory's backdrop beside the panes (or its Shell alone, Stories off). */
function App({ on, stories = true }: { on: "clips" | "stories"; stories?: boolean }) {
  return (
    <>
      <ClipsBackdrop />
      {stories ? <AppPanes on={on} clips={<div className="app" />} stories={<StoriesPane />} /> : <div className="app" />}
    </>
  );
}

/** Clip Factory's Looks, as its Settings › Look saves them (setPrefs), and what each draws. */
const CLIPS: Record<string, { prefs: Partial<Prefs>; kind: string; backdrop: string; seeThrough: boolean; strength: string | null }> = {
  Colours: { prefs: { backgroundMode: "colours", backgroundColours: ["#e2621f", "#3355dd"], glassStrength: "clear", background: null }, kind: "colours", backdrop: "backdrop backdrop--colours", seeThrough: false, strength: null },
  "a Picture": { prefs: { backgroundMode: "picture", background: PICTURE, glassStrength: "clear" }, kind: "picture", backdrop: "backdrop has-image", seeThrough: false, strength: null },
  "See-through Clear": { prefs: { backgroundMode: "see-through", glassStrength: "clear", background: null }, kind: "window", backdrop: "backdrop backdrop--window", seeThrough: true, strength: "clear" },
  "See-through Frosted": { prefs: { backgroundMode: "see-through", glassStrength: "frosted", background: null }, kind: "window", backdrop: "backdrop backdrop--window", seeThrough: true, strength: "frosted" },
};
type ClipsLook = keyof typeof CLIPS;

/** Clip Factory's own backdrop as drawn now (every .backdrop outside Stories). */
const clipsBackdrops = () => [...document.querySelectorAll<HTMLElement>(".backdrop")].filter((b) => !b.closest(".stories-app")).map((b) => b.className);

/** Clip Factory on screen: exactly as its own Look says. */
function expectClips(look: ClipsLook, why: string) {
  const want = CLIPS[look]!;
  expect(html.classList.contains("see-through"), `${why}: html.see-through`).toBe(want.seeThrough);
  expect(html.dataset.backdrop, `${why}: data-backdrop`).toBe(want.kind);
  expect(html.dataset.strength ?? null, `${why}: data-strength`).toBe(want.strength);
  expect(clipsBackdrops(), `${why}: Clip Factory's backdrop`).toEqual([want.backdrop]);
  expect(appOnScreen()).toBe("clips");
}

/** Stories on screen in its own See-through: the page is transparent and nothing of Clip Factory's is drawn under it. */
function expectStories(strength: GlassStrength, why: string) {
  const el = host.querySelector<HTMLElement>(".stories-app")!;
  expect(el.dataset.look, `${why}: data-look`).toBe("window");
  expect(el.dataset.strength, `${why}: Stories' strength`).toBe(strength);
  expect(el.style.getPropertyValue("--st-veil-page"), `${why}: Stories' own frost`).toBe(strength === "frosted" ? "0.3" : "0");
  expect(html.classList.contains("see-through"), `${why}: html.see-through`).toBe(true);
  expect(clipsBackdrops(), `${why}: nothing of Clip Factory's under Stories`).toEqual([]);
  expect(appOnScreen()).toBe("stories");
}

describe("See-through is Stories' own, and the shell keeps the two apps apart", () => {
  for (const clips of Object.keys(CLIPS) as ClipsLook[])
    for (const strength of ["clear", "frosted"] as const) {
      it(`Clip Factory on ${clips}, Stories See-through ${strength}: from Clip Factory to Stories and back, twice`, () => {
        act(() => void setPrefs(CLIPS[clips]!.prefs));
        setStoriesLook({ mode: "see-through", strength });
        render(<App on="clips" />);
        expectClips(clips, "first on screen");
        render(<App on="stories" />);
        expectStories(strength, "Stories on screen");
        render(<App on="clips" />);
        expectClips(clips, "back in Clip Factory");
        render(<App on="stories" />);
        expectStories(strength, "Stories again");
        render(<App on="clips" />);
        expectClips(clips, "Clip Factory again");
      });

      it(`Clip Factory on ${clips}, Stories See-through ${strength}: opened in Stories, then Clip Factory and back`, () => {
        act(() => void setPrefs(CLIPS[clips]!.prefs));
        setStoriesLook({ mode: "see-through", strength });
        render(<App on="stories" />);
        expectStories(strength, "opened in Stories");
        render(<App on="clips" />);
        expectClips(clips, "over to Clip Factory");
        render(<App on="stories" />);
        expectStories(strength, "back in Stories");
      });
    }

  it("the review's case: Clip Factory's Look synced to Colours and back to See-through while Stories is on screen", () => {
    // Desktop app, Clip Factory on See-through (the default), Stories on screen with its own See-through.
    act(() => void setPrefs(CLIPS["See-through Clear"]!.prefs));
    setStoriesLook({ mode: "see-through", strength: "clear" });
    render(<App on="clips" />);
    render(<App on="stories" />);
    expectStories("clear", "Stories on screen");
    // Another device changes Clip Factory's Look: the session's refresh calls setPrefs with it, twice.
    act(() => void setPrefs({ backgroundMode: "colours" }));
    expectStories("clear", "Clip Factory synced to Colours");
    act(() => void setPrefs({ backgroundMode: "see-through" }));
    expectStories("clear", "Clip Factory synced back to See-through");
    // The owner switches to Clip Factory: its See-through page, the desktop showing, its own backdrop drawn.
    render(<App on="clips" />);
    expectClips("See-through Clear", "back in Clip Factory");
  });

  it("the same the other way: Clip Factory on Colours, synced to See-through while Stories is on screen", () => {
    act(() => void setPrefs(CLIPS.Colours!.prefs));
    setStoriesLook({ mode: "see-through", strength: "frosted" });
    render(<App on="clips" />);
    render(<App on="stories" />);
    expectStories("frosted", "Stories on screen");
    act(() => void setPrefs(CLIPS["See-through Clear"]!.prefs));
    expectStories("frosted", "Clip Factory synced to See-through");
    render(<App on="clips" />);
    expectClips("See-through Clear", "back in Clip Factory");
    // and to Colours while Stories is on screen once more: back in Clip Factory, no see-through
    render(<App on="stories" />);
    act(() => void setPrefs(CLIPS.Colours!.prefs));
    expectStories("frosted", "Clip Factory synced to Colours");
    render(<App on="clips" />);
    expectClips("Colours", "back in Clip Factory again");
  });

  it("Clip Factory's Look changed while Clip Factory is on screen and Stories is kept behind: Clip Factory's own at once", () => {
    setStoriesLook({ mode: "see-through", strength: "clear" });
    act(() => void setPrefs(CLIPS.Colours!.prefs));
    render(<App on="stories" />);
    render(<App on="clips" />);
    for (const look of ["See-through Frosted", "a Picture", "See-through Clear", "Colours"] as const) {
      act(() => void setPrefs(CLIPS[look]!.prefs));
      expectClips(look, `Clip Factory on ${look}`);
    }
  });

  it("Stories on its Colours or a Picture asks for no see-through: its own stage is the page, Clip Factory's is not drawn", () => {
    act(() => void setPrefs(CLIPS["See-through Clear"]!.prefs));
    setStoriesLook({ mode: "colours" });
    render(<App on="stories" />);
    expect(host.querySelector<HTMLElement>(".stories-app")!.dataset.look).toBe("colours");
    expect(html.classList.contains("see-through")).toBe(false);
    expect(clipsBackdrops()).toEqual([]);
    render(<App on="clips" />);
    expectClips("See-through Clear", "back in Clip Factory");
  });

  it("Stories going away (its pane let go) leaves the page to Clip Factory's own Look", () => {
    act(() => void setPrefs(CLIPS.Colours!.prefs));
    setStoriesLook({ mode: "see-through", strength: "clear" });
    render(<App on="stories" />);
    expectStories("clear", "Stories on screen");
    // Signed out: the panes are gone, Clip Factory's sign-in page is on screen.
    render(<App on="clips" stories={false} />);
    expectClips("Colours", "the panes gone");
  });
});

describe("Stories switched off: Clip Factory exactly as before", () => {
  for (const clips of Object.keys(CLIPS) as ClipsLook[])
    it(`Clip Factory on ${clips}: its own class, attributes and backdrop, the same DOM as its Backdrop alone`, () => {
      act(() => void setPrefs(CLIPS[clips]!.prefs));
      render(<App on="clips" stories={false} />);
      expectClips(clips, "Stories off");
      const shell = host.innerHTML;
      act(() => root.unmount());
      root = createRoot(host);
      render(
        <>
          <Backdrop />
          <div className="app" />
        </>,
      );
      expect(host.innerHTML).toBe(shell);
      expectClips(clips, "its Backdrop alone");
    });

  it("its Look changing is on the page at once, as before", () => {
    render(<App on="clips" stories={false} />);
    for (const look of ["See-through Clear", "Colours", "See-through Frosted", "a Picture", "See-through Clear"] as const) {
      act(() => void setPrefs(CLIPS[look]!.prefs));
      expectClips(look, `Clip Factory on ${look}`);
    }
  });
});
