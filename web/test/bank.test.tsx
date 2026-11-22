// Your bank drawn in jsdom (docs/CONTRACTS.md §40.5, §40.5.13 web), against the pretend API (api/mock/bank.ts): the
// card's two states, one vermilion per screen (step 4 none; the green answers move next on; a reconnect's in the
// status block and pinned on phones; the link card's glass), the key box (the app ID found inside a paste and only it
// sent; the .pem boxes; Check again; the sentences), the picker, Stop and Forget with their Undo, BankDone, the
// question cards, the Money block, the place lines and pairs, `on: false` and 404 keeping today's words, the live
// refetch and the first read sent once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, BankView, CrConnection, CrMoney, MoneyEverywhere, PayoutRow, SentLine } from "../src/api/types.ts";
import type { LiveSignal } from "../src/lib/live.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));
const signals = new Set<(s: LiveSignal) => void>();
vi.mock("../src/lib/live.ts", async (orig) => ({
  ...(await orig<object>()),
  onLiveSignal: (fn: (s: LiveSignal) => void) => {
    signals.add(fn);
    return () => signals.delete(fn);
  },
}));
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me: null, saveSettings: vi.fn() }) }));

const { bankMockApi, bankScenario, bankViewOf } = await import("../src/api/mock/bank.ts");
const { getPaidMockApi } = await import("../src/api/mock/getpaid.ts");
const { BankPage, takeBankResult } = await import("../src/screens/getpaid/bank/BankPage.tsx");
const { BankDone, bankDoneForward, bankDoneSentence } = await import("../src/screens/getpaid/bank/BankDone.tsx");
const { GetPaidList } = await import("../src/screens/getpaid/GetPaidList.tsx");
const { SentRows } = await import("../src/screens/getpaid/SentRows.tsx");
const { AllMoney } = await import("../src/screens/money/AllMoney.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const bank = await import("../src/lib/bank.ts");
const gp = await import("../src/lib/getPaid.ts");
const { resetCr } = await import("../src/lib/contentRewards.ts");
const { sounds } = await import("../src/lib/sounds.ts");
const { httpApi } = await import("../src/api/http.ts");
const { BANK_PATH, CHECK_TEXT, NO_COUNTRY_HREF, DONE_OK, DONE_NOT, PEM_SAVED } = await import("../src/getpaid/bank.ts");
const { BANK_TEXT } = gp;

const UUID = "0f8c2a4e-9b1d-4c6e-8a3f-5d7b9e1c2a40";
const REAL_LOCATION = window.location;
/** Money is formatted with no-break spaces: compared as plain spaces. */
const nb = (s: string | null | undefined) => (s ?? "").replace(/\u00a0/g, " ");
const conn = (): CrConnection => ({ status: "connected", canSubmit: true, crLinked: {}, stepsDone: [], pilotEmail: { to: "", subject: "", body: "", mailto: "" } });
const crMoney = (): CrMoney => ({ state: "ok", tag: "Content Rewards' numbers", asOf: new Date().toISOString(), stillEarningCents: 0, onItsWayCents: 0, readyToMoveCents: 0, paidSoFarCents: 0, waitingForBrand: 0, campaigns: [], celebrations: [] });

let mock: ReturnType<typeof bankMockApi>;
let calls: string[] = [];
let country: string | null = "SE";
let published = 0;

function install(over: Partial<Api> = {}) {
  mock = bankMockApi(async () => undefined, { country: () => country, crOn: () => true, publish: () => published++ });
  const gpm = getPaidMockApi(async () => undefined, {
    accounts: () => [],
    country: () => country,
    setCountry: () => undefined,
    connect: () => undefined,
    cr: () => ({ on: true, conn: conn(), moneyAboveZero: false, readyCents: 0 }),
    publish: () => undefined,
  });
  const logged = Object.fromEntries(
    Object.entries(mock.api).map(([k, fn]) => [
      k,
      async (...a: unknown[]) => {
        calls.push(`${k}${a.length ? ` ${JSON.stringify(a)}` : ""}`);
        return (fn as (...x: unknown[]) => Promise<unknown>)(...a);
      },
    ]),
  );
  current = { ...gpm.api, ...logged, crOverview: async () => ({ connection: conn(), campaigns: [], money: crMoney(), waitingSends: [] }), ...over } as Partial<Api>;
}

let host: HTMLElement;
let root: Root;
function phone(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("max-width: 767px"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  bank.resetBank();
  gp.resetGetPaid();
  resetCr();
  calls = [];
  country = "SE";
  published = 0;
  phone(false);
  vi.spyOn(sounds, "play").mockImplementation(() => undefined);
  history.replaceState(null, "", BANK_PATH);
  install();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(n = 6) {
  for (let i = 0; i < n; i++) await act(async () => await new Promise((r) => setTimeout(r, 10)));
}
async function draw(node: React.ReactNode) {
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await settle();
}
const start = (name: Parameters<typeof bankScenario>[0], patch: (s: ReturnType<typeof bankScenario>) => void = () => undefined) => {
  const s = bankScenario(name);
  patch(s);
  sessionStorage.setItem("cf-mock-bank", JSON.stringify(s));
};
const vermilion = () => [...document.querySelectorAll<HTMLElement>(".btn--primary")];
const text = () => nb(host.textContent);
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
async function tap(el: HTMLElement | null | undefined) {
  expect(el, "the button is there").toBeTruthy();
  await act(async () => el!.click());
  await settle();
}
const toasts = () => [...document.querySelectorAll<HTMLElement>(".toast")].map((t) => nb(t.querySelector(".toast__text")?.textContent));

// ---------- off ----------

describe("off: today's words exactly (§40.5, §40.5.12)", () => {
  for (const [what, over] of [
    ["on: false", (): Partial<Api> => ({ getBank: async () => ({ on: false }) })],
    ["a 404", (): Partial<Api> => ({ getBank: async () => Promise.reject(Object.assign(new (class extends Error {})(), {})) })],
  ] as const) {
    it(`${what}: the card, a place page and Money keep Clip Factory can't see your bank`, async () => {
      if (what === "a 404") {
        const { ApiError } = await import("../src/api/errors.ts");
        install({ getBank: async () => Promise.reject(new ApiError(404, "not_found", "Not found")) });
      } else install(over());
      await draw(<GetPaidList />);
      const card = host.querySelector<HTMLElement>("[data-help='getpaid-bank-card']")!;
      expect(card.textContent).toContain(BANK_TEXT);
      expect(card.querySelector("a, button")).toBeNull();
      expect(bank.bankNow().state).toBe("off");
      await draw(<BankPage />);
      expect(text()).toContain(BANK_TEXT);
      expect(vermilion()).toHaveLength(0);
    });
  }

  it("a place page's Sent to your bank keeps the bank line; Money keeps its bank line and has no Reached block", async () => {
    install({ getBank: async () => ({ on: false }) });
    const sent: SentLine = { state: "none_yet", headline: "Nothing sent to your bank yet.", amounts: [] };
    await draw(<SentRows sent={sent} rows={[]} here="/settings/posting/getpaid/youtube" />);
    expect(host.querySelector(".gp-bank-line")!.textContent).toBe(BANK_TEXT);
    expect(host.querySelector("[data-bank-place]")).toBeNull();
  });
});

// ---------- the card ----------

describe("the Your bank card (§40.5.2 item 1)", () => {
  it("on: one big glass tap to the bank page with the pill, line and setup ring; no vermilion", async () => {
    await draw(<GetPaidList />);
    const card = host.querySelector<HTMLAnchorElement>("a[data-help='getpaid-bank-card']")!;
    expect(card.getAttribute("href")).toBe(BANK_PATH);
    expect(card.querySelector(".gp-pill")!.textContent).toBe("Not started");
    expect(card.textContent).toContain("See which app money reached your bank. Set it up once with BankID.");
    expect(card.querySelector("[role='progressbar']")!.getAttribute("aria-label")).toBe("Your bank: 0 of 7 steps done");
    expect(vermilion()).toHaveLength(0);
  });

  it("connected: the ring shows the days left; Reached your bank so far per currency; payments that need him", async () => {
    start("connected");
    await draw(<GetPaidList />);
    const card = host.querySelector<HTMLAnchorElement>("a[data-help='getpaid-bank-card']")!;
    expect(card.querySelector("[role='progressbar']")!.getAttribute("aria-label")).toBe("Swedbank: 143 days left of 180 days");
    expect(nb(card.textContent)).toContain("Reached your bank: SEK 2,146.96 so far");
    expect(card.textContent).toContain("2 payments need you");
    expect(card.querySelector(".gp-pill")!.textContent).toBe("Clip Factory can see it (Your bank says)");
  });
});

// ---------- one vermilion per screen ----------

describe("one vermilion per screen (§40.5.2)", () => {
  it("walking the steps: each green answer moves next on; step 4 has none; Save, then the link and connect", async () => {
    await draw(<BankPage />);
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual([expect.stringContaining("Open Enable Banking")]);
    expect(host.querySelector("[data-help='bank-status']")!.textContent).toContain("Next: step 1, Make an Enable Banking account.");
    await tap(button("I'm in"));
    expect(calls).toContain(`bankStep ${JSON.stringify(["bank-account", true])}`);
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Make my bank key"]);
    await tap(button("Make my bank key"));
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual([expect.stringContaining("Open your Enable Banking apps")]);
    // The bank key's Copy chip shows its first line and copies the whole key.
    expect(host.querySelector("[data-copy='publicKeyPem'] .copy-chip__value")!.textContent).toBe("-----BEGIN PUBLIC KEY----- …");
    await tap(button("I did this"));
    // Step 4 has no Open: no vermilion at all while it is next.
    expect(host.querySelector("#step-bank-details.is-current")).not.toBeNull();
    expect(vermilion()).toHaveLength(0);
    await tap(host.querySelector<HTMLElement>("#step-bank-details .gstep__done"));
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Save"]);
    // Green answers are green, never vermilion.
    for (const b of host.querySelectorAll(".gstep__done")) expect(b.className).toContain("btn--leaf");
  });

  it("a reconnect is the status block's vermilion, on screen once; another link's card Reconnect is glass; on phones it is pinned", async () => {
    start("ending");
    await draw(<BankPage />);
    const status = host.querySelector<HTMLElement>("[data-help='bank-status']")!;
    expect(status.querySelector(".gp-pill")!.textContent).toBe("Link ends in 9 days");
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Reconnect Swedbank"]);
    expect(status.contains(vermilion()[0]!)).toBe(true);
    // The same Reconnect is not on the link card a second time.
    expect(host.querySelector("[data-bank='reconnect-card']")).toBeNull();
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Reconnect Swedbank")).toHaveLength(1);
    // No Check now on a link card; When it's done has it (glass), with Connect another bank and Forget my bank.
    expect(host.querySelector(".bank-link")!.textContent).not.toContain("Check now");
    const done = host.querySelector<HTMLElement>(".gp-done")!;
    expect([...done.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Check now", "Connect another bank", "Forget my bank"]);
    act(() => root.unmount());
    root = createRoot(host);
    phone(true);
    await draw(<BankPage />);
    expect(vermilion()).toHaveLength(1);
    expect(vermilion()[0]!.closest(".gp-pin")).not.toBeNull();
    expect(host.querySelector("[data-help='bank-status'] .btn--primary")).toBeNull();
    // A second bank that needs a reconnect too: its own card's Reconnect is glass (the vermilion is the first's).
    act(() => root.unmount());
    root = createRoot(host);
    phone(false);
    bank.resetBank();
    start("ending", (s) => {
      s.links.push({ ...s.links[0]!, linkId: "f6e5d4c3b2a1", bank: "SEB", connectedAt: new Date(Date.now() - 175 * 86_400_000).toISOString(), consentUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    });
    await draw(<BankPage />);
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Reconnect SEB"]);
    const cards = [...host.querySelectorAll<HTMLElement>("[data-bank='reconnect-card']")];
    expect(cards.map((c) => [c.textContent?.trim(), /btn--glass/.test(c.className)])).toEqual([["Reconnect Swedbank", true]]);
  });

  it("on a phone the next step's main action is pinned at the bottom right from page open, and not in its card", async () => {
    phone(true);
    await draw(<BankPage />);
    expect(vermilion()).toHaveLength(1);
    expect(vermilion()[0]!.closest(".gp-pin")).not.toBeNull();
    expect(host.querySelector("#step-bank-account a[href='https://enablebanking.com/sign-in/']")).toBeNull();
  });

  it("all done: the steps fold to one green row (Enable Banking knows your app), and unfold when one stops being done", async () => {
    start("connected");
    await draw(<BankPage />);
    expect(host.querySelector("[data-bank='fold']")!.textContent).toBe("Set up ✓ (Enable Banking knows your app)");
    expect(host.querySelector("#step-bank-account")).toBeNull();
    expect(vermilion()).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    bank.resetBank();
    start("connected", (s) => {
      s.check = { code: "key_wrong", at: new Date().toISOString() };
      s.links = [];
    });
    await draw(<BankPage />);
    expect(host.querySelector("[data-bank='fold']")).toBeNull();
    expect(host.querySelector("#step-bank-appid")).not.toBeNull();
    // Check again is the main once an app ID is saved; Save (glass) shows only once he pastes a new one.
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Check again"]);
    expect(host.querySelector("[data-bank='save']")).toBeNull();
    const box = host.querySelector<HTMLTextAreaElement>("#step-bank-appid textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, UUID);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector<HTMLElement>("[data-bank='save']")!.className).toContain("btn--glass");
    expect(host.querySelector("[data-help='bank-status']")!.textContent).toContain(CHECK_TEXT.key_wrong.replace(/\*\*/g, ""));
  });
});

// ---------- the key box ----------

describe("the key box (§40.5.2 step 5)", () => {
  const atFive = () =>
    start("fresh", (s) => {
      s.stepsDone = ["bank-account", "bank-app", "bank-details"];
      s.key = { source: "clipfactory", appId: null, pemReminder: false };
    });

  it("finds the app ID inside a pasted message and sends only it; with none, the friendly line", async () => {
    atFive();
    await draw(<BankPage />);
    const box = host.querySelector<HTMLTextAreaElement>("#step-bank-appid textarea")!;
    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
    const typeIn = async (v: string) =>
      act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        set.call(box, v);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await typeIn("hello there");
    expect(host.querySelector(".bank-key__found")!.textContent).toBe("Clip Factory can't find an app ID in that. Copy the whole New application … has been added. message again.");
    await typeIn(`New application Clip Factory (${UUID.toUpperCase()}) has been added.`);
    expect(host.querySelector(".bank-key__found")!.textContent).toContain(UUID);
    await tap(button("Save"));
    expect(calls.find((c) => c.startsWith("bankSaveApp"))).toBe(`bankSaveApp ${JSON.stringify([{ appId: UUID }])}`);
    expect(text()).toContain(CHECK_TEXT.not_active);
    // Step 5 is done (Enable Banking knows the app); next is step 6's Open.
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual([expect.stringContaining("Open your Enable Banking apps")]);
  });

  it("the .pem paste box: no autocomplete or spellcheck, emptied after the send; the delete line until I deleted it", async () => {
    atFive();
    await draw(<BankPage />);
    const paste = host.querySelector<HTMLTextAreaElement>("#step-bank-appid textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(paste, UUID);
      paste.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tap(button("Have a .pem file instead?"));
    expect(text()).toContain("Better: make a new app with Generate outside the browser and import public certificate (steps 3 and 4).");
    await tap(button("Can't pick the file?"));
    const pem = host.querySelector<HTMLTextAreaElement>("[data-bank='pem-paste']")!;
    expect(pem.getAttribute("autocomplete")).toBe("off");
    expect(pem.getAttribute("spellcheck")).toBe("false");
    pem.value = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
    await tap(host.querySelector<HTMLElement>("[aria-label='Save the .pem file']"));
    expect(pem.value).toBe("");
    const sent = calls.find((c) => c.startsWith("bankSaveApp"))!;
    expect(JSON.parse(sent.slice("bankSaveApp ".length))).toEqual([{ pem: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", appId: UUID }]);
    expect(host.querySelector("[data-bank='pem-reminder']")!.textContent).toContain(PEM_SAVED);
    await tap(button("I deleted it"));
    expect(calls).toContain(`bankStep ${JSON.stringify(["pem-deleted", true])}`);
    expect(host.querySelector("[data-bank='pem-reminder']")).toBeNull();
  });

  it("the .pem file: its name holds the app ID; nothing of it stays on screen", async () => {
    atFive();
    await draw(<BankPage />);
    await tap(button("Have a .pem file instead?"));
    const input = host.querySelector<HTMLInputElement>("input[type='file']")!;
    const file = new File(["-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"], `${UUID}.pem`, { type: "application/x-pem-file" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    const sent = JSON.parse(calls.find((c) => c.startsWith("bankSaveApp"))!.slice("bankSaveApp ".length)) as [{ fileName: string; pem: string }];
    expect(sent[0].fileName).toBe(`${UUID}.pem`);
    expect(text()).not.toContain("MIIE");
  });
});

// ---------- connect, BankDone, the result ----------

describe("Connect your bank (§40.5.2)", () => {
  const atSeven = () => start("setup");

  it("the picker: its lead, the banks most used in Sweden first, search only filters; a row sends POST connect", async () => {
    atSeven();
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign, replace: vi.fn(), pathname: BANK_PATH, search: "", hash: "", href: `http://localhost${BANK_PATH}` }, configurable: true, writable: true });
    try {
      await draw(<BankPage />);
      expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Connect your bank"]);
      await tap(button("Connect your bank"));
      const sheet = document.querySelector<HTMLElement>("[data-help='bank-picker']")!;
      expect(sheet.textContent).toContain("Pick a bank you linked on Enable Banking.");
      expect(sheet.textContent).not.toContain("New bank?");
      const names = [...sheet.querySelectorAll<HTMLElement>(".bank-pick__name")].map((n) => n.textContent);
      expect(names.slice(0, 9)).toEqual(["Swedbank", "Handelsbanken", "SEB", "Nordea", "Danske Bank", "Länsförsäkringar Bank", "ICA Banken", "SBAB Bank", "Skandiabanken"]);
      expect(names.slice(9)).toEqual(["Revolut", "Marginalen Bank", "Ålandsbanken"]);
      const search = sheet.querySelector<HTMLInputElement>("input[type='search']")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "nord");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect([...sheet.querySelectorAll(".bank-pick__name")].map((n) => n.textContent)).toEqual(["Nordea"]);
      await tap(sheet.querySelector<HTMLElement>("[data-bank='Nordea']")!);
      expect(calls).toContain(`bankConnect ${JSON.stringify([{ bank: "Nordea" }])}`);
      expect(assign.mock.calls[0]![0]).toMatch(/^\/mock-bank\?state=/);
      expect(bank.connectSent()).not.toBeNull();
    } finally {
      Object.defineProperty(window, "location", { value: REAL_LOCATION, configurable: true, writable: true });
    }
  });

  it("no Money country: the sheet's Pick my country link comes back to the bank page; not linked: its sentence and Open", async () => {
    atSeven();
    mock.controls.noCountry(true);
    await draw(<BankPage />);
    await tap(button("Connect your bank"));
    const err = document.querySelector<HTMLElement>(".bank-picker__error")!;
    expect(err.getAttribute("data-code")).toBe("no_country");
    expect(err.textContent).toContain("Pick your country in Money settings first.");
    expect(err.querySelector("a")!.getAttribute("href")).toBe(NO_COUNTRY_HREF);
    expect(NO_COUNTRY_HREF).toBe("/settings/posting/money?back=/settings/posting/getpaid/bank#money-country");
    await tap(button("Cancel"));
    mock.controls.noCountry(false);
    mock.controls.countryNotLinked(true);
    await tap(button("Connect your bank"));
    const err2 = document.querySelector<HTMLElement>(".bank-picker__error")!;
    expect(err2.textContent).toContain("Enable Banking's app has no account from Sweden yet. Link one in step 6 first.");
    expect(err2.querySelector("a")!.getAttribute("href")).toBe("https://enablebanking.com/cp/applications");
  });

  it("?result=: lastConnect's sentence when it is the same and fresh, else the result's own with your bank; taken out of the address", async () => {
    start("setup", (s) => {
      s.lastConnect = { result: "bank_denied", bank: "Swedbank", reconnect: true, at: new Date().toISOString() };
    });
    history.replaceState(null, "", `${BANK_PATH}?result=bank_denied`);
    await draw(<BankPage />);
    expect(location.search).toBe("");
    expect(host.querySelector("#bank-connect-card")!.textContent).toBe("You stopped at the bank. Tap Reconnect Swedbank to try again.");
    expect(sounds.play).toHaveBeenCalledWith("deny");
    act(() => root.unmount());
    root = createRoot(host);
    start("setup");
    history.replaceState(null, "", `${BANK_PATH}?result=nonsense`);
    expect(takeBankResult()).toBe("bank_error");
    history.replaceState(null, "", `${BANK_PATH}?result=bank_no_accounts`);
    await draw(<BankPage />);
    const card = host.querySelector<HTMLElement>("#bank-connect-card")!;
    expect(card.textContent).toContain("Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap Connect your bank again.");
    expect(card.querySelector("a")!.getAttribute("href")).toBe("https://enablebanking.com/cp/applications");
    expect(card.querySelector(".btn--primary")).toBeNull();
  });

  it("bank_connected: the success sound, the sentence, Checking your bank…, and the first read sent once", async () => {
    mock.controls.firstReadMs(60_000);
    start("setup", (s) => {
      s.links = [{ linkId: "abc123abc123", bank: "Swedbank", status: "connected", connectedAt: new Date().toISOString(), consentUntil: new Date(Date.now() + 179 * 86_400_000).toISOString(), firstReadDone: false, accounts: 2 }];
      s.lastConnect = { result: "bank_connected", linkId: "abc123abc123", bank: "Swedbank", reconnect: false, at: new Date().toISOString() };
    });
    history.replaceState(null, "", `${BANK_PATH}?result=bank_connected`);
    await draw(<BankPage />);
    const card = host.querySelector<HTMLElement>("#bank-connect-card")!;
    expect(card.textContent).toContain("Clip Factory can see money coming into Swedbank now. It looks once a day.");
    expect(card.textContent).toContain("Checking your bank… This can take a few minutes.");
    expect(sounds.play).toHaveBeenCalledWith("success");
    // Drawn again (live news, a reload of the view): still one first read.
    await act(async () => void (await bank.reloadBank()));
    await settle();
    expect(calls.filter((c) => c === `bankCheckNow ${JSON.stringify([true])}`)).toHaveLength(1);
  });

  it("no query (the Mac app): the view is read again on focus, and lastConnect shows once it is newer than the connect", async () => {
    start("setup");
    bank.markConnectSent(new Date(Date.now() - 60_000).toISOString());
    await draw(<BankPage />);
    expect(host.querySelector("#bank-connect-card")).toBeNull();
    const s = JSON.parse(sessionStorage.getItem("cf-mock-bank")!) as ReturnType<typeof bankScenario>;
    s.lastConnect = { result: "bank_expired", bank: "Swedbank", reconnect: false, at: new Date().toISOString() };
    sessionStorage.setItem("cf-mock-bank", JSON.stringify(s));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle(10);
    expect(host.querySelector("#bank-connect-card")!.textContent).toBe("That took too long. Tap Connect your bank again.");
    expect(bank.connectSent()).toBeNull();
  });
});

describe("BankDone (§40.5.2 Connect, step 4)", () => {
  it("forwards a signed-in browser to the bank page with the result; an unknown result reads as an error", () => {
    expect(bankDoneForward("?result=bank_connected")).toBe(`${BANK_PATH}?result=bank_connected`);
    expect(bankDoneForward("?result=<script>")).toBe(`${BANK_PATH}?result=bank_error`);
    expect(bankDoneSentence("?result=bank_connected")).toBe(DONE_OK);
    expect(bankDoneSentence("?result=bank_denied")).toBe(DONE_NOT);
    expect(bankDoneSentence("?result=whatever")).toBe(DONE_NOT);
  });

  it("not signed in: one sentence, no button, no link, no API call; signed in: location.replace", async () => {
    current = {};
    history.replaceState(null, "", "/bank-done?result=bank_connected");
    await draw(<BankDone boot="signed_out" />);
    expect(host.querySelector(".bank-done__text")!.textContent).toBe(DONE_OK);
    expect(host.querySelector("button, a")).toBeNull();
    history.replaceState(null, "", "/bank-done?result=bank_error");
    await draw(<BankDone boot="broken" />);
    expect(host.querySelector(".bank-done__text")!.textContent).toBe(DONE_NOT);
    const replace = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, replace, search: "?result=bank_connected", pathname: "/bank-done" }, configurable: true, writable: true });
    try {
      await draw(<BankDone boot="ready" />);
      expect(replace).toHaveBeenCalledWith(`${BANK_PATH}?result=bank_connected`);
    } finally {
      Object.defineProperty(window, "location", { value: REAL_LOCATION, configurable: true, writable: true });
    }
  });

  it("App.tsx shows /bank-done before the sign-in gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const app = readFileSync(join(import.meta.dirname, "..", "src", "app", "App.tsx"), "utf8");
    expect(app.indexOf("<BankDone boot={boot.state} />")).toBeGreaterThan(0);
    expect(app.indexOf("<BankDone boot={boot.state} />")).toBeLessThan(app.indexOf("<SignIn note="));
    const { isBankDone } = await import("../src/app/App.tsx");
    expect(isBankDone("/bank-done")).toBe(true);
    expect(isBankDone("/bank-done/")).toBe(true);
    expect(isBankDone("/settings")).toBe(false);
  });
});

// ---------- Stop and Forget ----------

describe("Stop reading and Forget my bank: 8 s Undo, then sent; at once when the page goes", () => {
  it("Stop sends nothing until the toast ends; Undo sends nothing ever; the toast's end sends DELETE", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    start("connected");
    await draw(<BankPage />);
    await tap(button("Stop reading Swedbank"));
    expect(toasts()).toContain("Stopping Swedbank…");
    expect(calls.some((c) => c.startsWith("bankStopLink"))).toBe(false);
    await tap(document.querySelector<HTMLElement>(".toast__undo")!);
    await act(async () => void vi.advanceTimersByTime(9000));
    expect(calls.some((c) => c.startsWith("bankStopLink"))).toBe(false);
    await tap(button("Stop reading Swedbank"));
    await act(async () => void vi.advanceTimersByTime(8100));
    await settle();
    expect(calls.filter((c) => c.startsWith("bankStopLink"))).toEqual([`bankStopLink ${JSON.stringify(["a1b2c3d4e5f6"])}`]);
    expect(host.querySelector(".bank-link.is-stopped")!.textContent).toContain("You stopped reading Swedbank on");
  });

  for (const how of ["pagehide", "hidden", "a route change"] as const)
    it(`Stop and Forget are sent at once on ${how}`, async () => {
      start("connected");
      await draw(<BankPage />);
      await tap(button("Stop reading Swedbank"));
      await tap(button("Forget my bank"));
      expect(toasts()).toEqual(expect.arrayContaining(["Stopping Swedbank…", "Forgetting your bank…"]));
      expect(calls.some((c) => c.startsWith("bankStopLink") || c === "bankForget")).toBe(false);
      if (how === "pagehide") await act(async () => void window.dispatchEvent(new Event("pagehide")));
      else if (how === "hidden") {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      } else await act(async () => root.render(<ToastProvider>{null}</ToastProvider>));
      await settle();
      expect(calls.filter((c) => c.startsWith("bankStopLink"))).toHaveLength(1);
      expect(calls.filter((c) => c === "bankForget")).toHaveLength(1);
    });

  it("the two deletes go out with keepalive", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const a = httpApi({ baseUrl: "https://api.example", auth: { accessToken: async () => "t" }, fetcher });
    await a.bankStopLink("a1b2c3d4e5f6");
    await a.bankForget();
    const opts = fetcher.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1]);
    expect(fetcher.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["https://api.example/v1/getpaid/bank/links/a1b2c3d4e5f6", "https://api.example/v1/getpaid/bank"]);
    expect(opts.map((o) => [o.method, o.keepalive])).toEqual([
      ["DELETE", true],
      ["DELETE", true],
    ]);
  });
});

// ---------- the question cards ----------

describe("Is this from an app? (§40.5.2)", () => {
  it("a suggested place: green yes, glass No another app, quiet Not money from an app; never a vermilion", async () => {
    start("connected");
    await draw(<BankPage />);
    const card = host.querySelector<HTMLElement>(".bank-ask[data-suggested='youtube']")!;
    expect(nb(card.querySelector(".bank-ask__money")!.textContent)).toBe("SEK 85.00");
    expect(card.querySelector(".bank-ask__where")!.textContent).toBe("4 Nov · Swedbank");
    const btns = [...card.querySelectorAll<HTMLElement>("button")];
    expect(btns.map((b) => [b.textContent?.trim(), /btn--leaf/.test(b.className) ? "green" : /btn--ghost/.test(b.className) ? "quiet" : /btn--glass/.test(b.className) ? "glass" : "?"])).toEqual([
      ["Yes, it's YouTube", "green"],
      ["No, another app", "glass"],
      ["Not money from an app", "quiet"],
    ]);
    expect(host.querySelector(".bank-asks .btn--primary")).toBeNull();
  });

  it("Yes is saved at once with Saved for YouTube. Undo; Undo sends not_this", async () => {
    start("connected");
    await draw(<BankPage />);
    await tap(host.querySelector<HTMLElement>(".bank-ask[data-suggested='youtube'] .btn--leaf")!);
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0google000000000000000000000002", { answer: "yes" }])}`);
    expect(toasts()).toContain("Saved for YouTube.");
    await tap(document.querySelector<HTMLElement>(".toast__undo")!);
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0google000000000000000000000002", { answer: "not_this" }])}`);
  });

  it("No, another app opens Where is it from?: the places in order, Instagram and Facebook together, Content Rewards (Whop), Not sure", async () => {
    start("connected");
    await draw(<BankPage />);
    await tap([...host.querySelectorAll<HTMLElement>(".bank-ask[data-suggested='x'] button")].find((b) => b.textContent === "No, another app"));
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Where is it from?");
    expect([...dialog.querySelectorAll(".bank-places__row")].map((b) => b.textContent)).toEqual([
      "YouTube",
      "TikTok",
      "Instagram",
      "Facebook",
      "Instagram and Facebook together",
      "X",
      "Content Rewards (Whop)",
      "Not sure",
    ]);
    await tap(dialog.querySelector<HTMLElement>("[data-place='meta']")!);
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0stripe000000000000000000000003", { answer: "place", place: "meta" }])}`);
    expect(toasts()).toContain("Saved for Instagram and Facebook.");
  });

  it("Not sure folds the card into Not sure yet (1), sent when the Undo runs out (or the page goes)", async () => {
    start("connected");
    await draw(<BankPage />);
    await tap([...host.querySelectorAll<HTMLElement>(".bank-ask[data-suggested='x'] button")].find((b) => b.textContent === "No, another app"));
    await tap(document.querySelector<HTMLElement>("[role='dialog'] [data-place='not_sure']")!);
    expect(toasts()).toContain("Saved: not sure yet.");
    expect(host.querySelector(".bank-asks__fold")!.textContent).toBe("Not sure yet (1)");
    expect(calls.some((c) => c.includes("not_sure"))).toBe(false);
    await act(async () => void window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0stripe000000000000000000000003", { answer: "not_sure" }])}`);
  });

  it("no suggestion: the sheet's rows right on the card, then Not money from an app; own_move: Yes, I moved it and No, it's new money", async () => {
    start("connected", (s) => {
      s.deposits.push({ depositId: "d0paypal00000000000000000000005", date: "2026-11-15", amountMicros: 150_000_000, currency: "SEK", linkId: "a1b2c3d4e5f6", state: "needs_you", suggested: null, kind: "place", hint: "paypal" });
      s.deposits.push({ depositId: "d0move0000000000000000000000006", date: "2026-11-16", amountMicros: 99_000_000, currency: "SEK", linkId: "a1b2c3d4e5f6", state: "needs_you", suggested: null, kind: "own_move", hint: "paypal" });
    });
    await draw(<BankPage />);
    const none = host.querySelector<HTMLElement>(".bank-ask[data-kind='place'][data-suggested='none']")!;
    expect(none.querySelector("h3")!.textContent).toBe("Where is this money from?");
    expect(none.textContent).toContain("Your bank's text mentions PayPal.");
    expect([...none.querySelectorAll(".bank-places__row")].map((b) => b.textContent)).toContain("Instagram and Facebook together");
    const move = host.querySelector<HTMLElement>(".bank-ask[data-kind='own_move']")!;
    expect(move.querySelector("h3")!.textContent).toBe("Did you move this from your PayPal?");
    expect([...move.querySelectorAll("button")].map((b) => [b.textContent, /btn--leaf/.test(b.className)])).toEqual([
      ["Yes, I moved it", true],
      ["No, it's new money", false],
    ]);
  });

  it("Not from YouTube? under Reached your bank sends not_this, with its own toast and no Undo", async () => {
    start("connected");
    await draw(<BankPage />);
    await tap(button("Not from YouTube?"));
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0youtube00000000000000000000001", { answer: "not_this" }])}`);
    expect(toasts()).toContain("Moved to Is this from an app?");
    const t = [...document.querySelectorAll<HTMLElement>(".toast")].find((x) => x.textContent?.includes("Moved to"))!;
    expect(t.querySelector(".toast__undo")).toBeNull();
  });
});

// ---------- Reached your bank: the page, Money, the place lines ----------

const view = (name: Parameters<typeof bankScenario>[0] = "connected") => bankViewOf(bankScenario(name), { country: "SE", crOn: true });
const everywhere = (): MoneyEverywhere => ({
  from: "2026-10-18",
  to: "2026-11-16",
  periodText: "30 days up to Mon 16 Nov",
  places: [{ place: "youtube", name: "YouTube", state: "number", headline: "YouTube says", amounts: [{ currency: "USD", amountMicros: 12_400_000 }], tag: "YouTube's estimate" }],
  totals: [{ currency: "USD", amountMicros: 12_400_000, places: ["youtube"], tag: "YouTube's estimate" }],
  notCounted: [],
  sent: { totals: [{ currency: "SEK", amountMicros: 2_468_000_000, places: ["youtube"], names: "YouTube" }], tag: "Google and Whop say they sent it.", bankText: BANK_TEXT },
  asOf: "2026-11-19T15:00:00.000Z",
});

describe("Reached your bank (§40.5.9)", () => {
  it("the page: per place per currency, In total, the tag, the rows newest first; nothing before a match", async () => {
    start("connected");
    await draw(<BankPage />);
    const r = host.querySelector<HTMLElement>("[data-help='bank-reached']")!;
    expect([...r.querySelectorAll(".bank-reached__place")].map((p) => [p.querySelector(".bank-reached__name")!.textContent, nb(p.querySelector(".bank-reached__amounts")!.textContent)])).toEqual([
      ["YouTube", "SEK 1,234.56"],
      ["Instagram and Facebook (Meta pays them together)", "SEK 912.40"],
    ]);
    expect(nb(r.querySelector(".bank-reached__total")!.textContent)).toBe("In total:SEK 2,146.96");
    expect(r.textContent).toContain("Your bank says. Clip Factory matched each one to an app.");
    expect(r.textContent).toContain("Counted from 3 Aug 2026, as far back as your bank shows.");
    expect([...r.querySelectorAll(".bank-row__how")].map((x) => x.textContent)).toEqual(["matches Google's payment of 23 Oct", "from a payer you said is Instagram and Facebook"]);
    expect(nb(r.textContent)).not.toMatch(/\$0|SEK 0\.00/);
    act(() => root.unmount());
    root = createRoot(host);
    bank.resetBank();
    start("none_yet");
    await draw(<BankPage />);
    const empty = host.querySelector<HTMLElement>("[data-help='bank-reached']")!;
    expect(empty.textContent).toContain("Nothing from an app reached your bank yet.");
    // Said once: not again as "No money from YouTube, TikTok, … reached your bank yet."
    expect(empty.textContent).not.toContain("No money from");
  });

  it("Money: the block under Sent to your bank, its moneyLine for the bank line, Answer them; never in the 30-day total", async () => {
    start("connected");
    await draw(<AllMoney load={{ state: "ok", data: everywhere(), reload: () => undefined }} />);
    const block = host.querySelector<HTMLElement>("[data-help='money-reached']")!;
    expect(block.querySelector("h3")!.textContent).toBe("Reached your bank, so far");
    expect(nb(block.textContent)).toContain("SEK 2,146.96");
    expect(block.textContent).toContain("No money from TikTok, X or Content Rewards reached your bank yet.");
    expect(block.querySelector("a")!.getAttribute("href")).toBe(`${BANK_PATH}#bank-asks`);
    expect(block.querySelector("a")!.textContent).toBe("Answer them");
    expect(block.querySelector(".btn--primary")).toBeNull();
    expect(host.querySelector(".cr-all__bank")!.textContent).toBe("What reached your bank is below.");
    expect(nb(host.querySelector(".cr-all__total")!.textContent)).not.toContain("2,146.96");
    // The sent block comes first, then the bank's.
    const sent = host.querySelector(".cr-all__sentsofar")!;
    expect(sent.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Money before any link: no block, and BANK_TEXT stays", async () => {
    start("setup");
    await draw(<AllMoney load={{ state: "ok", data: everywhere(), reload: () => undefined }} />);
    expect(host.querySelector("[data-help='money-reached']")).toBeNull();
    expect(host.querySelector(".cr-all__bank")!.textContent).toBe(BANK_TEXT);
  });

  it("a place page: its Reached your bank line, Meta's amounts on Instagram, and the pair under Google's payment", async () => {
    const v = view();
    install({ getBank: async () => ({ ...v, pairs: [{ place: "youtube", payoutDate: "2026-10-21", amountMicros: 1_234_560_000, currency: "SEK", reachedOn: "2026-10-28" }] }) });
    const sent: SentLine = { state: "number", headline: "Sent to your bank by Google", amounts: [{ currency: "SEK", amountMicros: 1_234_560_000 }], tag: "YouTube says" };
    const rows: PayoutRow[] = [{ date: "2026-10-21", by: "Google", state: "sent", amountMicros: 1_234_560_000, currency: "SEK" }];
    await draw(<SentRows sent={sent} rows={rows} here="/settings/posting/getpaid/youtube" />);
    expect(host.querySelector("[data-pair]")!.textContent).toBe("Reached your bank on 28 Oct (Your bank says)");
    const line = host.querySelector<HTMLElement>("[data-bank-place]")!;
    expect(line.textContent).toContain("Reached your bank");
    expect(nb(line.textContent)).toContain("SEK 1,234.56");
    expect(line.textContent).toContain("Your bank says. Last on 28 Oct.");
    expect(host.querySelector(".gp-bank-line")).toBeNull();
    await draw(<SentRows sent={{ state: "not_available", headline: "Not available from Instagram", amounts: [] }} rows={[]} here="/settings/posting/getpaid/instagram" />);
    const ig = host.querySelector<HTMLElement>("[data-bank-place]")!;
    expect(ig.textContent).toContain("Nothing from Instagram reached your bank yet.");
    expect(ig.textContent).toContain("And from Meta, for Instagram and Facebook together:");
    expect(nb(ig.textContent)).toContain("SEK 912.40");
  });

  it("a place page before any link: Clip Factory can't see your bank yet, with a glass Set up Your bank", async () => {
    start("setup");
    await draw(<SentRows sent={{ state: "not_available", headline: "Not available from TikTok", amounts: [] }} rows={[]} here="/settings/posting/getpaid/tiktok" />);
    const line = host.querySelector<HTMLElement>("[data-bank-place]")!;
    expect(line.textContent).toContain("Clip Factory can't see your bank yet.");
    const a = line.querySelector("a")!;
    expect([a.textContent, a.getAttribute("href"), /btn--glass/.test(a.className)]).toEqual(["Set up Your bank", BANK_PATH, true]);
  });
});

// ---------- lib/bank.ts ----------

describe("lib/bank.ts", () => {
  it("reads the view again on bank news (one read however many), on a resync, never on others", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await draw(<GetPaidList />);
    const reads = () => calls.filter((c) => c === "getBank").length;
    const before = reads();
    const send = (s: LiveSignal) => act(() => signals.forEach((fn) => fn(s)));
    await send({ kind: "event", event: { type: "bank", op: "upsert", id: "bank", partial: true } } as LiveSignal);
    await send({ kind: "event", event: { type: "bank", op: "upsert", id: "bank", partial: true } } as LiveSignal);
    await send({ kind: "event", event: { type: "job", op: "delete", id: "x" } } as LiveSignal);
    await act(async () => void vi.advanceTimersByTime(1100));
    await settle();
    expect(reads() - before).toBe(1);
    await send({ kind: "resync" } as LiveSignal);
    await act(async () => void vi.advanceTimersByTime(1100));
    await settle();
    expect(reads() - before).toBe(2);
  });

  it("the live connection lets bank news through (partial, refetched by the screens themselves)", async () => {
    const { parseLiveMessage } = await vi.importActual<typeof import("../src/lib/live.ts")>("../src/lib/live.ts");
    expect(parseLiveMessage(JSON.stringify({ type: "bank", op: "upsert", id: "bank", partial: true }))).toEqual({ type: "bank", op: "upsert", id: "bank", partial: true });
  });

  it("sends the first read once per connect", async () => {
    current = { bankCheckNow: vi.fn(async () => view()) } as Partial<Api>;
    expect(bank.sendFirstRead("lc:1")).toBe(true);
    expect(bank.sendFirstRead("lc:1")).toBe(false);
    await settle(2);
    expect((current.bankCheckNow as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true]]);
  });

  it("Check now: 429 says Try again at …", async () => {
    start("connected", (s) => {
      s.lastManualAt = new Date().toISOString();
    });
    await draw(<BankPage />);
    await tap(button("Check now"));
    expect(toasts().find((t) => t.startsWith("Clip Factory checked a moment ago."))).toMatch(/^Clip Factory checked a moment ago\. Try again at \d{2}:\d{2}\.$/);
  });
});

/** Words never on a Your bank screen (§40.5.2): account numbers, consent, session, token, Live, Connected. */
describe("the bank page's words", () => {
  for (const name of ["fresh", "connected", "ending", "ended", "stopped_at_bank", "cant_read", "look_in_bank"] as const)
    it(`${name}: never Live, Connected, disconnected, consent, session or token`, async () => {
      start(name);
      await draw(<BankPage />);
      const t = (host.textContent ?? "").replace(/Have a \.pem file instead\?/g, "");
      expect(t).not.toMatch(/\b(Live|Connected|Not connected|disconnected|consent|session|tokens?|PSD2|AISP|IBAN)\b/);
      expect(t.replace(/API applications/g, "")).not.toMatch(/\bAPI\b/);
      expect(t.replace(/(Public certificate in PEM format|import public certificate)/g, "")).not.toMatch(/certificate|\bRSA\b|\bJWT\b/i);
    });
});

// ---------- the review's fixes ----------

const typeInto = async (box: HTMLTextAreaElement, v: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, v);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("the next tap after an Open (§40.5.2: one vermilion, the right one)", () => {
  it("desktop: once Open Enable Banking is tapped it turns glass; the green I'm in is the step's tap, and nothing is vermilion", async () => {
    await draw(<BankPage />);
    const open = host.querySelector<HTMLAnchorElement>("#step-bank-account a[href='https://enablebanking.com/sign-in/']")!;
    expect(open.className).toContain("btn--primary");
    open.addEventListener("click", (e) => e.preventDefault());
    await tap(open);
    expect(host.querySelector<HTMLElement>("#step-bank-account a[href='https://enablebanking.com/sign-in/']")!.className).toContain("btn--glass");
    expect(vermilion()).toHaveLength(0);
    const answer = host.querySelector<HTMLElement>("#step-bank-account [data-bank='answer']")!;
    expect([answer.textContent?.trim(), /btn--leaf/.test(answer.className)]).toEqual(["I'm in", true]);
    await tap(answer);
    expect(vermilion().map((b) => b.textContent?.trim())).toEqual(["Make my bank key"]);
  });

  it("phone: after the Open, the pin holds the green answer (I'm in, then I did this, then I linked them), never the Open again", async () => {
    phone(true);
    await draw(<BankPage />);
    const pin = () => host.querySelector<HTMLElement>(".gp-pin")!;
    expect(pin().textContent).toContain("Open Enable Banking");
    const open = pin().querySelector<HTMLAnchorElement>("a")!;
    open.addEventListener("click", (e) => e.preventDefault());
    await tap(open);
    expect(pin().querySelector(".btn--primary")).toBeNull();
    const answer = pin().querySelector<HTMLElement>("[data-bank='answer']")!;
    expect([answer.textContent?.trim(), /btn--leaf/.test(answer.className)]).toEqual(["I'm in", true]);
    // Not twice: the card leaves its own out while the pin has it.
    expect(host.querySelector("#step-bank-account [data-bank='answer']")).toBeNull();
    expect(host.querySelector<HTMLElement>("#step-bank-account a[href='https://enablebanking.com/sign-in/']")!.className).toContain("btn--glass");
    await tap(answer);
    expect(calls).toContain(`bankStep ${JSON.stringify(["bank-account", true])}`);
    expect(pin().textContent).toContain("Make my bank key");
  });

  it("step 6: after its Open, I linked them is the pinned tap on a phone and runs the check", async () => {
    phone(true);
    start("fresh", (s) => {
      s.stepsDone = ["bank-account", "bank-app", "bank-details"];
      s.key = { source: "clipfactory", appId: UUID, pemReminder: false };
      s.check = { code: "not_active", at: new Date().toISOString() };
    });
    await draw(<BankPage />);
    const open = host.querySelector<HTMLAnchorElement>(".gp-pin a")!;
    expect(open.textContent).toContain("Open your Enable Banking apps");
    open.addEventListener("click", (e) => e.preventDefault());
    await tap(open);
    const answer = host.querySelector<HTMLElement>(".gp-pin [data-bank='answer']")!;
    expect(answer.textContent?.trim()).toBe("I linked them");
    await tap(answer);
    expect(calls).toContain("bankCheckApp");
    expect(host.querySelector<HTMLElement>("#step-bank-link")!.getAttribute("data-done")).toBe("true");
  });
});

describe("the status block says what to tap, right there", () => {
  for (const name of ["cant_read", "look_in_bank"] as const)
    it(`${name}: Check now (glass) sits in the status block; When it's done doesn't have a second one`, async () => {
      start(name);
      await draw(<BankPage />);
      const status = host.querySelector<HTMLElement>("[data-help='bank-status']")!;
      expect(status.textContent).toContain("Check now.");
      const here = status.querySelector<HTMLElement>("[data-bank='check-now']")!;
      expect([here.textContent?.trim(), /btn--glass/.test(here.className)]).toEqual(["Check now", true]);
      expect(host.querySelector(".gp-done")!.textContent).not.toContain("Check now");
      // cant_read for 4 days: Reconnect is the vermilion, beside it.
      if (name === "cant_read") expect(status.querySelector(".btn--primary")!.textContent?.trim()).toBe("Reconnect Swedbank");
      else expect(vermilion()).toHaveLength(0);
      await tap(here);
      expect(calls).toContain("bankCheckNow");
    });

  it("questions waiting: the server's count and a glass Answer them that brings them into view", async () => {
    start("connected");
    await draw(<BankPage />);
    const need = host.querySelector<HTMLElement>("[data-bank='need-you']")!;
    expect(need.textContent).toContain("2 bank payments need you.");
    const go = need.querySelector<HTMLElement>("button")!;
    expect([go.textContent?.trim(), /btn--glass/.test(go.className)]).toEqual(["Answer them", true]);
    await tap(go);
    expect(document.activeElement?.id).toBe("bank-asks");
    expect(vermilion()).toHaveLength(0);
  });
});

describe("step 5 after Save", () => {
  it("says no more Then tap Save, and shows Save again only once a new app ID is pasted", async () => {
    start("fresh", (s) => {
      s.stepsDone = ["bank-account", "bank-app", "bank-details"];
      s.key = { source: "clipfactory", appId: null, pemReminder: false };
    });
    await draw(<BankPage />);
    const card = () => host.querySelector<HTMLElement>("#step-bank-appid")!;
    expect(card().textContent).toContain("Paste the message from step 4 here. Then tap Save.");
    await typeInto(card().querySelector("textarea")!, UUID);
    await tap(button("Save"));
    expect(card().textContent).toContain(CHECK_TEXT.not_active);
    expect(card().textContent).not.toContain("Then tap Save.");
    expect(card().querySelector("[data-bank='save']")).toBeNull();
    expect(card().querySelector("[data-bank='check-again']")).not.toBeNull();
    await typeInto(card().querySelector("textarea")!, "1f8c2a4e-9b1d-4c6e-8a3f-5d7b9e1c2a41");
    expect(card().querySelector("[data-bank='save']")).not.toBeNull();
  });

  it("the check line's icon and data-check come from the same answer as its words (a down answer is never green)", async () => {
    start("fresh", (s) => {
      s.stepsDone = ["bank-account", "bank-app", "bank-details"];
      s.key = { source: "clipfactory", appId: UUID, pemReminder: false };
      s.check = { code: "ok", at: new Date().toISOString() };
      s.links = [];
    });
    install({
      bankCheckApp: async () => ({ view: mock.view(), check: { code: "down", text: CHECK_TEXT.down, at: new Date().toISOString() } }),
    });
    await draw(<BankPage />);
    await tap(host.querySelector<HTMLElement>("#step-bank-appid .gstep__head"));
    expect(host.querySelector(".bank-key__check")!.getAttribute("data-check")).toBe("ok");
    const green = host.querySelector(".bank-key__check path")!.getAttribute("d");
    await tap(host.querySelector<HTMLElement>("[data-bank='check-again']"));
    const line = host.querySelector<HTMLElement>(".bank-key__check")!;
    expect([line.getAttribute("data-check"), line.textContent]).toEqual(["down", CHECK_TEXT.down]);
    // Not the green tick any more: the info mark, like every answer that isn't ok or not_active.
    expect(line.querySelector("path")!.getAttribute("d")).not.toBe(green);
  });

  it("a bank key chip before step 2: Do step 2 first, never Loading… for ever", async () => {
    await draw(<BankPage />);
    await tap(host.querySelector<HTMLElement>("#step-bank-app .gstep__head"));
    expect(host.querySelector("[data-copy='publicKeyPem'] .copy-chip__value")!.textContent).toBe("Do step 2 first");
    expect(host.textContent).not.toContain("Loading…");
  });
});

describe("an answer's Undo puts the question back as it was", () => {
  it("Yes then Undo: the same question and green yes come back; that yes then sends the place", async () => {
    start("connected");
    await draw(<BankPage />);
    const before = host.querySelector<HTMLElement>(".bank-ask[data-suggested='youtube']")!;
    const was = [before.querySelector("h3")!.textContent, before.querySelector(".bank-ask__line")!.textContent];
    await tap(before.querySelector<HTMLElement>(".btn--leaf")!);
    expect(host.querySelector(".bank-ask[data-deposit='d0google000000000000000000000002']")).toBeNull();
    await tap(document.querySelector<HTMLElement>(".toast__undo")!);
    const back = host.querySelector<HTMLElement>(".bank-ask[data-deposit='d0google000000000000000000000002']")!;
    expect([back.querySelector("h3")!.textContent, back.querySelector(".bank-ask__line")!.textContent]).toEqual(was);
    expect(back.textContent).not.toContain("names no app");
    const yes = back.querySelector<HTMLElement>(".btn--leaf")!;
    expect(yes.textContent?.trim()).toBe("Yes, it's YouTube");
    calls = [];
    await tap(yes);
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0google000000000000000000000002", { answer: "place", place: "youtube" }])}`);
  });

  it("one answer toast at a time: a second answer's takes the first's place, and the first is sent then", async () => {
    start("connected");
    await draw(<BankPage />);
    await tap(host.querySelector<HTMLElement>(".bank-ask[data-suggested='x'] .btn--ghost"));
    expect(toasts()).toEqual(["Saved: not money from an app."]);
    expect(calls.some((c) => c.includes("not_income"))).toBe(false);
    await tap(host.querySelector<HTMLElement>(".bank-ask[data-suggested='youtube'] .btn--leaf"));
    expect(toasts()).toEqual(["Saved for YouTube."]);
    expect(calls).toContain(`bankAnswer ${JSON.stringify(["d0stripe000000000000000000000003", { answer: "not_income" }])}`);
  });
});

describe("true words while loading, and the same numbers everywhere", () => {
  it("the card, a place page and Money never say can't see your bank before the view is read", async () => {
    let answer: (v: BankView) => void = () => undefined;
    install({ getBank: () => new Promise<BankView>((r) => (answer = r)) });
    await draw(<GetPaidList />);
    const card = host.querySelector<HTMLElement>("[data-help='getpaid-bank-card']")!;
    expect(card.getAttribute("data-bank")).toBe("loading");
    expect(card.textContent).not.toContain(BANK_TEXT);
    await draw(<SentRows sent={{ state: "none_yet", headline: "Nothing sent to your bank yet.", amounts: [] }} rows={[]} here="/settings/posting/getpaid/youtube" />);
    expect(host.textContent).not.toContain(BANK_TEXT);
    await draw(<AllMoney load={{ state: "ok", data: everywhere(), reload: () => undefined }} />);
    expect(host.querySelector(".cr-all__bank")).toBeNull();
    await act(async () => answer(view()));
    await settle();
    expect(host.querySelector(".cr-all__bank")!.textContent).toBe("What reached your bank is below.");
  });

  it("the card's count is the server's needYou number (Not sure ones never counted)", async () => {
    const v = view();
    install({ getBank: async () => ({ ...v, asks: [...v.asks, { ...v.asks[0]!, depositId: "d0extra0000000000000000000000009", notSure: true }], asksMore: 4, reached: { ...v.reached, needYou: "3 bank payments need you." } }) });
    await draw(<GetPaidList />);
    expect(host.querySelector("a[data-help='getpaid-bank-card']")!.textContent).toContain("3 payments need you");
  });

  it("a read already on its way when he changed something never puts the older view back", async () => {
    start("connected");
    await draw(<BankPage />);
    let late: (v: BankView) => void = () => undefined;
    const old = view();
    const answered = { ...old, asks: old.asks.slice(1) };
    let reads = 0;
    install({ getBank: () => (++reads === 1 ? new Promise<BankView>((r) => (late = r)) : Promise.resolve(answered)) });
    const reading = bank.reloadBank();
    // His answer lands (the server's view without that question) while the read above is still on its way.
    bank.putBank(answered);
    await act(async () => {
      late(old);
      await reading;
    });
    await settle();
    // The older answer was dropped, and a fresh read gave the last word: the answered question never comes back.
    expect(reads).toBe(2);
    expect(bank.bankNow().view!.asks).toHaveLength(1);
  });
});

describe("the rings say what they show", () => {
  it("a link stopped at the bank shows 0 and says it ended; the card's small ring says days", async () => {
    start("stopped_at_bank");
    await draw(<BankPage />);
    expect(host.querySelector(".bank-link [role='progressbar']")!.getAttribute("aria-label")).toBe("Swedbank: the link ended");
    act(() => root.unmount());
    root = createRoot(host);
    bank.resetBank();
    start("connected");
    await draw(<GetPaidList />);
    const ring = host.querySelector<HTMLElement>("a[data-help='getpaid-bank-card'] .bank-ring")!;
    expect(ring.querySelector(".bank-ring__n")!.textContent).toBe("143");
    expect(ring.querySelector(".bank-ring__unit")!.textContent).toBe("days");
  });

  it("About 25 minutes · Free shows only before every step is done", async () => {
    await draw(<BankPage />);
    expect(host.querySelector(".setup-head__meta")!.textContent).toBe("About 25 minutes · Free");
    act(() => root.unmount());
    root = createRoot(host);
    bank.resetBank();
    start("connected");
    await draw(<BankPage />);
    expect(host.querySelector(".setup-head__meta")).toBeNull();
  });
});

describe("Connect waits for Enable Banking's page", () => {
  it("a focus before the page opened never stops the wait, and the other Reconnect stays off meanwhile", async () => {
    start("ending", (s) => {
      s.links.push({ ...s.links[0]!, linkId: "f6e5d4c3b2a1", bank: "SEB", connectedAt: new Date(Date.now() - 175 * 86_400_000).toISOString(), consentUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    });
    install({ bankConnect: () => new Promise(() => undefined) });
    await draw(<BankPage />);
    await tap(vermilion()[0]);
    await act(async () => await new Promise((r) => setTimeout(r, 450)));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(vermilion()[0]!.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector<HTMLElement>("[data-bank='reconnect-card']")!.getAttribute("aria-disabled")).toBe("true");
  });
});

export type { BankView };
