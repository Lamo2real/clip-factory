import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";

// Clip Factory Stories' shell on the liquid-glass contract (web/src/stories/styles/GLASS-CONTRACT.md), measured in the
// mock app: the shell's own parts (the Needs you bar, the page head, the rail, the phone top bar and tab bar) keep every
// word at 4.5:1 over a white picture and a white desktop; inside glass their controls stay a light cream glass (never
// a second veil, a dark hole) and the Needs you bar's actions are cream, so the orange stays the screen's one main
// action; the phone top bar keeps the shell's workspace menu above the page in every look; the waiting state keeps its
// room in every look; the page head's actions line up with its title on a phone; and the orange toggle (StToggle) reads
// on the cream card and on glass, with a hover even when it is not available yet. Pictures under test-results.
// Stories is switched on with cf.storiesPreview = 1.

const SHOTS = join(import.meta.dirname, "..", "test-results", "stories-shell-glass");
type Look = "colours" | "picture" | "window";

async function open(page: Page, look: Look, { width = 1440, studios = 0, path = "/stories" } = {}) {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  if (look === "window") await asMacWindow(page);
  await page.addInitScript(
    ({ look, studios }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      const more: Record<string, string> = {};
      if (look === "picture") more["look.mode"] = "picture";
      if (look === "window") more["look.mode"] = "see-through";
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more }));
      if (studios) (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { moreStudios: studios } };
      if (look === "picture") {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const x = c.getContext("2d")!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, 32, 32);
        localStorage.setItem("cf.stories.picture", c.toDataURL("image/png"));
      }
      // A white desktop behind the see-through window (html.see-through leaves the page's own canvas showing).
      if (look === "window")
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = "html.see-through, html.see-through body { background: #fff !important; }";
          document.head.append(st);
        });
    },
    { look, studios },
  );
  await page.goto(path);
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  await expect(page.locator(".stories-app")).toHaveAttribute("data-look", look);
}

/** Every word in the shell's own parts against the lightest and the darkest pixel behind its glyphs (words hidden). */
async function worstContrast(page: Page, scope: string): Promise<{ worst: number; low: string[]; count: number }> {
  const items = await page.evaluate((scope) => {
    const out: { t: string; c: string; x: number; y: number; w: number; h: number }[] = [];
    for (const part of Array.from(document.querySelectorAll(scope))) {
      const walk = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const el = n.parentElement!;
        if (!el.checkVisibility() || el.closest(".sr-only, [aria-hidden='true']")) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width < 3 || r.bottom < 0 || r.top > innerHeight) continue;
          const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.x + r.width / 2), Math.min(innerHeight - 1, r.y + r.height / 2));
          if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
          out.push({ t: n.textContent.trim().slice(0, 30), c: getComputedStyle(el).color, x: r.x, y: r.y + r.height * 0.15, w: r.width, h: r.height * 0.7 });
        }
      }
    }
    return out;
  }, scope);
  const hide = await page.addStyleTag({ content: "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; transition: none !important; } svg { visibility: hidden !important; }" });
  await page.waitForTimeout(250);
  const shot = await page.screenshot();
  await hide.evaluate((el) => (el as Element).remove());
  // The words come back (their colour transition included) before anything else is read.
  await page.waitForTimeout(400);
  const res = await page.evaluate(
    async ({ src, items }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext("2d")!;
      x.drawImage(img, 0, 0);
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const L = (r: number, g: number, b: number) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return items.map((it) => {
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(it.c)!;
        const tl = L(+m[1]!, +m[2]!, +m[3]!);
        const x0 = Math.max(0, Math.floor(it.x));
        const y0 = Math.max(0, Math.floor(it.y));
        const d = x.getImageData(x0, y0, Math.max(1, Math.min(img.width - x0, Math.ceil(it.w))), Math.max(1, Math.min(img.height - y0, Math.ceil(it.h)))).data;
        let lo = 1;
        let hi = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = L(d[i]!, d[i + 1]!, d[i + 2]!);
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        return { t: it.t, ratio: Math.min(cr(tl, lo), cr(tl, hi)) };
      });
    },
    { src: `data:image/png;base64,${shot.toString("base64")}`, items },
  );
  const low = res.filter((r) => r.ratio < 4.5).map((r) => `${r.ratio.toFixed(2)} "${r.t}"`);
  return { worst: Math.min(...res.map((r) => r.ratio)), low, count: res.length };
}

const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);
const SHELL_PARTS = ".st-needs, .st-head, .st-rail, .st-top, .st-tabbar";

test.describe("the shell's parts over a white picture and a white desktop", () => {
  for (const look of ["picture", "window"] as const)
    for (const width of [375, 1440])
      test(`every word at 4.5:1, its controls light glass inside glass (${look}, ${width} px)`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await open(page, look, { width });
        await page.screenshot({ path: join(SHOTS, `${look}-${width}.png`) });
        const { worst, low, count } = await worstContrast(page, SHELL_PARTS);
        expect(count, "words measured").toBeGreaterThan(width < 768 ? 4 : 12);
        expect(low, `worst ${worst.toFixed(2)}`).toEqual([]);
        // Inside glass the shell's glass controls are a light cream glass, never the card's veil a second time.
        expect(await bg(page, ".st-head__actions .st-btn:not(.st-btn--main)")).toBe("rgba(255, 243, 228, 0.12)");
        expect(await bg(page, ".st-needs .st-needs__hide")).toBe("rgba(255, 243, 228, 0.12)");
        // The Needs you bar's action is cream with espresso words: the orange stays the page's one main action.
        const go = page.locator(".st-needs .st-needs__go").first();
        await expect(go).not.toHaveClass(/st-btn--main/);
        expect(await go.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual(["rgb(255, 243, 228)", "rgb(42, 22, 11)"]);
        // Hover still shows itself, and its words keep 4.5:1 (test/storiesShellGlass.test.tsx works out every fill).
        const quiet = page.locator(".st-head__actions .st-btn:not(.st-btn--main)").first();
        await quiet.hover();
        // The hover's fill eases in (--st-dur-hover); a slow frame (a busy CI machine) left it at its first step, the
        // resting 0.12, 300 ms after the hover. Waited for, it must still end on exactly the light lift.
        await expect(quiet, "hovered: the light cream lift").toHaveCSS("background-color", "rgba(255, 243, 228, 0.16)", { timeout: 3000 });
        await page.mouse.move(0, 0);
      });
});

test("Colours › Ember: the same controls keep the contract's control fill, and Needs you's action is cream there too", async ({ page }) => {
  await open(page, "colours");
  expect(await bg(page, ".st-head__actions .st-btn:not(.st-btn--main)")).toBe("rgba(255, 243, 228, 0.12)");
  expect(await bg(page, ".st-needs .st-needs__go")).toBe("rgb(255, 243, 228)");
  // Exactly one orange main action in the page head, none in the shell's Needs you bar.
  await expect(page.locator(".st-needs .st-btn--main")).toHaveCount(0);
});

test("on a phone the workspace menu opens over the page in every look (the top bar is its own layer)", async ({ page }) => {
  for (const look of ["colours", "picture"] as const) {
    await open(page, look, { width: 375, studios: 2 });
    const host = page.locator(".st-top .ws-switch-host--topbar");
    await host.getByRole("button", { name: /^Pick a workspace/ }).click();
    const menu = host.getByRole("dialog", { name: "Pick a workspace" });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    // Its lower part reaches over the page's glass (the Needs you bar, the page head): the menu is what is on top.
    for (const f of [0.5, 0.85]) {
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest(".ws-menu") !== null, [box.x + box.width / 2, box.y + box.height * f]);
      expect(top, `${look}: the menu at ${f} of its height`).toBe(true);
    }
    await page.screenshot({ path: join(SHOTS, `menu-${look}-375.png`) });
    await page.keyboard.press("Escape");
    // Below the tab bar and the More sheet, which stay above everything of the page.
    expect(await page.locator(".st-top").evaluate((e) => Number(getComputedStyle(e).zIndex))).toBeLessThan(await page.locator(".st-tabbar").evaluate((e) => Number(getComputedStyle(e).zIndex)));
  }
});

test("the waiting state keeps its room in every look", async ({ page }) => {
  const pad: string[] = [];
  for (const look of ["colours", "picture", "window"] as const) {
    await open(page, look);
    pad.push(
      await page.evaluate(() => {
        // The markup StLoading draws (ui.tsx), laid on the page.
        const el = document.createElement("div");
        el.className = "st-loading st-plate";
        el.setAttribute("role", "status");
        el.innerHTML = "<span>Getting it ready…</span>";
        document.querySelector(".st-main")!.prepend(el);
        const s = getComputedStyle(el);
        const out = `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`;
        el.remove();
        return out;
      }),
    );
  }
  expect(pad).toEqual(["36px 16px 36px 16px", "36px 16px 36px 16px", "36px 16px 36px 16px"]);
});

test("on a phone the page head's actions line up with its title", async ({ page }) => {
  for (const look of ["colours", "picture"] as const) {
    await open(page, look, { width: 375 });
    const title = (await page.locator(".st-head__title").first().boundingBox())!;
    const first = (await page.locator(".st-head__actions > *").first().boundingBox())!;
    expect(Math.abs(first.x - title.x), look).toBeLessThanOrEqual(1);
    // Nothing runs past the page at the smallest phone either.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(200);
    const over = await page.evaluate(() => Array.from(document.querySelectorAll(".st-head *")).filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).length);
    expect(over, `${look} at 320 px`).toBe(0);
  }
});

test("the orange toggle reads on the cream card and on glass, and shows a hover even when it is not available yet; so do chips and links", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await open(page, "colours");
  await page.evaluate(() => {
    // The markup StToggle draws (ui.tsx; test/storiesShellGlass.test.tsx holds the two together), on cream and on glass.
    const toggle = (checked: boolean, off = false) =>
      `<div class="st-toggle-row"><div class="st-toggle-row__text"><span class="st-toggle-row__label">Post by itself</span><span class="st-toggle-row__desc">Every six hours.</span></div>` +
      `<button type="button" role="switch" class="st-switch st-toggle" aria-checked="${checked}"${off ? ' aria-disabled="true"' : ""}><span class="st-toggle__track" aria-hidden="true"><span class="st-toggle__knob"></span></span></button></div>`;
    const words = `<p style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><span class="st-chip st-chip--mint">Ready</span><span class="st-chip st-chip--sun">Soon</span><span class="st-chip">Saved</span><a class="st-textlink" href="#e2e">Open it</a></p>`;
    const box = document.createElement("div");
    box.className = "st-e2e-toggles";
    box.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:var(--st-gap);margin-bottom:24px";
    box.innerHTML =
      `<section class="st-cream st-cream-card" data-on="cream">${toggle(true)}${toggle(false)}${toggle(false, true)}${words}</section>` +
      `<section class="st-glass st-card" data-on="glass">${toggle(true)}${toggle(false)}${toggle(false, true)}${words}</section>`;
    document.querySelector(".st-main")!.prepend(box);
  });
  await page.waitForTimeout(300);
  await page.locator(".st-e2e-toggles").screenshot({ path: join(SHOTS, "toggles.png") });
  // Its words read on both (espresso on the cream, cream on the glass), and so do the shell's chips and links.
  const { worst, low, count } = await worstContrast(page, ".st-e2e-toggles");
  expect(count, "words measured").toBe(20);
  expect(low, `worst ${worst.toFixed(2)}`).toEqual([]);
  for (const on of ["cream", "glass"]) {
    const sw = page.locator(`[data-on="${on}"] .st-switch`);
    const track = (i: number) => sw.nth(i).locator(".st-toggle__track").evaluate((e) => getComputedStyle(e).backgroundColor);
    // On: the orange accent with its white knob, moved to the end.
    expect(await track(0), `${on}: on`).toBe("rgb(255, 138, 61)");
    const knob = await sw.nth(0).locator(".st-toggle__knob").evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).transform]);
    expect(knob[0], `${on}: knob`).toBe("rgb(255, 250, 243)");
    expect(knob[1], `${on}: knob moved`).not.toBe("none");
    // Off and not available yet: never the orange; not available yet has the quieter knob.
    expect(await track(1)).not.toBe("rgb(255, 138, 61)");
    expect(await track(2)).not.toBe("rgb(255, 138, 61)");
    const knobOf = (i: number) => sw.nth(i).locator(".st-toggle__knob").evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await knobOf(2), `${on}: not available yet`).not.toBe(await knobOf(1));
    // Every one shows itself on hover.
    for (const i of [0, 1, 2]) {
      const before = await track(i);
      await sw.nth(i).hover();
      // The hover's colour eases in; a slow frame (a busy machine) must not read it before its first step.
      await expect.poll(() => track(i), { message: `${on}: hover ${i}`, timeout: 3000 }).not.toBe(before);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
    }
  }
});
