// Content Rewards screens drawn in jsdom (docs/CONTRACTS.md §38.6, §38.7): the money part's "Checking…" until the list
// was read to its end, its one vermilion step for each Finance answer, and the post line's buttons.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, CrConnection, CrMoney, CrOverview, CrSubmission } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { CrMoneyPart, amountChip, justMovedNow, moneySteps, moneyMainStep, readMoved, MOVED_FRESH_MS } = await import("../src/screens/money/CrMoneyPart.tsx");
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

  it("then one vermilion step: Move money to Whop while $1 or more is ready (Whop linked)", async () => {
    current = { crOverview: async () => overview(conn({ finance: false, stepsDone: ["move-whop"] }), money()) };
    await draw(<CrMoneyPart />);
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    expect(main[0]!.textContent).toContain("Open Earnings");
    expect(host.textContent).toContain("18.25");
  });

  it("a first-timer with money ready links Whop first (never Move money before step 1)", async () => {
    current = { crOverview: async () => overview(conn({ finance: false }), money()) };
    await draw(<CrMoneyPart />);
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    expect(main[0]!.textContent).toContain("Open Content Rewards settings");
  });

  it("each Finance answer shows only its own steps", () => {
    expect(moneySteps(undefined)).toEqual([]);
    expect(moneySteps(false).map((s) => s.id)).toEqual(["move-whop", "move-withdraw", "bank-setup", "bank-cashout"]);
    expect(moneySteps(true).map((s) => s.id)).toEqual(["fin-setup", "move-withdraw", "fin-bank"]);
    expect(moneyMainStep(moneySteps(false), money({ readyToMoveCents: 50 }), [], false)).toBe("move-whop");
    expect(moneyMainStep(moneySteps(false), money({ readyToMoveCents: 50 }), ["move-whop", "bank-setup"], true)).toBe("bank-cashout");
  });

  it("the main step follows the order a first-timer needs (§38.7)", () => {
    const no = moneySteps(false);
    const yes = moneySteps(true);
    // Money ready: the once-step first, then Move.
    expect(moneyMainStep(no, money(), [], false)).toBe("move-whop");
    expect(moneyMainStep(no, money(), ["move-whop"], false)).toBe("move-withdraw");
    expect(moneyMainStep(yes, money(), [], false)).toBe("fin-setup");
    expect(moneyMainStep(yes, money(), ["fin-setup"], false)).toBe("move-withdraw");
    // On its way to Whop: no vermilion (a calm line says so), never back to Link your Whop account.
    expect(moneyMainStep(no, money({ readyToMoveCents: 0, onItsWayCents: 1825 }), [], false)).toBeNull();
    // Just arrived on Whop: Add your bank first, then Get it to your bank.
    expect(moneyMainStep(no, money({ readyToMoveCents: 0 }), ["move-whop"], true)).toBe("bank-setup");
    expect(moneyMainStep(no, money({ readyToMoveCents: 0 }), ["move-whop", "bank-setup"], true)).toBe("bank-cashout");
    expect(moneyMainStep(yes, money({ readyToMoveCents: 0 }), ["fin-setup"], true)).toBe("fin-bank");
  });

  it("with Finance, Move money's hint points at Set up payouts (the step above on that path)", () => {
    const move = moneySteps(true).find((s) => s.id === "move-withdraw")!;
    expect(move.ifYouSee!.find((h) => /Connect payout account/.test(h.see))!.do).toBe("Do the step above: Set up payouts.");
    const moveNo = moneySteps(false).find((s) => s.id === "move-withdraw")!;
    expect(moveNo.ifYouSee!.find((h) => /Connect payout account/.test(h.see))!.do).toBe("Do the step above: link Whop.");
  });

  it("the Amount chip is never 0.00: Move copies what is ready, the bank step what was just moved", () => {
    expect(amountChip("move-withdraw", money(), null)).toBe("18.25");
    expect(amountChip("move-withdraw", money({ readyToMoveCents: 0 }), null)).toBeNull();
    expect(amountChip("move-withdraw", money({ readyToMoveCents: 50, onItsWayCents: 1825 }), null)).toBeNull();
    expect(amountChip("bank-cashout", money({ readyToMoveCents: 0 }), 1825)).toBe("18.25");
    expect(amountChip("bank-cashout", money({ readyToMoveCents: 0 }), null)).toBeNull();
  });

  it("money on its way: a calm line, no vermilion, and Link your Whop account counts as done", async () => {
    current = { crOverview: async () => overview(conn({ finance: false }), money({ readyToMoveCents: 0, onItsWayCents: 1825 })), crPatchConnection: async () => conn({ finance: false, stepsDone: ["move-whop"] }) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).toContain("Your $18.25 is on its way to Whop. It usually takes minutes.");
    expect(host.querySelectorAll(".btn--primary")).toHaveLength(0);
    expect(host.querySelector('[data-step="move-whop"]')!.getAttribute("data-done")).toBe("true");
  });

  it("then on Whop: the bank step's chip copies the amount that moved", async () => {
    localStorage.setItem("cf-cr-on-its-way", JSON.stringify({ onItsWay: 1825, lastMoveCents: 1825, moved: true }));
    current = { crOverview: async () => overview(conn({ finance: false, stepsDone: ["move-whop", "bank-setup"] }), money({ readyToMoveCents: 0, onItsWayCents: 0 })) };
    await draw(<CrMoneyPart />);
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    const bank = host.querySelector('[data-step="bank-cashout"]')!.textContent!;
    expect(bank).toContain("18.25");
    expect(bank).not.toContain("0.00");
  });

  it("a finished move to Whop: the API's movedAt when it sends one, else only what this device saw", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const fresh = readMoved(null);
    const hour = new Date(now - 3_600_000).toISOString();
    // Another device (nothing seen here): the API's movedAt leads the bank step, once per move.
    expect(justMovedNow(fresh, { onItsWayCents: 0, movedAt: hour }, now)).toBe(true);
    expect(justMovedNow({ ...fresh, seenMovedAt: hour }, { onItsWayCents: 0, movedAt: hour }, now)).toBe(false);
    expect(justMovedNow({ ...fresh, seenMovedAt: new Date(now - 9 * 86_400_000).toISOString() }, { onItsWayCents: 0, movedAt: hour }, now)).toBe(true);
    // Too old to say it just moved, or money on its way again: no.
    expect(justMovedNow(fresh, { onItsWayCents: 0, movedAt: new Date(now - MOVED_FRESH_MS - 1).toISOString() }, now)).toBe(false);
    // "Just finished" is one day: a move 23 hours ago still leads, one 2 days ago doesn't (he may have banked it since).
    expect(MOVED_FRESH_MS).toBe(86_400_000);
    expect(justMovedNow(fresh, { onItsWayCents: 0, movedAt: new Date(now - 23 * 3_600_000).toISOString() }, now)).toBe(true);
    expect(justMovedNow(fresh, { onItsWayCents: 0, movedAt: new Date(now - 2 * 86_400_000).toISOString() }, now)).toBe(false);
    expect(justMovedNow(fresh, { onItsWayCents: 500, movedAt: hour }, now)).toBe(false);
    // An API from before movedAt (absent) or before any move (null): this device's own memo, as before.
    expect(justMovedNow(fresh, { onItsWayCents: 0 }, now)).toBe(false);
    expect(justMovedNow({ ...fresh, onItsWay: 1825 }, { onItsWayCents: 0 }, now)).toBe(true);
    expect(justMovedNow({ ...fresh, onItsWay: 1825 }, { onItsWayCents: 0, movedAt: null }, now)).toBe(true);
    expect(justMovedNow({ ...fresh, onItsWay: 1825 }, { onItsWayCents: null, movedAt: hour }, now)).toBe(false);
    // The memo reads its older shapes.
    expect(readMoved("1825")).toEqual({ onItsWay: 1825, lastMoveCents: null, moved: true, seenMovedAt: null });
    expect(readMoved(JSON.stringify({ onItsWay: 0, lastMoveCents: 1825, moved: true }))).toEqual({ onItsWay: 0, lastMoveCents: 1825, moved: true, seenMovedAt: null });
  });

  it("on a device that never saw the move: the API's movedAt says Your money is on Whop, with the bank step the vermilion", async () => {
    const movedAt = new Date(Date.now() - 3_600_000).toISOString();
    current = { crOverview: async () => overview(conn({ finance: false, stepsDone: ["move-whop", "bank-setup"] }), money({ readyToMoveCents: 0, onItsWayCents: 0, movedAt })) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).toContain("Your money is on Whop. Move it to your bank.");
    const main = host.querySelectorAll(".btn--primary");
    expect(main).toHaveLength(1);
    expect(host.querySelector('[data-step="bank-cashout"] .btn--primary')).not.toBeNull();
    // The amount moved was seen on the other device only: no Amount chip is made up here.
    expect(host.querySelector('[data-step="bank-cashout"]')!.textContent).not.toContain("0.00");
    // Once per move on this device: the next visit doesn't lead with it again.
    expect(JSON.parse(localStorage.getItem("cf-cr-on-its-way")!).seenMovedAt).toBe(movedAt);
    act(() => root.unmount());
    resetCr();
    root = createRoot(host);
    await draw(<CrMoneyPart />);
    expect(host.textContent).not.toContain("Your money is on Whop. Move it to your bank.");
  });

  it("an API without movedAt and a device that saw nothing: no Your money is on Whop (as before)", async () => {
    current = { crOverview: async () => overview(conn({ finance: false, stepsDone: ["move-whop", "bank-setup"] }), money({ readyToMoveCents: 0, onItsWayCents: 0 })) };
    await draw(<CrMoneyPart />);
    expect(host.textContent).not.toContain("Your money is on Whop.");
  });

  it("per-campaign totals wait for the whole list: Checking… until paid-so-far is known", async () => {
    current = { crOverview: async () => overview(conn(), money({ state: "checking", paidSoFarCents: null })) };
    await draw(<CrMoneyPart />);
    expect(host.querySelector('[data-campaign-totals="checking"]')).not.toBeNull();
    expect(host.textContent).not.toContain("$54.10 paid");
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

  it("not approved: Ask again and the hint; Copy the words again and I asked only after Ask again", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await draw(
      <CrPostLines
        subs={[sub({ state: "rejected", reason: { code: "refused", text: "", brandSaid: "Logo missing in the first seconds." }, appeal: { href: "https://contentrewards.com/c/submissions", words: "This clip follows the brief." } })]}
        onChange={() => undefined}
      />,
    );
    expect(host.textContent).toContain("Not approved: “Logo missing in the first seconds.”");
    expect(host.textContent).toContain("Next time: keep the logo on screen the whole clip.");
    expect(host.textContent).toContain("Ask again");
    expect(host.textContent).not.toContain("Copy the words again");
    expect(host.textContent).not.toContain("I asked");
    const ask = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Ask again"))!;
    await act(async () => ask.click());
    expect(open).toHaveBeenCalledWith("https://contentrewards.com/c/submissions", "_blank", "noopener,noreferrer");
    expect(host.textContent).toContain("Copy the words again");
    expect(host.textContent).toContain("I asked");
    open.mockRestore();
  });

  it("the brand kept its answer: no more appeal buttons", async () => {
    await draw(
      <CrPostLines
        subs={[sub({ state: "rejected", reason: { code: "refused", text: "" }, appeal: { href: "https://contentrewards.com/c/submissions", words: "w", askedAt: new Date(Date.now() - 12 * 86_400_000).toISOString() } })]}
        onChange={() => undefined}
      />,
    );
    expect(host.textContent).toContain("The brand kept its answer. This one can't be asked again.");
    expect(host.textContent).not.toContain("Copy the words again");
    expect(host.textContent).not.toContain("Ask again");
  });

  it("a not-sent line shows the button names in bold, never raw ** marks", async () => {
    await draw(<CrPostLines subs={[sub({ state: "not_sent", reason: { code: "not_on_application", text: "" } }), sub({ postId: "p2", state: "not_sent", reason: { code: "not_linked", text: "" } })]} onChange={() => undefined} />);
    expect(host.textContent).not.toContain("**");
    expect([...host.querySelectorAll("strong")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Add accounts", "Accounts"]));
  });

  it("the brand's own quoted words never turn bold", async () => {
    await draw(<CrPostLines subs={[sub({ state: "rejected", reason: { code: "refused", text: "", brandSaid: "Use **our** logo" } })]} onChange={() => undefined} />);
    expect(host.querySelector(".cr-line strong")).toBeNull();
  });

  it("an X post whose Paid partnership switch didn't take names X, not YouTube", async () => {
    await draw(<CrPostLines subs={[sub({ platform: "x", paidLabel: "not_set" })]} onChange={() => undefined} />);
    expect(host.textContent).toContain("X didn't take the Paid partnership switch.");
    expect(host.textContent).not.toContain("YouTube didn't");
  });

  it("send by hand: the minutes count down from sendBy, the hint names the post's place, and a time-up send says Too late", async () => {
    const sendBy = new Date(Date.now() + 7.5 * 60_000).toISOString();
    await draw(<CrPostLines subs={[sub({ platform: "instagram", state: "send_by_hand", minutesLeft: 12, sendBy, openCampaignHref: "https://contentrewards.com/c/campaigns/x" })]} onChange={() => undefined} />);
    expect(host.textContent).toContain("(8 min left)");
    expect(host.textContent).toContain("You don't have a linked Instagram account");
    expect(host.textContent).not.toContain("linked YouTube account");
    expect(host.textContent).toContain("Open Content Rewards settings");
    await act(async () => root.render(<ToastProvider><CrPostLines subs={[sub({ state: "send_by_hand", minutesLeft: 12, sendBy: new Date(Date.now() - 60_000).toISOString() })]} onChange={() => undefined} /></ToastProvider>));
    expect(host.textContent).toContain("Too late to send this one.");
    expect(host.textContent).not.toContain("min left");
  });

  it("not added there: Open Content Rewards settings and I added it (§39.1)", async () => {
    await draw(<CrPostLines subs={[sub({ state: "not_sent", reason: { code: "not_linked", text: "" } })]} onChange={() => undefined} />);
    expect(host.textContent).toContain("Content Rewards didn't take it: Content Rewards doesn't know this YouTube account.");
    expect(host.textContent).toContain("Open Content Rewards settings");
    expect(host.textContent).toContain("I added it");
    expect(host.textContent).not.toContain("I linked it");
  });
});
