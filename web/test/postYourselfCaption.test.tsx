// Post it on TikTok yourself shows and copies the clip's TikTok caption exactly as the API gives it: emoji, accents and
// other scripts unchanged (22 Nov 2026: a 💀 reached TikTok as an Apple logo and "üíÄ"; the API now repairs captions
// garbled by a Mac clipboard, api/src/clipfactory_api/mojibake.py, and this sheet must pass them on untouched).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Clip } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { PostYourself } = await import("../src/screens/library/PostYourself.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");

const CAPTION = '"stupid good samaritan" 💀🔥 é 日本\nhero or idiot?\n#gta6 #xqc';

const clip = {
  clipId: "01M7W6QDTJZQAC9JRGDASE716Q",
  jobId: "01M7W4VMKGDEYGBMRVM52VPQS2",
  status: "posted",
  hook: "the stickup was going fine until this guy",
  captions: { youtubeTitle: "t", youtubeDescription: "d", instagram: "i", facebook: "f", tiktok: CAPTION, x: "x" },
} as unknown as Clip;

let host: HTMLElement;
let root: Root;
let copied: string[];
beforeEach(() => {
  copied = [];
  current = { clipFile: () => Promise.resolve({ url: "https://media.example/clip.mp4", filename: "clip.mp4", expiresAt: "" }) } as Partial<Api>;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
  });
  vi.spyOn(window, "open").mockImplementation(() => null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Post it on TikTok yourself: the caption", () => {
  it("shows and copies 💀🔥, é and 日本 exactly", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <PostYourself clip={clip} onMarked={() => undefined} onClose={() => undefined} />
        </ToastProvider>,
      );
    });
    const box = document.querySelector(".ty-sheet__caption");
    expect(box?.textContent).toBe(CAPTION);

    const open = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Open TikTok"));
    expect(open).toBeTruthy();
    await act(async () => {
      open?.click();
    });
    expect(copied).toEqual([CAPTION]);
    expect(copied[0]).toContain("💀🔥");
    expect(copied[0]).not.toMatch(/\uf8ff|üíÄ|√©|Êó•/u);
    expect(document.querySelector(".ty-sheet__copied")?.textContent).toContain("copied");
  });
});
