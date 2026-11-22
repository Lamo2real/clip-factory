// Lamo Stories › Social accounts (docs/CONTRACTS.md §45.13, §45.16.7, §45.30): the account's `reason` is a code from
// the API and is always said in words (never shown as it is, never twice with the warning that says the same); a
// connected YouTube changes channel with "Pick another channel"; one own Meta app's keys are entered once and the
// Meta cards say that removing them goes for Instagram and Facebook; and the link to Clip Factory's guide says first
// that the new app's keys go here, never into Clip Factory's guide.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
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
