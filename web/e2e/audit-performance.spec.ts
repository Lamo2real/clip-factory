import { expect, test, type Locator, type Page } from "@playwright/test";
import { animationsDone, CLIPS, openClip, settle } from "./helpers.ts";

// Findings from the audit of the clip performance page and Library › This week (November 2026), each pinned.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } as const;

/** The keyboard focus ring is an outline, so a control's own box-shadow can never hide it. */
async function expectRing(el: Locator) {
  const ring = await el.evaluate((e) => {
    const s = getComputedStyle(e);
    return { focused: e.matches(":focus-visible"), outline: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring.focused).toBe(true);
  expect(ring.outline).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
}

/** Tabs forward until `el` has the focus (at most 40 presses). */
async function tabTo(page: Page, el: Locator) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await el.evaluate((e) => e === document.activeElement)) return;
  }
  throw new Error("never reached by Tab");
}

/** WCAG contrast of white on the darkest-to-lightest stops of an element's background gradient. */
async function whiteContrastOnGradient(el: Locator): Promise<number> {
  return el.evaluate((e) => {
    const bg = getComputedStyle(e).backgroundImage + " " + getComputedStyle(e).getPropertyValue("--glass-tint");
    const stops = [...bg.matchAll(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const lum = (c: number[]) =>
      c.map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    return Math.min(...stops.map((c) => 1.05 / (lum(c) + 0.05)));
  });
}

test.describe("clip page, desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Back, the star and Refresh show a focus ring from the keyboard", async ({ page }) => {
    await openClip(page, CLIPS.all);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    for (const el of [
      page.getByRole("button", { name: "Back" }),
      page.getByRole("button", { name: /Best this week/ }),
      page.getByRole("button", { name: "Refresh numbers" }),
    ]) {
      await tabTo(page, el);
      await expectRing(el);
    }
  });

  test("white labels on the tomato button and the starred star read at 4.5:1 or better", async ({ page }) => {
    await openClip(page, CLIPS.all);
    expect(await whiteContrastOnGradient(page.getByRole("button", { name: "Refresh numbers" }))).toBeGreaterThanOrEqual(4.5);
    const star = page.getByRole("button", { name: /Best this week/ });
    if ((await star.getAttribute("aria-pressed")) !== "true") await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    expect(await whiteContrastOnGradient(star)).toBeGreaterThanOrEqual(4.5);
  });

  test("the switched-off Refresh and its toast give the same wait", async ({ page }) => {
    await openClip(page, CLIPS.all);
    const refresh = page.locator(".perf__refresh");
    await refresh.click();
    await expect(refresh).toHaveText(/^Next check in \d+ min$/, { timeout: 15_000 });
    const label = (await refresh.innerText()).match(/\d+ min/)![0];
    // Switched off (aria-disabled): only a forced click reaches it, as a finger's tap would.
    await refresh.click({ force: true });
    await expect(page.locator(".toast", { hasText: "Each app only lets" })).toContainText(`Next check in ${label}.`);
  });

  test("the ticking 'Updated … ago' line is not a live region", async ({ page }) => {
    await openClip(page, CLIPS.all);
    await expect(page.locator(".perf__updated")).not.toHaveAttribute("aria-live", /.+/);
  });
});

test.describe("clip page, layout decided like the CSS", () => {
  // Stage widths just under the 620 / 1060 px container breakpoints, with fractions (sidebar open).
  for (const width of [662, 946, 1101, 1385]) {
    test(`at ${width} px the lines follow the same layout as the stacks`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openClip(page, CLIPS.all);
      const { layout, columns } = await page.evaluate(() => ({
        layout: document.querySelector(".perf-lines")?.getAttribute("data-layout"),
        columns: getComputedStyle(document.querySelector(".perf__stacks")!).gridTemplateColumns.split(" ").length,
      }));
      expect({ layout, columns }).toEqual({ layout, columns: layout === "fan" ? 5 : layout === "rows" ? 6 : 1 });
    });
  }
});

test.describe("clip page, phone", () => {
  test.use(PHONE);

  test("the jump chips are 48 px tall and show a focus ring", async ({ page }) => {
    await openClip(page, CLIPS.all);
    const chips = page.locator(".perf-chip");
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all()) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await chips.first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expectRing(chips.first());
  });
});

test.describe("This week", () => {
  test("the tabs, the arrows and the stars show a focus ring", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/library?view=week");
    await settle(page);
    for (const el of [
      page.locator(".lib-tab").first(),
      page.getByRole("link", { name: "Earlier week" }),
      page.locator(".star-btn--card").first(),
    ]) {
      await tabTo(page, el);
      await expectRing(el);
    }
  });

  test("a private TikTok is left out of the app pills instead of promising numbers 'soon'", async ({ page }) => {
    await page.goto("/library?view=week");
    await settle(page);
    const card = page.locator(".week-card", { hasText: CLIPS.mixed });
    await expect(card.locator('.week-card__mark[data-platform="youtube"]')).toBeVisible();
    await expect(card.locator('.week-card__mark[data-platform="tiktok"]')).toHaveCount(0);
  });

  test("a starred card's label reads at 4.5:1 or better", async ({ page }) => {
    await page.goto("/library?view=week");
    await settle(page);
    const star = page.locator(".star-btn--card").first();
    if ((await star.getAttribute("aria-pressed")) !== "true") await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await animationsDone(page);
    expect(await whiteContrastOnGradient(star)).toBeGreaterThanOrEqual(4.5);
  });

  test("an empty week does not ask to star clips that are not there", async ({ page }) => {
    await page.goto("/library?view=week&week=2026-W30");
    await settle(page);
    await expect(page.getByText("No clips that week")).toBeVisible();
    await expect(page.locator(".week__learn")).toHaveCount(0);
  });

  test("the rank number is for the eyes; the list announces the position", async ({ page }) => {
    await page.goto("/library?view=week");
    await settle(page);
    await expect(page.locator(".week-card__rank").first()).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".week-list")).toHaveJSProperty("tagName", "OL");
  });
});

test.describe("This week on a phone", () => {
  test.use(PHONE);

  test("the whole card opens the clip, and the star still only stars", async ({ page }) => {
    await page.goto("/library?view=week");
    await settle(page);
    const card = page.locator(".week-card").first();
    // Keep the card clear of the phone tab bar (the money line makes it taller), then measure it.
    await card.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = (await card.boundingBox())!;
    const star = card.locator(".star-btn--card");
    const pressed = await star.getAttribute("aria-pressed");
    await star.click();
    await expect(star).not.toHaveAttribute("aria-pressed", pressed ?? "false");
    await expect(page).toHaveURL(/view=week/);
    // A tap low in the card, below the one-line hook, still opens the clip.
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height - 8);
    await expect(page).toHaveURL(/\/clips\/[A-Z0-9]+$/);
  });
});

test("Library: each post's numbers are read out with their names", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const metrics = page.locator(".post__metrics").first();
  await expect(metrics).not.toHaveAttribute("aria-label", /.+/);
  await expect(metrics.locator(".sr-only")).toHaveText(/views, .* likes, .* comments$/);
});
