// Content Rewards screens drawn in jsdom (docs/CONTRACTS.md §38.6, §38.7): the money part's "Checking…" until the list
// was read to its end, its one vermilion step for each Finance answer, and the post line's buttons.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, CrConnection, CrMoney, CrOverview, CrSubmission } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { CrMoneyPart, moneySteps, moneyMainStep } = await import("../src/screens/money/CrMoneyPart.tsx");
const { CrPostLines } = await import("../src/components/CrPostLine.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { resetCr } = await import("../src/lib/contentRewards.ts");

const conn = (over: Partial<CrConnection> = {}): CrConnection => ({
  status: "connected",
  canSubmit: true,
  crLinked: {},
  stepsDone: [],
  pilotEmail: { to: "", subject: "", body: "", mailto: "" },
  ...over,
});
const money = (over: Partial<CrMoney> = {}): CrMoney => ({
  state: "ok",
  tag: "Content Rewards' numbers",
  asOf: new Date().toISOString(),
  stillEarningCents: 420,
  onItsWayCents: 0,
  readyToMoveCents: 1825,
  paidSoFarCents: 6240,
  lastPaidAt: "2026-11-18T10:00:00Z",
  waitingForBrand: 3,
  campaigns: [{ name: "GameFuel Clips", paidCents: 5410, pendingCents: 420 }],
  celebrations: [],
  ...over,
});
const overview = (c: CrConnection, m: CrMoney): CrOverview => ({ connection: c, campaigns: [], money: m, waitingSends: [] });

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  resetCr();
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function draw(node: React.ReactNode) {
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Money › Content Rewards", () => {
  it("says Checking… until paid-so-far is known, and tags the numbers as Content Rewards' own", async () => {
    current = { crOverview: async () => overview(conn(), money({ state: "checking", paidSoFarCents: null })) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).toContain("Checking…");
    expect(host.textContent).toContain("Content Rewards' numbers");
    expect(host.textContent).toContain("$4.20");
    expect(host.textContent).toContain("$18.25");
    expect(host.textContent).not.toContain("paid you");
  });

  it("shows the paid line once it is known", async () => {
    current = { crOverview: async () => overview(conn(), money()) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).toContain("Content Rewards paid you $62.40 so far · last money Wed 18 Nov");
    expect(host.textContent).toContain("3 clips are waiting for the brand.");
  });

  it("asks about Finance first, with no main button until it is answered", async () => {
    current = { crOverview: async () => overview(conn(), money()) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).toContain("Do you see Finance in the Content Rewards menu?");
    expect(host.querySelectorAll(".btn--primary")).toHaveLength(0);
  });

  it("then one vermilion step: Move money to Whop while $1 or more is ready", async () => {
    current = { crOverview: async () => overview(conn({ finance: false }), money()) };
    await draw(<CrMoneyPart />);
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    expect(main[0]!.textContent).toContain("Open Earnings");
    expect(host.textContent).toContain("18.25");
  });

  it("each Finance answer shows only its own steps", () => {
    expect(moneySteps(undefined)).toEqual([]);
    expect(moneySteps(false).map((s) => s.id)).toEqual(["move-whop", "move-withdraw", "bank-setup", "bank-cashout"]);
    expect(moneySteps(true).map((s) => s.id)).toEqual(["fin-setup", "move-withdraw", "fin-bank"]);
    expect(moneyMainStep(moneySteps(false), money({ readyToMoveCents: 50 }), [], false)).toBe("move-whop");
    expect(moneyMainStep(moneySteps(false), money({ readyToMoveCents: 50 }), ["move-whop", "bank-setup"], true)).toBe("bank-cashout");
  });
});

describe("the post line", () => {
  const sub = (over: Partial<CrSubmission>): CrSubmission => ({
    postId: "p1",
    clipId: "c1",
    clipTitle: "Big win",
    campaignId: "k1",
    campaignName: "FaZe Clips",
    platform: "youtube",
    url: "https://youtu.be/x",
    state: "sent",
    line: "",
    views: null,
    earned: null,
    openCampaignHref: "https://contentrewards.com/c/campaigns/k1",
    updatedAt: "2026-11-21T10:00:00Z",
    ...over,
  });

  it("send by hand: Copy and open is the vermilion, with Copy link and the green I sent it", async () => {
    await draw(<CrPostLines subs={[sub({ state: "send_by_hand", minutesLeft: 12 }), sub({ postId: "p2", platform: "instagram", state: "send_by_hand", minutesLeft: 20, url: "https://instagram.com/x" })]} onChange={() => undefined} primary />);
    expect(host.textContent).toContain("Send these 2 to Content Rewards now (12 min left)");
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    expect(main[0]!.textContent).toContain("Copy and open");
    expect(host.textContent).toContain("Copy link");
    expect(host.querySelector(".btn--leaf")!.textContent).toContain("I sent it");
  });

  it("not approved: Ask again, the hint, and Copy the words again", async () => {
    await draw(
      <CrPostLines
        subs={[sub({ state: "rejected", reason: { code: "refused", text: "", brandSaid: "Logo missing in the first seconds." }, appeal: { href: "https://contentrewards.com/c/submissions", words: "This clip follows the brief." } })]}
        onChange={() => undefined}
      />,
    );
    expect(host.textContent).toContain("Not approved: “Logo missing in the first seconds.”");
    expect(host.textContent).toContain("Next time: keep the logo on screen the whole clip.");
    expect(host.textContent).toContain("Ask again");
    expect(host.textContent).toContain("Copy the words again");
    expect(host.textContent).toContain("I asked");
  });

  it("not linked: Open Content Rewards settings and I linked it", async () => {
    await draw(<CrPostLines subs={[sub({ state: "not_sent", reason: { code: "not_linked", text: "" } })]} onChange={() => undefined} />);
    expect(host.textContent).toContain("Content Rewards didn't take it: Content Rewards doesn't know this YouTube account.");
    expect(host.textContent).toContain("Open Content Rewards settings");
    expect(host.textContent).toContain("I linked it");
  });
});
