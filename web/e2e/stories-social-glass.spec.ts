import { expect, test, type Page } from "@playwright/test";
import { ACTIVE_SCENE, asDesktop, paintGlass, WHITE, type GlassPaint } from "./glass.ts";
import { findOverflow } from "./helpers.ts";

// Clip Factory Stories › Social accounts and the setup on the liquid glass (web/src/stories/styles/GLASS-CONTRACT.md)
// in the mock app: the setup's ring is the ArcDial (an orange arc with its white knob and a big light numeral) in a
// hero glass head, the steps sit on glass 6 px inside its edge with a solid cream current step, what is left is glass
// pills under the steps; Social accounts is a hero glass header, a glass progress card and five glass rows (two a line
// on a computer, one on a phone); each account card is glass on its platform's own page (hero glass when it needs the
// owner), flat inside a setup step. Every word on these screens' glass is measured in pixels (the words made
// transparent, the lightest pixel behind each line found) and reaches 4.5:1 over Colours › Ember, a white and a busy
// picture, See-through in the desktop app (Clear over a white desktop and over a busy one as the glass shows it,
// Frosted over white), and with reduced transparency over a busy picture. The shell's own chips, buttons and page
// heads are the shell's to check. Stories is switched on with cf.storiesPreview = 1.

type Look = "ember" | "white" | "busy" | "window-white" | "window-scene" | "frosted-white" | "solid-busy";
const WINDOW: Partial<Record<Look, { strength: "clear" | "frosted"; paint: GlassPaint }>> = {
  "window-white": { strength: "clear", paint: WHITE },
  "window-scene": { strength: "clear", paint: ACTIVE_SCENE },
  "frosted-white": { strength: "frosted", paint: WHITE },
};
const LOOK_NAME: Record<Look, string> = {
  ember: "Colours › Ember",
  white: "a white picture",
  busy: "a busy picture",
  "window-white": "See-through Clear over a white desktop",
  "window-scene": "See-through Clear over a busy desktop",
  "frosted-white": "See-through Frosted over a white desktop",
  "solid-busy": "reduced transparency over a busy picture",
};

/** Once per page, before it opens: the desktop app's window glass, or the device asking for less transparency. */
async function prepare(page: Page, look: Look) {
  if (WINDOW[look]) await asDesktop(page, "liquid");
  if (look === "solid-busy") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  }
}

/** A plain white picture, or a busy "desktop" (white windows, black text, bright blocks). */
function picture(kind: "white" | "busy"): string {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  if (kind === "white") {
    c.width = c.height = 64;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/png");
  }
  c.width = 1600;
  c.height = 1000;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 1600, 1000);
  const colours = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#ffffff", "#000000", "#ff9f0a", "#bf5af2", "#ffffff", "#f2f2f7"];
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 140; i++) {
    g.fillStyle = colours[Math.floor(r() * colours.length)]!;
    g.fillRect(r() * 1600, r() * 1000, 40 + r() * 320, 20 + r() * 220);
  }
  g.fillStyle = "#000";
  g.font = "16px sans-serif";
  for (let y = 20; y < 1000; y += 22) g.fillText("Lorem ipsum dolor sit amet 12:45 Inbox (3) README.md", (y * 7) % 400, y);
  return c.toDataURL("image/png");
}

async function open(page: Page, path: string, look: Look) {
  const glass = WINDOW[look];
  const pic: "white" | "busy" | null = look === "white" ? "white" : look === "busy" || look === "solid-busy" ? "busy" : null;
  const src = pic ? await page.evaluate(picture, pic) : null;
  await page.goto("/stories/connections");
  await page.evaluate(
    ({ src, strength }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      const prefs = JSON.parse(localStorage.getItem("cf.stories.prefs") ?? "{}") as { more?: Record<string, unknown> };
      const more = { ...(prefs.more ?? {}) };
      delete more["look.mode"];
      delete more["look.strength"];
      localStorage.removeItem("cf.stories.picture");
      if (strength) {
        more["look.mode"] = "see-through";
        more["look.strength"] = strength;
      } else if (src) {
        more["look.mode"] = "picture";
        localStorage.setItem("cf.stories.picture", src);
      }
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ ...prefs, more }));
    },
    { src, strength: glass?.strength ?? null },
  );
  await page.goto(path);
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  if (glass) await paintGlass(page, glass.paint);
  await page.waitForTimeout(500);
  await expect(page.locator(".stories-app")).toHaveAttribute("data-look", glass ? "window" : pic ? "picture" : "colours");
}

/** Every line of words inside `scope` (not the shell's chips and buttons) and the worst contrast behind it. */
async function lowContrast(page: Page, scope: string): Promise<string[]> {
  const lines = await page.evaluate((scope) => {
    const out: { what: string; color: string; rects: number[][] }[] = [];
    for (const root of Array.from(document.querySelectorAll(scope)))
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (el.closest(".sr-only, svg, .st-chip, .st-btn, .st-pick, details:not([open]) > :not(summary)")) continue;
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none") continue;
        const range = document.createRange();
        const rects: number[][] = [];
        for (const n of Array.from(el.childNodes))
          if (n.nodeType === 3 && n.textContent!.trim()) {
            range.selectNodeContents(n);
            for (const r of Array.from(range.getClientRects())) if (r.width > 2 && r.height > 2) rects.push([r.left, r.top + scrollY, r.width, r.height]);
          }
        if (rects.length) out.push({ what: `${el.tagName.toLowerCase()}.${el.className}: "${(el.textContent ?? "").trim().slice(0, 40)}"`, color: s.color, rects });
      }
    return out;
  }, scope);
  // The words made transparent and the fixed layers (tab bar, toasts) hidden: what is behind each line, in pixels.
  await page.addStyleTag({
    content: ".stories-app *, .stories-app *::before, .stories-app *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; }",
  });
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) if (getComputedStyle(el).position === "fixed" && !el.matches(".stories-app")) el.style.setProperty("visibility", "hidden", "important");
  });
  await page.waitForTimeout(150);
  const shot = (await page.screenshot({ fullPage: true })).toString("base64");
  return page.evaluate(
    async ({ shot, lines }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const lum = (r: number, gr: number, b: number) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(gr) + 0.0722 * f(b);
      };
      const low: string[] = [];
      for (const line of lines) {
        const [fr, fg, fb, fa = 1] = line.color.match(/[\d.]+/g)!.map(Number) as [number, number, number, number?];
        let worst = Infinity;
        for (const [x, y, w, h] of line.rects) {
          const x0 = Math.max(0, Math.round(x! + 1));
          const y0 = Math.max(0, Math.round(y! + 2));
          const x1 = Math.min(c.width - 1, Math.round(x! + w! - 1));
          const y1 = Math.min(c.height - 1, Math.round(y! + h! - 2));
          if (x1 <= x0 || y1 <= y0) continue;
          const d = g.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
          for (let i = 0; i < d.length; i += 8) {
            const [br, bg, bb] = [d[i]!, d[i + 1]!, d[i + 2]!];
            const a = lum(fr * fa + br * (1 - fa), fg * fa + bg * (1 - fa), fb * fa + bb * (1 - fa));
            const b = lum(br, bg, bb);
            worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
          }
        }
        if (worst < 4.5) low.push(`${line.what} ${worst.toFixed(2)}`);
      }
      return low;
    },
    { shot, lines },
  );
}

test("the setup: the ArcDial in a hero glass head, the steps on glass with a cream current step, and why a step is left on glass", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/stories/setup", "ember");
  const dial = page.locator(".st-setup__head.st-glass--hero .st-dial.st-ring");
  await expect(dial).toHaveAttribute("role", "progressbar");
  await expect(dial).toHaveAttribute("aria-valuemax", "11");
  const done = await dial.getAttribute("aria-valuenow");
  await expect(dial).toHaveAttribute("aria-label", `${done} of 11 done`);
  await expect(dial.locator(".st-dial__knob")).toHaveCount(1);
  await expect(dial.locator(".st-setup__dial-num")).toHaveText(done!);
  const list = page.locator(".st-steps__list.st-glass");
  await expect(list).toBeVisible();
  // The current step's highlight is solid cream with espresso words.
  const glide = page.locator(".glide--st-steps");
  await expect(glide).toHaveCSS("background-color", /rgba?\(255, 243, 228/);
  await expect(page.locator(".st-steps__item.is-on")).toHaveCSS("color", "rgb(42, 22, 11)");
  // Concentric: the rows and the cream highlight sit 6 px inside the list's glass (20 − 6 = their 14 px corners).
  await expect(list).toHaveCSS("padding-top", "6px");
  await expect(list).toHaveCSS("border-top-left-radius", "20px");
  await expect(glide).toHaveCSS("border-top-left-radius", "14px");
  await page.waitForTimeout(500);
  const [lb, gb, first] = await Promise.all([list.boundingBox(), glide.boundingBox(), page.locator(".st-steps__item").first().boundingBox()]);
  for (const b of [gb!, first!]) {
    expect(b.x - lb!.x, "inset on the left").toBeCloseTo(6, 0);
    expect(lb!.x + lb!.width - (b.x + b.width), "inset on the right").toBeCloseTo(6, 0);
  }
  expect(first!.y - lb!.y, "inset at the top").toBeCloseTo(6, 0);
  await expect(page.locator(".st-setup__panel.st-glass")).toBeVisible();
  // What is left is the step list itself (less text, the owner, 23 Nov): under it, on glass, only why a step is
  // still to do (the seed's X is Clip Factory's own), and no pills that say the steps again.
  await expect(page.locator(".st-left.st-glass .st-left__why").first()).toBeVisible();
  await expect(page.locator(".st-left__item")).toHaveCount(0);

  // A connect step: the platform's card is flat on the step's glass (no glass of its own inside the glass panel).
  await page.locator(".st-steps__item").filter({ hasText: "Connect Instagram" }).click();
  const card = page.locator(".st-setup__panel .st-conn");
  await expect(card).toHaveClass(/st-conn--in-step/);
  await expect(card).not.toHaveClass(/st-glass/);
  await expect(card).toHaveCSS("background-image", "none");
  await expect(card).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(card).toHaveCSS("box-shadow", "none");
  await expect(card).toHaveCSS("padding-left", "0px");
});

test("the setup keeps its steps beside the step from a 900 px window, with what is left under them", async ({ page }) => {
  for (const [width, beside] of [
    [375, false],
    [768, false],
    [900, true],
    [1024, true],
    [1280, true],
    [1440, true],
    [1920, true],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 375) await open(page, "/stories/setup", "ember");
    await page.waitForTimeout(250);
    const [steps, panel, left] = await Promise.all([page.locator(".st-steps").boundingBox(), page.locator(".st-setup__panel").boundingBox(), page.locator(".st-left").boundingBox()]);
    if (beside) {
      expect(steps!.x + steps!.width, `@${width}: the steps left of the step`).toBeLessThanOrEqual(panel!.x);
      expect(Math.abs(steps!.y - panel!.y), `@${width}: the steps level with the step`).toBeLessThan(2);
      // What is left under the steps, never a narrow third column beside the step.
      expect(left!.x, `@${width}`).toBeCloseTo(steps!.x, 0);
      expect(left!.y, `@${width}`).toBeGreaterThan(steps!.y + steps!.height);
      expect(panel!.width, `@${width}: the step is the widest column`).toBeGreaterThan(steps!.width);
    } else expect(steps!.y, `@${width}: a phone or tablet shows the step first`).toBeGreaterThan(panel!.y + panel!.height);
  }
});

/** The rows' boxes once their rise-in has ended (no row caught on its way up). */
async function rowBoxes(page: Page) {
  const rows = page.locator(".st-social-rows > .st-social-row-wrap");
  await rows.evaluateAll((els) => Promise.all(els.flatMap((e) => e.getAnimations()).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  return rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), top: Math.round(r.top), height: Math.round(r.height) })));
}

const PLATFORMS = ["youtube", "tiktok", "instagram", "facebook", "x"] as const;

test("Social accounts: a hero glass header, a glass progress card, five glass rows two a line, the setup's way back with its small dial", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/stories/connections", "ember");
  await expect(page.locator(".st-social-rows > .st-social-row-wrap.st-glass")).toHaveCount(5);
  // No card on the list, and nothing deals the rows into columns: the grid does.
  await expect(page.locator(".st-connections .st-conn")).toHaveCount(0);
  await expect(page.locator(".st-social-rows[data-cols], .st-conns[data-cols]")).toHaveCount(0);
  // Two a line at 1440, the rows of one line the same height.
  const wide = await rowBoxes(page);
  expect(new Set(wide.map((b) => b.x)).size, "two columns at 1440").toBe(2);
  for (let i = 0; i + 1 < wide.length; i += 2) {
    expect(wide[i]!.top, `line ${i / 2 + 1}`).toBe(wide[i + 1]!.top);
    expect(Math.abs(wide[i]!.height - wide[i + 1]!.height), `line ${i / 2 + 1}: the same height`).toBeLessThanOrEqual(1);
  }
  // Each row: its logo on a tile (an inner corner), its name in Fugaz One, a link at least 72 px tall (a control corner).
  const link = page.locator('.st-social-row-wrap[data-platform="youtube"] a.st-social-row');
  await expect(link).toHaveCSS("border-top-left-radius", "14px");
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(72);
  await expect(page.locator('.st-social-row-wrap[data-platform="youtube"]')).toHaveCSS("border-top-left-radius", "20px");
  await expect(page.locator('.st-social-row-wrap[data-platform="youtube"] .st-social-row__mark')).toHaveCSS("border-top-left-radius", "10px");
  expect(await page.locator('.st-social-row-wrap[data-platform="youtube"] .st-social-row__name').evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Fugaz One/);
  expect(await page.locator('.st-social-row-wrap[data-platform="youtube"] .st-social-row__line').evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Fraunces/);
  // The ready one has the orange disc; the others an empty ring of light.
  await expect(page.locator('.st-social-row-wrap[data-platform="youtube"] .st-social-row__done')).toHaveCSS("background-color", "rgb(255, 138, 61)");
  await expect(page.locator(".st-social-row__todo")).toHaveCount(4);
  // The glass never moves on hover: only the link's fill changes.
  const wrap = page.locator('.st-social-row-wrap[data-platform="tiktok"]');
  const still = await wrap.boundingBox();
  await wrap.locator("a.st-social-row").hover();
  await page.waitForTimeout(300);
  expect(await wrap.boundingBox()).toEqual(still);
  await expect(wrap).toHaveCSS("transform", "none");
  // The header is hero glass (its rim may bend), padded past the rim's band; the progress card is glass with the dial.
  const head = page.locator("header.st-social-head.st-glass.st-glass--hero.st-lens");
  await expect(head).toBeVisible();
  expect(parseFloat(await head.evaluate((e) => getComputedStyle(e).paddingTop))).toBeGreaterThanOrEqual(26);
  const progress = page.locator(".st-social-progress.st-glass");
  await expect(progress.locator(".st-dial")).toHaveAttribute("role", "progressbar");
  await expect(progress.locator(".st-dial")).toHaveAttribute("aria-label", /^\d of \d ready$/);
  // One a line on a phone, and nothing goes sideways.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    const narrow = await rowBoxes(page);
    expect(new Set(narrow.map((b) => b.x)).size, `one column at ${width}`).toBe(1);
    for (let i = 1; i < narrow.length; i++) expect(narrow[i]!.top, `@${width}: one under the other`).toBeGreaterThan(narrow[i - 1]!.top);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  // The way back to the setup: Social accounts' hero glass (its rim may bend), padded past the rim's band.
  const bar = page.locator(".st-setupback.st-glass.st-glass--hero.st-lens");
  await expect(bar).toBeVisible();
  expect(parseFloat(await bar.evaluate((e) => getComputedStyle(e).paddingTop))).toBeGreaterThanOrEqual(26);
  const back = bar.locator(".st-dial");
  await expect(back).toHaveAttribute("role", "progressbar");
  await expect(back).toHaveAttribute("aria-label", /^\d+ of 11 done$/);
  // Its dial: "N of 11" as before, big enough for the white knob to read as a knob.
  await expect(back.locator(".st-dial__centre")).toHaveText(/^\d+of 11$/);
  expect((await back.boundingBox())!.width).toBeGreaterThanOrEqual(80);
  expect((await back.locator(".st-dial__knob").boundingBox())!.width).toBeGreaterThanOrEqual(9);
  // Each platform's card, on its own page: glass, and hero glass too when it needs the owner; the others are plain
  // glass. One column, the breadcrumb on its plate above it, and the setup's way back kept (the owner may come back
  // from OAuth there).
  const needing: string[] = [];
  for (const p of PLATFORMS) {
    await page.goto(`/stories/connections/${p}`);
    await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
    const card = page.locator(`.st-conns--one > .st-conn.st-glass[data-platform="${p}"]`);
    await expect(card, p).toHaveCount(1);
    await expect(page.locator(".st-conn"), p).toHaveCount(1);
    await expect(page.locator('nav.st-crumbs.st-plate[aria-label="Breadcrumb"]'), p).toBeVisible();
    await expect(page.locator(".st-setupback.st-glass--hero"), p).toBeVisible();
    const cls = (await card.getAttribute("class"))!;
    const needs = /st-conn--(choose_account|needs_reconnect|same_as_clips)\b/.test(cls);
    if (needs) needing.push(p);
    expect(/\bst-glass--hero\b/.test(cls) && /\bst-lens\b/.test(cls), cls).toBe(needs);
    if (needs) expect(parseFloat(await card.evaluate((e) => getComputedStyle(e).paddingTop))).toBeGreaterThanOrEqual(26);
  }
  // The seed: TikTok to connect again, Instagram to pick, X Clip Factory's own.
  expect(needing).toEqual(["tiktok", "instagram", "x"]);
});

for (const look of Object.keys(LOOK_NAME) as Look[]) {
  test(`every word on the social screens' glass reaches 4.5:1 over ${LOOK_NAME[look]}`, async ({ page }) => {
    await prepare(page, look);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "/stories/connections", look);
      expect(await lowContrast(page, ".st-social-head, .st-social-progress, .st-social-rows, .st-setupback, .st-connections > .st-note"), `Social accounts @${width}`).toEqual([]);
      await open(page, "/stories/setup", look);
      expect(await lowContrast(page, ".st-setup__head, .st-setup__grid"), `the setup @${width}`).toEqual([]);
    }
  });

  // Each platform's card on its own page (every card, as the list showed them all before), one width per test.
  for (const width of [375, 1280])
    test(`every word on each platform's page reaches 4.5:1 over ${LOOK_NAME[look]} @${width}`, async ({ page }) => {
      await prepare(page, look);
      await page.setViewportSize({ width, height: 900 });
      for (const p of PLATFORMS) {
        await open(page, `/stories/connections/${p}`, look);
        expect(await lowContrast(page, ".st-crumbs, .st-conn, .st-setupback, .st-connections > .st-note"), `${p}'s page @${width}`).toEqual([]);
      }
    });
}

test("nothing on the setup overflows from 320 px, over a busy picture too", async ({ page }) => {
  await open(page, "/stories/setup", "busy");
  for (const width of [320, 375, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
});
