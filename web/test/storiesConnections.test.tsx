// Lamo Stories › Social accounts (docs/CONTRACTS.md §45.13, §45.16.7, §45.30): the account's `reason` is a code from
// the API and is always said in words (never shown as it is, never twice with the warning that says the same); a
// connected YouTube changes channel with "Pick another channel"; one own Meta app's keys are entered once and the
// Meta cards say that removing them goes for Instagram and Facebook; and the link to Clip Factory's guide says first
// that the new app's keys go here, never into Clip Factory's guide. Round 3 (§45.34): both Meta cards show both
// redirect URIs, a connect is said with the account it connected and asks whether it is the intended one, the line
// after Disconnect follows the app used, and every reason code is said in words. Less text (the owner, 23 Nov: "even
// an 8 year old should be able to use the app"): each card keeps its account, what needs the owner, its safety line
// while an account is still to connect or fix, and one main button; while the developer app still needs setting up
// that button is "Set up the app" and opens the choice on the card; everything else is in one closed More fold; and the
// API's limits never say again what the card already says, while who can see the posts and what costs money stay on
// the card in short.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { SocialReason, StoriesApi } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding, PLATFORM_NAME } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { beforeConnect, ConnectionsScreen, KEYS_HERE_ONLY, limitNotes, NEW_ACCOUNT_LINE, ONLY_ME_NOTE, reasonSentence, SHARED_APP_ACCOUNT_LINE, SHARED_APP_LINE, unsaid, X_OVER_NOTE } = await import(
  "../src/stories/screens/Connections.tsx"
);

describe("the account's reason", () => {
  it("is a code said in plain words; anything unknown gets the plain sentence", () => {
    for (const code of ["keys_changed", "token_dead", "expires_soon", "signed_out_90_days", "missing_permissions", "expired", "clips_unknown"]) {
      const text = reasonSentence(code, "tiktok");
      expect(text).not.toMatch(/_/);
      expect(text).toMatch(/\.$/);
    }
    expect(reasonSentence("keys_changed", "tiktok")).toBe("The TikTok app keys changed. Connect again.");
    expect(reasonSentence("token_dead", "youtube")).toBe("Clips Funded's YouTube sign-in stopped working. Connect again.");
    expect(reasonSentence("something_new", "x")).toBe("Clips Funded's X needs connecting again.");
    expect(reasonSentence(null, "facebook")).toBe("Clips Funded's Facebook needs connecting again.");
  });
});

describe("the Social accounts page", () => {
  let host: HTMLElement;
  let root: Root;
  let store: MockStore;

  beforeEach(async () => {
    await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    const api: StoriesApi = mockStoriesApi();
    store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
    setStoriesApi(api);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <ToastProvider>
          <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    localStorage.clear();
  });

  const card = (platform: string) => host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
  const button = (el: HTMLElement, name: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
  const click = async (b: HTMLElement | undefined) => {
    expect(b).toBeTruthy();
    await act(async () => b!.click());
    for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };

  it("says a code's words once, and never shows the code", () => {
    const tiktok = card("tiktok");
    expect(store.social.find((a) => a.platform === "tiktok")?.reason).toBe("keys_changed");
    expect(tiktok.textContent).not.toContain("keys_changed");
    expect(tiktok.textContent!.split("The TikTok app keys changed. Connect again.").length - 1).toBe(1);
    // The button says what the chip says: Connect again.
    expect(tiktok.querySelector(".st-chip")?.textContent).toBe("Connect again");
    expect(button(tiktok, "Connect again")).toBeTruthy();
    expect(button(tiktok, "Reconnect")).toBeUndefined();
  });

  it("a connected YouTube changes channel with Pick another channel, the words its limits use", () => {
    const yt = card("youtube");
    expect(button(yt, "Pick another channel")).toBeTruthy();
    expect(button(yt, "Connect again")).toBeUndefined();
    expect(yt.textContent).toContain("Google will ask which channel.");
  });

  it("on a Meta card, removing the keys says it goes for Instagram and Facebook", async () => {
    const insta = card("instagram");
    await click(button(insta, "Remove keys"));
    expect(insta.querySelector(".st-sure__ask")?.textContent).toContain("This removes the Meta app keys for Instagram and Facebook.");
    await click(button(insta, "Yes, remove the keys"));
    expect(store.social.find((a) => a.platform === "facebook")?.app).toEqual({ choice: null, saved: false });
    expect(store.social.find((a) => a.platform === "instagram")?.app).toEqual({ choice: null, saved: false });
  });

  it("before the link to Clip Factory's guide, says the keys go here and never into Clip Factory's guide", async () => {
    const fb = card("facebook");
    await click(button(fb, "New keys"));
    const guide = fb.querySelector<HTMLElement>(".st-app__guide")!;
    expect(guide.textContent).toContain(KEYS_HERE_ONLY);
    const text = guide.textContent!;
    expect(text.indexOf(KEYS_HERE_ONLY)).toBeLessThan(text.indexOf("Read Clip Factory's Meta guide"));
    // Said once on the card, beside the guide's link: the steps above it do not say it again.
    expect(fb.querySelector(".st-app__notes")?.textContent).not.toContain("never in Clip Factory");
    expect(fb.textContent!.split("never in Clip Factory").length - 1).toBe(1);
  });

  /** The card as it shows before its More fold is opened. */
  const surface = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelector(":scope > details.st-conn__more")?.remove();
    return copy;
  };
  const names = (el: ParentNode) => Array.from(el.querySelectorAll("button")).map((b) => b.textContent?.trim());

  it("keeps each card short: its safety line while an account is to fix, one main button, and the rest in one closed More fold", () => {
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"] as const) {
      const c = card(p);
      const folds = c.querySelectorAll<HTMLDetailsElement>(":scope > details");
      expect(folds, p).toHaveLength(1);
      const more = folds[0]!;
      expect(more.classList.contains("st-conn__more"), p).toBe(true);
      // On the page every fold starts closed (each seed card's developer app is ready, so its line says More).
      expect(more.open, p).toBe(false);
      expect(more.querySelector("summary")?.textContent, p).toBe(`More for ${PLATFORM_NAME[p]}`);
      const shown = surface(c);
      // Said up front on every card whose next step is an account; a connected YouTube that is fine does not repeat it.
      if (p === "youtube") expect(shown.querySelector(".st-conn__new"), p).toBeNull();
      else expect(shown.querySelector(".st-conn__new")?.textContent, p).toBe(NEW_ACCOUNT_LINE);
      expect(shown.querySelectorAll(".st-btn--main").length, p).toBeLessThanOrEqual(1);
      expect(names(shown), p).not.toContain("Check now");
      expect(names(shown), p).not.toContain("Disconnect");
      for (const part of [".st-app", ".st-limits", ".st-auth", ".st-conn__clips", ".st-who__id", ".st-tech-fold"]) expect(shown.querySelector(part), `${p} ${part}`).toBeNull();
      // All of it is still there, one tap away.
      expect(more.querySelector(".st-app"), p).not.toBeNull();
      expect(more.querySelector(".st-conn__clips")?.textContent, p).toMatch(/^Clip Factory posts to: /);
    }
    // A connected account: its authorization, when it was checked and since when, its id, Check now and Disconnect.
    const yt = card("youtube").querySelector<HTMLElement>("details.st-conn__more")!;
    expect(yt.querySelector(".st-auth")?.textContent).toContain("Allowed: Clips Funded may post here.");
    expect(yt.querySelector(".st-auth")?.textContent).toContain("Last checked");
    expect(yt.querySelector(".st-who__id code")?.textContent).toBe(store.social.find((a) => a.platform === "youtube")!.externalAccountId);
    expect(names(yt)).toEqual(expect.arrayContaining(["Check now", "Disconnect"]));
    // Its picture, name and handle stay on the card.
    expect(surface(card("youtube")).querySelector(".st-who")?.textContent).toBe("Clips Funded@fundedclips");
    // Who can see the posts, and what costs money, stay on the card in short (the whole lines are in More).
    expect(Array.from(surface(card("tiktok")).querySelectorAll(".st-conn__limit")).map((n) => n.textContent)).toEqual([ONLY_ME_NOTE]);
    expect(Array.from(surface(card("x")).querySelectorAll(".st-conn__limit")).map((n) => n.textContent)).toEqual([X_OVER_NOTE]);
    expect(surface(card("youtube")).querySelector(".st-conn__limit")).toBeNull();
    // The Instagram card's fix in Clip Factory has the way there, right under its note (glass, never the main).
    const toClips = Array.from(surface(card("instagram")).querySelectorAll<HTMLAnchorElement>("a.st-btn")).find((l) => l.textContent?.trim() === "Open Clip Factory");
    expect(toClips?.getAttribute("href")).toBe("/settings/posting/setup/instagram");
    expect(toClips?.classList.contains("st-btn--main")).toBe(false);
    // Not connected: the one main button is Connect, with the sign-in tip above it; nothing to check or disconnect.
    const fb = card("facebook");
    expect(Array.from(surface(fb).querySelectorAll(".st-btn--main")).map((b) => b.textContent?.trim())).toEqual(["Connect Facebook"]);
    expect(surface(fb).querySelector(".st-conn__before")?.textContent).toBe(beforeConnect("facebook", "own"));
    expect(fb.querySelector(".st-auth")).toBeNull();
    expect(names(fb.querySelector("details.st-conn__more")!)).not.toContain("Disconnect");
    // A list to pick from is the main part: Pick another stays, never as a second main button.
    const ig = surface(card("instagram"));
    expect(ig.querySelector(".st-choose__list")).not.toBeNull();
    expect(ig.querySelectorAll(".st-btn--main")).toHaveLength(0);
    expect(names(ig)).toContain("Pick another account");
  });
});

describe("the limits say nothing the card already says", () => {
  it("drops each sentence the card says, keeps the rest of its line, and drops a line left with nothing", () => {
    // The API's own lines (social.py OWN_ACCOUNT, _TIKTOK, _X).
    const tiktok = [
      "Use a new account made for Clips Funded, not Clip Factory's.",
      "Sign in to your Clips Funded account on tiktok.com in this browser first. TikTok connects the account that is signed in.",
      "Until TikTok approves the app, the account must be private and posts stay Only me.",
    ];
    expect(unsaid(tiktok, [NEW_ACCOUNT_LINE, beforeConnect("tiktok", "clips")])).toEqual([
      "TikTok connects the account that is signed in.",
      "Until TikTok approves the app, the account must be private and posts stay Only me.",
    ]);
    // A sentence ends at a stop and a space: x.com stays whole.
    const x = "Use a separate X account. First sign in to your Clips Funded account on x.com in this browser. X connects the account that is signed in.";
    expect(unsaid([x], [beforeConnect("x", "clips")])).toEqual(["Use a separate X account. X connects the account that is signed in."]);
    expect(unsaid([x], [])).toEqual([x]);
  });
});

describe("round 3 on the Social accounts page (§45.34)", () => {
  let host: HTMLElement;
  let root: Root;
  let store: MockStore;
  let calls: string[];

  async function render(page: { platform: string | null; result: string | null }, change?: (store: MockStore) => void) {
    await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    const real = mockStoriesApi();
    store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
    change?.(store);
    calls = [];
    setStoriesApi(
      new Proxy(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
        get(target, key: string) {
          return (...args: unknown[]) => {
            calls.push(key);
            return target[key]!(...args);
          };
        },
      }) as unknown as StoriesApi,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <ToastProvider>
          <ConnectionsScreen ws="stories" page={{ name: "connections", platform: page.platform as never, result: page.result, ws: null }} />
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    localStorage.clear();
  });

  const card = (platform: string) => host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
  const button = (el: HTMLElement, name: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
  const click = async (b: HTMLElement | undefined) => {
    expect(b).toBeTruthy();
    await act(async () => b!.click());
    for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  const uris = (el: HTMLElement) => Array.from(el.querySelectorAll(".st-copy__value")).map((c) => c.textContent);
  const BOTH = ["https://api.test/v1/stories-oauth/instagram/callback", "https://api.test/v1/stories-oauth/facebook/callback"];

  it("both Meta cards show both redirect URIs with Copy buttons, once the keys are saved and in the keys form", async () => {
    await render({ platform: null, result: null });
    for (const p of ["instagram", "facebook"]) {
      // The seed's Meta app keys are saved: the saved state shows both.
      expect(uris(card(p))).toEqual(BOTH);
      expect(button(card(p), /Copy/)?.getAttribute("aria-label")).toBe("Copy Instagram's redirect URI");
      expect(Array.from(card(p).querySelectorAll(".st-copy__btn")).map((b) => b.getAttribute("aria-label"))).toEqual(["Copy Instagram's redirect URI", "Copy Facebook's redirect URI"]);
      expect(card(p).textContent).toContain("Valid OAuth Redirect URIs");
    }
    await click(button(card("facebook"), "New keys"));
    // The keys form shows them too (the saved state's lines make way for it).
    expect(card("facebook").querySelector(".st-keys")).not.toBeNull();
    expect(uris(card("facebook"))).toEqual(BOTH);
    // The first lines are plain words; the developer site's own words are one tap away (§45.36 E14).
    expect(card("facebook").querySelector(".st-app__notes")?.textContent).toContain("Copy both addresses below into your Meta app's settings");
    expect(card("facebook").querySelector(".st-app__notes")?.textContent).not.toContain("Valid OAuth Redirect URIs");
    expect(card("facebook").querySelector(".st-app__go .st-tech-fold")?.textContent).toContain("Facebook Login › Settings › Valid OAuth Redirect URIs");
    // A platform with one app of its own shows its own one.
    expect(uris(card("youtube"))).toEqual([]);
  });

  it("after a connect says Connected as {name} ({handle}) and asks whether this is the Lamo Stories account: Yes", async () => {
    await render({ platform: "tiktok", result: "connected" }, (s) => {
      const t = s.social.find((a) => a.platform === "tiktok")!;
      Object.assign(t, { connectionStatus: "connected", reason: null, warning: null, accountName: "Clips Funded", handle: "@funded.clips" });
    });
    expect(document.body.textContent).toContain("Connected as Clips Funded (@funded.clips).");
    const ask = card("tiktok").querySelector<HTMLElement>('[aria-label="Is this your Clips Funded account?"]')!;
    expect(ask.textContent).toContain("Is this your Clips Funded account?");
    expect(button(ask, "Pick another account")).toBeTruthy();
    // Only the platform that was just connected asks.
    expect(card("youtube").querySelector(".st-intended")).toBeNull();
    await click(button(ask, "Yes, that's it"));
    expect(card("tiktok").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("Great! Clips Funded posts to this TikTok account (Clips Funded).");
  });

  it("Pick another connects again, to pick the intended account", async () => {
    await render({ platform: "youtube", result: "connected" });
    const ask = card("youtube").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.textContent).toContain("Connected as Clips Funded (@fundedclips).");
    expect(ask.textContent).toContain("Is this your Clips Funded channel?");
    await click(button(ask, "Pick another channel"));
    expect(calls).toContain("connectSocial");
  });

  it("a connect finished by picking from the list asks too; Clip Factory's own pick does not", async () => {
    await render({ platform: null, result: null });
    const list = () => card("instagram").querySelector<HTMLElement>(".st-choose")!;
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    await click(button(list(), /funded\.clips/));
    expect(calls).toContain("chooseSocial");
    const ask = card("instagram").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.getAttribute("aria-label")).toBe("Is this your Clips Funded account?");
    expect(ask.textContent).toContain("Connected as funded.clips.");
    expect(button(ask, "Pick another account")).toBeTruthy();
    expect(card("facebook").querySelector(".st-intended")).toBeNull();
    await click(button(ask, "Yes, that's it"));
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("Great! Clips Funded posts to this Instagram account (funded.clips).");
  });

  it("Clip Factory's own account in the list is never picked: the tap says why and sends nothing (§45.37 G8)", async () => {
    await render({ platform: null, result: null });
    const own = button(card("instagram").querySelector<HTMLElement>(".st-choose")!, /Clip Factory's own/)!;
    expect(own.getAttribute("aria-disabled")).toBe("true");
    await click(own);
    expect(calls).not.toContain("chooseSocial");
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.");
  });

  it("a connect that also warns about Lamo Clips' Meta connection (clips_meta_check) asks too", async () => {
    await render({ platform: "facebook", result: "clips_meta_check" }, (s) => {
      const fb = s.social.find((a) => a.platform === "facebook")!;
      Object.assign(fb, { connectionStatus: "connected", externalAccountId: "109876543210987", accountName: "Clips Funded", handle: "Clips Funded" });
    });
    expect(document.body.textContent).toContain("But Clip Factory may have lost Facebook");
    const ask = card("facebook").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.getAttribute("aria-label")).toBe("Is this your Clips Funded Page?");
    expect(ask.textContent).toContain("Connected as Clips Funded.");
  });

  it("after Disconnect, the line follows the app the account used: its own app, or Clip Factory's", async () => {
    await render({ platform: null, result: null }, (s) => {
      const fb = s.social.find((a) => a.platform === "facebook")!;
      Object.assign(fb, { connectionStatus: "connected", externalAccountId: "109876543210987", accountName: "Clips Funded", handle: "Clips Funded" });
    });
    await click(button(card("facebook"), "Disconnect"));
    await click(button(card("facebook"), "Yes, disconnect"));
    const note = () => host.querySelector(".st-note--wide")?.textContent ?? "";
    expect(note()).toContain("To remove Clips Funded completely, remove your Clips Funded app in the account's own settings. Clip Factory is not affected.");
    await click(host.querySelector<HTMLElement>(".st-note__close")!);
    await click(button(card("youtube"), "Disconnect"));
    await click(button(card("youtube"), "Yes, disconnect"));
    expect(note()).toContain("To remove Clip Factory from this account completely, remove the app in the account's own settings.");
  });

  it("says a reason code in words on a connected account too, when the server sent no warning", async () => {
    await render({ platform: null, result: null }, (s) => {
      const t = s.social.find((a) => a.platform === "tiktok")!;
      Object.assign(t, { connectionStatus: "connected", reason: "clips_unknown", warning: null });
    });
    expect(card("tiktok").textContent).toContain("Clips Funded cannot tell this TikTok account apart from Clip Factory's own. Check which account is signed in.");
    expect(card("tiktok").textContent).not.toContain("clips_unknown");
  });

  it("a card whose developer app still needs setting up has Set up the app as its one main button, opening the choice on the card", async () => {
    await render({ platform: null, result: null }, (s) => {
      s.social.find((a) => a.platform === "youtube")!.app = { choice: null, saved: false };
    });
    const yt = () => card("youtube");
    const setUp = () => button(yt(), /^Set up the app/)!;
    // One main button, no Connect yet (it comes once the app is ready), and the fold keeps its plain line.
    expect(setUp().classList.contains("st-btn--main")).toBe(true);
    expect(setUp().getAttribute("aria-expanded")).toBe("false");
    expect(button(yt(), "Pick another channel")).toBeUndefined();
    expect(yt().querySelector("details.st-conn__more > summary")?.textContent).toBe("More for YouTube");
    expect(yt().querySelector("[role=radiogroup]")).toBeNull();
    // The cards that are ready keep Connect and their plain line.
    for (const p of ["tiktok", "instagram", "facebook", "x"] as const) {
      expect(button(card(p), /^Set up the app/), p).toBeUndefined();
      expect(card(p).querySelector("details.st-conn__more > summary")?.textContent, p).toBe(`More for ${PLATFORM_NAME[p]}`);
    }
    // Set up the app: the choice opens on the card itself (not in a fold), in kid words; nothing is sent.
    await click(setUp());
    expect(setUp().getAttribute("aria-expanded")).toBe("true");
    const setup = yt().querySelector<HTMLElement>(".st-conn__setup")!;
    expect(setup.closest("details")).toBeNull();
    expect(setup.querySelector(".st-app__title")?.textContent).toBe("Pick the YouTube app");
    expect(setup.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Which YouTube app Clips Funded uses");
    // What the platform allows and Clip Factory's own account stay in More.
    expect(setup.querySelector(".st-limits, .st-conn__clips")).toBeNull();
    expect(calls).not.toContain("connectSocial");
    // Share Clip Factory's app: the app is ready, so Connect is back as the main button and the choice goes to More.
    // YouTube is connected, so the pick asks once more (Yes, switch apps); there is no second button of the pick's name.
    await click(button(setup, /Share Clip Factory's app/));
    expect(button(yt(), "Share Clip Factory's app")).toBeUndefined();
    await click(button(yt(), "Yes, switch apps"));
    expect(button(yt(), /^Set up the app/)).toBeUndefined();
    // Switching apps disconnected it first (Clip Factory is not touched): Connect YouTube is the one main button.
    expect(button(yt(), "Connect YouTube")?.classList.contains("st-btn--main")).toBe(true);
    expect(yt().querySelector("details.st-conn__more .st-app")).not.toBeNull();
  });

  it("closing More with a Disconnect still to answer drops the question, so it never waits hidden", async () => {
    await render({ platform: null, result: null });
    const more = () => card("youtube").querySelector<HTMLDetailsElement>("details.st-conn__more")!;
    await act(async () => {
      more().open = true;
      more().dispatchEvent(new Event("toggle"));
    });
    await click(button(card("youtube"), "Disconnect"));
    expect(button(card("youtube"), "Yes, disconnect")).toBeTruthy();
    await act(async () => {
      more().open = false;
      more().dispatchEvent(new Event("toggle"));
    });
    expect(button(card("youtube"), "Yes, disconnect")).toBeUndefined();
    expect(button(card("youtube"), "Disconnect")).toBeTruthy();
  });

  it("the short notes follow the platform's limits: who can see the posts, and what can go over a limit", () => {
    expect(limitNotes(["Until TikTok approves the app, the account must be private and posts stay Only me."])).toEqual([ONLY_ME_NOTE]);
    expect(limitNotes(["A new TikTok app starts in Sandbox: only test accounts added there can connect, and they must be private."])).toEqual([ONLY_ME_NOTE]);
    expect(limitNotes(["Clip Factory does not count Clips Funded's X posts, so if Clip Factory posts much more than planned, the month can go over your X limit by what Clips Funded spent."])).toEqual([X_OVER_NOTE]);
    expect(limitNotes(["One Google sign-in can hold several channels."])).toEqual([]);
  });

  it("says each line once: the API's limits that repeat the card's own lines stay out of its fold", async () => {
    const ONLY_ME = "Until TikTok approves the app, the account must be private and posts stay Only me.";
    await render({ platform: null, result: null }, (s) => {
      // As the API sends them (social.py _LIMITS["tiktok"] with Clip Factory's app).
      s.social.find((a) => a.platform === "tiktok")!.limits = [
        NEW_ACCOUNT_LINE,
        SHARED_APP_LINE,
        SHARED_APP_ACCOUNT_LINE,
        ONLY_ME,
        "Sign in to your Clips Funded account on tiktok.com in this browser first. TikTok connects the account that is signed in.",
      ];
    });
    const t = card("tiktok");
    for (const line of [NEW_ACCOUNT_LINE, SHARED_APP_LINE, SHARED_APP_ACCOUNT_LINE, beforeConnect("tiktok", "clips")]) expect(t.textContent!.split(line).length - 1, line).toBe(1);
    // Who can see the posts, and why to sign in first, are still there.
    expect(t.querySelector(".st-limits")?.textContent).toContain(ONLY_ME);
    expect(t.querySelector(".st-limits")?.textContent).toContain("TikTok connects the account that is signed in.");
  });

  it("every SocialReason code has its own words", () => {
    const codes = ["keys_changed", "token_dead", "expired", "expires_soon", "missing_permissions", "clips_unknown"] as const satisfies readonly SocialReason[];
    const words = codes.map((c) => reasonSentence(c, "instagram"));
    expect(new Set(words).size).toBe(codes.length);
    for (const w of words) expect(w).not.toBe(reasonSentence("something_new", "instagram"));
  });
});
