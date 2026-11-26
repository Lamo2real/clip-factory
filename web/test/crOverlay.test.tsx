// CR active in Review (docs/CONTRACTS.md §53): the switch is CR inactive until the owner turns it on, "Edit for campaign"
// shows only while it is active, the editor's one warning line, the logo library (add by picking, delete with Undo),
// Make it with the pretend render, the edit becoming ready with a celebration, and Reset. All against the mock API.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Clip } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Api;
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current }));
vi.mock("../src/api/upload.ts", () => ({ putFile: async () => undefined }));
const burst = vi.fn();
vi.mock("../src/lib/confetti.ts", () => ({ burst: (...a: unknown[]) => burst(...a), centerOf: () => undefined }));

const { mockApi, MOCK_RENDER_MS } = await (async () => ({ ...(await import("../src/api/mock/index.ts")), ...(await import("../src/api/mock/crOverlay.ts")) }))();
const { seed } = await import("../src/api/mock/fixtures.ts");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { CrSwitch } = await import("../src/screens/review/CrSwitch.tsx");
const { withOverlay, logoRefusal, withHashtags, bodyProblem, takeLogo, putLogoBack, W } = await import("../src/lib/crOverlay.ts");

let root: Root;
let host: HTMLElement;
let store: ReturnType<typeof seed>;
let shown: Clip;

/** A Review card's stand-in: it keeps the clip the way the list does (the fresh clip's CR and edit replace the old). */
function Harness({ first }: { first: Clip }) {
  const [clip, setClip] = useState(first);
  shown = clip;
  return <CrSwitch clip={clip} onClip={(fresh) => setClip((c) => withOverlay([c], fresh)[0]!)} />;
}

/** Waits for one mock call: its pretend latency is a timer, so the (fake) clock is moved on while it runs. */
async function run<T>(call: Promise<T>): Promise<T> {
  const settled = call.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(30);
  const out = await settled;
  if ("error" in out) throw out.error;
  return out.value;
}
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(50)));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const q = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const byText = (sel: string, text: string, from: ParentNode = document) => Array.from(from.querySelectorAll<HTMLElement>(sel)).find((e) => e.textContent?.trim() === text) ?? null;
const click = (el: Element | null) => {
  expect(el).not.toBeNull();
  act(() => (el as HTMLElement).click());
};
const typeInto = (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const radio = (label: string) => byText(".segmented__opt", label)?.querySelector<HTMLInputElement>("input")?.parentElement ?? null;

async function mount(first?: Clip) {
  const clip = first ?? store.clips.find((c) => c.status === "review" && c.layout === "facecam_top")!;
  await act(async () => {
    root.render(
      <ToastProvider>
        <Harness first={clip} />
      </ToastProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  burst.mockClear();
  store = seed();
  current = mockApi(store, { keepStopsAfterSave: 0, resumeAfterMs: 60_000, latencyMs: 0 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the switch", () => {
  it("is CR inactive by default and shows no editor button", async () => {
    await mount();
    expect(q<HTMLInputElement>('.segmented__opt.is-on input')!.parentElement!.textContent).toBe(W.inactive);
    expect(byText("button", W.edit)).toBeNull();
    expect(shown.cr).toBeUndefined();
  });

  it("CR active shows Edit for campaign; the server keeps the pick", async () => {
    await mount();
    click(radio(W.active));
    await flush();
    expect(byText("button", W.edit)).not.toBeNull();
    expect(shown.cr).toEqual({ active: true });
    expect(store.clips.find((c) => c.clipId === shown.clipId)!.cr).toEqual({ active: true });
  });

  it("the editor opens only from the button, and closes with Escape", async () => {
    await mount();
    expect(q('[role="dialog"]')).toBeNull();
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
    expect(q('[role="dialog"]')).not.toBeNull();
    act(() => q('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(q('[role="dialog"]')).toBeNull();
  });
});

describe("the editor's warning line", () => {
  async function open() {
    await mount();
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
  }
  const warning = () => q("[data-edit-warning]")?.textContent ?? "";
  const corner = (name: string) => q(`.cr-corner[aria-label="${name}"]`);

  it("says nothing until there is a logo or words, then names the area they sit on", async () => {
    await open();
    expect(warning()).toBe("");
    // The seeded logo, a square at the default top right: its bottom edge runs 30 px into the facecam of a facecam clip.
    click(q('.cr-logo__pick[aria-label="Lamo Clips"]'));
    expect(warning()).toBe("On the facecam");
    expect(q(".cr-ed__logo")!.className).toContain("is-warn");
    click(corner("Bottom left"));
    expect(warning()).toBe("Under the captions");
    click(corner("Top left"));
    // Top left is the same height; shrink the logo a little and it clears the facecam.
    const size = q<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(size, "12");
      size.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(corner("Top left"));
    expect(warning()).toBe("");
    expect(q(".cr-ed__logo")!.className).not.toContain("is-warn");
  });

  it("warns for the words too, and Make it waits until there is something to draw", async () => {
    await open();
    const make = byText("button", W.make)!;
    expect(make.getAttribute("aria-disabled")).toBe("true");
    typeInto(q<HTMLInputElement>('input[type="text"]')!, "#Valor");
    expect(make.getAttribute("aria-disabled")).toBeNull();
    expect(warning()).toBe("");
    click(corner("Bottom right"));
    expect(warning()).toBe("Under the captions");
    expect(q(".cr-ed__text")!.className).toContain("is-warn");
  });

  it("a clip with no facecam is only warned about the captions", async () => {
    const blur = store.clips.find((c) => c.status === "review" && c.layout === "blur_fill")!;
    await mount(blur);
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
    click(q('.cr-logo__pick[aria-label="Lamo Clips"]'));
    expect(warning()).toBe("");
  });
});

describe("the logo library", () => {
  async function open() {
    await mount();
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
  }
  const pick = (name: string, type: string, size = 100) => {
    const f = new File(["x"], name, { type });
    Object.defineProperty(f, "size", { value: size });
    const input = q<HTMLInputElement>('.cr-logo__add input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [f], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
  };
  const tiles = () => Array.from(document.querySelectorAll(".cr-logo__pick.is-on, button.cr-logo__pick")).length;

  it("adds a picked picture, picks it at once, and the mock keeps it", async () => {
    await open();
    expect(tiles()).toBe(1);
    pick("valor.png", "image/png");
    await wait(100);
    expect(tiles()).toBe(2);
    expect(q('.cr-logo__pick.is-on')?.getAttribute("aria-label")).toBe("valor.png");
    expect((await run(current.listLogos())).map((l) => l.name)).toEqual(["Lamo Clips", "valor.png"]);
  });

  const data = (files: File[], text = "") => ({
    types: ["Files"],
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    getData: (t: string) => (t === "text/plain" ? text : ""),
    dropEffect: "none",
  });
  const fire = (type: string, d: unknown, to: Element = q('[role="dialog"]')!) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", { value: d });
    act(() => void to.dispatchEvent(e));
    return e;
  };

  it("a picture dropped anywhere on the sheet is added", async () => {
    await open();
    const png = new File(["x"], "dropped.png", { type: "image/png" });
    fire("dragenter", data([png]));
    expect(q(".drop-layer")).not.toBeNull();
    fire("drop", data([png]), q(".cr-ed__preview")!);
    await wait(100);
    expect(tiles()).toBe(2);
    expect(q('.cr-logo__pick.is-on')?.getAttribute("aria-label")).toBe("dropped.png");
  });

  it("a pasted screenshot is added as Pasted logo; pasted text still types", async () => {
    await open();
    const shot = new File(["x"], "image.png", { type: "image/png" });
    const e = fire("paste", data([shot]));
    expect(e.defaultPrevented).toBe(true);
    await wait(100);
    expect(q('.cr-logo__pick.is-on')?.getAttribute("aria-label")).toBe("Pasted logo");
    const text = fire("paste", { items: [], files: [], getData: (t: string) => (t === "text/plain" ? "#Valor" : "") }, q('input[type="text"]')!);
    expect(text.defaultPrevented).toBe(false);
  });

  it("a dropped file that is not a picture is refused and adds nothing", async () => {
    await open();
    fire("drop", data([new File(["x"], "clip.mp4", { type: "video/mp4" })]));
    await wait(100);
    expect(tiles()).toBe(1);
  });

  it("refuses a file that is not a PNG, JPG or WebP with one sentence, and adds nothing", async () => {
    await open();
    pick("clip.mp4", "video/mp4");
    await wait(100);
    expect(tiles()).toBe(1);
    expect(document.body.textContent).toContain("Use a PNG, JPG or WebP picture under 10 MB.");
  });

  it("delete takes the tile away at once; Undo brings it back; the time running out deletes it for good", async () => {
    await open();
    click(q('.cr-logo__remove[aria-label="Delete Lamo Clips"]'));
    expect(tiles()).toBe(0);
    click(byText("button", "Undo"));
    await flush();
    expect(tiles()).toBe(1);
    expect((await run(current.listLogos())).length).toBe(1);
    click(q('.cr-logo__remove[aria-label="Delete Lamo Clips"]'));
    await wait(7000);
    expect(tiles()).toBe(0);
    expect(await run(current.listLogos())).toEqual([]);
  });

  it("deleting the logo the edit uses lets go of it", async () => {
    await open();
    click(q('.cr-logo__pick[aria-label="Lamo Clips"]'));
    expect(q(".cr-ed__logo")).not.toBeNull();
    click(q('.cr-logo__remove[aria-label="Delete Lamo Clips"]'));
    expect(q(".cr-ed__logo")).toBeNull();
  });
});

describe("For campaign (C6)", () => {
  it("picking a campaign stores it on the clip, copies its logo into the library and puts its hashtags in the text", async () => {
    await mount();
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
    await wait(200);
    const button = q<HTMLButtonElement>('[data-help="cr-for-campaign"] .dropdown__button');
    expect(button).not.toBeNull();
    click(button);
    await flush();
    click(byText('[role="option"]', "Valor Esports Clips"));
    await wait(300);
    expect(store.clips.find((c) => c.clipId === shown.clipId)!.cr?.campaignId).toBeTruthy();
    expect(shown.cr?.campaignId).toBeTruthy();
    expect(q('.cr-logo__pick.is-on')?.getAttribute("aria-label")).toBe("Valor Esports logo");
    expect(q<HTMLInputElement>('input[type="text"]')!.value).toBe("#Valor");
    // Both stay editable.
    typeInto(q<HTMLInputElement>('input[type="text"]')!, "#Valor #Ad");
    expect(q<HTMLInputElement>('input[type="text"]')!.value).toBe("#Valor #Ad");
  });
});

describe("Make it, the pretend render, Reset", () => {
  async function makeIt() {
    await mount();
    click(radio(W.active));
    await flush();
    click(byText("button", W.edit));
    await flush();
    click(q('.cr-logo__pick[aria-label="Lamo Clips"]'));
    typeInto(q<HTMLInputElement>('input[type="text"]')!, "#Valor");
    click(byText("button", W.make));
    await flush();
  }

  it("closes the sheet, says Making it…, polls, then the edit is ready and the card celebrates", async () => {
    await makeIt();
    expect(q('[role="dialog"]')).toBeNull();
    expect(shown.overlay?.status).toBe("working");
    expect(shown.overlay?.logo?.logoId).toBeTruthy();
    expect(shown.overlay?.text).toMatchObject({ text: "#Valor", size: "m" });
    expect(q(".cr-switch__working")!.textContent).toContain("Making it…");
    expect(byText("button", W.edit)).toBeNull();
    const calls = (window as unknown as { __cfMockCalls: Record<string, number> }).__cfMockCalls;
    const before = calls.getClip ?? 0;
    await wait(MOCK_RENDER_MS + 2500);
    expect(calls.getClip!).toBeGreaterThan(before);
    expect(shown.overlay?.status).toBe("ready");
    expect(burst).toHaveBeenCalledTimes(1);
    expect(q(".cr-switch__working")).toBeNull();
    expect(byText("button", W.edit)).not.toBeNull();
    expect(byText("button", W.reset)).not.toBeNull();
    expect(q(".cr-switch__tags")!.textContent).toContain(W.logo);
    expect(q(".cr-switch__tags")!.textContent).toContain(W.text);
  });

  it("a render that did not work says so, with Edit for campaign and Reset still there", async () => {
    (window as unknown as { __cfMock: { crOverlay: { failNext(): void } } }).__cfMock.crOverlay.failNext();
    await makeIt();
    await wait(MOCK_RENDER_MS + 2500);
    expect(shown.overlay?.status).toBe("failed");
    expect(q(".cr-switch__bad")!.textContent).toContain("did not work");
    expect(burst).not.toHaveBeenCalled();
    expect(byText("button", W.edit)).not.toBeNull();
  });

  it("Reset puts the original back and says Edit removed", async () => {
    await makeIt();
    await wait(MOCK_RENDER_MS + 2500);
    click(byText("button", W.reset));
    await flush();
    expect(shown.overlay).toBeUndefined();
    expect(store.clips.find((c) => c.clipId === shown.clipId)!.overlay).toBeUndefined();
    expect(document.body.textContent).toContain(W.removed);
  });

  it("switching to CR inactive on an edited clip removes the edit and says so", async () => {
    await makeIt();
    await wait(MOCK_RENDER_MS + 2500);
    click(radio(W.inactive));
    await flush();
    expect(shown.cr).toEqual({ active: false });
    expect(shown.overlay).toBeUndefined();
    expect(byText("button", W.edit)).toBeNull();
    expect(document.body.textContent).toContain(W.removed);
  });

  it("Upload is refused while the edit is being made", async () => {
    await makeIt();
    await expect(run(current.confirmClip(shown.clipId))).rejects.toMatchObject({ status: 409, message: "The edit is still being made." });
  });
});

describe("the mock's rules (the API's sentences)", () => {
  it("Make it needs CR active, a logo or words, and numbers in range", async () => {
    const id = store.clips.find((c) => c.status === "review")!.clipId;
    await expect(run(current.makeOverlay(id, { text: { text: "x", x: 0.5, y: 0.5, size: "m" } }))).rejects.toMatchObject({ status: 409 });
    await run(current.setClipCr(id, { active: true }));
    await expect(run(current.makeOverlay(id, {}))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { text: { text: "x".repeat(81), x: 0.5, y: 0.5, size: "m" } }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { text: { text: "x", x: 1.5, y: 0.5, size: "m" } }))).rejects.toMatchObject({ status: 400 });
    const [logo] = await run(current.listLogos());
    await expect(run(current.makeOverlay(id, { logo: { logoId: logo!.logoId, x: 0.5, y: 0.5, size: 0.6 } }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { logo: { logoId: "nope", x: 0.5, y: 0.5, size: 0.2 } }))).rejects.toMatchObject({ status: 404 });
    await expect(run(current.makeOverlay(id, { text: { text: "x", x: 0.5, y: 0.5, size: "m" }, timing: { startSec: 5, endSec: 2 } }))).rejects.toMatchObject({ status: 400 });
    const ok = await run(current.makeOverlay(id, { text: { text: "x", x: 0.5, y: 0.5, size: "m" }, timing: { startSec: 1, endSec: 3 } }));
    expect(ok.overlay).toMatchObject({ rev: 1, status: "working", timing: { startSec: 1, endSec: 3 } });
    await expect(run(current.makeOverlay(id, { text: { text: "y", x: 0.5, y: 0.5, size: "m" } }))).rejects.toMatchObject({ status: 409 });
  });

  it("the logo routes: only PNG, JPEG or WebP up to 10 MB, a campaign's logo once, 404 without one", async () => {
    await expect(run(current.createLogoUpload({ filename: "a.gif", contentType: "image/gif", size: 10 }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.createLogoUpload({ filename: "a.png", contentType: "image/png", size: 10 * 1024 * 1024 + 1 }))).rejects.toMatchObject({ status: 400 });
    const { CR_IDS } = await import("../src/api/mock/contentrewards.ts");
    const first = await run(current.logoFromCampaign(CR_IDS.logo));
    const again = await run(current.logoFromCampaign(CR_IDS.logo));
    expect(again.logoId).toBe(first.logoId);
    expect(first.campaignId).toBe(CR_IDS.logo);
    expect((await run(current.listLogos())).filter((l) => l.campaignId === CR_IDS.logo)).toHaveLength(1);
    await expect(run(current.logoFromCampaign(CR_IDS.faze))).rejects.toMatchObject({ status: 404 });
  });
});

describe("helpers", () => {
  it("logoRefusal: kind, size, empty and the 60 logo limit", () => {
    const f = (name: string, type: string, size = 5) => ({ name, type, size });
    expect(logoRefusal(f("a.png", "image/png"))).toBeNull();
    expect(logoRefusal(f("a.JPG", ""))).toBeNull();
    expect(logoRefusal(f("a.gif", "image/gif"))).toBe("Use a PNG, JPG or WebP picture under 10 MB.");
    expect(logoRefusal(f("a.png", "image/png", 10 * 1024 * 1024 + 1))).toBe("That picture is bigger than 10 MB.");
    expect(logoRefusal(f("a.png", "image/png", 0))).toBe("That file is empty.");
    expect(logoRefusal(f("a.png", "image/png"), 60)).toBe("Up to 60 logos. Delete one first.");
  });
  it("withHashtags adds the missing tags and never goes past 80 letters", () => {
    expect(withHashtags("", ["#Valor", "#Ad"])).toBe("#Valor #Ad");
    expect(withHashtags("New skin #valor", ["#Valor", "Ad"])).toBe("New skin #valor #Ad");
    expect(Array.from(withHashtags("x".repeat(75), ["#Valor"])).length).toBeLessThanOrEqual(80);
  });
  it("bodyProblem", () => {
    expect(bodyProblem({}, 30)).not.toBeNull();
    expect(bodyProblem({ text: { text: "  ", x: 0.5, y: 0.5, size: "s" } }, 30)).not.toBeNull();
    expect(bodyProblem({ text: { text: "hi", x: 0.5, y: 0.5, size: "s" }, timing: { startSec: 2, endSec: 1 } }, 30)).not.toBeNull();
    expect(bodyProblem({ text: { text: "hi", x: 0.5, y: 0.5, size: "s" }, timing: { startSec: Number.NaN, endSec: 4 } }, 30)).not.toBeNull();
    expect(bodyProblem({ text: { text: "hi", x: 0.5, y: 0.5, size: "s" }, timing: { startSec: 1, endSec: 4 } }, 30)).toBeNull();
  });
  it("takeLogo and putLogoBack keep the order", () => {
    const l = (logoId: string) => ({ logoId, name: logoId, url: "", width: 1, height: 1, createdAt: "" });
    const { list, removed } = takeLogo([l("a"), l("b"), l("c")], "b");
    expect(list.map((x) => x.logoId)).toEqual(["a", "c"]);
    expect(putLogoBack(list, removed!).map((x) => x.logoId)).toEqual(["a", "b", "c"]);
    expect(takeLogo(list, "zzz").removed).toBeNull();
  });
  it("withOverlay swaps in the fresh CR and edit, and drops an edit that is gone", () => {
    const base = store.clips[0]!;
    const edited = { ...base, cr: { active: true }, overlay: { rev: 1, status: "ready" as const, text: { text: "a", x: 0.5, y: 0.5, size: "s" as const } } };
    const [a] = withOverlay([base], edited);
    expect(a!.overlay?.status).toBe("ready");
    const [b] = withOverlay([a!], { ...base, cr: { active: false } });
    expect(b!.overlay).toBeUndefined();
    expect(b!.cr).toEqual({ active: false });
  });
});
