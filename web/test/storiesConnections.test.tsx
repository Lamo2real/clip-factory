// Lamo Stories › Social accounts (docs/CONTRACTS.md §45.13, §45.16.7, §45.30): the account's `reason` is a code from
// the API and is always said in words (never shown as it is, never twice with the warning that says the same); a
// connected YouTube changes channel with "Pick another channel"; one own Meta app's keys are entered once and the
// Meta cards say that removing them goes for Instagram and Facebook; and the link to Clip Factory's guide says first
// that the new app's keys go here, never into Clip Factory's guide. Round 3 (§45.34): both Meta cards show both
// redirect URIs, a connect is said with the account it connected and asks whether it is the intended one, the line
// after Disconnect follows the app used, and every reason code is said in words.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { SocialReason, StoriesApi } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { ConnectionsScreen, KEYS_HERE_ONLY, reasonSentence } = await import("../src/stories/screens/Connections.tsx");

describe("the account's reason", () => {
  it("is a code said in plain words; anything unknown gets the plain sentence", () => {
    for (const code of ["keys_changed", "token_dead", "expires_soon", "signed_out_90_days", "missing_permissions", "expired", "clips_unknown"]) {
      const text = reasonSentence(code, "tiktok");
      expect(text).not.toMatch(/_/);
      expect(text).toMatch(/\.$/);
    }
    expect(reasonSentence("keys_changed", "tiktok")).toBe("The TikTok app keys changed. Connect again.");
    expect(reasonSentence("token_dead", "youtube")).toBe("Lamo Stories' YouTube sign-in stopped working. Connect again.");
    expect(reasonSentence("something_new", "x")).toBe("Lamo Stories' X needs connecting again.");
    expect(reasonSentence(null, "facebook")).toBe("Lamo Stories' Facebook needs connecting again.");
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
    expect(button(tiktok, "Reconnect")).toBeTruthy();
  });

  it("a connected YouTube changes channel with Pick another channel, the words its limits use", () => {
    const yt = card("youtube");
    expect(button(yt, "Pick another channel")).toBeTruthy();
    expect(button(yt, "Reconnect")).toBeUndefined();
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
    expect(fb.querySelector(".st-app__notes")?.textContent).toContain("never in Clip Factory");
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
      Object.assign(t, { connectionStatus: "connected", reason: null, warning: null, accountName: "Lamo Stories", handle: "@lamo.stories" });
    });
    expect(document.body.textContent).toContain("Connected as Lamo Stories (@lamo.stories).");
    const ask = card("tiktok").querySelector<HTMLElement>('[aria-label="Is this your Lamo Stories account?"]')!;
    expect(ask.textContent).toContain("Is this your Lamo Stories account?");
    expect(button(ask, "Pick another account")).toBeTruthy();
    // Only the platform that was just connected asks.
    expect(card("youtube").querySelector(".st-intended")).toBeNull();
    await click(button(ask, "Yes, that's it"));
    expect(card("tiktok").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("Great! Lamo Stories posts to this TikTok account (Lamo Stories).");
  });

  it("Pick another connects again, to pick the intended account", async () => {
    await render({ platform: "youtube", result: "connected" });
    const ask = card("youtube").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.textContent).toContain("Connected as Lamo Stories (@lamostories).");
    expect(ask.textContent).toContain("Is this your Lamo Stories channel?");
    await click(button(ask, "Pick another channel"));
    expect(calls).toContain("connectSocial");
  });

  it("a connect finished by picking from the list asks too; Clip Factory's own pick does not", async () => {
    await render({ platform: null, result: null });
    const list = () => card("instagram").querySelector<HTMLElement>(".st-choose")!;
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    await click(button(list(), /lamo\.stories/));
    expect(calls).toContain("chooseSocial");
    const ask = card("instagram").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.getAttribute("aria-label")).toBe("Is this your Lamo Stories account?");
    expect(ask.textContent).toContain("Connected as lamo.stories.");
    expect(button(ask, "Pick another account")).toBeTruthy();
    expect(card("facebook").querySelector(".st-intended")).toBeNull();
    await click(button(ask, "Yes, that's it"));
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("Great! Lamo Stories posts to this Instagram account (lamo.stories).");
  });

  it("Clip Factory's own account in the list is never picked: the tap says why and sends nothing (§45.37 G8)", async () => {
    await render({ platform: null, result: null });
    const own = button(card("instagram").querySelector<HTMLElement>(".st-choose")!, /Clip Factory's own/)!;
    expect(own.getAttribute("aria-disabled")).toBe("true");
    await click(own);
    expect(calls).not.toContain("chooseSocial");
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    expect(document.body.textContent).toContain("This is Clip Factory's own account. Clip Factory Stories needs its own separate account: sign in with a different one.");
  });

  it("a connect that also warns about Lamo Clips' Meta connection (clips_meta_check) asks too", async () => {
    await render({ platform: "facebook", result: "clips_meta_check" }, (s) => {
      const fb = s.social.find((a) => a.platform === "facebook")!;
      Object.assign(fb, { connectionStatus: "connected", externalAccountId: "109876543210987", accountName: "Lamo Stories", handle: "Lamo Stories" });
    });
    expect(document.body.textContent).toContain("But Clip Factory may have lost Facebook");
    const ask = card("facebook").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.getAttribute("aria-label")).toBe("Is this your Lamo Stories Page?");
    expect(ask.textContent).toContain("Connected as Lamo Stories.");
  });

  it("after Disconnect, the line follows the app the account used: its own app, or Clip Factory's", async () => {
    await render({ platform: null, result: null }, (s) => {
      const fb = s.social.find((a) => a.platform === "facebook")!;
      Object.assign(fb, { connectionStatus: "connected", externalAccountId: "109876543210987", accountName: "Lamo Stories", handle: "Lamo Stories" });
    });
    await click(button(card("facebook"), "Disconnect"));
    await click(button(card("facebook"), "Yes, disconnect"));
    const note = () => host.querySelector(".st-note--wide")?.textContent ?? "";
    expect(note()).toContain("To remove Lamo Stories completely, remove your Lamo Stories app in the account's own settings. Clip Factory is not affected.");
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
    expect(card("tiktok").textContent).toContain("Lamo Stories cannot tell this TikTok account apart from Clip Factory's own. Check which account is signed in.");
    expect(card("tiktok").textContent).not.toContain("clips_unknown");
  });

  it("every SocialReason code has its own words", () => {
    const codes = ["keys_changed", "token_dead", "expired", "expires_soon", "missing_permissions", "clips_unknown"] as const satisfies readonly SocialReason[];
    const words = codes.map((c) => reasonSentence(c, "instagram"));
    expect(new Set(words).size).toBe(codes.length);
    for (const w of words) expect(w).not.toBe(reasonSentence("something_new", "instagram"));
  });
});
