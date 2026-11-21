// The Content Rewards connect gaps the owner approved on 21 Nov 2026 (live check in the Mac app): Content Rewards never
// sends the browser back when it refuses at sign-in, so the page asks "What did Content Rewards say?" (while it waits,
// after Cancel, when the wait runs out) and never says "That took too long" then; the pilot email goes from the
// address he signs in with (Gmail's compose page for a Gmail address); the steps tick themselves when they are really
// known, so the one vermilion is the real next step; and a failed read says so on the Set up posting card.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, CrConnection, CrConnectionPatch, CrMoney, CrOverview, SetupOverview } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { ApiError } = await import("../src/api/errors.ts");
const { CrSetup } = await import("../src/screens/settings/setup/CrSetup.tsx");
const { CrCardPart } = await import("../src/screens/settings/setup/SetupList.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const lib = await import("../src/lib/contentRewards.ts");
const guide = await import("../src/setup/contentrewards.ts");
const { ASK_MIN_MS, ASK_RETURN_MS } = await import("../src/lib/crConnect.ts");
const { crMockApi } = await import("../src/api/mock/contentrewards.ts");

const { CR_ASK, CR_SAID_CANT, CR_LOGIN_ASK, CR_LOGIN_FIRST, CR_PILOT, CR_PILOT_EMAIL } = guide;

const conn = (over: Partial<CrConnection> = {}): CrConnection => ({
  status: "not_connected",
  canSubmit: false,
  crLinked: {},
  stepsDone: [],
  pilotEmail: { ...CR_PILOT_EMAIL, mailto: guide.pilotMailto() },
  ...over,
});
const money = { state: "not_connected", campaigns: [], celebrations: [] } as unknown as CrMoney;
const overview = (c: CrConnection): CrOverview => ({ connection: c, campaigns: [], money, waitingSends: [] });
const setupNone = { platforms: [], ready: 0, values: {} } as unknown as SetupOverview;

type Door = { status: string; state?: string; code?: string };
/** The Mac app's door, faked: `results` answers each poll (then "waiting"). */
function door(results: Door[] = []) {
  const b = {
    version: 1,
    canceled: 0,
    listen: vi.fn(async () => ({ port: 47811, expiresAt: "" })),
    open: vi.fn(async () => ({})),
    result: vi.fn(async () => results.shift() ?? { status: "waiting" }),
    cancel: vi.fn(async () => {
      b.canceled++;
      return {};
    }),
  };
  (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__ = b;
  return b;
}

let host: HTMLElement;
let root: Root;
let scrolledTo: string[] = [];
beforeEach(() => {
  lib.resetCr();
  sessionStorage.clear();
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  scrolledTo = [];
  window.scrollBy = () => undefined;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.id);
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  delete (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__;
});

async function flush(n = 4) {
  for (let i = 0; i < n; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}
async function draw(node: React.ReactNode) {
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush(3);
}
const vermilion = () => [...host.querySelectorAll(".btn--primary")].map((b) => b.textContent?.trim() ?? "");
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined | null) => {
  expect(el, "the button is on screen").toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const pilot = () => host.querySelector('[data-step="connect-pilot"]') as HTMLElement;

/** A fake API whose connection PATCH answers like the new API (or 400 like an older one). */
function fakeApi(start: CrConnection, { old = false } = {}) {
  let c = structuredClone(start);
  const patches: CrConnectionPatch[] = [];
  current = {
    crOverview: async () => overview(structuredClone(c)),
    getSetup: async () => setupNone,
    crConnect: async () => ({ authorizeUrl: "https://id.contentrewards.com/oauth2/authorize?x=1", expiresAt: "" }),
    crConnectFinish: async () => {
      c = { ...c, status: "connected", canSubmit: true, lastResult: "connected" };
      return { result: "connected", connection: structuredClone(c) };
    },
    crCheck: async () => ({ check: { at: "", ok: false, code: "not_connected", message: "Content Rewards isn't connected. Tap Connect Content Rewards." }, connection: structuredClone(c) }),
    crPatchConnection: async (body) => {
      patches.push(body);
      if ("said" in body && body.said === "cant_connect") {
        if (old) throw new ApiError(400, "bad_request", "Pick an answer Clip Factory knows.");
        c = { ...c, lastResult: "not_allowed", stepsDone: [...new Set([...c.stepsDone, "ready-account"])] };
      } else if ("step" in body) c = { ...c, stepsDone: body.done ? [...new Set([...c.stepsDone, body.step])] : c.stepsDone.filter((x) => x !== body.step) };
      else if ("said" in body) c = body.said === "pilot_sent" ? { ...c, pilotSentAt: "2026-11-21T17:25:26Z" } : { ...c, pilotSentAt: undefined };
      return structuredClone(c);
    },
  };
  return patches;
}

describe("the steps tick themselves when they are really known (gap 3)", () => {
  it("a finished Connect means steps 1 and 2; Content Rewards saying no proves step 1; a place it doesn't know reopens step 2", () => {
    const d = lib.crStepsDone;
    expect(d(conn({ status: "connected", canSubmit: true }))).toEqual({ "ready-account": true, "ready-socials": true, connect: true });
    expect(d(conn({ status: "read_only" }))).toEqual({ "ready-account": true, "ready-socials": true, connect: true });
    expect(d(conn({ status: "needs_reconnect" }))).toEqual({ "ready-account": true, "ready-socials": true, connect: false });
    expect(d(conn({ lastResult: "not_allowed" }))).toEqual({ "ready-account": true, "ready-socials": false, connect: false });
    expect(d(conn({ pilotSentAt: "2026-11-21T17:25:26Z" }))).toEqual({ "ready-account": true, "ready-socials": false, connect: false });
    expect(d(conn({ status: "connected", canSubmit: true, crLinked: { youtube: false } }))["ready-socials"]).toBe(false);
    expect(d(conn())).toEqual({ "ready-account": false, "ready-socials": false, connect: false });
    // The Set up posting card: after Content Rewards said no, the email to them is next (then it waits for their yes).
    expect(lib.crCardLine(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }), true)).toBe(lib.CR_CARD_EMAIL);
    expect(lib.crCardLine(conn({ lastResult: "not_allowed", pilotSentAt: "2026-11-21T17:25:26Z" }), true)).toBe("Waiting for Content Rewards to say yes");
    expect(lib.crCardLine(conn({ stepsDone: ["ready-account"] }), true)).toBe("Step 2 of 3");
  });

  it("after Content Rewards said no (another device, or a reload): the email card is the step on screen, step 2 waits folded", async () => {
    door();
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 220))));
    expect(pilot().classList.contains("is-open")).toBe(true);
    expect(host.querySelector('[data-step="ready-socials"]')!.classList.contains("is-open")).toBe(false);
    expect(pilot().classList.contains("is-current")).toBe(true);
    expect(host.querySelector('[data-step="ready-socials"]')!.classList.contains("is-current")).toBe(false);
    expect(scrolledTo).toEqual([`step-${CR_PILOT.id}`]);
    expect(vermilion()).toEqual(["Open email"]);
    // Once the email went, step 2 is next again: it opens, and its Open is the vermilion.
    await click(button("I sent it"));
    expect(host.querySelector('[data-step="ready-socials"]')!.classList.contains("is-open")).toBe(true);
    expect(vermilion()).toEqual(["Open Content Rewards settings (opens in a new tab)"]);
  });

  it("the owner's case (email sent, Connect never told): never step 1's Open; step 2's answer, then Connect, is the one vermilion", async () => {
    door();
    fakeApi(conn({ pilotSentAt: "2026-11-21T17:25:26Z" }));
    await draw(<CrSetup />);
    expect(host.querySelector('[data-step="ready-account"]')!.getAttribute("data-done")).toBe("true");
    expect(vermilion()).toEqual(["Open Content Rewards settings (opens in a new tab)"]);
    expect(host.querySelector(".setup-head")!.textContent).toContain("1/3");
    await click(button("I added them"));
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
    // The email went: the card never pushes him to send it again (Open email stays, glass, for sending it again).
    expect(pilot().querySelector("[data-cr='open-email']")!.className).toContain("btn--glass");
    expect(pilot().querySelector("[data-cr='login']")).toBeNull();
    expect(pilot().textContent).toContain("Content Rewards will email you back.");
    expect(button("I sent it")).toBeUndefined();
  });
});

describe("What did Content Rewards say? (gap 1)", () => {
  it("the wait runs out: the question, never 'That took too long'; 'can't connect apps' tells the API and opens the email card", async () => {
    const b = door([{ status: "expired" }]);
    const patches = fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    const ask = host.querySelector("[data-cr='ask']")!;
    expect(ask.textContent).toContain(CR_ASK.noAnswer);
    expect(ask.textContent).toContain(CR_ASK.question);
    expect([...ask.querySelectorAll("button")].map((x) => x.textContent?.trim())).toEqual([CR_ASK.cant, CR_ASK.allowed, CR_ASK.other]);
    expect(host.textContent).not.toContain("That took too long");
    expect(b.canceled).toBe(0);
    // Until he answers, the question is the thing on screen (no Connect beside it, no vermilion).
    expect(button("Connect Content Rewards")).toBeUndefined();
    expect(vermilion()).toEqual([]);
    await click(button(CR_ASK.cant));
    expect(patches).toEqual([{ said: "cant_connect" }]);
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(pilot().classList.contains("is-open")).toBe(true);
    expect(pilot().textContent).toContain(CR_SAID_CANT);
    // The pilot email is the next step: Open email is the one vermilion, Connect is glass.
    expect(vermilion()).toEqual(["Open email"]);
    expect(button("Connect Content Rewards")!.className).toContain("btn--glass");
  });

  it("an older API (400): the card still opens here, and step 1 ticks the old way", async () => {
    door([{ status: "expired" }]);
    const patches = fakeApi(conn(), { old: true });
    await draw(<CrSetup />);
    await click(host.querySelector('[data-step="connect"] .gstep__head'));
    await click(button("Connect Content Rewards"));
    await click(button(CR_ASK.cant));
    expect(patches).toEqual([{ said: "cant_connect" }, { step: "ready-account", done: true }]);
    expect(pilot().classList.contains("is-open")).toBe(true);
    expect(pilot().textContent).toContain(CR_SAID_CANT);
    expect(host.querySelector('[data-step="ready-account"]')!.getAttribute("data-done")).toBe("true");
    expect(vermilion()).toEqual(["Open email"]);
    // A later read of the old API (no lastResult) keeps the card open on this device.
    await act(async () => void (await lib.reloadCr()));
    await flush();
    expect(pilot().classList.contains("is-open")).toBe(true);
  });

  it("Cancel asks too; Something else gives the plain next step and Connect again", async () => {
    const b = door();
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    expect(host.textContent).toContain("Waiting for you in the browser…");
    await click(button("Cancel"));
    expect(b.canceled).toBeGreaterThan(0);
    expect(host.querySelector("[data-cr='ask']")!.textContent).toContain(CR_ASK.question);
    expect(host.querySelector("[data-cr='ask']")!.textContent).not.toContain(CR_ASK.noAnswer);
    // The Cancel button went: focus is on the question, so a screen reader reads it next.
    expect(document.activeElement).toBe(host.querySelector(".cr-said__q"));
    // The Ask launcher never rests on the answers.
    expect(host.querySelector(".cr-said__answers")!.hasAttribute("data-help-clear")).toBe(true);
    await click(button(CR_ASK.other));
    expect(host.textContent).toContain(CR_ASK.other_next);
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("while the question is on screen nothing else is the vermilion; after Something else, Connect is (even with step 2 not done)", async () => {
    door();
    fakeApi(conn());
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Open Content Rewards (opens in a new tab)"]);
    await click(host.querySelector('[data-step="connect"] .gstep__head'));
    await click(button("Connect Content Rewards"));
    await click(button("Cancel"));
    expect(host.querySelector("[data-cr='ask']")).toBeTruthy();
    expect(vermilion()).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);
    lib.resetCr();
    // The owner's state: step 1 known, step 2 not ticked.
    fakeApi(conn({ pilotSentAt: "2026-11-21T17:25:26Z" }));
    await draw(<CrSetup />);
    await click(host.querySelector('[data-step="connect"] .gstep__head'));
    await click(button("Connect Content Rewards"));
    await click(button("Cancel"));
    expect(vermilion()).toEqual([]);
    await click(button(CR_ASK.other));
    expect(host.textContent).toContain(CR_ASK.other_next);
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("Connect right after Cancel: the stopped run closes its door before the new one opens, never the new run's door", async () => {
    const b = door();
    const order: string[] = [];
    b.listen.mockImplementation(async () => {
      order.push("listen");
      return { port: 47811, expiresAt: "" };
    });
    b.cancel.mockImplementation(async () => {
      order.push("cancel");
      return {};
    });
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    await act(async () => {
      button("Cancel")!.click();
    });
    await act(async () => {
      button(CR_ASK.other)!.click();
    });
    await act(async () => {
      button("Connect Content Rewards")!.click();
    });
    // Longer than one poll: a stopped run still asleep would close the door only now.
    await act(async () => void (await new Promise((r) => setTimeout(r, 650))));
    expect(host.textContent).toContain("Waiting for you in the browser…");
    // Every cancel came before the second listen: nothing closes the door the new run opened.
    expect(order.lastIndexOf("cancel")).toBeLessThan(order.lastIndexOf("listen"));
    expect(order.filter((x) => x === "listen")).toHaveLength(2);
  });

  it("Cancel before the browser had Content Rewards' page: no question (it showed him nothing yet)", async () => {
    const b = door();
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    current.crConnect = () => new Promise(() => undefined);
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    expect(b.open).not.toHaveBeenCalled();
    await click(button("Cancel"));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(button("Connect Content Rewards")).toBeTruthy();
  });

  it("he folded the email card earlier: 'can't connect apps' opens it again", async () => {
    door([{ status: "expired" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(pilot().querySelector(".gstep__head"));
    expect(pilot().classList.contains("is-open")).toBe(true);
    await click(pilot().querySelector(".gstep__head"));
    expect(pilot().classList.contains("is-open")).toBe(false);
    await click(button("Connect Content Rewards"));
    await click(button(CR_ASK.cant));
    expect(pilot().classList.contains("is-open")).toBe(true);
    expect(pilot().textContent).toContain(CR_SAID_CANT);
    await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
    expect(scrolledTo).toContain(`step-${CR_PILOT.id}`);
  });

  it("I tapped Allow after the wait stopped: Check it, and the plain line when Clip Factory still isn't connected", async () => {
    door([{ status: "expired" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    const check = vi.spyOn(current as Required<Api>, "crCheck");
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    await click(button(CR_ASK.allowed));
    expect(check).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(CR_ASK.missed);
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("I tapped Allow after the wait stopped, and he is connected: 'Checking…' while it checks, never 'didn't get it'", async () => {
    door([{ status: "expired" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    let answer!: () => void;
    const on = conn({ status: "connected", canSubmit: true, stepsDone: ["ready-account", "ready-socials"], connectedAt: "2026-11-21T17:40:00Z" });
    current.crCheck = () =>
      new Promise((r) => {
        answer = () => r({ check: { at: "", ok: true, code: "ok", message: "" }, connection: on } as Awaited<ReturnType<Api["crCheck"]>>);
      });
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    await click(button(CR_ASK.allowed));
    expect(host.textContent).toContain(CR_ASK.checking);
    expect(host.textContent).not.toContain(CR_ASK.missed);
    expect(button("Connect Content Rewards")).toBeUndefined();
    await act(async () => answer());
    await flush();
    expect(host.textContent).not.toContain(CR_ASK.missed);
    expect(host.textContent).not.toContain(CR_ASK.checking);
    expect(host.textContent).toContain("You're connected");
  });

  it("while it waits: asked a moment after he comes back to the window; I tapped Allow keeps waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    door();
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await act(async () => {
      root.render(
        <ToastProvider>
          <CrSetup />
        </ToastProvider>,
      );
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    await act(async () => button("Connect Content Rewards")!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_MIN_MS - 1_000)));
    // Too soon after the browser opened: no question yet.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_RETURN_MS + 100)));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_500)));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_RETURN_MS - 200)));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(host.querySelector("[data-cr='ask']")!.textContent).toContain(CR_ASK.question);
    expect(host.textContent).toContain("Waiting for you in the browser…");
    // A screen reader hears it from the waiting card's status line; focus stays where it was.
    expect(host.querySelector(".cr-waiting[role='status']")!.textContent).toContain(CR_ASK.question);
    expect(document.activeElement).not.toBe(host.querySelector(".cr-said__q"));
    await act(async () => button(CR_ASK.allowed)!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(host.textContent).toContain(CR_ASK.waiting);
    expect(button("Cancel")).toBeTruthy();
  });

  it("I tapped Allow while it waits, then the wait runs out: never the same question again, the plain line and Connect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    door([...Array.from({ length: 14 }, () => ({ status: "waiting" })), { status: "expired" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await act(async () => {
      root.render(
        <ToastProvider>
          <CrSetup />
        </ToastProvider>,
      );
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    await act(async () => button("Connect Content Rewards")!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_MIN_MS + 100)));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_RETURN_MS + 100)));
    await act(async () => button(CR_ASK.allowed)!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(host.textContent).not.toContain("Waiting for");
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(host.textContent).toContain(CR_ASK.missed);
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("a good answer after a long sign-in: the window comes back while the API finishes, and it never asks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 35 seconds of "waiting" (past the 30 s question), then Content Rewards' code.
    door([...Array.from({ length: 70 }, () => ({ status: "waiting" })), { status: "done", code: "c0de", state: "s1" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    const finish = current.crConnectFinish!;
    current.crConnectFinish = async (body) => {
      await new Promise((r) => setTimeout(r, 3_000));
      return finish(body);
    };
    await act(async () => {
      root.render(
        <ToastProvider>
          <CrSetup />
        </ToastProvider>,
      );
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    await act(async () => button("Connect Content Rewards")!.click());
    // Away 30 s: the question shows by itself.
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    expect(host.querySelector("[data-cr='ask']")).toBeTruthy();
    // Content Rewards answers: the question goes, and the door brings the window to the front.
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_600)));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(host.textContent).toContain(CR_ASK.finishing);
    expect(button("Cancel")).toBeUndefined();
    // The finish takes a while: still no question.
    await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_RETURN_MS + 500)));
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(host.textContent).toContain(CR_ASK.finishing);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_500)));
    expect(host.querySelector(".result-card")!.textContent).toContain("Content Rewards is connected!");
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(host.textContent).not.toContain(CR_ASK.missed);
  });

  it("a good answer while it waits: no question, Content Rewards is connected", async () => {
    door([{ status: "waiting" }, { status: "done", code: "c0de", state: "s1" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 700))));
    await flush();
    expect(host.querySelector(".result-card")!.textContent).toContain("Content Rewards is connected!");
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
  });
});

describe("the pilot email goes from his Content Rewards login (gap 2)", () => {
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  };

  it("asks once; a Gmail address opens Gmail's compose page for that exact account; kept on this device only", async () => {
    const patches = fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    const box = pilot().querySelector<HTMLInputElement>("input[type='email']")!;
    expect(pilot().querySelector(`label[for='${box.id}']`)!.textContent).toBe(CR_LOGIN_ASK);
    const open = () => pilot().querySelector<HTMLAnchorElement>("[data-cr='open-email']")!;
    // No email yet: Open email (still the one vermilion) opens nothing, never Mail's default account; it points at the box.
    expect(open().tagName).toBe("BUTTON");
    expect(open().hasAttribute("href")).toBe(false);
    expect(vermilion()).toEqual(["Open email"]);
    // One "send it from" line: the guide's "Check the From line" bullet is not said again beside the box.
    expect(pilot().textContent).not.toContain(CR_PILOT.say[1]);
    await click(open());
    expect(document.activeElement).toBe(box);
    expect(pilot().querySelector("[role='alert']")!.textContent).toBe(CR_LOGIN_FIRST);
    await type(box, "kid.test@gmail.com");
    expect(open().tagName).toBe("A");
    expect(pilot().textContent).not.toContain(CR_LOGIN_FIRST);
    const href = open().getAttribute("href")!;
    const u = new URL(href);
    expect(`${u.origin}${u.pathname}`).toBe("https://mail.google.com/mail/");
    expect(u.searchParams.get("view")).toBe("cm");
    expect(u.searchParams.get("authuser")).toBe("kid.test@gmail.com");
    expect(u.searchParams.get("to")).toBe("support@contentrewards.com");
    expect(u.searchParams.get("su")).toBe(CR_PILOT_EMAIL.subject);
    expect(u.searchParams.get("body")).toBe(CR_PILOT_EMAIL.body);
    expect(href).not.toMatch(/ /);
    expect(open().getAttribute("target")).toBe("_blank");
    expect(open().getAttribute("rel")).toContain("noopener");
    expect(pilot().querySelector("strong")!.textContent).toBe("Send it from kid.test@gmail.com.");
    // Gmail picks the account itself: no From line to check.
    expect(pilot().textContent).not.toContain("Check the From line says");
    expect(localStorage.getItem("cf.crLoginEmail")).toBe("kid.test@gmail.com");
    // The email stays on this device: no PATCH carries it.
    expect(JSON.stringify(patches)).not.toContain("kid.test");
    // Open email is still the one vermilion; Copy stays under Show more.
    expect(vermilion()).toEqual(["Open email (opens Gmail in a new tab)"]);
    await click(button("Show more"));
    expect([...pilot().querySelectorAll("button")].some((x) => /Copy/.test(`${x.getAttribute("aria-label") ?? ""} ${x.textContent ?? ""}`))).toBe(true);

    // Next visit: asked once, so only the bold line with Change.
    act(() => root.unmount());
    root = createRoot(host);
    lib.resetCr();
    await draw(<CrSetup />);
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().textContent).toContain("Send it from kid.test@gmail.com.");
    expect(button("Change")).toBeTruthy();
    expect(new URL(open().getAttribute("href")!).searchParams.get("authuser")).toBe("kid.test@gmail.com");
  });

  it("any other address keeps the mailto, with the bold Check the From line", async () => {
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    const box = pilot().querySelector<HTMLInputElement>("input[type='email']")!;
    await type(box, "faze@outlook.com");
    const open = pilot().querySelector<HTMLAnchorElement>("[data-cr='open-email']")!;
    expect(open.getAttribute("href")).toMatch(/^mailto:support@contentrewards\.com\?/);
    expect(open.getAttribute("target")).toBeNull();
    const bold = [...pilot().querySelectorAll("strong")].map((s) => s.textContent);
    expect(bold).toEqual(["Send it from faze@outlook.com.", "Check the From line says faze@outlook.com."]);
  });

  it("the helpers: Gmail and Googlemail only, every value URL-encoded, only ever to Content Rewards' support", () => {
    expect(guide.isGmail("A@Gmail.com")).toBe(true);
    expect(guide.isGmail("a@googlemail.com")).toBe(true);
    expect(guide.isGmail("a@gmail.co")).toBe(false);
    expect(guide.isGmail("a@notgmail.com.evil")).toBe(false);
    expect(lib.looksLikeEmail("a b@gmail.com")).toBe(false);
    expect(lib.looksLikeEmail("kid.test@gmail.com")).toBe(true);
    const evil = { to: "evil@example.com", subject: "x", body: "y", mailto: "mailto:evil@example.com?x" };
    expect(lib.pilotOpen("a@outlook.com", evil).href).toBe(guide.pilotMailto());
    expect(new URL(lib.pilotOpen("a+b@gmail.com", evil).href).searchParams.get("to")).toBe("support@contentrewards.com");
    expect(lib.pilotOpen("a+b@gmail.com", null).href).toContain("authuser=a%2Bb%40gmail.com");
    expect(lib.pilotOpen("", null)).toEqual({ href: guide.pilotMailto(), gmail: false });
  });
});

describe("the Connect leftovers (final check of the Connect fixes)", () => {
  const SENT = "2026-11-21T17:25:26Z";
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  };
  const open = () => pilot().querySelector<HTMLAnchorElement>("[data-cr='open-email']");

  it("after I sent it, Open email stays where it was, glass, from his Gmail; nothing pushes him to send it again", async () => {
    localStorage.setItem("cf.crLoginEmail", "faze.clips@gmail.com");
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Open email (opens Gmail in a new tab)"]);
    await click(button("I sent it"));
    expect(pilot().textContent).toContain("Content Rewards will email you back.");
    const a = open()!;
    expect(a.tagName).toBe("A");
    expect(a.className).toContain("btn--glass");
    expect(a.className).not.toContain("btn--primary");
    expect(a.hasAttribute("data-help-clear")).toBe(false);
    const u = new URL(a.getAttribute("href")!);
    expect(`${u.origin}${u.pathname}`).toBe("https://mail.google.com/mail/");
    expect(u.searchParams.get("authuser")).toBe("faze.clips@gmail.com");
    expect(u.searchParams.get("to")).toBe("support@contentrewards.com");
    expect(a.getAttribute("target")).toBe("_blank");
    // No email question, no "Send it from", no Change, no I sent it, and Open email is never the vermilion.
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().querySelector("[data-cr='login']")).toBeNull();
    expect(pilot().textContent).not.toContain("Send it from");
    expect(button("Change")).toBeUndefined();
    expect(button("I sent it")).toBeUndefined();
    expect(vermilion().some((v) => v.startsWith("Open email"))).toBe(false);
    // It stays above the email's own line, where it was before sending.
    const actions = a.closest(".gstep__actions")!;
    expect(actions.compareDocumentPosition(pilot().querySelector(".cr-email")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("after sending, any other address keeps the mailto with the bold Check the From line", async () => {
    localStorage.setItem("cf.crLoginEmail", "faze.clips@outlook.com");
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"], pilotSentAt: SENT }));
    await draw(<CrSetup />);
    expect(open()!.getAttribute("href")).toBe(guide.pilotMailto());
    expect(open()!.className).toContain("btn--glass");
    expect(open()!.getAttribute("target")).toBeNull();
    expect([...pilot().querySelectorAll("strong")].map((x) => x.textContent)).toEqual(["Check the From line says faze.clips@outlook.com."]);
    expect(pilot().textContent).not.toContain("Send it from");
    expect(pilot().querySelector("input[type='email']")).toBeNull();
  });

  it("after sending from another device (no email kept here): Open email asks for the box only when he taps it", async () => {
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"], pilotSentAt: SENT }));
    await draw(<CrSetup />);
    expect(open()!.tagName).toBe("BUTTON");
    expect(open()!.hasAttribute("href")).toBe(false);
    expect(open()!.className).toContain("btn--glass");
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().textContent).not.toContain(CR_LOGIN_FIRST);
    await click(open());
    const box = pilot().querySelector<HTMLInputElement>("input[type='email']")!;
    expect(document.activeElement).toBe(box);
    expect(pilot().querySelector("[role='alert']")!.textContent).toBe(CR_LOGIN_FIRST);
    // The next step is still step 2's Open, never the email again.
    expect(vermilion()).toEqual(["Open Content Rewards settings (opens in a new tab)"]);
    await type(box, "faze.clips@gmail.com");
    expect(open()!.tagName).toBe("A");
    expect(new URL(open()!.getAttribute("href")!).searchParams.get("authuser")).toBe("faze.clips@gmail.com");
    expect(open()!.className).toContain("btn--glass");
    // Still no "Send it from" line or Change after sending; the box folds once Open email opens it.
    expect(pilot().textContent).not.toContain("Send it from");
    expect(button("Change")).toBeUndefined();
    host.addEventListener("click", (e) => e.preventDefault());
    await click(open());
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().querySelector("[data-cr='login']")).toBeNull();
    expect(button("Change")).toBeUndefined();
    expect(open()!.className).toContain("btn--glass");
  });

  it("he tapped Open email before typing, then sent it from Gmail: no email question after I sent it", async () => {
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    await click(open());
    expect(pilot().querySelector("[role='alert']")!.textContent).toBe(CR_LOGIN_FIRST);
    await type(pilot().querySelector<HTMLInputElement>("input[type='email']")!, "faze.clips@gmail.com");
    host.addEventListener("click", (e) => e.preventDefault());
    await click(open());
    await click(button("I sent it"));
    expect(pilot().textContent).toContain("Content Rewards will email you back.");
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().querySelector("[data-cr='login']")).toBeNull();
    expect(pilot().querySelector("[role='alert']")).toBeNull();
    expect(pilot().textContent).not.toContain("Send it from");
    expect(button("Change")).toBeUndefined();
    expect(open()!.tagName).toBe("A");
    expect(open()!.className).toContain("btn--glass");
    expect(new URL(open()!.getAttribute("href")!).searchParams.get("authuser")).toBe("faze.clips@gmail.com");
  });

  it("he tapped Open email before typing, typed another address, then I sent it: no box, only the Check the From line", async () => {
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    await click(open());
    await type(pilot().querySelector<HTMLInputElement>("input[type='email']")!, "faze.clips@outlook.com");
    await click(button("I sent it"));
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().textContent).not.toContain(CR_LOGIN_ASK);
    expect(pilot().textContent).not.toContain("Send it from");
    expect(button("Change")).toBeUndefined();
    expect([...pilot().querySelectorAll("strong")].map((x) => x.textContent)).toEqual(["Check the From line says faze.clips@outlook.com."]);
    expect(open()!.getAttribute("href")).toBe(guide.pilotMailto());
    expect(open()!.className).toContain("btn--glass");
  });

  it("he tapped Open email before typing, then I sent it with no email typed: no box until he taps Open email again", async () => {
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    await click(open());
    expect(pilot().querySelector("[role='alert']")!.textContent).toBe(CR_LOGIN_FIRST);
    await click(button("I sent it"));
    expect(pilot().querySelector("input[type='email']")).toBeNull();
    expect(pilot().querySelector("[role='alert']")).toBeNull();
    expect(pilot().textContent).not.toContain(CR_LOGIN_FIRST);
    await click(open());
    const box = pilot().querySelector<HTMLInputElement>("input[type='email']")!;
    expect(document.activeElement).toBe(box);
    expect(pilot().querySelector("[role='alert']")!.textContent).toBe(CR_LOGIN_FIRST);
  });

  it("Change is a glass button, at least 48 px tall, that shows the box again", async () => {
    localStorage.setItem("cf.crLoginEmail", "faze.clips@gmail.com");
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account"] }));
    await draw(<CrSetup />);
    const change = button("Change")!;
    expect(change.className).toContain("btn--glass");
    expect(change.className).toContain("cr-login__change");
    expect(change.className).not.toContain("text-link");
    // Outside the bold line, so the box's description is only "Send it from …".
    expect(change.closest("p")).toBeNull();
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "contentrewards.css"), "utf8");
    const at = css.indexOf("\n.cr-login__change {");
    expect(at).toBeGreaterThanOrEqual(0);
    const px = Number(/--btn-h:\s*(\d+)px/.exec(css.slice(at, css.indexOf("}", at)))?.[1]);
    expect(px).toBeGreaterThanOrEqual(48);
    await click(change);
    expect(pilot().querySelector<HTMLInputElement>("input[type='email']")!.value).toBe("faze.clips@gmail.com");
    expect(button("Change")).toBeUndefined();
  });

  it("while Connect waits for the browser (before the question shows) nothing is the vermilion", async () => {
    door();
    fakeApi(conn());
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Open Content Rewards (opens in a new tab)"]);
    await click(host.querySelector('[data-step="connect"] .gstep__head'));
    await click(button("Connect Content Rewards"));
    expect(host.textContent).toContain("Waiting for you in the browser…");
    expect(host.querySelector("[data-cr='ask']")).toBeNull();
    expect(vermilion()).toEqual([]);
    // Cancel: the question, still no vermilion; Something else: Connect is.
    await click(button("Cancel"));
    expect(vermilion()).toEqual([]);
    await click(button(CR_ASK.other));
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("while Connect waits, the pilot email's Open email is glass too", async () => {
    door();
    fakeApi(conn({ lastResult: "not_allowed", stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Open email"]);
    await click(host.querySelector('[data-step="connect"] .gstep__head'));
    await click(button("Connect Content Rewards"));
    expect(host.textContent).toContain("Waiting for you in the browser…");
    expect(vermilion()).toEqual([]);
    expect(open()!.className).toContain("btn--glass");
  });

  it("a good answer after the wait: the vermilion comes back (Add a campaign)", async () => {
    door([{ status: "waiting" }, { status: "done", code: "c0de", state: "s1" }]);
    fakeApi(conn({ stepsDone: ["ready-account", "ready-socials"] }));
    await draw(<CrSetup />);
    await click(button("Connect Content Rewards"));
    expect(vermilion()).toEqual([]);
    await act(async () => void (await new Promise((r) => setTimeout(r, 700))));
    await flush();
    expect(host.querySelector(".result-card")!.textContent).toContain("Content Rewards is connected!");
    expect(vermilion()).toEqual(["Add a campaign"]);
  });
});

describe("the Set up posting card when the read fails (gap 4)", () => {
  it("nothing kept yet: Couldn't load, with Try again, never Not started", async () => {
    let fail = true;
    current = {
      crOverview: async () => {
        if (fail) throw new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment.");
        return overview(conn());
      },
    };
    await draw(<CrCardPart />);
    const card = host.querySelector("[data-cr='card']")!;
    expect(card.textContent).toContain(lib.CR_LOAD_FAILED);
    expect(card.textContent).not.toContain("Not started");
    expect(card.tagName).not.toBe("A");
    fail = false;
    await click(button("Try again"));
    expect(host.querySelector("[data-cr='card']")!.textContent).toContain("Not started");
    expect(button("Try again")).toBeUndefined();
  });

  it("Try again shows it is trying, and says why when it still can't load", async () => {
    let answer!: () => void;
    let calls = 0;
    current = {
      crOverview: () => {
        calls++;
        if (calls === 1) return Promise.reject(new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment."));
        return new Promise((_, no) => {
          answer = () => no(new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment."));
        });
      },
    };
    await draw(<CrCardPart />);
    await click(button("Try again"));
    expect(button("Try again")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => answer());
    await flush();
    expect(button("Try again")!.getAttribute("aria-busy")).toBeNull();
    expect(host.querySelector("[data-cr='card']")!.textContent).toContain(lib.CR_LOAD_FAILED);
    expect(document.body.textContent).toContain("Something went wrong on our side.");
  });
});

describe("the new words are plain and short", () => {
  it("no tech words, no 'CR', nothing longer than a short sentence or two", () => {
    const BANNED = /\b(mcp|oauth|tokens?|scopes?|api|pilot|redirect|cr|authuser)\b/i;
    const words = [...Object.values(CR_ASK), CR_SAID_CANT, CR_LOGIN_ASK, CR_LOGIN_FIRST, lib.CR_LOAD_FAILED, lib.CR_CARD_EMAIL];
    for (const w of words) {
      expect(BANNED.test(w), w).toBe(false);
      expect(w.length, w).toBeLessThanOrEqual(90);
      expect(w, w).not.toMatch(/took too long/i);
    }
  });
});

describe("the mock answers said: cant_connect like the API", () => {
  it("lastResult not_allowed and step 1 ticked", async () => {
    sessionStorage.setItem("cf-mock-cr-start", "fresh");
    const cr = crMockApi({ store: { clips: [], posts: [] }, setup: () => setupNone, publish: () => undefined });
    const out = await cr.api.crPatchConnection({ said: "cant_connect" });
    expect(out.lastResult).toBe("not_allowed");
    expect(out.stepsDone).toContain("ready-account");
    expect(out.pilotSentAt).toBeUndefined();
  });
});
