// The floating setup to-do list as a component (docs/CONTRACTS.md §17.13): the room it keeps while the setups load,
// what happens when they cannot be read, the skip question and the panel as a real dialog. A confirmed skip takes the
// row off the list and out of the count; Settings › Posting › Set up posting keeps it, with Un-skip (rule S). The window
// here is never 1440 px wide, so the list is the pill (the open column is covered end to end, e2e/setup-todo.spec.ts).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api, SetupOverview } from "../src/api/types.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { TODO_SEEN_KEY } from "../src/lib/setupTodo.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Api;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));
vi.mock("../src/lib/config.ts", () => ({ config: () => ({ wsUrl: "ws://test" }), isMock: true }));
vi.mock("../src/lib/live.ts", () => ({
  startLive: () => undefined,
  stopLive: () => undefined,
  useLiveEvents: () => undefined,
  useLivePoll: () => undefined,
  // Set up posting's Content Rewards card listens for its own live news.
  onLiveSignal: () => () => undefined,
}));

const { SessionProvider } = await import("../src/app/session.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { SetupTodo } = await import("../src/components/SetupTodo.tsx");
const { SetupList } = await import("../src/screens/settings/setup/SetupList.tsx");

let root: Root;
let app: HTMLElement;
const flush = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 150 && !ok(); i++) await flush(20);
  expect(ok(), what).toBe(true);
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const button = (name: string) => all("button, a").find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name)!;
const click = (el: HTMLElement) => act(async () => el.click());

/** The signed-in shell, as far as the list needs it: a page beside the list, inside `.app`. */
async function mount(page: ReactNode = <button type="button">On the page</button>) {
  app = document.createElement("div");
  app.className = "app";
  document.body.append(app);
  root = createRoot(app);
  await act(async () =>
    root.render(
      <ToastProvider>
        <SessionProvider onSignOut={() => undefined}>
          <div className="shell">
            <main id="main" tabIndex={-1}>
              {page}
            </main>
          </div>
          <SetupTodo />
        </SessionProvider>
      </ToastProvider>,
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Each test is a fresh sign-in: nothing remembered from the last one's setups (useLoad's cache).
  forgetLoaded();
  // jsdom has no matchMedia: a window that matches no width query (below 1440 px, so the pill).
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener: () => undefined, removeEventListener: () => undefined }));
  current = mockApi(seed());
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the list's room while the setups load", () => {
  /** A getSetup that answers only when the test says so. */
  function slowSetup() {
    const real = current;
    let answer!: (how: "ok" | "fail") => void;
    const asked = new Promise<"ok" | "fail">((r) => (answer = r));
    current = {
      ...real,
      getSetup: async (): Promise<SetupOverview> => {
        if ((await asked) === "fail") throw new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
        return real.getSetup();
      },
    };
    return answer;
  }

  it("a device that has seen the list keeps its room from the first paint, then shows the list in it", async () => {
    localStorage.setItem(TODO_SEEN_KEY, "1");
    const answer = slowSetup();
    await mount();
    await flush(300); // the settings are in; the setups are not
    const hold = q(".setup-todo")!;
    expect(hold.className).toContain("setup-todo--hold");
    // The same data-mode the list will have, so the page already leaves its strip; nothing to see or to reach.
    expect(hold.getAttribute("data-mode")).toBe("pill");
    expect(hold.getAttribute("aria-hidden")).toBe("true");
    expect(hold.childElementCount).toBe(0);
    expect(q(".setup-todo__pill")).toBeNull();

    answer("ok");
    await until(() => !!q(".setup-todo__pill"), "the pill shows");
    expect(q(".setup-todo--hold")).toBeNull();
    expect(q(".setup-todo")!.getAttribute("data-mode")).toBe("pill");
    expect(q(".setup-todo__pill")!.getAttribute("aria-label")).toBe("Set up posting: 0 of 5 done");
  });

  it("gives the room back when the setups cannot be read", async () => {
    localStorage.setItem(TODO_SEEN_KEY, "1");
    const answer = slowSetup();
    await mount();
    await flush(300);
    expect(q(".setup-todo--hold")).not.toBeNull();
    answer("fail");
    await until(() => !q(".setup-todo"), "the room is given back");
  });

  it("a device that has never seen the list holds no room before it knows", async () => {
    const answer = slowSetup();
    await mount();
    await flush(300);
    expect(q(".setup-todo")).toBeNull();
    answer("ok");
    await until(() => !!q(".setup-todo__pill"), "the pill shows");
    // From now on this device expects it.
    expect(localStorage.getItem(TODO_SEEN_KEY)).toBe("1");
  });

  it("shows nothing, and remembers nothing, when every platform is already skipped", async () => {
    await current.putSettings({ setupSkipped: ["youtube", "tiktok", "instagram", "facebook", "x"] });
    await mount();
    await flush(600);
    expect(q(".setup-todo")).toBeNull();
    expect(localStorage.getItem(TODO_SEEN_KEY)).toBeNull();
  });
});

describe("the panel and the skip question", () => {
  beforeEach(async () => {
    await mount();
    await until(() => !!q(".setup-todo__pill"), "the pill shows");
  });

  it("opens as a dialog with a row per platform; the page behind is out of reach until it closes", async () => {
    const pill = q(".setup-todo__pill")!;
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    await click(pill);
    const panel = q(".setup-todo-panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(all(".setup-todo-panel .todo-row").map((r) => r.dataset.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(all(".setup-todo-panel .todo-row").every((r) => r.dataset.state === "not_started")).toBe(true);
    // Focus is in the panel, and everything beside it is inert (the pill too; the panel covers it).
    expect(document.activeElement).toBe(button("Close the setup list"));
    expect(q(".shell")!.hasAttribute("inert")).toBe(true);
    expect(q(".setup-todo")!.hasAttribute("inert")).toBe(true);
    expect(q(".setup-todo-scrim")!.hasAttribute("inert")).toBe(false);

    await click(button("Close the setup list"));
    expect(q(".setup-todo-panel")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("Skip asks first; Keep it saves nothing; the confirmed skip takes the row off the list, and Un-skip in Settings brings it back", async () => {
    const put = vi.spyOn(current, "putSettings");
    await click(q(".setup-todo__pill")!);
    await click(button("Skip TikTok"));
    const sheet = q(".sheet")!;
    expect(sheet.textContent).toContain("Skip TikTok?");
    expect(sheet.textContent).toContain("You won't post there until you set it up. You can do it later in Settings.");
    // Keep it comes first, has the focus and is the strong button; Skip is plain glass with no motion of its own.
    const [keep, skip] = all(".sheet__actions .btn") as [HTMLElement, HTMLElement];
    expect(keep.textContent).toBe("Keep it");
    expect(keep.className).toContain("btn--primary");
    expect(document.activeElement).toBe(keep);
    expect(skip.textContent).toBe("Skip TikTok");
    expect(skip.className).toContain("btn--glass");
    expect(skip.hasAttribute("data-act")).toBe(false);

    await click(keep);
    expect(q(".sheet")).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(q(".todo-row[data-platform='tiktok']")!.dataset.state).toBe("not_started");

    // From the keyboard this time: the question gives the focus back to the row's Skip, which goes with the row.
    button("Skip TikTok").focus();
    await click(button("Skip TikTok"));
    await click(all(".sheet__actions .btn")[1]!);
    expect(q(".sheet")).toBeNull();
    // Off the list at once (no Un-skip there: only Settings has it), out of the count, and saved.
    expect(q(".todo-row[data-platform='tiktok']")).toBeNull();
    expect(all(".setup-todo-panel .todo-row").map((r) => r.dataset.platform)).toEqual(["youtube", "instagram", "facebook", "x"]);
    expect(all(".setup-todo-panel .todo-row").some((r) => r.dataset.state === "skipped")).toBe(false);
    expect(q("[aria-label='Un-skip TikTok']")).toBeNull();
    expect(put).toHaveBeenCalledWith({ setupSkipped: ["tiktok"] });
    expect(q(".setup-todo__pill")!.getAttribute("aria-label")).toBe("Set up posting: 0 of 4 done");
    expect(q(".setup-todo-panel .setup-todo__head")!.textContent).toContain("0/4");
    // The keyboard's place moved to the next row, never to the page behind the list.
    expect(document.activeElement).toBe(button("Set up Instagram"));

    // Un-skip lives in Settings › Posting › Set up posting: the TikTok card says Skipped, and one tap brings it back.
    act(() => root.unmount());
    document.body.innerHTML = "";
    put.mockClear();
    await mount(<SetupList />);
    await until(() => !!q("[data-skipped='tiktok']") && !!q(".setup-todo__pill"), "Settings and the pill show");
    expect(q(".setup-card[data-platform='tiktok'] .setup-card__state")!.textContent).toBe("Skipped");
    expect(q("[data-skipped='tiktok']")!.textContent).toContain("You won't post to TikTok until you set it up.");
    expect(q(".setup-todo__pill")!.getAttribute("aria-label")).toBe("Set up posting: 0 of 4 done");
    await click(button("Un-skip TikTok"));
    expect(put).toHaveBeenCalledWith({ setupSkipped: [] });
    expect(q("[data-skipped='tiktok']")).toBeNull();
    expect(q(".setup-card[data-platform='tiktok'] .setup-card__state")!.textContent).toBe("Not started");
    expect(q(".setup-todo__pill")!.getAttribute("aria-label")).toBe("Set up posting: 0 of 5 done");
    await click(q(".setup-todo__pill")!);
    expect(all(".setup-todo-panel .todo-row").map((r) => r.dataset.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(q(".setup-todo-panel .todo-row[data-platform='tiktok']")!.dataset.state).toBe("not_started");
  });
});

describe("Settings › Posting › Set up posting counts only what is not skipped (rule S)", () => {
  const title = () => q("#setup-posting-name")!.textContent;

  it("with TikTok skipped: 0 of 4 ready, and all five cards are still there", async () => {
    await current.putSettings({ setupSkipped: ["tiktok"] });
    await mount(<SetupList />);
    await until(() => !!q("[data-skipped='tiktok']"), "the skipped card shows");
    expect(title()).toBe("0 of 4 ready");
    expect(q(".setup-summary__ring")!.textContent).toBe("0/4");
    expect(q("#setup-todo-name")!.textContent).toBe("On your screen: 0 of 4 done");
    expect(all("ul[aria-label='The five platforms'] .setup-card").map((c) => c.dataset.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(all("[data-skip]").map((p) => p.dataset.skip)).toEqual(["youtube", "instagram", "facebook", "x"]);
    expect(button("Un-skip TikTok")).toBeTruthy();
  });

  it("with all five skipped: All skipped, no ring, every card with Un-skip, and no floating list", async () => {
    await current.putSettings({ setupSkipped: ["youtube", "tiktok", "instagram", "facebook", "x"] });
    await mount(<SetupList />);
    await until(() => all("[data-skipped]").length === 5, "every card says Skipped");
    expect(title()).toBe("All skipped");
    expect(q(".setup-summary__ring")).toBeNull();
    expect(q("#setup-todo-name")!.textContent).toBe("All done: the list is gone");
    expect(all(".setup-card__state").slice(0, 5).map((s) => s.textContent)).toEqual(["Skipped", "Skipped", "Skipped", "Skipped", "Skipped"]);
    for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) expect(button(`Un-skip ${name}`), name).toBeTruthy();
    await flush(300);
    expect(q(".setup-todo")).toBeNull();
  });
});
