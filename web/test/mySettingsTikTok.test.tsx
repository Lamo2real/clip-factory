// Settings › Posting › My settings, TikTok's words (docs/CONTRACTS.md §47.9): while his Mac posts TikTok, every Review
// card but a campaign clip starts on My settings, TikTok included, so the page never asks for "your own tap on each
// clip"; for a paid partnership he ticks Branded content on that clip's TikTok row and the Mac adds TikTok's label.
// While the Mac is off, TikTok's API rule still wants his tap, and the page says so as before.
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

const OWN_TAP = "TikTok wants your own tap, so tap Use my settings on each clip.";
const COMMERCIAL = "Commercial content: off.";
const MAC_COMMERCIAL = "Commercial content: off. Your Mac posts TikTok with these.";
// The paid-partnership how-to sits in one fold under the line (shut until tapped).
const PAID = "Tick Branded content in that clip's TikTok row.";
const MAC_PAID = "Tick Branded content in that clip's TikTok row.Your Mac adds TikTok's Paid partnership label when it posts it.Campaign clips have it ticked already.";

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
const paidFold = () => host.querySelector<HTMLDetailsElement>("#my-settings-tiktok details[data-my='paid']");

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
    expect(tiktokHint()).toBe(MAC_COMMERCIAL);
    // A paid partnership goes through the Mac with TikTok's label: the fold says how, shut until tapped.
    expect(paidFold()!.open).toBe(false);
    expect(paidFold()!.querySelector("summary")!.textContent).toBe("Paid partnership?");
    expect(paidFold()!.querySelector(".cr-fold__body")!.textContent).toBe(MAC_PAID);
    expect(host.textContent).not.toContain("own tap");
    // Never the old way round: no "can't post those", no TikTok app by hand, no "don't use Post with my Mac".
    expect(host.textContent).not.toMatch(/can't post those|in the TikTok app|Don't use Post with my Mac/i);
    // Nothing on the page (the TikTok leaf included) still asks for a tap on each clip.
    expect(host.textContent).not.toMatch(/still tap|tap Use my settings/i);
    expect(note()).toContain("Every clip on Review starts on these, TikTok too, except campaign clips.");
    expect(note()).not.toContain("Tap Use my settings");
  });

  it("while the Mac is off: TikTok's API rule still wants his tap, word for word as before", async () => {
    me = meWith({ on: false });
    await render();
    expect(tiktokHint()).toBe(`${COMMERCIAL} ${OWN_TAP}`);
    expect(paidFold()!.querySelector(".cr-fold__body")!.textContent).toBe(PAID);
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
