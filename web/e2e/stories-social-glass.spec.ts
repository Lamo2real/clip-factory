import { expect, test, type Page } from "@playwright/test";
import { findOverflow } from "./helpers.ts";

// Clip Factory Stories › Social accounts and the setup on the liquid glass (web/src/stories/styles/GLASS-CONTRACT.md)
// in the mock app: the setup's ring is the ArcDial (an orange arc with its white knob and a big light numeral) in a
// hero glass head, the steps sit on glass with a solid cream current step, what is left is glass pills; the account
// cards are glass and still flow by their own height. Every word on these screens' glass is measured in pixels (the
// words made transparent, the lightest pixel behind each line found) and reaches 4.5:1 over Colours › Ember and over
// a white and a busy picture (Picture uses the veils measured for See-through over a white or busy desktop). The
// shell's own chips and buttons are the shell's to check. Stories is switched on with cf.storiesPreview = 1.

type Look = "ember" | "white" | "busy";

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
  await page.goto("/stories/connections");
  await page.evaluate(
    ({ look, src }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      const prefs = JSON.parse(localStorage.getItem("cf.stories.prefs") ?? "{}") as { more?: Record<string, unknown> };
      const more = { ...(prefs.more ?? {}) };
      if (look === "ember") delete more["look.mode"];
      else {
        more["look.mode"] = "picture";
        localStorage.setItem("cf.stories.picture", src!);
      }
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ ...prefs, more }));
    },
    { look, src: look === "ember" ? null : await page.evaluate(picture, look) },
  );
  await page.goto(path);
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await expect(page.locator(".stories-app")).toHaveAttribute("data-look", look === "ember" ? "colours" : "picture");
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

test("the setup: the ArcDial in a hero glass head, the steps on glass with a cream current step, what is left as glass pills", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "/stories/setup", "ember");
  const dial = page.locator(".st-setup__head.st-glass--hero .st-dial.st-ring");
  await expect(dial).toHaveAttribute("role", "progressbar");
  await expect(dial).toHaveAttribute("aria-valuemax", "11");
  const done = await dial.getAttribute("aria-valuenow");
  await expect(dial).toHaveAttribute("aria-label", `${done} of 11 done`);
  await expect(dial.locator(".st-dial__knob")).toHaveCount(1);
  await expect(dial.locator(".st-setup__dial-num")).toHaveText(done!);
  await expect(page.locator(".st-steps__list.st-glass")).toBeVisible();
  // The current step's highlight is solid cream with espresso words.
  const glide = page.locator(".glide--st-steps");
  await expect(glide).toHaveCSS("background-color", /rgba?\(255, 243, 228/);
  await expect(page.locator(".st-steps__item.is-on")).toHaveCSS("color", "rgb(42, 22, 11)");
  await expect(page.locator(".st-setup__panel.st-glass")).toBeVisible();
  await expect(page.locator(".st-left.st-glass .st-left__item.st-pill").first()).toBeVisible();
  // A pill shows itself on hover.
  const pill = page.locator(".st-left__item").first();
  const before = await pill.evaluate((e) => getComputedStyle(e).backgroundColor);
  await pill.hover();
  await page.waitForTimeout(300);
  expect(await pill.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(before);
});

test("Social accounts: five glass cards, the setup's way back with its small dial", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/stories/connections", "ember");
  await expect(page.locator(".st-conns > .st-conn.st-glass")).toHaveCount(5);
  await expect(page.locator(".st-conns")).toHaveAttribute("data-cols", /^[2-9]$/);
  const back = page.locator(".st-setupback.st-glass .st-dial");
  await expect(back).toHaveAttribute("role", "progressbar");
  await expect(back).toHaveAttribute("aria-label", /^\d+ of 11 done$/);
});

for (const look of ["ember", "white", "busy"] as const)
  test(`every word on the social screens' glass reaches 4.5:1 over ${look === "ember" ? "Colours › Ember" : `a ${look} picture`}`, async ({ page }) => {
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "/stories/connections", look);
      expect(await lowContrast(page, ".st-conn, .st-setupback, .st-connections > .st-note"), `Social accounts @${width}`).toEqual([]);
      await open(page, "/stories/setup", look);
      expect(await lowContrast(page, ".st-setup__head, .st-setup__grid"), `the setup @${width}`).toEqual([]);
    }
  });

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
