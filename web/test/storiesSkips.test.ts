// Clips Funded's platform skips (web/src/stories/skips.ts; the owner, 24 Nov: "if i skip on a platform setup then i
// dont want to see it anywhere except in settings or social accounts tab"): what is left never holds a skipped
// platform, the platform pages' addresses, the kid-proof words, and Skip and Un-skip (the setup's own PATCH, then the
// setup, the dashboard and the page follow; a second tap while one is on its way does nothing; an error is a toast).
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import type { Onboarding, OnboardStep, Platform, StoriesApi } from "../src/stories/api/types.ts";
import { isSkippedPlatform, isSocialHref, leftOf, PLATFORM_STEPS, skippedLine, skipQuestion, socialHref, useSkip } from "../src/stories/skips.ts";
import { forgetDashboards, forgetOnboarding, useOnboarding } from "../src/stories/ui.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORDER: OnboardStep[] = ["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"];
const ob = (states: Partial<Record<OnboardStep, "done" | "skipped" | "todo">>): Onboarding => {
  const steps = ORDER.map((step) => ({ step, label: `L ${step}`, state: states[step] ?? ("todo" as const) }));
  return { steps, done: steps.filter((s) => s.state === "done").length, total: 11, finishedAt: null };
};

describe("the pure parts", () => {
  it("knows the five platform steps, in the setup's order", () => {
    expect(PLATFORM_STEPS).toEqual(["instagram", "tiktok", "youtube", "facebook", "x"]);
  });

  it("a skipped platform is a platform step in state skipped; a step of another kind skipped is not", () => {
    const o = ob({ x: "skipped", video: "skipped", youtube: "done" });
    const of = (step: OnboardStep) => o.steps.find((s) => s.step === step)!;
    expect(isSkippedPlatform(of("x"))).toBe(true);
    expect(isSkippedPlatform(of("video"))).toBe(false);
    expect(isSkippedPlatform(of("youtube"))).toBe(false);
    expect(isSkippedPlatform(of("tiktok"))).toBe(false);
  });

  it("leftOf: not done, not Done itself, never a skipped platform; a step skipped for later stays", () => {
    const o = ob({ ai: "done", x: "skipped", tiktok: "skipped", video: "skipped", youtube: "done" });
    expect(leftOf(o).map((s) => s.step)).toEqual(["model", "effort", "video", "agents", "instagram", "facebook"]);
    // the owner's case: X was the only step left, and he skipped it
    const owner = ob(Object.fromEntries(ORDER.map((s) => [s, s === "x" ? "skipped" : "done"])));
    expect(leftOf(owner)).toEqual([]);
  });

  it("each platform has its own page under Social accounts, and both kinds of address count as Social accounts", () => {
    expect(socialHref("youtube")).toBe("/stories/connections/youtube");
    expect(socialHref("x")).toBe("/stories/connections/x");
    for (const href of ["/stories/connections", "/stories/connections/", "/stories/connections/tiktok", "/stories/connections/x?result=connected", "/stories/connections#more"])
      expect(isSocialHref(href), href).toBe(true);
    for (const href of ["/stories", "/stories/connections/myspace", "/stories/review/S1", "/stories/connectionsx", "/stories/connections/x/more", "/connections/x"])
      expect(isSocialHref(href), href).toBe(false);
  });

  it("says it in kid-proof words, with the platform's name", () => {
    expect(skipQuestion("tiktok")).toEqual({ title: "Skip TikTok?", text: "You won't post there until you set it up. You can come back here any time." });
    expect(skippedLine("x")).toBe("You won't post to X until you set it up.");
    expect(skippedLine("youtube")).toBe("You won't post to YouTube until you set it up.");
    for (const p of PLATFORM_STEPS) expect(`${skipQuestion(p).title} ${skipQuestion(p).text} ${skippedLine(p)}`).not.toMatch(/Funded Clips/);
  });
});

describe("useSkip", () => {
  let host: HTMLElement;
  let root: Root;
  let api: StoriesApi;
  let skips: ReturnType<typeof useSkip>;
  let setup: Onboarding | null;
  const after = vi.fn();

  function Probe() {
    skips = useSkip("stories", after);
    const o = useOnboarding("stories");
    useEffect(() => {
      setup = o.data;
    });
    return null;
  }

  beforeEach(async () => {
    localStorage.clear();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    after.mockReset();
    setup = null;
    api = mockStoriesApi();
    setStoriesApi(api);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(Probe))));
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    vi.restoreAllMocks();
  });

  const toasts = () => document.body.textContent ?? "";

  it("Skip saves the setup's own skip, then the setup, the dashboard and the page follow", async () => {
    const patch = vi.spyOn(api, "patchOnboarding");
    const dashboard = vi.spyOn(api, "dashboard");
    let ok = false;
    await act(async () => {
      ok = await skips.skip("tiktok");
    });
    expect(ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("stories", { step: "tiktok", skipped: true });
    expect(setup?.steps.find((s) => s.step === "tiktok")?.state).toBe("skipped");
    expect(setup?.total).toBe(10);
    expect(dashboard).toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain("Skipped. You can un-skip it here.");
    expect(skips.busy).toBeNull();
    expect((await api.social("stories")).accounts.find((a) => a.platform === "tiktok")?.skipped).toBe(true);
  });

  it("Un-skip brings it back, in one tap", async () => {
    await act(async () => {
      await skips.skip("x");
    });
    const patch = vi.spyOn(api, "patchOnboarding");
    let ok = false;
    await act(async () => {
      ok = await skips.unskip("x");
    });
    expect(ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("stories", { step: "x", skipped: false });
    expect(setup?.steps.find((s) => s.step === "x")?.state).toBe("todo");
    expect(setup?.total).toBe(11);
    expect(toasts()).toContain("X is back.");
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("a second tap while one is on its way does nothing; an error is a toast in plain words and false", async () => {
    let release = () => undefined as void;
    const held = new Promise<void>((r) => (release = r));
    const real = api.patchOnboarding.bind(api);
    const patch = vi.spyOn(api, "patchOnboarding").mockImplementation(async (ws, body) => {
      await held;
      return real(ws, body);
    });
    let first: Promise<boolean> = Promise.resolve(false);
    let second = true;
    await act(async () => {
      first = skips.skip("facebook");
      await Promise.resolve();
    });
    expect(skips.busy).toBe<Platform>("facebook");
    await act(async () => {
      second = await skips.unskip("facebook");
    });
    expect(second).toBe(false);
    release();
    await act(async () => {
      expect(await first).toBe(true);
    });
    expect(patch).toHaveBeenCalledTimes(1);

    patch.mockRejectedValueOnce(new ApiError(409, "conflict", "That is a Clips Funded page. Switch to Clips Funded first."));
    let ok = true;
    await act(async () => {
      ok = await skips.skip("instagram");
    });
    expect(ok).toBe(false);
    expect(toasts()).toContain("That is a Clips Funded page. Switch to Clips Funded first.");
    expect(skips.busy).toBeNull();
  });
});
