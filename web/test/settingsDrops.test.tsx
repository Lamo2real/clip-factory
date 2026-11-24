// Drag and drop on Clip Factory's settings uploads (docs/CONTRACTS.md §45.40.2): a skill file dropped on the
// Add a skill panel, a cookies.txt on the YouTube cookies panel and a picture on the background picture card are taken
// like the picker's; anything else is refused with the picker's own line. Nothing shows at rest.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Me, Settings, Skill } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL: Skill = {
  skillId: "sk_1",
  name: "funny-moments",
  title: "Funny moments",
  description: "Picks the laughs.",
  builtin: false,
  source: "upload",
  format: "md",
  size: 120,
  createdAt: "2026-11-23T10:00:00Z",
  updatedAt: "2026-11-23T10:00:00Z",
  version: 1,
};
const put = { uploadUrl: "https://up.example/put", key: "k", headers: {} };
const current = {
  listSkills: vi.fn(async () => [] as Skill[]),
  createSkillUpload: vi.fn(async (_name: string) => ({ ...put, skillId: "sk_1" })),
  createSkill: vi.fn(async () => SKILL),
  createCookiesUpload: vi.fn(async (_name: string) => put),
} satisfies Partial<Api>;
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as unknown as Api }));
vi.mock("../src/api/upload.ts", () => ({ putFile: vi.fn(async () => undefined) }));

const saveSettings = vi.fn(async (patch: Partial<Settings>) => patch);
const refresh = vi.fn(async () => undefined);
const me = { user: { id: "u", email: "a@b.c" }, settings: { hasYoutubeCookies: false, backgroundMode: "see-through" } } as unknown as Me;
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me, saveSettings, refresh }) }));
const shrinkImage = vi.fn(async (_f: File) => "data:image/jpeg;base64,AAAA");
vi.mock("../src/lib/prefs.ts", async (orig) => ({ ...(await orig<object>()), shrinkImage: (f: File) => shrinkImage(f) }));

const { SkillsSection } = await import("../src/screens/settings/SkillsSection.tsx");
const { BackgroundBranch, YoutubeBranch } = await import("../src/screens/settings/branches.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");

type Fired = Event & { dataTransfer: { dropEffect: string } };
function drag(type: string, files: File[]): Fired {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Fired;
  Object.assign(e, { dataTransfer: { types: ["Files"], files, items: [], getData: () => "", dropEffect: "none" }, relatedTarget: null, clientX: 300, clientY: 300 });
  return e;
}

let host: HTMLElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  localStorage.clear();
});

async function show(ui: ReactElement) {
  await act(async () => root.render(<ToastProvider>{ui}</ToastProvider>));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function fire(el: Element, e: Event) {
  await act(async () => {
    el.dispatchEvent(e);
  });
  return e;
}
async function until(ok: () => boolean) {
  await act(async () => {
    await vi.waitFor(
      () => {
        if (!ok()) throw new Error("not yet");
      },
      { timeout: 3000, interval: 10 },
    );
  });
}
/** A whole drag onto `el`: in, over (its highlight), then dropped. */
async function dragDrop(el: Element, files: File[]) {
  await fire(el, drag("dragenter", files));
  const over = await fire(el, drag("dragover", files));
  const layer = el.closest(".drop-host")?.querySelector(".drop-layer")?.textContent ?? null;
  const drop = await fire(el, drag("drop", files));
  return { over: over as Fired, layer, taken: drop.defaultPrevented };
}
const said = (zone: Element) => zone.querySelector("[role=status]")?.textContent;

describe("Settings drops", () => {
  it("a SKILL.md dropped on the Add a skill panel is uploaded; a PDF is refused with the picker's line", async () => {
    await show(<SkillsSection />);
    const panel = $("#add-skill")!.closest(".apple-panel")!;
    expect(panel.classList.contains("drop-host")).toBe(true);
    expect(panel.querySelector(".drop-layer")).toBeNull();
    const pdf = await dragDrop($("#add-skill .skill-add")!, [new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    expect(pdf.taken).toBe(true);
    expect(current.createSkillUpload).not.toHaveBeenCalled();
    expect(said(panel)).toBe("That is not a skill. Pick a SKILL.md file or a .zip with one inside.");
    const md = await dragDrop($("#add-skill")!, [new File(["---\nname: funny-moments\n---\nLaugh."], "SKILL.md", { type: "text/markdown" })]);
    expect(md.layer).toBe("Drop it here");
    expect(md.over.dataTransfer.dropEffect).toBe("copy");
    expect(md.taken).toBe(true);
    await until(() => current.createSkill.mock.calls.length === 1);
    expect(current.createSkillUpload).toHaveBeenCalledWith("SKILL.md");
  });

  it("a cookies.txt dropped on the YouTube cookies panel is checked and saved; another file is refused", async () => {
    await show(<YoutubeBranch />);
    const panel = $("#youtube-cookies")!.closest(".apple-panel")!;
    expect(panel.classList.contains("drop-host")).toBe(true);
    const png = await dragDrop($(".cookie-guide")!, [new File(["x"], "shot.png", { type: "image/png" })]);
    expect(png.taken).toBe(true);
    expect(said(panel)).toBe("This is not a cookies.txt file. Export it again and pick that file.");
    const cookies = [".youtube.com", "TRUE", "/", "TRUE", "0", "LOGIN_INFO", "abc"].join("\t");
    const txt = await dragDrop($("#youtube-cookies")!, [new File([`# Netscape HTTP Cookie File\n${cookies}\n`], "cookies.txt", { type: "text/plain" })]);
    expect(txt.layer).toBe("Drop it here");
    await until(() => current.createCookiesUpload.mock.calls.length === 1);
    expect(current.createCookiesUpload).toHaveBeenCalledWith("cookies.txt");
    await until(() => refresh.mock.calls.length === 1);
  });

  it("a picture dropped on the background picture card is set; a video is refused", async () => {
    await show(<BackgroundBranch />);
    const card = $(".bg-picker")!;
    expect(card.classList.contains("drop-host")).toBe(true);
    const mp4 = await dragDrop(card, [new File(["v"], "clip.mp4", { type: "video/mp4" })]);
    expect(mp4.taken).toBe(true);
    expect(shrinkImage).not.toHaveBeenCalled();
    expect(said(card)).toBe("That is not a picture. Tap Choose a picture and pick a JPG or PNG.");
    const png = new File(["p"], "beach.png", { type: "image/png" });
    const pic = await dragDrop(card.querySelector(".bg-picker__preview")!, [png]);
    expect(pic.layer).toBe("Drop it here");
    await until(() => shrinkImage.mock.calls.length === 1);
    expect(shrinkImage).toHaveBeenCalledWith(png);
    await until(() => saveSettings.mock.calls.some(([p]) => p.backgroundMode === "picture"));
  });
});
