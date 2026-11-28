// Money › Can I earn? (docs/CONTRACTS.md §58): one card per connected app with the server's one word, eased bars,
// "Can't see this yet" for a number the app doesn't share, one Details fold, and nothing at all on an older API.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, MoneyView } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));
vi.mock("../src/lib/confetti.ts", () => ({ burst: vi.fn(), centerOf: () => undefined }));

const { EarnCards, CANT_SEE, EARN_TITLE, READY_TONE } = await import("../src/screens/money/EarnCards.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { buildMoneyView } = await import("../src/api/mock/money.ts");
const { CONFETTI, forgetPlayed } = await import("../src/lib/useMoney.ts");

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  forgetPlayed();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(view: MoneyView) {
  current = { getMoney: async () => view, seenMoney: vi.fn(async () => view) };
  await act(async () => {
    root.render(
      <ToastProvider>
        <EarnCards />
      </ToastProvider>,
    );
  });
}

const card = (platform: string) => host.querySelector<HTMLElement>(`[data-earn='${platform}']`);

describe("Can I earn?", () => {
  it("shows one card per connected app with the server's word, in app order", async () => {
    await show(buildMoneyView({ scenario: "start", country: null, seen: [] }));
    expect(host.querySelector("h2")?.textContent).toBe(EARN_TITLE);
    const cards = [...host.querySelectorAll<HTMLElement>("[data-earn]")];
    expect(cards.map((c) => c.dataset.earn)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(cards.map((c) => c.querySelector(".pill__text")?.textContent)).toEqual(["Not yet", "Not here", "Ready", "Invite", "Not yet"]);
    expect(card("tiktok")!.textContent).toContain("Creator Rewards isn't open in Sweden yet.");
    expect(card("instagram")!.className).toContain("is-ready");
    expect(card("youtube")!.querySelector("h3")!.textContent).toContain("YouTube Partner Program");
    // No money amounts and no buttons beyond the fold.
    expect(host.textContent).not.toMatch(/[$€£]\s?\d/);
    for (const c of cards) expect(c.querySelectorAll("button")).toHaveLength(1);
  });

  it("draws an eased bar per requirement, with 'or' between watch hours and Shorts views", async () => {
    await show(buildMoneyView({ scenario: "not_yet", country: "US", seen: [] }));
    const yt = card("youtube")!;
    const bars = [...yt.querySelectorAll<HTMLElement>(".earn-bar")];
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["81", "38", "12"]);
    expect(bars[0]!.getAttribute("aria-label")).toBe("812 / 1,000 subscribers");
    expect(yt.querySelectorAll(".money-goal__or")).toHaveLength(1);
    expect(yt.textContent).toContain("Keep posting. You're 37% there.");
  });

  it("says Can't see this yet instead of a number the app doesn't share", async () => {
    await show(buildMoneyView({ scenario: "goal_reached", country: "US", seen: [] }));
    const tt = card("tiktok")!;
    expect(tt.querySelector(".pill__text")!.textContent).toBe("Can't see");
    expect(tt.textContent).toContain(CANT_SEE);
    expect(tt.querySelectorAll(".earn-bar")).toHaveLength(0);
    expect(card("youtube")!.querySelector(".pill__text")!.textContent).toBe("Ready");
  });

  it("folds the details away: more goals, notes, where to look, the check day and the sources", async () => {
    await show(buildMoneyView({ scenario: "not_yet", country: "US", seen: [] }));
    const yt = card("youtube")!;
    const fold = yt.querySelector<HTMLButtonElement>("button")!;
    expect(fold.textContent).toBe("Details");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(yt.textContent).not.toContain("Checked");
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(yt.textContent).toContain("subscribers for fan money");
    expect(yt.textContent).toContain("Checked 28 Nov 2026");
    expect(yt.textContent).toContain("YouTube Studio › Earn");
    const source = yt.querySelector<HTMLAnchorElement>("a[href='https://support.google.com/youtube/answer/72851']")!;
    expect(source.target).toBe("_blank");
    act(() => fold.click());
    expect(yt.textContent).not.toContain("Checked");
  });

  it("shows the region note in the fold", async () => {
    await show(buildMoneyView({ scenario: "start", country: "SE", seen: [] }));
    const tt = card("tiktok")!;
    act(() => tt.querySelector<HTMLButtonElement>("button")!.click());
    expect(tt.textContent).toContain("Only open in the US");
  });

  it("renders nothing on an API from before this change, or with no connected app", async () => {
    const old = buildMoneyView({ scenario: "not_yet", country: "US", seen: [] });
    for (const c of old.platforms) delete c.ready;
    await show(old);
    expect(host.querySelector(".earn")).toBeNull();
    await show(buildMoneyView({ scenario: "not_connected", country: "US", seen: [] }));
    expect(host.querySelector(".earn")).toBeNull();
  });

  it("the ready and close parties, and no vermilion word", () => {
    expect(CONFETTI.ready).toBe(200);
    expect(CONFETTI.close).toBe(90);
    expect(Object.values(READY_TONE)).not.toContain("vermilion");
  });

  it("the pretend app's ready celebrations wait once each", () => {
    const view = buildMoneyView({ scenario: "earn_ready", country: "US", seen: [] });
    expect(view.celebrations.map((c) => [c.key, c.kind])).toEqual([
      ["youtube:ready", "ready"],
      ["instagram:ready", "ready"],
    ]);
    expect(buildMoneyView({ scenario: "earn_ready", country: "US", seen: ["youtube:ready"] }).celebrations.map((c) => c.key)).toEqual(["instagram:ready"]);
  });
});
