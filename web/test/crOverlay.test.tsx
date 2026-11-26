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
const { L, MAX_LAYERS, layersOf, layerBoxes, newLayerId, overlayLayers, pictureCount, timingOf, whenOf } = await import("../src/lib/crLayers.ts");

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
    // The picture goes as `logos` with its own id, and no old single `logo` (§54 L3).
    expect(shown.overlay?.logos).toHaveLength(1);
    expect(shown.overlay?.logos?.[0]?.layerId).toBeTruthy();
    expect(shown.overlay?.logos?.[0]?.logoId).toBeTruthy();
    expect(shown.overlay?.logo).toBeUndefined();
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

describe("more than one picture (§54)", () => {
  async function open(prepare?: (clip: Clip) => void) {
    const clip = store.clips.find((c) => c.status === "review" && c.layout === "facecam_top")!;
    prepare?.(clip);
    await mount(clip);
    if (!clip.cr?.active) {
      click(radio(W.active));
      await flush();
    }
    click(byText("button", W.edit));
    await flush();
  }
  const tile = () => q('.cr-logo__pick[aria-label="Lamo Clips"]');
  const items = () => Array.from(document.querySelectorAll<HTMLElement>(".cr-ed__logo"));
  const chipList = () => Array.from(document.querySelectorAll<HTMLElement>(".cr-chips .cr-chip"));
  const chipPick = (n: number) => chipList()[n]!.querySelector<HTMLElement>(".cr-chip__pick");
  const chipX = (n: number) => chipList()[n]!.querySelector<HTMLElement>(".cr-chip__x");
  const chosen = () => chipList().findIndex((c) => c.classList.contains("is-on"));
  const corner = (name: string) => q(`.cr-corner[aria-label="${name}"]`);
  const warning = () => q("[data-edit-warning]")?.textContent ?? "";
  const cap = () => q("[data-edit-cap]")?.textContent ?? "";
  const setRange = (v: string) => {
    const size = q<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(size, v);
      size.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const at = (el: HTMLElement) => [el.style.left, el.style.top].join(" ");

  it("tapping a library logo adds a picture, and tapping it again adds another copy; the new one is chosen", async () => {
    await open();
    expect(chipList()).toHaveLength(0);
    click(tile());
    expect(items()).toHaveLength(1);
    expect(chipList()).toHaveLength(1);
    expect(chosen()).toBe(0);
    click(tile());
    expect(items()).toHaveLength(2);
    expect(chipList()).toHaveLength(2);
    expect(chosen()).toBe(1);
    // Two that were not moved do not sit on each other: the first top right, the second top left.
    expect(at(items()[0]!)).not.toBe(at(items()[1]!));
    expect(q('.cr-logo__pick[aria-label="Lamo Clips"]')!.className).toContain("is-on");
  });

  it("at 4 pictures one line says so and the tiles stop adding; removing one brings adding back", async () => {
    await open();
    expect(cap()).toBe("");
    for (let i = 0; i < MAX_LAYERS; i++) click(tile());
    expect(chipList()).toHaveLength(4);
    expect(cap()).toBe("That's 4 pictures. Remove one to add another.");
    expect(tile()!.getAttribute("aria-disabled")).toBe("true");
    click(tile());
    expect(items()).toHaveLength(4);
    click(chipX(1));
    expect(chipList()).toHaveLength(3);
    expect(cap()).toBe("");
    expect(tile()!.getAttribute("aria-disabled")).toBeNull();
    click(tile());
    expect(items()).toHaveLength(4);
  });

  it("the corners, Size and drag change only the chosen picture", async () => {
    await open();
    click(tile());
    click(tile());
    const [a, b] = [at(items()[0]!), at(items()[1]!)];
    click(chipPick(0));
    expect(chosen()).toBe(0);
    setRange("12");
    expect(items()[0]!.style.width).toBe("12%");
    expect(items()[1]!.style.width).toBe("22%");
    click(corner("Bottom left"));
    expect(at(items()[0]!)).not.toBe(a);
    expect(at(items()[1]!)).toBe(b);
    // The arrow keys move the one in focus (and focusing it chooses it).
    act(() => items()[1]!.focus());
    expect(chosen()).toBe(1);
    const before = at(items()[1]!);
    act(() => void items()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(at(items()[1]!)).not.toBe(before);
    expect(items()[1]!.style.width).toBe("22%");
  });

  it("the one warning line is for the chosen picture; every covered chip has a dot", async () => {
    await open();
    click(tile());
    click(tile());
    // Both sit near the top of a facecam clip: the facecam starts at 400 px and a 22% square reaches past it.
    expect(chipList().map((c) => !!c.querySelector("[data-chip-dot]"))).toEqual([true, true]);
    expect(warning()).toBe("On the facecam");
    // The chosen one gets smaller and clears the facecam: its dot and the line go, the other's dot stays.
    setRange("12");
    expect(chipList().map((c) => !!c.querySelector("[data-chip-dot]"))).toEqual([true, false]);
    expect(warning()).toBe("");
    expect(items()[0]!.className).toContain("is-warn");
    expect(items()[1]!.className).not.toContain("is-warn");
    click(chipPick(0));
    expect(warning()).toBe("On the facecam");
    expect(chipPick(0)!.getAttribute("aria-label")).toContain("On the facecam");
  });

  it("the small x removes that picture, and the chip next to it is chosen", async () => {
    await open();
    click(tile());
    click(tile());
    click(tile());
    click(chipPick(1));
    click(chipX(1));
    expect(chipList()).toHaveLength(2);
    expect(items()).toHaveLength(2);
    expect(chosen()).toBe(1);
    expect(chipX(0)!.getAttribute("aria-label")).toBe(L.remove);
    // Keyboard: Delete on a focused chip removes it.
    act(() => chipPick(0)!.focus());
    act(() => void chipPick(0)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    expect(chipList()).toHaveLength(1);
    expect(document.activeElement).toBe(chipPick(0));
  });

  it("the Text chip appears with the words, is chosen while they are typed, and its x clears them", async () => {
    await open();
    click(tile());
    expect(q(".cr-chip--text")).toBeNull();
    typeInto(q<HTMLInputElement>('input[type="text"]')!, "#Valor");
    expect(q(".cr-chip--text")).not.toBeNull();
    expect(chipList().at(-1)!.classList.contains("is-on")).toBe(true);
    // The text size shows for the words, the slider for a picture.
    expect(q('[aria-label="Text size"]')).not.toBeNull();
    expect(q('input[type="range"]')).toBeNull();
    click(chipPick(0));
    expect(q('input[type="range"]')).not.toBeNull();
    expect(q('[aria-label="Text size"]')).toBeNull();
    click(q(".cr-chip--text .cr-chip__x"));
    expect(q(".cr-chip--text")).toBeNull();
    expect(q<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(items()).toHaveLength(1);
  });

  it("When changes the chosen one only: each picture and the words keep their own time", async () => {
    await open();
    click(tile());
    click(tile());
    typeInto(q<HTMLInputElement>('input[type="text"]')!, "#Valor");
    const setTimes = (from: string, to: string) => {
      const det = q<HTMLDetailsElement>("details.cr-fold")!;
      act(() => {
        det.open = true;
        det.dispatchEvent(new Event("toggle"));
      });
      const [f, t] = Array.from(det.querySelectorAll<HTMLInputElement>("input"));
      typeInto(f!, from);
      typeInto(t!, to);
    };
    click(chipPick(1));
    setTimes("1", "3");
    expect(q(".cr-ed__whole")!.textContent).toContain("1–3 s");
    click(chipPick(0));
    expect(q(".cr-ed__whole")!.textContent).toBe(W.whole);
    expect(q<HTMLDetailsElement>("details.cr-fold")!.open).toBe(false);
    click(chipPick(2));
    setTimes("2", "4");
    click(byText("button", W.make));
    await flush();
    const o = shown.overlay!;
    expect(o.logos).toHaveLength(2);
    expect(o.logos![0]!.timing).toBeUndefined();
    expect(o.logos![1]!.timing).toEqual({ startSec: 1, endSec: 3 });
    expect(o.timing).toEqual({ startSec: 2, endSec: 4 });
    expect(new Set(o.logos!.map((l) => l.layerId)).size).toBe(2);
  });

  it("Make it sends every picture in list order with its place and size, and no old `logo`", async () => {
    await open();
    click(tile());
    click(tile());
    click(chipPick(0));
    setRange("30");
    click(byText("button", W.make));
    await flush();
    const o = store.clips.find((c) => c.clipId === shown.clipId)!.overlay!;
    expect(o.logo).toBeUndefined();
    expect(o.logos!.map((l) => l.size)).toEqual([0.3, 0.22]);
    for (const l of o.logos!) {
      expect(l.x).toBeGreaterThan(0);
      expect(l.x).toBeLessThan(1);
    }
  });

  it("an edit made with one logo (§53) opens as one picture, keeps its time, and is made again as `logos`", async () => {
    const [logo] = await run(current.listLogos());
    await open((c) => {
      c.cr = { active: true };
      c.overlay = { rev: 1, status: "ready", logo: { logoId: logo!.logoId, x: 0.8, y: 0.12, size: 0.2 }, timing: { startSec: 1, endSec: 4 } };
    });
    expect(items()).toHaveLength(1);
    expect(chipList()).toHaveLength(1);
    expect(items()[0]!.style.left).toBe("80%");
    expect(q(".cr-ed__whole")!.textContent).toContain("1–4 s");
    click(byText("button", W.make));
    await flush();
    const o = store.clips.find((c) => c.clipId === shown.clipId)!.overlay!;
    expect(o.logo).toBeUndefined();
    expect(o.logos).toHaveLength(1);
    expect(o.logos![0]).toMatchObject({ logoId: logo!.logoId, x: 0.8, y: 0.12, size: 0.2, timing: { startSec: 1, endSec: 4 } });
    expect(o.timing).toBeUndefined();
  });

  it("an edit with several pictures opens with all of them, each with its own place and time", async () => {
    const [logo] = await run(current.listLogos());
    await open((c) => {
      c.cr = { active: true };
      c.overlay = {
        rev: 2,
        status: "ready",
        logos: [
          { layerId: "a1", logoId: logo!.logoId, x: 0.8, y: 0.12, size: 0.2 },
          { layerId: "b2", logoId: logo!.logoId, x: 0.2, y: 0.12, size: 0.15, timing: { startSec: 2, endSec: 5 } },
        ],
      };
    });
    expect(chipList()).toHaveLength(2);
    expect(items().map((i) => i.style.left)).toEqual(["80%", "20%"]);
    click(chipPick(1));
    expect(q(".cr-ed__whole")!.textContent).toContain("2–5 s");
    click(chipPick(0));
    expect(q(".cr-ed__whole")!.textContent).toBe(W.whole);
  });

  it("the card's tag counts the pictures", async () => {
    await open();
    click(tile());
    click(tile());
    click(byText("button", W.make));
    await flush();
    await wait(MOCK_RENDER_MS + 2500);
    expect(q(".cr-switch__tags")!.textContent).toContain(`${W.logo} × 2`);
  });

  it("deleting a logo takes its pictures off the clip", async () => {
    await open();
    click(tile());
    click(tile());
    click(q('.cr-logo__remove[aria-label="Delete Lamo Clips"]'));
    expect(items()).toHaveLength(0);
    expect(chipList()).toHaveLength(0);
  });
});

describe("the layers (§54 L3, L4)", () => {
  it("overlayLayers reads `logos`, else the one `logo` as a one-layer list with the edit's time", () => {
    const logo = { logoId: "a", x: 0.5, y: 0.5, size: 0.2 };
    expect(overlayLayers(undefined)).toEqual([]);
    expect(overlayLayers({})).toEqual([]);
    expect(overlayLayers({ logo, timing: { startSec: 1, endSec: 2 } })).toEqual([{ ...logo, layerId: "logo", timing: { startSec: 1, endSec: 2 } }]);
    const logos = [{ ...logo, layerId: "x" }];
    expect(overlayLayers({ logo, logos })).toBe(logos);
    expect(pictureCount({ logo })).toBe(1);
    expect(pictureCount({ logos: [...logos, { ...logos[0]!, layerId: "y" }] })).toBe(2);
    expect(pictureCount({})).toBe(0);
  });
  it("layersOf keeps ids unique and stops at the cap", () => {
    const one = { logoId: "a", x: 0.5, y: 0.5, size: 0.2 };
    const list = layersOf({ logos: Array.from({ length: 6 }, () => ({ ...one, layerId: "same" })) }, 30);
    expect(list).toHaveLength(MAX_LAYERS);
    expect(new Set(list.map((l) => l.layerId)).size).toBe(MAX_LAYERS);
  });
  it("newLayerId is short and never one that is taken", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newLayerId(taken);
      expect(id.length).toBeLessThanOrEqual(12);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
  it("whenOf and timingOf round-trip, and a bad number stays NaN", () => {
    expect(timingOf(whenOf(undefined, 30))).toBeUndefined();
    expect(timingOf(whenOf({ startSec: 1, endSec: 2.5 }, 30))).toEqual({ startSec: 1, endSec: 2.5 });
    expect(timingOf({ part: true, from: "", to: "3" })!.startSec).toBeNaN();
  });
  it("layerBoxes: moved ones stay, unmoved ones start at the top right, the top left, then under what is there", () => {
    const sq = { size: 0.2, width: 1, height: 1 };
    const boxes = layerBoxes([{ pos: null, ...sq }, { pos: null, ...sq }, { pos: null, ...sq }, { pos: { x: 0.5, y: 0.5 }, ...sq }]);
    expect(boxes[0]!.x).toBeGreaterThan(0.5);
    expect(boxes[1]!.x).toBeLessThan(0.5);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes[3]).toMatchObject({ x: 0.5, y: 0.5 });
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const apart = Math.abs(boxes[i]!.x - boxes[j]!.x) >= (boxes[i]!.w + boxes[j]!.w) / 2 - 1e-6 || Math.abs(boxes[i]!.y - boxes[j]!.y) >= (boxes[i]!.h + boxes[j]!.h) / 2 - 1e-6;
        expect(apart).toBe(true);
      }
  });
  it("bodyProblem: more than 4 pictures, and a picture's own bad time", () => {
    const layer = (i: number, extra = {}) => ({ layerId: `l${i}`, logoId: "a", x: 0.5, y: 0.5, size: 0.2, ...extra });
    expect(bodyProblem({ logos: [layer(1)] }, 30)).toBeNull();
    expect(bodyProblem({ logos: [1, 2, 3, 4, 5].map((i) => layer(i)) }, 30)).toBe("Up to 4 pictures.");
    expect(bodyProblem({ logos: [layer(1, { timing: { startSec: 5, endSec: 2 } })] }, 30)).not.toBeNull();
    expect(bodyProblem({ logos: [] }, 30)).not.toBeNull();
  });
  it("the mock: up to 4 pictures, the old `logo` still accepted, each picture checked", async () => {
    const id = store.clips.find((c) => c.status === "review")!.clipId;
    await run(current.setClipCr(id, { active: true }));
    const [logo] = await run(current.listLogos());
    const layer = (i: number, extra: object = {}) => ({ layerId: `l${i}`, logoId: logo!.logoId, x: 0.5, y: 0.5, size: 0.2, ...extra });
    await expect(run(current.makeOverlay(id, { logos: [1, 2, 3, 4, 5].map((i) => layer(i)) }))).rejects.toMatchObject({ status: 400, message: "Up to 4 pictures." });
    await expect(run(current.makeOverlay(id, { logos: [layer(1), layer(1)] }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { logos: [layer(1, { size: 0.9 })] }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { logos: [layer(1, { logoId: "nope" })] }))).rejects.toMatchObject({ status: 404 });
    await expect(run(current.makeOverlay(id, { logos: [layer(1, { timing: { startSec: 4, endSec: 1 } })] }))).rejects.toMatchObject({ status: 400 });
    await expect(run(current.makeOverlay(id, { logos: [] }))).rejects.toMatchObject({ status: 400 });
    const four = await run(current.makeOverlay(id, { logos: [1, 2, 3, 4].map((i) => layer(i, i === 2 ? { timing: { startSec: 1, endSec: 3 } } : {})) }));
    expect(four.overlay?.logos).toHaveLength(4);
    expect(four.overlay?.logos?.[1]?.timing).toEqual({ startSec: 1, endSec: 3 });
    expect(four.overlay?.logo).toBeUndefined();
    await run(current.resetOverlay(id));
    const old = await run(current.makeOverlay(id, { logo: { logoId: logo!.logoId, x: 0.5, y: 0.5, size: 0.2 } }));
    expect(old.overlay?.logo?.logoId).toBe(logo!.logoId);
    expect(old.overlay?.logos).toBeUndefined();
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
