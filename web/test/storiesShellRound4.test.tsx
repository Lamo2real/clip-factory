// The shell between the two apps, round 4 (docs/CONTRACTS.md §45.35 D16, D17, D18; request 2 §1 "These two
// applications must not depend on each other's internal functionality", §2 "When I return to Clip Factory, I should
// see the existing application exactly as I left it"):
// - each pane has its own error boundary: Lamo Stories breaking shows "Lamo Stories had a problem." with Try again
//   (a fresh mount) and Go to Clip Factory, and Clip Factory's pane, its state and its own fallback stay as they are;
// - a pane that is hidden has its playing videos and sounds paused; Lamo Stories' previews stop painting while it is
//   hidden; Clip Factory's confetti never draws over Lamo Stories (a no-op while Lamo Stories is switched off); a
//   Connect redirect that answers while Clip Factory is on screen waits for Lamo Stories to be back;
// - Clip Factory's pane carries its kept search (useKeptSearch), exactly window.location.search outside a pane;
// - on phones the toasts sit above an open sheet's buttons.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterLook } from "../src/stories/engine/types.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/stories/StoriesApp.tsx", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  StoriesApp: () => null,
}));

const pane = await import("../src/stories/pane.tsx");
const {
  AppPanes,
  AWAY_RAN_OUT,
  KeptSearchProvider,
  pauseMediaIn,
  StoriesPaneBoundary,
  storiesAwayLater,
  takeParkedStoriesAway,
  useAppActive,
  useKeptSearch,
} = pane;
const {
  chooseClips,
  currentChoice,
  rememberStoriesPath,
  resetWorkspaceMemory,
} = await import("../src/stories/workspace.ts");
const { burst } = await import("../src/lib/confetti.ts");
const { toastLift } = await import("../src/stories/StoriesApp.tsx");

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetWorkspaceMemory();
  history.replaceState(null, "", "/");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (node: React.ReactNode) => act(() => root.render(node));
/** A source file of the web app, as written. */
/** A stylesheet's text with its `@import "./x.css"` lines inlined in order (stories.css and studio.css are indexes). */
const withImports = (file: string): string =>
  readFileSync(file, "utf8").replace(
    /@import "\.\/([^"]+)";[^\n]*\n?/g,
    (_m, f: string) => withImports(join(dirname(file), f)) + "\n",
  );
const source = (path: string) =>
  withImports(join(import.meta.dirname, "..", "src", path));
const q = <T extends Element = HTMLElement>(sel: string) =>
  host.querySelector<T>(sel);
const buttonNamed = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name,
  )!;

function Counter({ name }: { name: string }) {
  const [n, setN] = useState(0);
  return (
    <button
      type="button"
      data-counter={name}
      onClick={() => setN((x) => x + 1)}
    >
      {name} {n}
    </button>
  );
}

let throwNow = true;
function Breaks() {
  if (throwNow) throw new Error("Lamo Stories broke");
  return <p data-stories-ok="">Lamo Stories is back</p>;
}

describe("each app has its own error boundary (§45.35 D16)", () => {
  beforeEach(() => {
    throwNow = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("Lamo Stories breaking shows its own card, and Clip Factory's pane and its state stay as they were", () => {
    const onClips = vi.fn();
    const stories = (
      <StoriesPaneBoundary onClips={onClips}>
        <Breaks />
      </StoriesPaneBoundary>
    );
    render(
      <AppPanes
        on="clips"
        clips={<Counter name="clips" />}
        stories={stories}
      />,
    );
    act(() => q<HTMLButtonElement>("[data-counter=clips]")!.click());
    render(
      <AppPanes
        on="stories"
        clips={<Counter name="clips" />}
        stories={stories}
      />,
    );
    const card = q('[data-app-pane="stories"] [data-stories-problem]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Clips Funded had a problem.");
    expect(card.textContent).toContain("Clip Factory is fine");
    expect(
      Array.from(card.querySelectorAll("button")).map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["Try again", "Go to Clip Factory"]);
    // Its pane is the main landmark while it is on screen.
    expect(card.id).toBe("main");
    // Clip Factory is untouched: still mounted (hidden behind), with its own state.
    expect(q("[data-counter=clips]")!.textContent).toBe("clips 1");
    render(
      <AppPanes
        on="clips"
        clips={<Counter name="clips" />}
        stories={stories}
      />,
    );
    expect(q('[data-app-pane="clips"]')!.hidden).toBe(false);
    expect(q("[data-counter=clips]")!.textContent).toBe("clips 1");
    // Hidden behind Clip Factory, the card never takes the page's main landmark.
    expect(q("[data-stories-problem]")!.id).toBe("");
  });

  it("Try again mounts Lamo Stories afresh; Go to Clip Factory is the owner's way out", () => {
    const onClips = vi.fn();
    render(
      <StoriesPaneBoundary onClips={onClips}>
        <Breaks />
      </StoriesPaneBoundary>,
    );
    act(() => buttonNamed("Go to Clip Factory").click());
    expect(onClips).toHaveBeenCalledTimes(1);
    throwNow = false;
    act(() => buttonNamed("Try again").click());
    expect(q("[data-stories-problem]")).toBeNull();
    expect(q("[data-stories-ok]")!.textContent).toBe("Lamo Stories is back");
  });

  it("Go to Clip Factory says Clip Factory on this device at once and opens Clip Factory's last page", () => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem(
      "cf.workspace",
      JSON.stringify({
        workspaceId: "stories",
        lastStoriesWorkspaceId: "stories",
        lastClipsPath: "/library?view=week",
        lastStoriesPath: "/stories/ideas",
      }),
    );
    resetWorkspaceMemory();
    rememberStoriesPath("/stories/ideas", "stories");
    expect(currentChoice().workspaceId).toBe("stories");
    expect(chooseClips()).toBe("/library?view=week");
    expect(currentChoice().workspaceId).toBe("clips");
    expect(JSON.parse(localStorage.getItem("cf.workspace")!).workspaceId).toBe(
      "clips",
    );
  });

  it("App.tsx gives each pane its boundary: Clip Factory's own (its fallback as before) and Lamo Stories' card", async () => {
    const app = source("app/App.tsx");
    // Each pane has its own toasts too (§45.38 A2): a toast of the app that is hidden waits for it.
    // Its Shell is given the page it keeps next to Clips Funded (held), so a slide to it opens there.
    expect(app).toMatch(/clips=\{\s*<KeptSearchProvider value=\{lastClipsSearch\.current\}>\s*<ToastScope active=\{!inStories\} onScreen=\{clipsOnScreen\} onError=\{clipsDenied\}>\s*<ErrorBoundary scope="app">\s*<Shell held=\{held\} \/>/);
    // Clips Funded' toasts carry its st-toast class (its Fraunces in the shell's toast box); Clip Factory's carry none.
    expect(app).toMatch(/stories=\{\s*<ToastScope active=\{inStories\} onScreen=\{storiesOnScreen\} onError=\{storiesDeniedSound\} className="st-toast">\s*<StoriesPaneBoundary onClips=\{\(\) => navigate\(chooseClips\(\)\)\}>\s*<StoriesHost/);
    // Clip Factory without Lamo Stories: the same Shell, with no pane and no new boundary around it.
    expect(app).toContain("{storiesEnabled() ? <BothApps /> : <Shell />}");
    // Campaign Home is kept now; only the skill editor opens fresh (§45.35 D18).
    expect(app).toContain(
      'const fresh = held.name === "skill" && held.mode !== "read" ? "clips" : null;',
    );
    expect(app).not.toContain("campaignStart");
  });
});

describe("the hidden app is quiet (§45.35 D17)", () => {
  /** A video (jsdom cannot play): `paused` and pause() as a browser has them. */
  function playing(el: HTMLMediaElement): { pause: ReturnType<typeof vi.fn> } {
    let paused = false;
    Object.defineProperty(el, "paused", {
      configurable: true,
      get: () => paused,
    });
    const pause = vi.fn(() => {
      paused = true;
    });
    Object.defineProperty(el, "pause", { configurable: true, value: pause });
    return { pause };
  }

  it("a pane that is hidden has every playing video and sound in it paused; the one on screen keeps playing", () => {
    const Clips = () => (
      <div>
        <video data-v="clips" />
        <audio data-a="clips" />
      </div>
    );
    const Stories = () => <video data-v="stories" />;
    render(<AppPanes on="clips" clips={<Clips />} stories={<Stories />} />);
    const v = playing(q<HTMLVideoElement>("[data-v=clips]")!);
    const a = playing(q<HTMLAudioElement>("[data-a=clips]")!);
    render(<AppPanes on="stories" clips={<Clips />} stories={<Stories />} />);
    expect(v.pause).toHaveBeenCalledTimes(1);
    expect(a.pause).toHaveBeenCalledTimes(1);
    const s = playing(q<HTMLVideoElement>("[data-v=stories]")!);
    render(<AppPanes on="clips" clips={<Clips />} stories={<Stories />} />);
    expect(s.pause).toHaveBeenCalledTimes(1);
    // Already paused ones are left alone.
    expect(pauseMediaIn(q('[data-app-pane="clips"]'))).toBe(0);
    expect(pauseMediaIn(null)).toBe(0);
  });

  it("Clip Factory's confetti never draws while a Lamo Stories page is on screen, and draws as before everywhere else", () => {
    vi.stubGlobal("matchMedia", (m: string) => ({
      matches: false,
      media: m,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => new Proxy({}, { get: () => () => undefined }) as never,
    );
    const bursts = () => document.querySelectorAll("canvas.confetti").length;
    // Lamo Stories switched off: /stories is just an address Clip Factory does not know, and the burst draws.
    localStorage.setItem("cf.storiesPreview", "0");
    history.replaceState(null, "", "/stories");
    burst();
    expect(bursts()).toBe(1);
    localStorage.setItem("cf.storiesPreview", "1");
    burst();
    expect(bursts()).toBe(1);
    history.replaceState(null, "", "/jobs");
    burst();
    expect(bursts()).toBe(2);
  });

  it("Lamo Stories' previews stop painting while hidden, and paint again once back", async () => {
    // A frame clock the test turns by hand: what is asked for waits in the queue until tick().
    let id = 0;
    const queue = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      "requestAnimationFrame",
      (fn: FrameRequestCallback) => (queue.set(++id, fn), id),
    );
    vi.stubGlobal("cancelAnimationFrame", (n: number) => queue.delete(n));
    vi.stubGlobal("matchMedia", (m: string) => ({
      matches: false,
      media: m,
      addEventListener() {},
      removeEventListener() {},
    }));
    let now = 0;
    const tick = () => {
      now += 1000;
      const due = [...queue.values()];
      queue.clear();
      for (const fn of due) fn(now);
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        return new Proxy({ canvas: this } as Record<string | symbol, unknown>, {
          get: (t, k) => (k in t ? t[k] : () => undefined),
        }) as never;
      },
    );
    const { CharacterPreview } =
      await import("../src/stories/preview/CharacterPreview.tsx");
    const look: CharacterLook = {
      body: "bean",
      skin: "#F6C9A0",
      height: 1,
      width: 1,
      hair: { style: "curly", color: "#3B2A20" },
      eyes: { shape: "round", color: "#2B2340" },
      brows: "thick",
      nose: "button",
      mouth: "wide",
      outfit: {
        top: "#FFC94A",
        bottom: "#62C6FF",
        accent: "#FF6F61",
        pattern: "stripes",
      },
      accessory: "scarf",
      outline: "#1C1842",
    };
    const Preview = () => (
      <CharacterPreview
        look={look}
        movementStyle="bouncy"
        size={40}
        label="Pip"
      />
    );
    render(
      <AppPanes
        on="stories"
        clips={<Counter name="clips" />}
        stories={<Preview />}
      />,
    );
    expect(queue.size).toBe(1);
    tick();
    // On screen it keeps painting: every frame asks for the next one.
    expect(queue.size).toBe(1);
    render(
      <AppPanes
        on="clips"
        clips={<Counter name="clips" />}
        stories={<Preview />}
      />,
    );
    // Hidden behind Clip Factory: the loop stopped, and nothing paints while time passes.
    expect(queue.size).toBe(0);
    tick();
    tick();
    expect(queue.size).toBe(0);
    render(
      <AppPanes
        on="stories"
        clips={<Counter name="clips" />}
        stories={<Preview />}
      />,
    );
    expect(queue.size).toBe(1);
    tick();
    expect(queue.size).toBe(1);
  });

  it("a Connect sign-in page that answers while Clip Factory is on screen waits, and goes when Lamo Stories is back", () => {
    const go = vi.fn();
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories/connections");
    const until = "2026-11-22T10:10:00.000Z";
    storiesAwayLater("https://accounts.example/authorize?a=1", until, go);
    expect(go).toHaveBeenCalledWith("https://accounts.example/authorize?a=1");
    expect(takeParkedStoriesAway()).toBeNull();
    history.replaceState(null, "", "/library");
    storiesAwayLater("https://accounts.example/authorize?a=2", until, go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(
      takeParkedStoriesAway(Date.parse("2026-11-22T10:05:00.000Z")),
    ).toEqual({
      url: "https://accounts.example/authorize?a=2",
      expired: false,
    });
    expect(takeParkedStoriesAway()).toBeNull();
    // StoriesApp takes it the moment it is on screen again (the same place a parked page change is taken).
    expect(source("stories/StoriesApp.tsx")).toMatch(
      /const away = takeParkedStoriesAway\(\);\s*if \(away && !away\.expired\) \{\s*location\.assign\(away\.url\);/,
    );
    const connections = source("stories/screens/Connections.tsx");
    expect(connections).toContain(
      'if (where === "away") storiesAwayLater(authorizeUrl, expiresAt);',
    );
    expect(connections).toContain("else storiesGoLater(authorizeUrl);");
    expect(connections).not.toContain("location.assign(authorizeUrl)");
  });

  it("a held sign-in page whose 10 minutes ran out before Lamo Stories was back is dropped, never opened", () => {
    const go = vi.fn();
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/library");
    storiesAwayLater(
      "https://accounts.example/authorize?a=3",
      "2026-11-22T10:10:00.000Z",
      go,
    );
    // Twenty minutes later: it ran out while Clip Factory was on screen.
    expect(
      takeParkedStoriesAway(Date.parse("2026-11-22T10:20:00.000Z")),
    ).toEqual({ url: "https://accounts.example/authorize?a=3", expired: true });
    expect(takeParkedStoriesAway()).toBeNull();
    // Exactly at its end it has run out too; with no end given it never runs out.
    storiesAwayLater(
      "https://accounts.example/authorize?a=4",
      "2026-11-22T10:10:00.000Z",
      go,
    );
    expect(
      takeParkedStoriesAway(Date.parse("2026-11-22T10:10:00.000Z"))?.expired,
    ).toBe(true);
    storiesAwayLater("https://accounts.example/authorize?a=5", null, go);
    expect(
      takeParkedStoriesAway(Date.parse("2030-01-01T00:00:00.000Z"))?.expired,
    ).toBe(false);
    expect(go).not.toHaveBeenCalled();
    expect(AWAY_RAN_OUT).toBe("That sign-in link ran out. Tap Connect again.");
    expect(source("stories/StoriesApp.tsx")).toContain(
      "if (away) toast.info(AWAY_RAN_OUT);",
    );
  });
});

describe("Clip Factory's kept search (§45.35 D18)", () => {
  function Shows() {
    return (
      <p data-search={useKeptSearch()} data-active={String(useAppActive())} />
    );
  }

  it("is exactly window.location.search outside a pane (Lamo Stories switched off), following the address", () => {
    history.replaceState(
      null,
      "",
      "/?campaign=200ea21b-be80-4db8-b552-8e32b148604e",
    );
    render(<Shows />);
    expect(q("[data-search]")!.getAttribute("data-search")).toBe(
      "?campaign=200ea21b-be80-4db8-b552-8e32b148604e",
    );
    history.replaceState(null, "", "/");
    render(<Shows />);
    expect(q("[data-search]")!.getAttribute("data-search")).toBe("");
  });

  it("inside Clip Factory's pane it is the kept page's search, whatever Lamo Stories' address says", () => {
    history.replaceState(null, "", "/stories/ideas?x=1");
    render(
      <KeptSearchProvider value="?campaign=200ea21b-be80-4db8-b552-8e32b148604e">
        <Shows />
      </KeptSearchProvider>,
    );
    expect(q("[data-search]")!.getAttribute("data-search")).toBe(
      "?campaign=200ea21b-be80-4db8-b552-8e32b148604e",
    );
    render(
      <KeptSearchProvider value="">
        <Shows />
      </KeptSearchProvider>,
    );
    expect(q("[data-search]")!.getAttribute("data-search")).toBe("");
  });

  it("NewJobForm reads its way and its start through the hook only (its one change)", async () => {
    const form = source("screens/home/NewJobForm.tsx");
    // From the shell, never from Lamo Stories' own files (§45.38 A3); with clipsGoLater, its one other change.
    expect(form).toContain('import { clipsGoLater, useKeptSearch } from "../../app/shell.ts";');
    expect(form).not.toMatch(/stories\//);
    expect(form).not.toMatch(/location\.search/);
    expect(form).toContain(
      'const way = campaignStart(search).campaignId ? "campaign" : "normal";',
    );
    expect(form).toContain(
      "const [start] = useState(() => fileStart(search));",
    );
    expect(form).toContain(
      "const [fromCampaign] = useState(() => campaignStart(search));",
    );
  });
});

describe("toasts on a phone clear an open sheet's buttons (§45.35 D21)", () => {
  const bar = (top: number, height = 80) => ({
    getBoundingClientRect: () => ({ top, height }) as DOMRect,
  });

  it("lifts them above the sheet's action bar on phones only, with 8 px of air", () => {
    expect(toastLift(bar(700), 390, 844)).toBe(844 - 700 + 8);
    expect(toastLift(bar(560), 320, 640)).toBe(88);
    expect(toastLift(bar(700), 1024, 844)).toBe(0);
    expect(toastLift(null, 390, 844)).toBe(0);
    // A bar that is not on screen (not laid out, or below the window) lifts nothing.
    expect(toastLift(bar(700, 0), 390, 844)).toBe(0);
    expect(toastLift(bar(900), 390, 844)).toBe(0);
  });

  it("Lamo Stories' stylesheet reads the lift only while StoriesApp sets it, on phones", async () => {
    const css = source("stories/styles/stories.css");
    expect(css).toMatch(
      /@media \(max-width: 767px\) \{\s*\.st-toasts-up \.toasts \{\s*bottom: var\(--st-toast-lift/,
    );
  });
});
