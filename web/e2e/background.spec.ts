import { expect, test, type Page } from "@playwright/test";
import { coloursVeil, contrast, hexToRgb, mix, seeThroughVeils, seeThroughWorstBackground, VEIL, type Rgb } from "../src/lib/background.ts";
import { findOverflow, looseText, resolveRoute, ROUTES, settle } from "./helpers.ts";

// Background modes and see-through glass (docs/CONTRACTS.md §22).

const PAGE = "/settings/look-and-feel/background";
const NOTE =
  "See-through works in the Mac and Windows app. Browsers don't let apps look behind them, so here you get the Clip Factory colours.";
const PHONE_NOTE =
  "See-through works in the Mac and Windows app on a computer. Phones don't let apps look behind them, so here you get the Clip Factory colours.";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function open(page: Page, path = PAGE) {
  await page.goto(path);
  await settle(page);
}

/** Pretends to be the desktop app with real window glass, the way desktop/src-tauri/src/init.js does. */
async function asDesktop(page: Page, glass = "vibrancy") {
  await page.addInitScript((g) => {
    (window as unknown as Record<string, unknown>).__CF_GLASS__ = g;
    (window as unknown as Record<string, unknown>).__CF_DESKTOP__ = true;
  }, glass);
}

/** Waits until the (mock) server has the change, so a reload does not race the save. */
const saved = (page: Page, text: string) =>
  expect.poll(() => page.evaluate(() => sessionStorage.getItem("cf-mock-look") ?? "")).toContain(text);
const backdrop = (page: Page) => page.evaluate(() => document.documentElement.dataset.backdrop);
const veil = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--backdrop-veil")));
const panelVeil = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--panel-veil")));
/** The highest alpha in an element's own background (colour or gradient). */
const surfaceAlpha = (page: Page, selector: string, pseudo?: string) =>
  page.locator(selector).first().evaluate((el, p) => {
    const s = getComputedStyle(el, p ?? null);
    const all = [...`${s.backgroundColor} ${s.backgroundImage}`.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    });
    return Math.max(0, ...all);
  }, pseudo);

function rgbOf(css: string): Rgb {
  const [r, g, b] = css.match(/[\d.]+/g)!.map(Number);
  return [r!, g!, b!];
}

/** The text colours of everything that sits straight on the backdrop or on a nearly clear panel. */
async function textColours(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>("h1, h2, .apple__leaf, .apple__name, .crumbs a, .crumbs__here, .muted, .bg-note, .bg-mode__name, .page-lede, .text-link")) {
      if (!el.offsetParent || !el.textContent?.trim()) continue;
      out.add(getComputedStyle(el).color);
    }
    return [...out];
  });
}

test.describe("background modes", () => {
  test("see-through is the default; in a browser it falls back to frosted colours and says why in one sentence", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("radio", { name: "See-through" })).toBeChecked();
    expect(await backdrop(page)).toBe("frosted");
    await expect(page.locator("html")).not.toHaveClass(/see-through/);
    await expect(page.locator(".backdrop--frosted .backdrop__caustic")).toHaveCount(2);
    const note = page.locator(".bg-note");
    await expect(note).toContainText(NOTE);
    await expect(note.getByRole("link", { name: "Get the app" })).toHaveAttribute("href", "/get-app");
    // The glide sits on the chosen tile.
    await expect(page.locator(".bg-modes")).toHaveClass(/has-glide/);
  });

  test("switching modes changes what is behind the glass, and it stays after a reload", async ({ page }) => {
    await open(page);
    await page.getByRole("radio", { name: "Colours" }).check();
    await expect.poll(() => backdrop(page)).toBe("colours");
    await expect(page.locator(".bg-note")).toHaveCount(0);

    // Sage out, Night in: the backdrop draws exactly the chosen colours, with a veil strong enough for them.
    await page.getByRole("button", { name: "Sage" }).click();
    await expect(page.getByRole("button", { name: "Sage" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Night" }).click();
    await expect(page.getByRole("button", { name: "Night" })).toHaveAttribute("aria-pressed", "true");
    const want = ["#f7f5ef", "#e8412c", "#1f2937"];
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", want.join(" "));
    expect(await veil(page)).toBeCloseTo(coloursVeil(want), 5);
    const c1 = await page.locator(".backdrop--colours").evaluate((el) => getComputedStyle(el).getPropertyValue("--c1").trim());
    expect(c1).toBe("#f7f5ef");

    // A fourth colour is refused kindly.
    await page.getByRole("button", { name: "Sunny" }).click();
    await expect(page.getByText("You can mix 3 colours. Tap one of yours to take it off first.")).toBeVisible();

    // Your own colour from the picker.
    await page.getByRole("button", { name: "Night" }).click();
    await page.getByLabel("Your own colour").fill("#123456");
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#f7f5ef #e8412c #123456");
    await expect(page.getByRole("button", { name: "Your colour" })).toHaveAttribute("aria-pressed", "true");

    await saved(page, "#123456");
    await page.reload();
    await settle(page);
    await expect(page.getByRole("radio", { name: "Colours" })).toBeChecked();
    expect(await backdrop(page)).toBe("colours");
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#f7f5ef #e8412c #123456");

    // Picture with no picture yet: the Clip Factory colours. Picking one uses it.
    await page.getByRole("radio", { name: "Picture" }).check();
    await expect.poll(() => backdrop(page)).toBe("brand");
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "bg.png", mimeType: "image/png", buffer: PNG });
    await expect.poll(() => backdrop(page)).toBe("picture");
    await expect(page.locator("#background-picture .pill")).toHaveText("In use");

    // Glass strength picks see-through too.
    await page.getByRole("radio", { name: "Frosted" }).check();
    await expect(page.getByRole("radio", { name: "See-through" })).toBeChecked();
    await expect.poll(() => backdrop(page)).toBe("frosted");
    await saved(page, '"frosted"');
    await page.reload();
    await settle(page);
    await expect(page.getByRole("radio", { name: "Frosted" })).toBeChecked();
    // Here Frosted thickens the frost over the Clip Factory colours, so the control always does something.
    await expect(page.locator("html")).toHaveAttribute("data-strength", "frosted");
    const frosted = await surfaceAlpha(page, ".backdrop__frost");
    await page.getByRole("radio", { name: "Clear" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-strength", "clear");
    expect(await surfaceAlpha(page, ".backdrop__frost")).toBeLessThan(frosted);
  });

  test("on a phone the note promises nothing the phone can't do, and offers no Get the app", async ({ browser }) => {
    const context = await browser.newContext({ userAgent: IPHONE, viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await open(page);
    const note = page.locator(".bg-note");
    await expect(note).toContainText(PHONE_NOTE);
    await expect(note.getByRole("link")).toHaveCount(0);
    await context.close();
  });

  test("a picture set before see-through existed is still shown after the upgrade", async ({ page }) => {
    await page.addInitScript((png) => {
      if (!localStorage.getItem("cf.background")) {
        localStorage.setItem("cf.background", png);
        localStorage.setItem("cf.prefs", JSON.stringify({ soundEnabled: true }));
      }
    }, `data:image/png;base64,${PNG.toString("base64")}`);
    await open(page);
    expect(await backdrop(page)).toBe("picture");
    await expect(page.getByRole("radio", { name: "Picture" })).toBeChecked();
    // Still so after the server answers and after a reload.
    await page.reload();
    await settle(page);
    expect(await backdrop(page)).toBe("picture");
  });

  test("a dark colour looks as soft in its previews as it will behind the glass, and says why", async ({ page }) => {
    await open(page);
    await page.getByRole("radio", { name: "Colours" }).check();
    for (const name of ["Sage", "Cream"]) await page.getByRole("button", { name }).click();
    await page.getByRole("button", { name: "Night" }).click();
    await page.getByRole("button", { name: "Tomato" }).click();
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#1f2937");
    const want = coloursVeil(["#1f2937"]);
    expect(await veil(page)).toBeCloseTo(want, 5);
    expect(await surfaceAlpha(page, ".bg-colours__mix", "::after")).toBeCloseTo(want, 2);
    expect(await surfaceAlpha(page, ".bg-tile--colours", "::after")).toBeCloseTo(want, 2);
    await expect(page.getByText("Dark colours show soft, so words stay easy to read.")).toBeVisible();
  });

  test("Ask Clip Factory's words and the search find the new settings", async ({ page }) => {
    await open(page, "/settings");
    const box = page.getByLabel("Find a setting");
    await box.fill("see-through");
    await expect(page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first()).toContainText("What's behind the glass");
    await box.fill("frosted");
    await expect(page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first()).toContainText("Glass strength");
  });
});

test.describe("see-through in the desktop app (simulated)", () => {
  test("the page is transparent, the gaps stay clear, and the panels carry just enough tint for AA", async ({ page }) => {
    await asDesktop(page);
    await open(page);
    await expect(page.locator("html")).toHaveClass(/see-through/);
    expect(await backdrop(page)).toBe("window");
    await expect(page.locator(".bg-note")).toHaveCount(0);
    await expect(page.locator(".backdrop--window .blob")).toHaveCount(0);

    const bg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(bg).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);

    // Clear: nothing over the window's own glass between the panels, so the wallpaper's shapes stay guessable.
    const clear = seeThroughVeils("vibrancy", "light", "clear");
    expect(await veil(page)).toBe(clear.page);
    expect(await surfaceAlpha(page, ".backdrop__veil")).toBe(0);
    // The panels carry the tint, and only as much as the darkest glass needs.
    expect(await panelVeil(page)).toBeCloseTo(clear.panel, 5);
    expect(await surfaceAlpha(page, ".apple-panel")).toBeCloseTo(clear.panel, 2);
    const behind = seeThroughWorstBackground("vibrancy", "light", "clear");
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);

    // Frosted: a light frost over the gaps too.
    await page.getByRole("radio", { name: "Frosted" }).check();
    const frosted = seeThroughVeils("vibrancy", "light", "frosted");
    await expect.poll(() => veil(page)).toBeCloseTo(frosted.page, 5);
    expect(await panelVeil(page)).toBeCloseTo(frosted.panel, 5);
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), seeThroughWorstBackground("vibrancy", "light", "frosted")), c).toBeGreaterThanOrEqual(4.5);

    // Colours and Picture still work inside the app: the page is drawn again.
    await page.getByRole("radio", { name: "Colours" }).check();
    await expect(page.locator("html")).not.toHaveClass(/see-through/);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("Windows blur keeps the app's tint, so its panels can be clearer", async ({ page }) => {
    await asDesktop(page, "blur");
    await open(page);
    expect(await panelVeil(page)).toBeCloseTo(seeThroughVeils("blur", "light", "clear").panel, 5);
    expect(await panelVeil(page)).toBeLessThan(seeThroughVeils("acrylic", "light", "clear").panel);
    const behind = seeThroughWorstBackground("blur", "light", "clear");
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);
  });

  test("dark system setting: the panel tint assumes the darkest glass", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await asDesktop(page, "acrylic");
    await open(page);
    await expect.poll(() => panelVeil(page)).toBeCloseTo(seeThroughVeils("acrylic", "dark", "clear").panel, 5);
    const behind = seeThroughWorstBackground("acrylic", "dark", "clear");
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);
  });

  // No text may sit straight on the transparent window: it would be unreadable over a dark wallpaper.
  for (const width of [375, 1440]) {
    test(`every piece of text sits on a tint, on every screen, at ${width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      await asDesktop(page);
      const paths: string[] = [];
      // The static pages (about, legal) are their own opaque pages, never see-through.
      for (const r of ROUTES.filter((r) => !r.endsWith(".html"))) paths.push(await resolveRoute(page, r));
      const failures: string[] = [];
      for (const path of paths) {
        await page.goto(path);
        await settle(page);
        if (!(await page.evaluate(() => document.documentElement.classList.contains("see-through")))) continue;
        for (const t of await looseText(page)) failures.push(`${path}: ${t}`);
      }
      expect(failures).toEqual([]);
    });
  }

  test("a desktop app with no glass keeps an ordinary page and says so", async ({ page }) => {
    await asDesktop(page, "none");
    await open(page);
    expect(await backdrop(page)).toBe("frosted");
    await expect(page.locator(".bg-note")).toContainText("This computer can't show see-through");
    await expect(page.locator(".bg-note").getByRole("link")).toHaveCount(0);
  });
});

// Readable and inside the screen at every size, light and dark, in every mode.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [320, 375, 768, 1440, 1920]) {
    test(`background page at ${width}px ${scheme}: no overflow, readable text`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await asDesktop(page);
      await open(page);
      for (const mode of ["See-through", "Colours", "Picture"]) {
        await page.getByRole("radio", { name: mode }).check();
        await page.waitForTimeout(300);
        const o = await findOverflow(page);
        expect(o.page, `${mode}: page scroll`).toBeLessThanOrEqual(o.viewport);
        expect(o.items, `${mode}: overflow`).toEqual([]);
      }
      // The three names stay on one line each, "See-through" included.
      const lines = await page.locator(".bg-mode__name").evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))),
      );
      expect(lines).toEqual([1, 1, 1]);
      // Colours at their darkest: Night alone, its veil keeps the text readable.
      await page.getByRole("radio", { name: "Colours" }).check();
      for (const name of ["Sage", "Cream"]) await page.getByRole("button", { name }).click();
      await page.getByRole("button", { name: "Night" }).click();
      await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", /#1f2937/);
      const colours = (await page.locator(".backdrop--colours").getAttribute("data-colours"))!.split(" ");
      const v = await veil(page);
      expect(v).toBeCloseTo(coloursVeil(colours), 5);
      for (const hex of colours) {
        const behind = mix(VEIL, hexToRgb(hex), v);
        for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), `${c} on ${hex}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}
