// Settings › Posting › My settings, TikTok's words (docs/CONTRACTS.md §47.9): while his Mac posts TikTok, every Review
// card starts on My settings, TikTok included, so the page never asks for "your own tap on each clip". While the Mac
// is off, TikTok's API rule still wants his tap, and the page says so as before.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, PlatformSetup, Settings } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let me: Me;
let platforms: PlatformSetup[] | null = null;
const saveSettings = vi.fn(async (patch: Partial<Settings>) => patch);
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me, saveSettings }) }));
vi.mock("../src/screens/settings/setup/useSetup.ts", () => ({
  useSetup: () => ({ data: platforms ? { platforms } : null, error: null, reload: async () => {}, put: () => {} }),
}));

const { MySettingsBranch } = await import("../src/screens/settings/MySettingsBranch.tsx");

const OWN_TAP = "TikTok wants your own tap on each clip, so tap Use my settings there.";
const COMMERCIAL = "Commercial content is off. For a paid partnership, tick Branded content in the TikTok row of that clip.";

let host: HTMLElement;
let root: Root;

function meWith(tiktokMac: Settings["tiktokMac"] | undefined): Me {
  return { user: { id: "u", email: "a@b.c" }, settings: { platforms: [], ...(tiktokMac ? { tiktokMac } : {}) } } as unknown as Me;
}

async function render(): Promise<void> {
  await act(async () => root.render(<MySettingsBranch />));
}

const tiktokHint = () => host.querySelector("#my-settings-tiktok .field__hint")?.textContent ?? "";
const note = () => host.querySelector(".preset-page__note")?.textContent ?? "";

beforeEach(() => {
  platforms = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("My settings, TikTok (§47.9)", () => {
  it("while his Mac posts TikTok: no own-tap sentence, and every clip starts on these", async () => {
    me = meWith({ on: true });
    await render();
    expect(tiktokHint()).toBe(COMMERCIAL);
    expect(host.textContent).not.toContain("own tap");
    // Nothing on the page (the TikTok leaf included) still asks for a tap on each clip.
    expect(host.textContent).not.toMatch(/still tap|tap Use my settings/i);
    expect(note()).toContain("Every clip on Review starts on these, TikTok too.");
    expect(note()).not.toContain("Tap Use my settings");
  });

  it("while the Mac is off: TikTok's API rule still wants his tap, word for word as before", async () => {
    me = meWith({ on: false });
    await render();
    expect(tiktokHint()).toBe(`${COMMERCIAL} ${OWN_TAP}`);
    expect(note()).toContain("Tap Use my settings on a clip to put these on.");
  });

  it("once TikTok approved the app, Review is back on TikTok's API rule, so the page asks for his tap again", async () => {
    me = meWith({ on: true });
    const ok = (key: string) => ({ key, state: "ok" });
    platforms = [{ platform: "tiktok", ready: true, gates: [ok("app_review"), ok("posting_audit")] } as unknown as PlatformSetup];
    await render();
    expect(tiktokHint()).toBe(`${COMMERCIAL} ${OWN_TAP}`);
    expect(note()).toContain("Tap Use my settings on a clip to put these on.");
  });

  it("an older server with no tiktokMac reads as off", async () => {
    me = meWith(undefined);
    await render();
    expect(tiktokHint()).toBe(`${COMMERCIAL} ${OWN_TAP}`);
  });
});
