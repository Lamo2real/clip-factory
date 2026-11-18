import { expect, test, type Page } from "@playwright/test";
import {
  coloursVeil,
  contrast,
  hexToRgb,
  mix,
  seeThroughVeils,
  seeThroughWorstBackground,
  TEXT_TOKENS,
  VEIL,
  WINDOW_TEXT_TOKENS,
  type NativeGlass,
  type Rgb,
} from "../src/lib/background.ts";
import { ACTIVE_FLOOR, ACTIVE_SCENE, asDesktop, INACTIVE_FLOOR, INACTIVE_SCENE, paintGlass, plannedFloor, WHITE, WINDOW_EXTRA_ROUTES } from "./glass.ts";
import { animationsDone, CLIPS, findOverflow, looseText, openClip, resolveRoute, ROUTES, scanText, settle } from "./helpers.ts";

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
/** The colour a word written in `token` is drawn in, inside a panel of the page. */
const drawnIn = (page: Page, token: string) =>
  page.locator(".apple-panel").first().evaluate((panel, t) => {
    const word = document.createElement("span");
    word.style.color = `var(${t})`;
    panel.append(word);
    const [r, g, b] = getComputedStyle(word).color.match(/[\d.]+/g)!.map(Number);
    word.remove();
    return [r, g, b];
  }, token);
/** The text colour tokens as <html> has them right now, `{ "--ink-3": "#344031", ... }`. */
const textTokens = (page: Page) =>
  page.evaluate((names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])), Object.keys(TEXT_TOKENS));

/**
 * The text colours of everything that sits straight on the backdrop or on a panel. The Background tiles' names are
 * left out: the chosen one sits on its own bone pill (green words), and they fade between the two as the pill
 * slides; contrast.spec.ts reads them once settled.
 */
async function textColours(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>("h1, h2, .apple__leaf, .apple__name, .crumbs a, .crumbs__here, .muted, .bg-note, .page-lede, .text-link")) {
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

    // Bottle green out, Night in: the backdrop draws exactly the chosen colours, with a veil strong enough for them.
    await page.getByRole("button", { name: "Bottle green" }).click();
    await expect(page.getByRole("button", { name: "Bottle green" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Night" }).click();
    await expect(page.getByRole("button", { name: "Night" })).toHaveAttribute("aria-pressed", "true");
    const want = ["#efe7da", "#e8392b", "#1f2937"];
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", want.join(" "));
    expect(await veil(page)).toBeCloseTo(coloursVeil(want), 5);
    const c1 = await page.locator(".backdrop--colours").evaluate((el) => getComputedStyle(el).getPropertyValue("--c1").trim());
    expect(c1).toBe("#efe7da");

    // A fourth colour is refused kindly.
    await page.getByRole("button", { name: "Sunny" }).click();
    await expect(page.getByText("You can mix 3 colours. Tap one of yours to take it off first.")).toBeVisible();

    // Your own colour from the picker.
    await page.getByRole("button", { name: "Night" }).click();
    await page.getByLabel("Your own colour").fill("#123456");
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#efe7da #e8392b #123456");
    await expect(page.getByRole("button", { name: "Your colour" })).toHaveAttribute("aria-pressed", "true");

    await saved(page, "#123456");
    await page.reload();
    await settle(page);
    await expect(page.getByRole("radio", { name: "Colours" })).toBeChecked();
    expect(await backdrop(page)).toBe("colours");
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#efe7da #e8392b #123456");

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

  test("a light colour looks as soft in its previews as it will behind the glass, and says why", async ({ page }) => {
    await open(page);
    await page.getByRole("radio", { name: "Colours" }).check();
    for (const name of ["Bottle green", "Vermilion"]) await page.getByRole("button", { name }).click();
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#efe7da");
    const want = coloursVeil(["#efe7da"]);
    expect(want).toBeGreaterThan(0.5);
    expect(await veil(page)).toBeCloseTo(want, 5);
    expect(await surfaceAlpha(page, ".bg-colours__mix", "::after")).toBeCloseTo(want, 2);
    expect(await surfaceAlpha(page, ".bg-tile--colours", "::after")).toBeCloseTo(want, 2);
    await expect(page.getByText("Light colours show soft, so words stay easy to read.")).toBeVisible();
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
  test("macOS Liquid Glass: the page is transparent, the gaps stay clear, the panels carry just enough green and the softer words go to bone", async ({ page }) => {
    await asDesktop(page, "liquid");
    await open(page);
    await expect(page.locator("html")).toHaveClass(/see-through/);
    await expect(page.locator("html")).toHaveAttribute("data-glass", "liquid");
    expect(await backdrop(page)).toBe("window");
    await expect(page.locator(".bg-note")).toHaveCount(0);
    await expect(page.locator(".backdrop--window .blob")).toHaveCount(0);

    const bg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(bg).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);

    // Clear: nothing over the window's own glass between the panels, so the shapes behind stay guessable.
    const clear = seeThroughVeils("liquid", "light", "clear");
    expect(await veil(page)).toBe(clear.page);
    expect(await surfaceAlpha(page, ".backdrop__veil")).toBe(0);
    // The panels carry the green, only as much as bone words need over a white desktop.
    expect(await panelVeil(page)).toBeCloseTo(clear.panel, 5);
    expect(clear.panel).toBeLessThanOrEqual(0.75);
    expect(await surfaceAlpha(page, ".apple-panel")).toBeCloseTo(clear.panel, 2);

    // The window look's own text colours: the softer ones are bone or lighter here, the rest as everywhere.
    expect(await textTokens(page)).toEqual(WINDOW_TEXT_TOKENS);
    // And words written in them are drawn in them: the meta line of a panel, vermilion words, green words.
    for (const token of ["--ink-3", "--vermilion-ink", "--green-ink", "--green-text"] as const) expect(await drawnIn(page, token), token).toEqual(hexToRgb(WINDOW_TEXT_TOKENS[token]));
    const behind = seeThroughWorstBackground("liquid", "light", "clear");
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);

    // Frosted: a green frost over the gaps too, and heavier panels, so it shows less.
    await page.getByRole("radio", { name: "Frosted" }).check();
    const frosted = seeThroughVeils("liquid", "light", "frosted");
    await expect.poll(() => veil(page)).toBeCloseTo(frosted.page, 5);
    expect(await panelVeil(page)).toBeCloseTo(frosted.panel, 5);
    expect(frosted.panel).toBeGreaterThan(clear.panel);
    expect(await surfaceAlpha(page, ".backdrop__veil")).toBeCloseTo(frosted.page, 2);
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), seeThroughWorstBackground("liquid", "light", "frosted")), c).toBeGreaterThanOrEqual(4.5);

    // Colours and Picture still work inside the app: the page is drawn again, with the usual text colours.
    await page.getByRole("radio", { name: "Colours" }).check();
    await expect(page.locator("html")).not.toHaveClass(/see-through/);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await textTokens(page)).toEqual(TEXT_TOKENS);
  });

  // The glasses nobody has measured yet keep their careful numbers; each still gets its own panel tint.
  for (const glass of ["vibrancy", "acrylic", "mica", "blur"] as const) {
    test(`${glass} keeps working: its own panel tint, the window text colours, AA over white`, async ({ page }) => {
      await asDesktop(page, glass);
      await open(page);
      await expect(page.locator("html")).toHaveClass(/see-through/);
      await expect(page.locator("html")).toHaveAttribute("data-glass", glass);
      const clear = seeThroughVeils(glass, "light", "clear");
      expect(await panelVeil(page)).toBeCloseTo(clear.panel, 5);
      expect(await surfaceAlpha(page, ".apple-panel")).toBeCloseTo(clear.panel, 2);
      expect(await textTokens(page)).toEqual(WINDOW_TEXT_TOKENS);
      const behind = seeThroughWorstBackground(glass, "light", "clear");
      for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("every glass plans for a white desktop, so every glass gets the same panel tint", async ({ page }) => {
    const liquid = seeThroughVeils("liquid", "light", "clear").panel;
    for (const glass of ["vibrancy", "acrylic", "mica", "blur"] as const) expect(seeThroughVeils(glass, "light", "clear").panel).toBe(liquid);
    await asDesktop(page, "blur");
    await open(page);
    expect(await panelVeil(page)).toBeCloseTo(liquid, 5);
  });

  test("dark system setting: the panel tint still plans for a white desktop, whatever the glass", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await asDesktop(page, "liquid");
    await open(page);
    const dark = seeThroughVeils("liquid", "dark", "clear");
    expect(dark).toEqual(seeThroughVeils("acrylic", "dark", "clear"));
    await expect.poll(() => panelVeil(page)).toBeCloseTo(dark.panel, 5);
    const behind = seeThroughWorstBackground("liquid", "dark", "clear");
    for (const c of await textColours(page)) expect(contrast(rgbOf(c), behind), c).toBeGreaterThanOrEqual(4.5);
  });

  // The real glass, stood in for: what was measured behind the real window is painted behind the transparent page
  // (e2e/glass.ts) and every piece of text on the Background page is read against it, Clear and Frosted.
  for (const width of [375, 1440]) {
    test(`over the measured glass every word on the Background page is readable, Clear and Frosted, at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await asDesktop(page, "liquid");
      await open(page);
      const failures: string[] = [];
      for (const strength of ["Clear", "Frosted"]) {
        await page.getByRole("radio", { name: strength }).check();
        await expect(page.locator("html")).toHaveAttribute("data-strength", strength.toLowerCase());
        // The chosen label fades to its new colour: read the page once that is over.
        await animationsDone(page);
        for (const paint of [INACTIVE_FLOOR, ACTIVE_FLOOR, INACTIVE_SCENE, ACTIVE_SCENE, plannedFloor("liquid"), WHITE]) {
          await paintGlass(page, paint);
          const scan = await scanText(page);
          expect(scan.checked).toBeGreaterThan(10);
          for (const f of [...scan.contrast, ...scan.tiny])
            failures.push(`${strength} over ${paint.name}: ${f.selector} "${f.text}" ${f.ratio ?? `${f.fontSize}px`} (${f.color ?? ""} on ${f.background ?? ""})`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  // No text may sit straight on the transparent window: it would be unreadable over a dark desktop. Every surface
  // that holds words is at least as strong as the look's own panel tint (liquid 0.44, vibrancy 0.68).
  for (const glass of ["liquid", "vibrancy"] as const satisfies readonly NativeGlass[]) {
    for (const width of [375, 1440]) {
      test(`${glass}: every piece of text sits on a tint, on every screen, at ${width}px`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width, height: 900 });
        await asDesktop(page, glass);
        const paths: string[] = [];
        // The static pages (about, legal) are their own opaque pages, never see-through.
        for (const r of ROUTES.filter((r) => !r.endsWith(".html"))) paths.push(await resolveRoute(page, r));
        paths.push(...WINDOW_EXTRA_ROUTES);
        const failures: string[] = [];
        for (const path of paths) {
          await page.goto(path);
          await settle(page);
          await expect(page.locator("html"), path).toHaveClass(/see-through/);
          for (const t of await looseText(page)) failures.push(`${path}: ${t}`);
        }
        // A clip's page has no fixed address (the mock makes new ids on every load): opened from the Library.
        await openClip(page, CLIPS.all);
        for (const t of await looseText(page)) failures.push(`a clip page: ${t}`);
        expect(failures).toEqual([]);
      });
    }
  }

  test("a desktop app with no glass keeps an ordinary page and says so", async ({ page }) => {
    await asDesktop(page, "none");
    await open(page);
    expect(await backdrop(page)).toBe("frosted");
    await expect(page.locator(".bg-note")).toContainText("This computer can't show see-through");
    await expect(page.locator(".bg-note").getByRole("link")).toHaveCount(0);
  });

  test("a glass name this page does not know (a newer desktop app) falls back to an ordinary page", async ({ page }) => {
    await asDesktop(page, "crystal");
    await open(page);
    await expect(page.locator("html")).not.toHaveClass(/see-through/);
    expect(await backdrop(page)).toBe("frosted");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await textTokens(page)).toEqual(TEXT_TOKENS);
  });
});

// Readable and inside the screen at every size, light and dark, in every mode.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [320, 375, 768, 1440, 1920]) {
    test(`background page at ${width}px ${scheme}: no overflow, readable text`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await asDesktop(page, "liquid");
      await open(page);
      for (const mode of ["See-through", "Colours", "Picture"]) {
        await page.getByRole("radio", { name: mode }).check();
        await expect(page.getByRole("radio", { name: mode })).toBeChecked();
        await animationsDone(page); // the highlight has slid over and the mode's own controls are in
        const o = await findOverflow(page);
        expect(o.page, `${mode}: page scroll`).toBeLessThanOrEqual(o.viewport);
        expect(o.items, `${mode}: overflow`).toEqual([]);
      }
      // The three names stay on one line each, "See-through" included.
      const lines = await page.locator(".bg-mode__name").evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))),
      );
      expect(lines).toEqual([1, 1, 1]);
      // Colours at their lightest: Bone alone, its veil keeps the text readable.
      await page.getByRole("radio", { name: "Colours" }).check();
      for (const name of ["Bottle green", "Vermilion"]) await page.getByRole("button", { name }).click();
      await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#efe7da");
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
