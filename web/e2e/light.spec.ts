import { writeFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { DEFAULT_COLOURS, hexToRgb, LADDER_STEP, oklabL, type Rgb } from "../src/lib/background.ts";
import { launcherSettled, settle, stillBackdrop } from "./helpers.ts";
import { decode, type Pixels } from "./pixels.ts";

// The logic of light (docs/CONTRACTS.md §22.7, docs/DECISIONS.md ADR-87): the top layer is always brighter than the
// one under it, and inside a pane the top is brighter than the bottom. lib/background.ts works the numbers out and
// test/background.test.ts holds them for every look; this measures the real render, from screenshot pixels, in
// headless Chromium: a Library card → its post row → the row's mark, and the Home hero → its new-clip card. Each
// step compares a 4 × 4 px patch of the child's top padding (no words) with its parent right beside it, at the same
// height. The screenshots (and the measured steps) are saved in the test's output folder for a person to look at.
//
// In every look, over a white photo and a light colour too, each level reads at least a whole step (LADDER_STEP, +0.015
// OKLab L) brighter than the one it sits on, and none reads darker: a pane over a light backdrop sits low enough under
// the AA ceiling (its look's --light-pay, lib/background.ts lightPay) for the ladder above it to fit.

test.use({ reducedMotion: "reduce" });
test.skip(({ browserName }) => browserName !== "chromium", "measured in headless Chromium");

/** A plain white picture: the hardest photo for bone words. */
const WHITE_PICTURE = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' fill='#fff'/></svg>")}`;

interface LookCase {
  name: string;
  /** The look, saved on the device and on the (mock) server. */
  look: Record<string, unknown>;
  picture?: string;
  /** The backdrop is one flat colour, so a pane's top and bottom can be compared without the backdrop changing. */
  uniform?: boolean;
  /** The app's own dark backdrop (named in the report). */
  dark?: boolean;
}
const LOOKS: LookCase[] = [
  { name: "brand see-through", look: { backgroundMode: "see-through", glassStrength: "clear" }, dark: true },
  { name: "Frosted", look: { backgroundMode: "see-through", glassStrength: "frosted" }, dark: true },
  { name: "Picture (white)", look: { backgroundMode: "picture" }, picture: WHITE_PICTURE, uniform: true },
  { name: "Colours", look: { backgroundMode: "colours", backgroundColours: [...DEFAULT_COLOURS] }, dark: true },
  { name: "Colours (Cream)", look: { backgroundMode: "colours", backgroundColours: ["#f7f5ef"] }, uniform: true },
];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

/** No level may read darker than the one under it, in any look. */
const TOLERANCE = 0;
/** And each level reads at least a whole step brighter than its parent, in every look (the maths' least, the ladder). */
const STEP = LADDER_STEP;

async function useLook(page: Page, c: LookCase) {
  await page.addInitScript(
    ({ look, picture }) => {
      if (sessionStorage.getItem("cf-light-look")) return;
      sessionStorage.setItem("cf-light-look", "1");
      const prefs = JSON.parse(localStorage.getItem("cf.prefs") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("cf.prefs", JSON.stringify({ ...prefs, ...look }));
      sessionStorage.setItem("cf-mock-look", JSON.stringify(look));
      if (picture) localStorage.setItem("cf.background", picture);
    },
    { look: c.look, picture: c.picture ?? null },
  );
}

/** What is measured: a 4 × 4 patch of a child's top padding and of its parent beside it, at the same height. */
interface Step {
  name: string;
  child: { x: number; y: number };
  parent: { x: number; y: number };
}

/**
 * The first `childSel` inside a `parentSel` whose patches really show those two surfaces (nothing floating over them,
 * no words in them). With `scroll`, each candidate is scrolled to the middle of the screen first; the one picked is
 * marked `data-light-probe`, so it can be found again once the page is still.
 */
async function findStep(page: Page, name: string, parentSel: string, childSel: string, scroll: boolean): Promise<Step | null> {
  return page.evaluate(
    ({ name, parentSel, childSel, scroll }) => {
      const hitsOnly = (x: number, y: number, ok: (el: Element | null) => boolean) => {
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) if (!ok(document.elementFromPoint(x + dx, y + dy))) return false;
        return true;
      };
      for (const child of Array.from(document.querySelectorAll(childSel))) {
        const parent = child.parentElement?.closest(parentSel);
        if (!parent) continue;
        if (scroll) child.scrollIntoView({ block: "center", behavior: "instant" });
        const c = child.getBoundingClientRect();
        const p = parent.getBoundingClientRect();
        if (c.width < 24 || c.height < 24 || c.top < 0 || c.bottom > innerHeight) continue;
        // The child's top padding at its middle, just under its edge.
        const cx = Math.round(c.left + c.width / 2 - 2);
        const y = Math.round(c.top + 2);
        // The parent beside the child, in the middle of the parent's own padding, at the same height.
        const gap = c.left - p.left;
        if (gap < 7) continue;
        const px = Math.round(p.left + (gap - 4) / 2);
        // Beside the child only the parent shows, or a plain wrapper of the child inside it (a list, a column).
        const own = (el: Element | null) => el === child;
        const beside = (el: Element | null) => !!el && (el === parent || (parent.contains(el) && el.contains(child)));
        if (!hitsOnly(cx, y, own) || !hitsOnly(px, y, beside)) continue;
        document.querySelectorAll("[data-light-probe]").forEach((el) => el.removeAttribute("data-light-probe"));
        child.setAttribute("data-light-probe", "");
        return { name, child: { x: cx, y }, parent: { x: px, y } };
      }
      return null;
    },
    { name, parentSel, childSel, scroll },
  );
}

/**
 * A point in a pane's top padding (or its bottom padding), a quarter of the way in (off the catch light's centre),
 * with that edge scrolled into view: a tall pane's top and bottom are measured one at a time.
 */
async function paneEdge(page: Page, sel: string, edge: "top" | "bottom"): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ sel, edge }) => {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const first = el.getBoundingClientRect();
        window.scrollBy({ top: (edge === "top" ? first.top - innerHeight / 3 : first.bottom - (innerHeight * 2) / 3), behavior: "instant" });
        const r = el.getBoundingClientRect();
        const at = { x: Math.round(r.left + r.width / 4), y: Math.round(edge === "top" ? r.top + 5 : r.bottom - 9) };
        if (at.y < 0 || at.y + 4 > innerHeight) continue;
        // Only the pane shows there, or a plain wrapper inside it (no fill, no shadow of its own).
        const plain = (hit: Element | null) => {
          if (hit === el) return true;
          if (!hit || !el.contains(hit)) return false;
          const s = getComputedStyle(hit);
          return s.backgroundImage === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor) && s.boxShadow === "none";
        };
        let clean = true;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) if (!plain(document.elementFromPoint(at.x + dx, at.y + dy))) clean = false;
        if (clean) return at;
      }
      return null;
    },
    { sel, edge },
  );
}

/** The mean colour of a 4 × 4 patch. */
function patch(p: Pixels, at: { x: number; y: number }): Rgb {
  const sum = [0, 0, 0];
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 4; dx++) {
      const i = ((at.y + dy) * p.width + at.x + dx) * 4;
      for (let k = 0; k < 3; k++) sum[k]! += p.data[i + k]!;
    }
  return sum.map((v) => v / 16) as unknown as Rgb;
}

/** A screenshot, kept in the test's output folder (an artifact for review) and attached to the report. */
async function shoot(page: Page, info: TestInfo, name: string): Promise<Pixels> {
  const png = await page.screenshot({ path: info.outputPath(`${name}.png`) });
  await info.attach(`${name}.png`, { body: png, contentType: "image/png" });
  return decode(page, png);
}

/** The measured steps, kept beside the screenshots. */
async function note(info: TestInfo, name: string, lines: string[]) {
  const body = lines.join("\n") + "\n";
  writeFileSync(info.outputPath(`${name}.txt`), body);
  await info.attach(`${name}.txt`, { body, contentType: "text/plain" });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Finds a step, lets the page come to rest (the Ask launcher moves out of the way after a scroll), checks the step
 * still shows what it should, then measures it from a screenshot: the child must never read darker than its parent,
 * and it must read a whole step brighter, in every look.
 */
async function climb(page: Page, info: TestInfo, c: LookCase, shot: string, name: string, parentSel: string, childSel: string): Promise<string> {
  const picked = await findStep(page, name, parentSel, childSel, true);
  expect(picked, `${name}: a ${childSel} with its ${parentSel} beside it, in view`).not.toBeNull();
  await launcherSettled(page);
  const step = await findStep(page, name, parentSel, `${childSel}[data-light-probe]`, false);
  expect(step, `${name}: still in view once the page is still`).not.toBeNull();
  const pixels = await shoot(page, info, shot);
  const dl = oklabL(patch(pixels, step!.child)) - oklabL(patch(pixels, step!.parent));
  expect(dl, `${name} never reads darker (${c.name})`).toBeGreaterThanOrEqual(TOLERANCE);
  expect(dl, `${name} reads a whole step brighter (${c.name})`).toBeGreaterThanOrEqual(STEP);
  return `${name}: ${dl >= 0 ? "+" : ""}${dl.toFixed(3)}`;
}

/** Over a flat backdrop, inside a pane: its top is brighter than its bottom (the backdrop is the same at both). */
async function paneTopBrighter(page: Page, info: TestInfo, c: LookCase, shot: string, sel: string): Promise<string> {
  const read = async (edge: "top" | "bottom") => {
    const at = await paneEdge(page, sel, edge);
    expect(at, `${sel}'s ${edge} padding in view, with nothing over it`).not.toBeNull();
    await launcherSettled(page);
    return patch(await shoot(page, info, `${shot}-${edge}`), at!);
  };
  const top = await read("top");
  const bottom = await read("bottom");
  const dl = oklabL(top) - oklabL(bottom);
  expect(dl, `${sel}: its top is brighter than its bottom (${c.name})`).toBeGreaterThan(0.01);
  return `${sel} top over its bottom: +${dl.toFixed(3)}`;
}

for (const size of SIZES)
  for (const c of LOOKS) {
    test.describe(`${c.name} at ${size.width}`, () => {
      test.beforeEach(async ({ page }) => {
        // Each measure scrolls, waits for the page to come to rest and takes full-size screenshots: under a loaded
        // machine (many workers) the Library's three steps can take over two minutes.
        test.setTimeout(240_000);
        await stillBackdrop(page);
        await useLook(page, c);
        await page.setViewportSize(size);
      });

      test("Library: a card, its post row and the row's mark each climb one level of light", async ({ page }, info) => {
        await page.goto("/library");
        await settle(page);
        const name = `library-${slug(c.name)}-${size.width}`;
        const out = [
          await climb(page, info, c, `${name}-row`, "the post row over its card", ".lib-card", ".post:not(.post--group)"),
          // A mark that is not a tinted chip (a posted row's mark is the success tint, a colour of its own).
          await climb(page, info, c, `${name}-mark`, "the mark over its row", ".post", ".post:not(.is-posted):not(.post--group) > .post__mark"),
        ];
        if (c.uniform) out.push(await paneTopBrighter(page, info, c, `${name}-card`, ".lib-card"));
        await note(info, name, out);
      });

      test("Home: the new-clip card is one level of light above the hero", async ({ page }, info) => {
        await page.goto("/");
        await settle(page);
        const name = `home-${slug(c.name)}-${size.width}`;
        const out = [await climb(page, info, c, `${name}-card`, "the new-clip card over the hero", ".hero", ".newjob")];
        if (c.uniform) out.push(await paneTopBrighter(page, info, c, `${name}-hero`, ".hero"));
        await note(info, name, out);
      });
    });
  }

test.describe("the Reload button on the update bar", () => {
  test.beforeEach(async ({ page }) => {
    await stillBackdrop(page);
  });
  for (const size of SIZES)
    test(`is colourless liquid glass with bone words, and brighter than Later, at ${size.width}`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await page.goto("/?update=1");
      await settle(page);
      const bar = page.getByRole("region", { name: "New version" });
      await expect(bar).toBeVisible();
      const reload = bar.locator(".update-bar__reload");
      await expect(reload).toBeVisible();
      await page.waitForTimeout(600);
      const look = await reload.evaluate((el) => {
        const s = getComputedStyle(el);
        const before = getComputedStyle(el, "::before");
        const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
        return { color: s.color, ink, paint: [s.backgroundColor, s.backgroundImage, s.boxShadow, before.backgroundImage, before.backgroundColor].join(" ") };
      });
      // Its words are --ink (bone), not the CTA's white.
      const [r, g, b] = hexToRgb(look.ink);
      expect(look.color).toBe(`rgb(${r}, ${g}, ${b})`);
      // No vermilion anywhere in its fill, its shine or its glow: every colour it paints is green, bone or shadow.
      const colours = [...look.paint.matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
      expect(colours.length, look.paint).toBeGreaterThan(0);
      const warm = colours.filter(([cr, cg]) => cr! > cg! + 60);
      expect(warm, look.paint).toEqual([]);
      // Told apart from Later by light alone: the lens's top reads brighter than Later's.
      const tops = await bar.evaluate((el) => {
        const at = (sel: string) => {
          const r = el.querySelector(sel)!.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2 - 2), y: Math.round(r.top + 3) };
        };
        return { reload: at(".update-bar__reload"), later: at(".btn--ghost") };
      });
      const shot = await shoot(page, info, `update-bar-${size.width}`);
      const dl = oklabL(patch(shot, tops.reload)) - oklabL(patch(shot, tops.later));
      await note(info, `update-bar-${size.width}`, [`Reload over Later: ${dl.toFixed(3)}`]);
      expect(dl, "Reload reads brighter than Later").toBeGreaterThanOrEqual(0.02);
    });
});
