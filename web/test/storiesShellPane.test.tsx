// The shell between the two apps (docs/CONTRACTS.md §45.34; request 2 §2 "When I return to Clip Factory, I should see
// the existing application exactly as I left it"): each app, once shown, stays mounted; the one not on screen is
// hidden and inert and told it is not active (its title, focus and measuring stay quiet); a key press in Lamo Stories
// never reaches Clip Factory's window key handlers; an app hidden with a dialog open, or named `fresh`, opens fresh
// next time; StoriesApp's chunk is fetched once while idle, only while Lamo Stories is switched on.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/stories/StoriesApp.tsx", () => ({ StoriesApp: () => null, marker: "the StoriesApp chunk" }));

const { AppPanes, prefetchStoriesApp, resetStoriesChunk, storiesBehind, storiesGoLater, storiesModule, storiesOnScreen, takeParkedStoriesGo, useAppActive, useAppPane } = await import("../src/stories/pane.tsx");

/** A page with its own state (a counter) that says whether its app is on screen. */
function Page({ name }: { name: string }) {
  const [n, setN] = useState(0);
  const { active, clipsMounted } = useAppPane();
  return (
    <section data-page={name} data-active={String(active)} data-clips-mounted={String(clipsMounted)}>
      <button type="button" onClick={() => setN((x) => x + 1)}>
        {name} {n}
      </button>
    </section>
  );
}

function Plain() {
  return <p data-plain={String(useAppActive())} />;
}

describe("the two panes", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  const show = (on: "clips" | "stories", opts: { fresh?: "clips" | "stories" | null; clips?: React.ReactNode; stories?: React.ReactNode } = {}) =>
    act(() => root.render(<AppPanes on={on} fresh={opts.fresh ?? null} clips={opts.clips ?? <Page name="clips" />} stories={opts.stories ?? <Page name="stories" />} />));
  const pane = (app: string) => host.querySelector<HTMLElement>(`[data-app-pane="${app}"]`);
  const tap = (name: string) => act(() => host.querySelector<HTMLButtonElement>(`[data-page="${name}"] button`)!.click());

  it("mounts only the app on screen, as it lays out without a pane (display: contents)", () => {
    show("clips");
    expect(pane("clips")).not.toBeNull();
    expect(pane("stories")).toBeNull();
    expect(pane("clips")!.hidden).toBe(false);
    expect(pane("clips")!.hasAttribute("inert")).toBe(false);
    expect(pane("clips")!.style.display).toBe("contents");
    expect(host.querySelector('[data-page="clips"]')!.getAttribute("data-active")).toBe("true");
  });

  it("keeps both mounted once each was shown: the hidden one is hidden, inert and not active, and its state stays", () => {
    show("clips");
    tap("clips");
    tap("clips");
    show("stories");
    expect(pane("clips")!.hidden).toBe(true);
    expect(pane("clips")!.hasAttribute("inert")).toBe(true);
    expect(pane("clips")!.style.display).toBe("");
    expect(host.querySelector('[data-page="clips"]')!.getAttribute("data-active")).toBe("false");
    expect(host.querySelector('[data-page="stories"]')!.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-page="stories"]')!.getAttribute("data-clips-mounted")).toBe("true");
    tap("stories");
    show("clips");
    // Exactly as left: both counters kept their state, and the panes swapped.
    expect(host.querySelector('[data-page="clips"] button')!.textContent).toBe("clips 2");
    expect(host.querySelector('[data-page="stories"] button')!.textContent).toBe("stories 1");
    expect(pane("stories")!.hidden).toBe(true);
    expect(pane("stories")!.hasAttribute("inert")).toBe(true);
    expect(pane("clips")!.hidden).toBe(false);
    // The order in the page never changes, so nothing is ever mounted again.
    expect([...host.children].map((el) => el.getAttribute("data-app-pane"))).toEqual(["clips", "stories"]);
  });

  it("opened at a Lamo Stories page: Clip Factory mounts only when first shown, and says it is not mounted until then", () => {
    show("stories");
    expect(pane("clips")).toBeNull();
    expect(host.querySelector('[data-page="stories"]')!.getAttribute("data-clips-mounted")).toBe("false");
    show("clips");
    expect(pane("clips")).not.toBeNull();
  });

  it("is active everywhere outside the panes (Lamo Stories switched off)", () => {
    act(() => root.render(<Plain />));
    expect(host.querySelector("[data-plain]")!.getAttribute("data-plain")).toBe("true");
  });

  it("an app hidden with one of its dialogs open is not kept (the contract never keeps open sheets): it opens fresh", () => {
    function WithSheet() {
      const [n, setN] = useState(0);
      return (
        <div data-page="clips">
          <button type="button" onClick={() => setN((x) => x + 1)}>
            clips {n}
          </button>
          <div role="dialog" aria-modal="true">
            Delete this job?
          </div>
        </div>
      );
    }
    show("clips", { clips: <WithSheet /> });
    tap("clips");
    show("stories", { clips: <WithSheet /> });
    expect(pane("clips")).toBeNull();
    expect(host.textContent).not.toContain("Delete this job?");
    show("clips", { clips: <WithSheet /> });
    expect(host.querySelector('[data-page="clips"] button')!.textContent).toBe("clips 0");
  });

  it("an app named fresh (Clip Factory's skill editor, which asks Leave without saving?) is not kept either", () => {
    show("clips", { fresh: "clips" });
    tap("clips");
    show("stories", { fresh: "clips" });
    expect(pane("clips")).toBeNull();
    show("clips");
    expect(host.querySelector('[data-page="clips"] button')!.textContent).toBe("clips 0");
  });

  it("an app named fresh never draws behind the other, not even for the switch itself (it reads the live address)", () => {
    const seen: boolean[] = [];
    function Watch() {
      seen.push(useAppActive());
      return <p data-page="clips" />;
    }
    show("clips", { fresh: "clips", clips: <Watch /> });
    show("stories", { fresh: "clips", clips: <Watch /> });
    expect(pane("clips")).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean), "Clip Factory rendered hidden").toBe(true);
  });

  it("while Clip Factory is hidden its window key handlers hear nothing; React's own handlers and capture listeners do", () => {
    const heard: string[] = [];
    const onWindow = (e: KeyboardEvent) => heard.push(`window ${e.key}`);
    const onCapture = (e: KeyboardEvent) => heard.push(`capture ${e.key}`);
    window.addEventListener("keydown", onWindow);
    window.addEventListener("keydown", onCapture, true);
    const Field = () => <input aria-label="Lamo Stories field" onKeyDown={(e) => heard.push(`react ${e.key}`)} />;
    try {
      show("clips", { stories: <Field /> });
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(heard).toEqual(["capture Escape", "window Escape"]);
      heard.length = 0;
      show("stories", { stories: <Field /> });
      host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(heard).toEqual(["capture Escape", "react Escape"]);
      heard.length = 0;
      show("clips", { stories: <Field /> });
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(heard).toEqual(["capture Escape", "window Escape"]);
    } finally {
      window.removeEventListener("keydown", onWindow);
      window.removeEventListener("keydown", onCapture, true);
    }
  });
});

describe("where the owner is, and StoriesApp's chunk", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStoriesChunk();
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a Lamo Stories page is on screen only at /stories… and only while Lamo Stories is switched on", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    history.replaceState(null, "", "/stories/ideas");
    expect(storiesOnScreen()).toBe(false);
    localStorage.setItem("cf.storiesPreview", "1");
    expect(storiesOnScreen()).toBe(true);
    history.replaceState(null, "", "/library");
    expect(storiesOnScreen()).toBe(false);
    history.replaceState(null, "", "/storiesque");
    expect(storiesOnScreen()).toBe(false);
  });

  it("Lamo Stories is behind Clip Factory only while it is switched on and a Clip Factory page is on screen", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    history.replaceState(null, "", "/jobs");
    expect(storiesBehind()).toBe(false);
    localStorage.setItem("cf.storiesPreview", "1");
    expect(storiesBehind()).toBe(true);
    history.replaceState(null, "", "/stories/review");
    expect(storiesBehind()).toBe(false);
  });

  it("a page change after a wait never moves the owner out of Clip Factory: it waits until Lamo Stories is back", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories/setup");
    storiesGoLater("/stories");
    expect(location.pathname).toBe("/stories");
    expect(takeParkedStoriesGo()).toBeNull();
    history.replaceState(null, "", "/library");
    const before = history.length;
    storiesGoLater("/stories/production/S1", { replace: true });
    expect(location.pathname).toBe("/library");
    expect(history.length).toBe(before);
    expect(takeParkedStoriesGo()).toBe("/stories/production/S1");
    expect(takeParkedStoriesGo()).toBeNull();
  });

  it("fetches the chunk once while idle, and never while Lamo Stories is switched off", async () => {
    localStorage.setItem("cf.storiesPreview", "0");
    vi.useFakeTimers();
    prefetchStoriesApp();
    await vi.runAllTimersAsync();
    expect(storiesModule()).toBeNull();
    localStorage.setItem("cf.storiesPreview", "1");
    prefetchStoriesApp();
    prefetchStoriesApp();
    expect(storiesModule()).toBeNull();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await vi.waitFor(() => expect(storiesModule()).not.toBeNull());
    expect((storiesModule() as unknown as { marker: string }).marker).toBe("the StoriesApp chunk");
  });
});
