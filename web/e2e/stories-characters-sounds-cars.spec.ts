// Clips Funded's characters, sounds, cars and series in mock mode (docs/CONTRACTS.md §45.41 to §45.44), one spec for
// the owner's six asks of 23 Nov:
// * Sounds (§45.41): every voice, noise and effect has a play button that plays the synth's own sample (Web Audio is
//   watched: each source started names its file), one at a time, a second tap stops it, a play button never picks its
//   chip and never makes the click sound, a car hears its car sounds, and the part keeps 44 px targets (48 on phones).
// * Cars (§45.42): the rail's Cars, right under Characters, › Make a car opens the car flow; New character › A car
//   takes photos by drag and drop (3 dropped photos, 3 thumbnails); Design it makes 3 cartoon cars to pick from; the
//   picked one saves as a car in Cars, and Characters shows it too with its Car tag; the car pages keep the studio's
//   rules.
// * A person and a car (§45.43): Production's cast picker takes the main character plus a car, and the practice
//   writer's car scenes draw.
// * Series (§45.44): "My first car" made with the main character and the car, an idea filed in it, the "All ▾" switch,
//   an approved episode and its story so far; the kid path on a phone; a moved video becomes episode 2.
// Lamo Stories is switched on with cf.storiesPreview = 1; nothing leaves the machine. The mock's store lives in the
// page, so a flow moves inside the app (taps, or history.pushState) and never reloads.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { SAMPLE_ROOT } from "../src/stories/studio/samplesRoot.ts";
import { visibleEdges } from "./edges.ts";
import { findOverflow } from "./helpers.ts";

/** The mock's seeded ids (SEED_IDS in src/stories/api/mock/stories.ts, SEED_CAR_ID, SEED_SERIES_ID). */
const C = { pip: "01JSTCH0000000000000000001", rosso: "01JSTCH0000000000000000005" };
const S = { review: "01JSTST0000000000000000001" };
const SEED_SERIES = "01JSTSR0000000000000000001";
/** The effects a car picks from first (samples.ts CAR_SFX). */
const CAR_SFX = ["engine", "honk", "brake_squeal", "skid", "screech", "tyre_burst", "beep", "click"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface AudioSpy {
  /** the sample file of each buffer source started, in order */
  started: string[];
  /** the sample file of each source stopped by the player */
  stopped: string[];
  /** how many sample sources play now, and the most at once */
  live: number;
  most: number;
}
type MockWindow = Window & {
  __cfAudio?: AudioSpy;
  __cfSampleLog?: { url: string; action: string }[];
  __cfSoundLog?: { kind: string; target: string }[];
  __cfStoriesMock?: {
    knobs?: Record<string, unknown>;
    store?: {
      knobs: Record<string, unknown>;
      series: { seriesId: string; name: string; castIds: string[] }[];
      stories: { storyId: string; title: string; status: string; seriesId?: string; characterIds: string[] }[];
      characters: { characterId: string; name: string; kind?: string }[];
    };
  };
};

/**
 * Watches Web Audio from the page's first script: the bytes each /sounds/stories/ fetch gives, the buffer decoded
 * from them, and each buffer source started and stopped, so a test can say which file really played and that two
 * never play at once.
 */
function spyOnAudio() {
  const spy: AudioSpy = { started: [], stopped: [], live: 0, most: 0 };
  (window as MockWindow).__cfAudio = spy;
  const fromBytes = new WeakMap<ArrayBuffer, string>();
  const fromBuffer = new WeakMap<AudioBuffer, string>();
  const playing = new Set<AudioBufferSourceNode>();
  const plainFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await plainFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (url.startsWith("/sounds/stories/")) {
      const read = answer.arrayBuffer.bind(answer);
      answer.arrayBuffer = async () => {
        const bytes = await read();
        fromBytes.set(bytes, url);
        return bytes;
      };
    }
    return answer;
  };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, bytes: ArrayBuffer, ...rest: never[]) {
    const url = fromBytes.get(bytes);
    return (decode as (...a: unknown[]) => Promise<AudioBuffer>).call(this, bytes, ...rest).then((b) => {
      if (url) fromBuffer.set(b, url);
      return b;
    });
  } as typeof decode;
  const gone = (node: AudioBufferSourceNode) => {
    if (playing.delete(node)) spy.live = playing.size;
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: Parameters<typeof start>) {
    const url = this.buffer ? fromBuffer.get(this.buffer) : undefined;
    if (url) {
      spy.started.push(url);
      playing.add(this);
      spy.live = playing.size;
      spy.most = Math.max(spy.most, playing.size);
      this.addEventListener("ended", () => gone(this));
    }
    return start.apply(this, a);
  };
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (this: AudioBufferSourceNode, ...a: Parameters<typeof stop>) {
    const url = this.buffer ? fromBuffer.get(this.buffer) : undefined;
    if (url && playing.has(this)) spy.stopped.push(url);
    gone(this);
    return stop.apply(this, a);
  };
}

async function context(browser: Browser, width: number, height: number, touch: boolean, knobs?: Record<string, unknown>) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript((k) => {
    localStorage.setItem("cf.storiesPreview", "1");
    if (k) (window as MockWindow).__cfStoriesMock = { knobs: k };
  }, knobs ?? null);
  return ctx;
}

/** A studio page, opened fresh (a new mock store). */
async function open(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
}

/** Moves inside the app without a reload, so the mock store keeps what the test made. */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

async function settle(page: Page) {
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** A character's page, on its Sounds part. */
async function openSounds(page: Page, characterId: string) {
  await open(page, `/stories/characters/${characterId}`);
  await page.locator(".st-s-editor__parts .st-s-pick__opt", { hasText: "Sounds" }).click();
  await page.locator('.st-sd[aria-label="Sounds"]').waitFor();
}

const store = (page: Page) => page.evaluate(() => (window as MockWindow).__cfStoriesMock?.store);
const spied = (page: Page) => page.evaluate(() => (window as MockWindow).__cfAudio!);
const played = (page: Page) => page.evaluate(() => ((window as MockWindow).__cfSampleLog ?? []).filter((e) => e.action === "play").map((e) => e.url));

/** The studio's measured rules on the page as it is now (the same as stories-studio.spec.ts). */
async function audit(page: Page, label: string, phone: boolean, glide = true): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) if (/st-/.test(i.selector)) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  for (const e of await visibleEdges(page)) if (/\.st-/.test(e)) out.push(`${label}: edge ${e}`);
  const axe = await new AxeBuilder({ page }).include(".st-studio").withRules(["color-contrast"]).analyze();
  for (const v of axe.violations) for (const n of v.nodes) out.push(`${label}: contrast ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);
  const bad = await page.evaluate(
    ({ min, glide }) => {
      const found: string[] = [];
      const vw = document.documentElement.clientWidth;
      for (const e of document.querySelectorAll<HTMLElement>(".st-studio button, .st-studio a, .st-studio input:not([type=radio]):not([type=file])")) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(e).display === "inline") continue;
        const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
        if (r.height < min - 0.5 || r.width < min - 0.5) found.push(`"${name}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
        if (r.right > vw + 0.5 || r.left < -0.5) found.push(`"${name}" is off the screen`);
        const cursor = getComputedStyle(e).cursor;
        if (cursor !== "default" && cursor !== "auto") found.push(`"${name}" changes the cursor (${cursor})`);
      }
      if (glide) for (const bar of document.querySelectorAll(".st-studio [role=radiogroup]")) if (!bar.querySelector(":scope > .glide")) found.push(`a pick-one bar without its sliding highlight: ${bar.textContent?.slice(0, 40)}`);
      return found;
    },
    { min: phone ? 48 : 44, glide },
  );
  for (const b of bad) out.push(`${label}: ${b}`);
  return out;
}

/** Drops files on an element the way a browser does: dragenter, dragover, then drop, with the files in the drag. */
async function dropFiles(page: Page, target: Locator, names: string[]) {
  const drag = await page.evaluateHandle(
    ({ b64, names }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      for (const n of names) dt.items.add(new File([bytes], n, { type: "image/png" }));
      return dt;
    },
    { b64: PNG, names },
  );
  await target.dispatchEvent("dragenter", { dataTransfer: drag });
  await expect(target).toHaveClass(/is-over/);
  await expect(target.getByText("Let go to add")).toBeVisible();
  await target.dispatchEvent("dragover", { dataTransfer: drag });
  await target.dispatchEvent("drop", { dataTransfer: drag });
  await drag.dispose();
}

/** Whether each option's picture sits wholly inside its own card and is at least this wide. */
const artInside = (opts: Locator, min: number) =>
  opts.evaluateAll(
    (els, least) =>
      els.map((o) => {
        const a = o.querySelector(".st-s-pick__art")!.getBoundingClientRect();
        const r = o.getBoundingClientRect();
        return a.width >= least - 0.5 && a.top >= r.top - 0.5 && a.bottom <= r.bottom + 0.5 && a.left >= r.left - 0.5 && a.right <= r.right + 0.5;
      }),
    min,
  );

// ---------- A. Sound samples (§45.41) ----------

test.describe("sounds", () => {
  test("every play button plays its own sample through Web Audio, one at a time, and a second tap stops it", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await context(browser, 1280, 900, false);
    await ctx.addInitScript(spyOnAudio);
    const page = await ctx.newPage();
    await openSounds(page, C.pip);

    // Pip babbles at pitch 1.25: the voices and noises come from the p125 stop, the effects from sfx/.
    const want: [string, string][] = [
      ["Babble voice", `${SAMPLE_ROOT}/babble/p125/babble.mp3`],
      ["Hum voice", `${SAMPLE_ROOT}/hum/p125/babble.mp3`],
      ...CATALOG.noises.map((n): [string, string] => [n.label, `${SAMPLE_ROOT}/babble/p125/${n.id}.mp3`]),
      ...CATALOG.sfx.map((s): [string, string] => [s.label, `${SAMPLE_ROOT}/sfx/${s.id}.mp3`]),
    ];
    expect(want.length).toBe(2 + 11 + 23);
    const pressedBefore = await page.locator(".st-sd [aria-pressed]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));
    for (const [label, url] of want) {
      const n = (await spied(page)).started.length;
      await page.getByRole("button", { name: `Play ${label}`, exact: true }).click();
      await expect.poll(async () => (await spied(page)).started.slice(n), { message: `Play ${label}` }).toEqual([url]);
    }
    const spy = await spied(page);
    expect(spy.most, "two samples played at once").toBe(1);
    // Tapping the play buttons picked nothing, and never made the click sound.
    expect(await page.locator(".st-sd [aria-pressed]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")))).toEqual(pressedBefore);
    const clicks = await page.evaluate(() => ((window as MockWindow).__cfSoundLog ?? []).filter((e) => /^(Play|Stop) /.test(e.target)));
    expect(clicks).toEqual([]);

    // One at a time: Wind plays (2.5 s), then Rain stops it and plays alone; a second tap on Rain stops it.
    await page.getByRole("button", { name: "Play Wind", exact: true }).click();
    await expect.poll(async () => (await spied(page)).started.at(-1)).toBe(`${SAMPLE_ROOT}/sfx/wind.mp3`);
    await expect(page.getByRole("button", { name: "Stop Wind", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Play Rain", exact: true }).click();
    await expect.poll(async () => (await spied(page)).started.at(-1)).toBe(`${SAMPLE_ROOT}/sfx/rain.mp3`);
    expect((await spied(page)).stopped.at(-1)).toBe(`${SAMPLE_ROOT}/sfx/wind.mp3`);
    expect((await spied(page)).live).toBe(1);
    await expect(page.getByRole("button", { name: "Play Wind", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop Rain", exact: true }).click();
    await expect.poll(async () => (await spied(page)).live).toBe(0);
    expect((await spied(page)).stopped.at(-1)).toBe(`${SAMPLE_ROOT}/sfx/rain.mp3`);
    await expect(page.getByRole("button", { name: "Play Rain", exact: true })).toBeVisible();
    expect((await spied(page)).most).toBe(1);
    await ctx.close();
  });

  test("Play Gasp plays the synth's own sample, without picking the chip", async ({ browser }) => {
    const ctx = await context(browser, 1280, 900, false);
    const page = await ctx.newPage();
    await openSounds(page, C.pip);

    // Pip's pitch is 1.25: down to the middle stop (1) with the keys; it plays the voice there once the keys rest.
    const slider = page.getByRole("slider", { name: "Voice pitch" });
    const voice = page.waitForResponse((r) => r.url().endsWith("/babble/p100/babble.mp3"));
    await slider.focus();
    for (let i = 0; i < 5; i++) await slider.press("ArrowLeft");
    expect((await voice).status()).toBe(200);
    expect(await slider.inputValue()).toBe("1");

    const chip = page.getByRole("button", { name: "Gasp", exact: true });
    const pressed = await chip.getAttribute("aria-pressed");
    expect(pressed).toMatch(/^(true|false)$/);
    const gasp = page.waitForResponse((r) => r.url().endsWith("/babble/p100/gasp.mp3"));
    await page.getByRole("button", { name: "Play Gasp", exact: true }).click();
    const answer = await gasp;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["content-type"]).toMatch(/^audio\/mpeg/);
    expect(answer.url()).toMatch(/\/sounds\/stories\/[0-9a-f]{10}\/babble\/p100\/gasp\.mp3$/);
    await expect(chip).toHaveAttribute("aria-pressed", pressed!);
    expect((await played(page)).at(-1)).toMatch(/\/babble\/p100\/gasp\.mp3$/);
    await ctx.close();
  });

  test("a car hears its car sounds first, and Play Honk fetches the honk", async ({ browser }) => {
    const ctx = await context(browser, 1280, 900, false);
    const page = await ctx.newPage();
    await openSounds(page, C.rosso);
    await expect(page.getByText("Rosso has no voice. Pick its car sounds.")).toBeVisible();
    await expect(page.getByRole("slider", { name: "Voice pitch" })).toHaveCount(0);
    const first = await page.locator(".st-sd .st-s-chips").first().locator(".st-s-hear").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(first).toEqual(CAR_SFX.map((id) => `Play ${CATALOG.sfx.find((s) => s.id === id)!.label}`));
    const honk = page.waitForResponse((r) => r.url().endsWith("/sfx/honk.mp3"));
    await page.getByRole("button", { name: "Play Honk", exact: true }).click();
    expect((await honk).status()).toBe(200);
    await ctx.close();
  });

  for (const [w, h, touch] of [
    [320, 640, true],
    [390, 844, true],
    [1280, 900, false],
  ] as const)
    test(`the Sounds part fits and keeps 44 px targets (48 on phones) at ${w}x${h}`, async ({ browser }) => {
      const ctx = await context(browser, w, h, touch);
      const page = await ctx.newPage();
      await openSounds(page, C.pip);
      const o = await findOverflow(page);
      expect(o.page, "sideways scroll").toBeLessThanOrEqual(o.viewport);
      const small = await page.evaluate((min) => {
        const out: string[] = [];
        for (const e of document.querySelectorAll<HTMLElement>(".st-sd button, .st-sd a, .st-sd input:not([type=radio])")) {
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(e).display === "inline") continue;
          const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
          if (r.height < min - 0.5 || r.width < min - 0.5) out.push(`"${name}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
          const cursor = getComputedStyle(e).cursor;
          if (cursor !== "default" && cursor !== "auto") out.push(`"${name}" changes the cursor (${cursor})`);
        }
        return out;
      }, touch ? 48 : 44);
      expect(small).toEqual([]);
      expect(await page.locator(".st-sd .st-s-hear").count()).toBeGreaterThan(30);
      const axe = await new AxeBuilder({ page }).include(".st-sd").withRules(["color-contrast"]).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
      await ctx.close();
    });
});

// ---------- B to D. The owner's whole flow: a car, the car in a video, and a series ----------

test("the owner's flow: a car from 3 dropped photos, the main character and the car in one video, and the series “My first car” that remembers the story so far", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await context(browser, 1280, 860, false, { taskSeconds: 1 });
  const page = await ctx.newPage();
  let car = { id: "", name: "" };

  await test.step("the rail's Cars place: Make a car opens the car flow", async () => {
    await page.goto("/stories");
    await page.locator(".st-rail .st-rail__item.is-active").waitFor({ timeout: 20_000 });
    const rail = page.locator(".st-rail");
    // Right under Characters, with its car icon.
    await expect(rail.locator(".st-rail__label").nth(2)).toHaveText("Characters");
    await expect(rail.locator(".st-rail__label").nth(3)).toHaveText("Cars");
    await expect(rail.getByRole("link", { name: "Cars", exact: true }).locator("svg")).toHaveCount(1);
    await rail.getByRole("link", { name: "Cars", exact: true }).click();
    await expect(page).toHaveURL(/\/stories\/cars$/);
    await settle(page);
    await expect(page).toHaveTitle(/^Cars · /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cars");
    await expect(rail.locator(".st-rail__item.is-active .st-rail__label")).toHaveText("Cars");
    await expect(page.locator(".st-s-cast__card", { hasText: "Rosso" })).toBeVisible();
    await page.getByRole("link", { name: "Make a car", exact: true }).click();
    await expect(page).toHaveURL(/\/stories\/cars\/new$/);
    await expect(page.getByRole("heading", { name: "New car", exact: true })).toBeVisible();
    await expect(page.locator(".st-s-photos__zone")).toBeVisible();
    await expect(page.locator(".st-s-kindbox")).toHaveCount(0);
  });

  await test.step("New character › A car shows the photo drop, and 3 dropped photos show 3 thumbnails", async () => {
    await rail(page, "Characters");
    await page.getByRole("link", { name: /New character/ }).first().click();
    await expect(page).toHaveURL(/\/stories\/characters\/new/);
    await settle(page);
    await expect(page.locator(".st-s-photos")).toHaveCount(0);
    // The two big tiles each show their picture inside the tile.
    expect(await artInside(page.locator(".st-s-kindbox .st-s-pick__opt"), 72)).toEqual([true, true]);
    await page.locator(".st-s-kindbox .st-s-pick__opt", { hasText: "A car" }).click();
    const zone = page.locator(".st-s-photos__zone");
    await expect(zone).toBeVisible();
    await expect(page.getByText("Your car's photos")).toBeVisible();
    await expect(zone.locator('input[type="file"]')).toHaveAttribute("multiple", "");
    await dropFiles(page, zone, ["front.png", "side.png", "back.png"]);
    await expect(page.locator(".st-s-photos__item")).toHaveCount(3);
    await expect(page.locator(".st-s-photos__item.is-ready")).toHaveCount(3, { timeout: 15_000 });
    const thumbs = page.locator(".st-s-photos__item img");
    await expect(thumbs).toHaveCount(3);
    await expect.poll(() => thumbs.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toEqual([true, true, true]);
    await expect(page.getByRole("button", { name: "Remove photo 3" })).toBeVisible();
  });

  await test.step("Design it makes 3 cartoon cars; picking the second and saving makes a car in Cars", async () => {
    await page.getByLabel("What is your car like? (you can skip this)").fill("my red hatchback, a bit old");
    // The model chip: the owner's pick for character_design (Fable 5.2 · High unless changed).
    await expect(page.locator(".st-s-design--car .st-s-ai-btn")).toBeVisible();
    await page.getByRole("button", { name: "Design it", exact: true }).click();
    const cards = page.locator(".st-s-caropts .st-s-pick__opt");
    await expect(cards).toHaveCount(3, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Pick one" })).toBeVisible();
    await expect(cards.first()).toContainText("Picked");
    expect(await cards.locator("canvas.st-car-preview").count()).toBe(3);
    // Each cartoon car is drawn big inside its own card, above its name (never squeezed into a small box).
    expect(await artInside(cards, 96)).toEqual([true, true, true]);
    const second = (await cards.nth(1).locator(".st-s-pick__label").textContent())!.trim();
    await cards.nth(1).click();
    await expect(cards.nth(1)).toContainText("Picked");
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(second);
    await page.getByRole("button", { name: "Save car" }).click();
    await expect(page).toHaveURL(/\/stories\/cars\/[0-9A-Z]{26}$/, { timeout: 20_000 });
    await settle(page);
    car = { id: page.url().split("/").pop()!, name: second };
    await expect(page.getByRole("heading", { name: second, exact: true })).toBeVisible();
    await expect(page.locator(".st-s-refs__item")).toHaveCount(3, { timeout: 15_000 });
    const saved = (await store(page))!.characters.find((c) => c.characterId === car.id);
    expect(saved).toMatchObject({ name: second, kind: "car" });
    await rail(page, "Cars");
    await expect(page.locator(".st-s-cast__card", { hasText: second }).locator(".st-s-tag").first()).toHaveText("Car");
  });

  await test.step("Production's cast picker takes the main character plus the car", async () => {
    await rail(page, "Production");
    await page.getByRole("link", { name: "Make a new video" }).first().click();
    await expect(page).toHaveURL(/\/stories\/production\/new/);
    await settle(page);
    await expect(page.locator(".st-cast__row")).toHaveText(["People", "Your cars"]);
    const pip = page.locator(".st-s-casttile", { hasText: "Pip" }).first();
    if ((await pip.getAttribute("aria-pressed")) !== "true") await pip.click();
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: car.name }).click();
    await expect(page.locator('.st-s-casttile[aria-pressed="true"]')).toHaveCount(2);
    await expect(pip).toHaveAttribute("aria-pressed", "true");
    // A second car swaps for the first: one car at most.
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: "Rosso" }).click();
    await expect(page.locator('.st-cast__cars .st-s-casttile[aria-pressed="true"]')).toHaveText(/Rosso/);
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: car.name }).click();
    await expect(page.locator('.st-cast__cars .st-s-casttile[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByText("Add someone to drive it.")).toHaveCount(0);
  });

  let seriesId = "";
  await test.step("a series “My first car” with the main character and the car", async () => {
    // The mock seeds a series with that name: deleting it keeps its videos, under No series.
    await go(page, `/stories/series/${SEED_SERIES}`);
    await page.getByRole("button", { name: "More for My first car" }).click();
    await page.locator(".st-series-menu").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Delete My first car? Its videos stay, under No series.")).toBeVisible();
    await page.locator(".st-series-sheet").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Deleted. Its videos are under No series.")).toBeVisible();
    await expect(page).toHaveURL(/\/stories\/series$/);
    const kept = await store(page);
    expect(kept!.series.some((s) => s.seriesId === SEED_SERIES)).toBe(false);
    expect(kept!.stories.filter((s) => s.status === "published").every((s) => !s.seriesId)).toBe(true);

    await rail(page, "Series");
    await page.getByRole("button", { name: "New series", exact: true }).first().click();
    const sheet = page.locator(".st-series-sheet");
    await sheet.getByLabel("Name").fill("My first car");
    await sheet.getByRole("button", { name: /^Pip/ }).click();
    await sheet.getByRole("button", { name: new RegExp(`^${car.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
    await sheet.getByLabel("About it (you can skip this)").fill("He buys a car and drives it");
    await sheet.getByRole("button", { name: "Make it", exact: true }).click();
    await expect(page).toHaveURL(/\/stories\/series\/[0-9A-Z]{26}$/);
    await settle(page);
    seriesId = page.url().split("/").pop()!;
    await expect(page.locator(".st-series-head__name")).toHaveText("My first car");
    await expect(page.locator(".st-series-head__line")).toHaveText("He buys a car and drives it");
    expect((await store(page))!.series.find((s) => s.seriesId === seriesId)!.castIds).toEqual([C.pip, car.id]);
  });

  await test.step("an idea filed in the series, and the switch shows one series or none", async () => {
    await rail(page, "Ideas");
    await page.locator(".st-series-switch").click();
    await page.locator(".st-series-sheet").getByRole("button", { name: /^My first car/ }).click();
    await expect(page).toHaveURL(new RegExp(`/stories/ideas\\?series=${seriesId}$`));
    await expect(page.locator(".st-series-switch__name")).toHaveText("My first car");
    await expect(page.locator(".st-s-idea")).toHaveCount(0);
    await page.getByRole("button", { name: "New idea", exact: true }).click();
    const form = page.getByRole("form", { name: "New idea" });
    await expect(form.getByText("For My first car")).toBeVisible();
    await form.getByRole("textbox", { name: "Title", exact: true }).fill("The first drive");
    await form.getByRole("textbox", { name: "What happens, in one line" }).fill("He buys the red car and drives it round the block.");
    await form.locator(".st-s-pick__opt", { hasText: "Funny" }).click();
    await form.getByRole("button", { name: "Save idea" }).click();
    await expect(page.locator(".st-s-idea", { hasText: "The first drive" })).toBeVisible();
    await expect(page.locator(".st-s-idea")).toHaveCount(1);
    await page.locator(".st-series-switch").click();
    await page.locator(".st-series-sheet").getByRole("button", { name: "No series", exact: true }).click();
    await expect(page).toHaveURL(/\/stories\/ideas\?series=none$/);
    await expect(page.locator(".st-s-idea", { hasText: "The first drive" })).toHaveCount(0);
    await page.locator(".st-series-switch").click();
    await page.locator(".st-series-sheet").getByRole("button", { name: "All", exact: true }).click();
    await expect(page).toHaveURL(/\/stories\/ideas$/);
    await expect(page.locator(".st-s-idea", { hasText: "The first drive" })).toBeVisible();
    await go(page, `/stories/series/${seriesId}`);
    await expect(page.locator(".st-series-coming")).toContainText("The first drive");
    await expect(page.locator(".st-series-quiet", { hasText: "It fills in when an episode is approved." })).toBeVisible();
  });

  await test.step("an approved episode fills the story so far", async () => {
    await go(page, `/stories/review/${S.review}`);
    await page.getByRole("button", { name: /^Move “When the car starts to slide”/ }).click();
    const sheet = page.locator(".st-series-sheet");
    await sheet.getByRole("button", { name: /^My first car/ }).click();
    await sheet.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Moved to My first car.")).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Added to My first car as episode 1.")).toBeVisible();
    await go(page, `/stories/series/${seriesId}`);
    await expect(page.locator(".st-series-ep__n")).toHaveText(["Ep 1"]);
    await expect(page.locator(".st-series-ep").first()).toContainText("When the car starts to slide");
    await expect(page.locator("#st-series-sofar")).toHaveText("Story so far");
    await expect(page.locator(".st-series-sofar")).toContainText("Where things stand:", { timeout: 15_000 });
    await expect(page.locator(".st-series-by")).toHaveText("Written by Clips Funded");
  });
  await ctx.close();
});

/** Opens a rail place by its word (the desktop rail). */
async function rail(page: Page, word: string) {
  await page.locator(".st-rail").getByRole("link", { name: word, exact: true }).click();
  await settle(page);
}

// ---------- B. Cars (§45.42) ----------

test.describe("cars", () => {
  for (const [w, h, touch] of [
    [390, 844, true],
    [1280, 800, false],
  ] as const)
    test(`a car from 3 photos: pick the second option, save, and it is in Cars as a Car (${w})`, async ({ browser }) => {
      test.setTimeout(90_000);
      const ctx = await context(browser, w, h, touch, { taskSeconds: 1 });
      const page = await ctx.newPage();
      await open(page, "/stories/cars");
      await page.getByRole("link", { name: "Make a car", exact: true }).click();
      await expect(page).toHaveURL(/\/stories\/cars\/new$/);
      await expect(page.getByRole("heading", { name: "New car", exact: true })).toBeVisible();
      await expect(page.getByText("Your car's photos")).toBeVisible();
      await page.locator('.st-s-photos input[type="file"]').setInputFiles(
        ["front.png", "side.png", "back.png"].map((name) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG, "base64") })),
      );
      await expect(page.locator(".st-s-photos__item")).toHaveCount(3);
      await expect(page.locator(".st-s-photos__item.is-ready")).toHaveCount(3, { timeout: 15_000 });
      await page.getByLabel("What is your car like? (you can skip this)").fill("my red hatchback, a bit old");
      await page.getByRole("button", { name: "Design it", exact: true }).click();
      const cards = page.locator(".st-s-caropts .st-s-pick__opt");
      await expect(cards).toHaveCount(3, { timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "Pick one" })).toBeVisible();
      await expect(cards.first()).toContainText("Picked");
      expect(await audit(page, `Pick one ${w}`, touch && w < 768)).toEqual([]);
      const second = (await cards.nth(1).locator(".st-s-pick__label").textContent())!.trim();
      await cards.nth(1).click();
      await expect(cards.nth(1)).toContainText("Picked");
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(second);
      await page.getByRole("button", { name: "Save car" }).click();
      await expect(page).toHaveURL(/\/stories\/cars\/[0-9A-Z]{26}$/, { timeout: 20_000 });
      await expect(page.getByRole("heading", { name: second, exact: true })).toBeVisible();
      // The photos it was made from stay with it.
      await expect(page.locator(".st-s-refs__item")).toHaveCount(3, { timeout: 15_000 });
      // Back to Cars: the new car and Rosso, each a Car.
      await page.locator(".st-s-head").getByRole("link", { name: /Cars$/ }).click();
      await expect(page).toHaveURL(/\/stories\/cars$/);
      const card = page.locator(".st-s-cast__card", { hasText: second });
      await expect(card).toBeVisible();
      await expect(card.locator(".st-s-tag").first()).toHaveText("Car");
      await expect(page.locator(".st-s-cast__card", { hasText: "Rosso" }).locator(".st-s-tag").first()).toHaveText("Car");
      // Characters shows the whole cast: the people and the new car, with its Car tag.
      await go(page, "/stories/characters");
      await expect(page.locator(".st-s-cast__card", { hasText: second }).locator(".st-s-tag").first()).toHaveText("Car");
      await expect(page.locator(".st-s-cast__card", { hasText: "Pip" })).toBeVisible();
      await ctx.close();
    });

  test("Make a car (/stories/cars/new) and the car editor's parts keep the studio's rules", async ({ browser }) => {
    test.setTimeout(90_000);
    for (const [w, h, touch] of [
      [320, 640, true],
      [1280, 800, false],
    ] as const) {
      const ctx = await context(browser, w, h, touch);
      const page = await ctx.newPage();
      await open(page, "/stories/cars/new");
      for (const part of ["Looks", "Face", "Moves", "Sounds"]) {
        await page.locator(".st-s-editor__parts .st-s-pick__opt", { hasText: part }).click();
        if (part === "Face") await page.locator(".st-s-pick__opt", { hasText: "Headlight eyes" }).click();
        expect(await audit(page, `The car's ${part} ${w}`, touch && w < 768)).toEqual([]);
      }
      await ctx.close();
    }
  });
});

// ---------- C. A person and a car in one story (§45.43) ----------

test.describe("a person and a car", () => {
  for (const [w, h, touch] of [
    [390, 844, true],
    [1280, 800, false],
  ] as const)
    test(`Pip and Rosso in one video: Make the video, and the car scenes draw (${w})`, async ({ browser }) => {
      test.setTimeout(90_000);
      const ctx = await context(browser, w, h, touch);
      const page = await ctx.newPage();
      await open(page, `/stories/production/new?cast=${C.pip}`);
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const s = (window as MockWindow).__cfStoriesMock?.store;
        if (s) s.knobs.jobSeconds = 3;
      });

      // The cast: People, then the "Your cars" row; Rosso joins Pip.
      await expect(page.locator(".st-cast__row")).toHaveText(["People", "Your cars"]);
      await page.locator(".st-cast__cars .st-s-casttile", { hasText: "Rosso" }).click();
      await expect(page.locator('.st-s-casttile[aria-pressed="true"]')).toHaveCount(2);
      expect(await audit(page, `New video with a car ${w}`, touch && w < 768, false)).toEqual([]);

      // The idea, in a few words.
      await page.locator(".st-s-pick__opt", { hasText: "Type my own" }).click();
      await page.getByRole("textbox", { name: "Title", exact: true }).fill("The first drive");
      await page.getByRole("textbox", { name: "What happens, in one line" }).fill("Pip drives Rosso round the block.");
      await page.locator(".st-s-pick__opt", { hasText: "Funny" }).click();
      await page.getByRole("button", { name: "Make the video" }).click();
      await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
      const storyId = page.url().split("/").pop();
      expect((await store(page))!.stories.find((s) => s.storyId === storyId)!.characterIds).toEqual([C.pip, C.rosso]);

      // The production page: the car scenes, and a preview frame that draws.
      await expect(page.locator(".st-s-film__card").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".st-s-film__title")).toContainText(["The new car", "Off we go"]);
      await expect(page.locator(".st-s-film__title").last()).toHaveText("Oops");
      await page.getByRole("button", { name: /^Play scene 2: Off we go/ }).click();
      const canvas = page.locator(".st-s-film__card.is-live canvas").first();
      await expect(canvas).toBeVisible();
      await expect
        .poll(
          () =>
            canvas.evaluate((c: HTMLCanvasElement) => {
              const ctx2d = c.getContext("2d");
              if (!ctx2d || !c.width || !c.height) return 0;
              const data = ctx2d.getImageData(0, 0, c.width, c.height).data;
              let lit = 0;
              for (let i = 3; i < data.length; i += 4 * 16) if (data[i]! > 0) lit += 1;
              return lit;
            }),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(100);
      await ctx.close();
    });
});

// ---------- D. Series (§45.44) ----------

test.describe("series", () => {
  test("the kid path: a series and its next episode in 8 taps from the rail, 9 on a phone", async ({ browser }) => {
    test.setTimeout(90_000);
    const ctx = await context(browser, 375, 812, true);
    const page = await ctx.newPage();
    let taps = 0;
    const tap = async (target: Locator) => {
      taps += 1;
      await target.click();
    };

    // On a phone the rail's places past the first five are under More (Series among them).
    await page.goto("/stories");
    await page.locator(".stories-app[data-ws]").waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 20_000 });
    await tap(page.locator(".st-tabbar").getByRole("button", { name: "More pages" }));
    await tap(page.locator(".st-more").getByRole("link", { name: "Series", exact: true }));
    await expect(page).toHaveURL(/\/stories\/series$/);
    await page.locator(".st-series").first().waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
    await tap(page.getByRole("button", { name: "New series", exact: true }).first());
    const sheet = page.locator(".st-series-sheet");
    await sheet.getByLabel("Name").fill("Pip drives to school");
    await tap(sheet.getByRole("button", { name: /^Pip/ }));
    await tap(sheet.getByRole("button", { name: /^Rosso/ }));
    await tap(sheet.getByRole("button", { name: "Make it", exact: true }));
    await expect(page).toHaveURL(/\/stories\/series\/[0-9A-Z]{26}$/);
    await expect(page.locator(".st-series-head__name")).toHaveText("Pip drives to school");
    const seriesId = page.url().split("/").pop()!;

    await tap(page.getByRole("button", { name: "Make the next episode", exact: true }));
    await expect(page).toHaveURL(new RegExp(`/stories/production/new\\?cast=${C.pip}&cast=${C.rosso}&series=${seriesId}$`));
    await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
    await expect(page.locator(".st-series-field")).toContainText("Pip drives to school");
    await tap(page.locator(".st-s-ideapick .st-s-pick__opt").first());
    await tap(page.getByRole("button", { name: "Make the video", exact: true }));
    await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/, { timeout: 20_000 });
    expect(taps).toBeLessThanOrEqual(9); // the rail's 8 (CONTRACTS §45.44) and the phone's More

    const made = await page.evaluate((id) => {
      const s = (window as MockWindow).__cfStoriesMock?.store;
      const storyId = location.pathname.split("/").pop();
      const story = s?.stories.find((x) => x.storyId === storyId);
      return { seriesId: story?.seriesId, cast: story?.characterIds, named: s?.series.find((x) => x.seriesId === id)?.name };
    }, seriesId);
    expect(made).toEqual({ seriesId, cast: [C.pip, C.rosso], named: "Pip drives to school" });
    await ctx.close();
  });

  test("a video moved into a series and approved becomes its episode 2", async ({ browser }) => {
    test.setTimeout(90_000);
    const ctx = await context(browser, 375, 812, true);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.review}`);
    await page.getByRole("button", { name: /^Move “When the car starts to slide”/ }).click();
    const sheet = page.locator(".st-series-sheet");
    await sheet.getByRole("button", { name: /^My first car/ }).click();
    await expect(sheet).toContainText("Move “When the car starts to slide” to My first car?");
    await sheet.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Moved to My first car.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Series: My first car" })).toBeVisible();

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Added to My first car as episode 2.")).toBeVisible();

    await go(page, `/stories/series/${SEED_SERIES}`);
    await expect(page.locator(".st-series-ep__n")).toHaveText(["Ep 1", "Ep 2"]);
    await expect(page.locator(".st-series-ep").nth(1)).toContainText("When the car starts to slide");
    await expect(page.locator(".st-series-sofar")).toContainText("Where things stand:");
    await ctx.close();
  });
});
