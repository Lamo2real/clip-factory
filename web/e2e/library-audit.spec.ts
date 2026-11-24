import { expect, test, type Page } from "@playwright/test";
import { CLIPS, settle } from "./helpers.ts";

// Layout and order fixes from the UI audit: Library cards (F018, F062), This week at 320 px (F036, F065), the Get the
// app menu picture (F038) and the public pages' header and links (F039, F063).

const ORDER = ["YouTube", "TikTok", "Instagram", "Facebook", "X"];

/** The platform names a Library card lists, in DOM order (the grouped "waiting" marks first, then the rows). */
const cardPlatforms = (page: Page) =>
  page.locator(".lib-card").evaluateAll((cards) =>
    cards.map((card) => ({
      waiting: Array.from(card.querySelectorAll(".post--group .post__mark")).map((m) => m.getAttribute("title") ?? ""),
      rows: Array.from(card.querySelectorAll(".post:not(.post--group) .post__name")).map((n) => n.textContent ?? ""),
    })),
  );

test("Library cards list platforms in the one app-wide order (F018)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto("/library");
  await settle(page);
  const cards = await cardPlatforms(page);
  expect(cards.length).toBeGreaterThan(3);
  for (const c of cards) {
    expect(c.waiting).toEqual(ORDER.filter((p) => c.waiting.includes(p)));
    expect(c.rows).toEqual(ORDER.filter((p) => c.rows.includes(p)));
  }
  await page.goto("/settings/posting/where");
  await settle(page);
  const chips = await page.locator(".check-chips").innerText();
  const at = ORDER.map((p) => chips.indexOf(p));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

for (const width of [320, 375, 768]) {
  test(`Library card: the whole top opens the clip, at least 48 px tall at ${width}px (F062)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/library");
    await settle(page);
    // Matched by its own hook: other cards can name this clip in their "Like clips that did well" strip.
    const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: CLIPS.fresh }) });
    const target = await card.locator(".lib-card__link").evaluate((a) => {
      const r = getComputedStyle(a, "::after");
      const top = a.closest(".lib-card__top")!.getBoundingClientRect();
      return { content: r.content, position: r.position, height: top.height };
    });
    expect(target.content).not.toBe("none");
    expect(target.position).toBe("absolute");
    expect(target.height).toBeGreaterThanOrEqual(48);
    // Tapping the card's cover area (outside the hook text) opens the clip.
    const top = card.locator(".lib-card__top");
    const box = (await top.boundingBox())!;
    await top.click({ position: { x: box.width - 8, y: box.height - 8 } });
    await expect(page).toHaveURL(/\/clips\/[0-9A-Z]{26}$/);
  });
}

for (const size of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`a new owner's empty Library starts with its one next step, Go to Review, at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.addInitScript(() => sessionStorage.setItem("cf-mock-empty", "1"));
    await page.goto("/library");
    await settle(page);
    const go = page.getByRole("link", { name: "Go to Review" });
    await expect(go).toBeInViewport();
    // No zero totals and no filter above it.
    await expect(page.locator(".totals")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
    await go.click();
    await expect(page).toHaveURL(/\/review/);
  });
}

test("the Library's filter stays after opening a clip and going Back, and after a reload", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const show = page.getByRole("radiogroup", { name: "Show" });
  await show.getByRole("radio", { name: "Not posted yet" }).check();
  await expect(page).toHaveURL(/\/library\?show=waiting$/);
  const waiting = await page.locator(".lib-card").count();
  expect(waiting).toBeGreaterThan(0);
  await page.locator(".lib-card__link").first().click();
  await page.waitForURL(/\/clips\/[A-Z0-9]+$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/library\?show=waiting$/);
  await settle(page);
  await expect(show.getByRole("radio", { name: "Not posted yet" })).toBeChecked();
  await expect(page.locator(".lib-card")).toHaveCount(waiting);
  await page.reload();
  await settle(page);
  await expect(page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Not posted yet" })).toBeChecked();
  // The All clips tab is the whole list again.
  await page.getByRole("link", { name: "All clips" }).click();
  await expect(page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "All" })).toBeChecked();
});

test("a 'Like clips that did well' tile opens that clip, from a tap or the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  await settle(page);
  // A strip loads once its card is near the screen: the cards start below the totals on a phone.
  await page.locator(".lib-card").first().scrollIntoViewIfNeeded();
  const tile = page.locator(".similar__item").first();
  await tile.scrollIntoViewIfNeeded();
  await expect(tile).toBeVisible();
  const href = await tile.getAttribute("href");
  expect(href).toMatch(/^\/clips\/[A-Z0-9]+$/);
  await tile.focus();
  await expect(tile).toBeFocused();
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await page.locator("[data-stack]").nth(4).waitFor();
});

test("This week at 320px: the hook keeps its width, views stay on one line, no hanging dot (F036, F065)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/library?view=week");
  await settle(page);
  const card = page.locator(".week-card").first();
  const m = await card.evaluate((el) => {
    const body = el.querySelector(".week-card__body")!.getBoundingClientRect();
    const hook = el.querySelector<HTMLElement>(".week-card__hook")!;
    const total = el.querySelector(".week-card__total")!;
    const star = el.querySelector(".star-btn--card")!.getBoundingClientRect();
    return {
      body: body.width,
      cut: hook.scrollHeight > hook.clientHeight + 1,
      totalLines: total.getClientRects().length,
      starBelow: star.top >= body.bottom - 1,
      starHeight: star.height,
    };
  });
  expect(m.body).toBeGreaterThan(160);
  expect(m.cut).toBe(false);
  expect(m.totalLines).toBe(1);
  expect(m.starBelow).toBe(true);
  expect(m.starHeight).toBeGreaterThanOrEqual(48);

  // "This week" on line 1, the dates on line 2, and no visible "·" at the end of a line.
  const head = await page.locator("#week-title").evaluate((h) => ({
    sep: h.querySelector(".week__sep")!.getBoundingClientRect().width,
    name: h.textContent,
  }));
  expect(head.sep).toBeLessThanOrEqual(1);
  expect(head.name).toMatch(/^This week ·\s/);
  await expect(page.getByRole("heading", { level: 2, name: /^This week ·\s/ })).toBeVisible();
});

test("This week at 360px: if the heading wraps, the dot moves with the dates (F065)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/library?view=week");
  await settle(page);
  const m = await page.locator("#week-title").evaluate((h) => {
    const sep = h.querySelector(".week__sep")!.getBoundingClientRect();
    const dates = h.querySelector(".week__dates")!.lastChild!;
    const range = document.createRange();
    range.setStart(dates, 0);
    range.setEnd(dates, 1);
    return { sepTop: sep.top, firstTop: range.getBoundingClientRect().top };
  });
  // The dot sits on the same line as the first character of the dates, never alone at the end of line 1.
  expect(Math.abs(m.sepTop - m.firstTop)).toBeLessThanOrEqual(2);
});

test("This week at 1280px: one-line heading with the dot, star beside the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/library?view=week");
  await settle(page);
  expect(await page.locator(".week__sep").evaluate((s) => s.getBoundingClientRect().width)).toBeGreaterThan(1);
  const card = page.locator(".week-card").first();
  const side = await card.evaluate((el) => {
    const body = el.querySelector(".week-card__body")!.getBoundingClientRect();
    const star = el.querySelector(".star-btn--card")!.getBoundingClientRect();
    return star.left >= body.right - 1;
  });
  expect(side).toBe(true);
});

for (const width of [1024, 1280, 375]) {
  test(`Get the app, iPhone step 2: "Add to Home Screen" is never cut at ${width}px (F038)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/get-app");
    await settle(page);
    await page.getByRole("button", { name: "iPhone or iPad", exact: true }).click();
    const label = page.locator(".art--menu .art__label", { hasText: "Add to Home Screen" });
    await expect(label).toBeVisible();
    const fit = await label.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1);
  });
}

for (const path of ["/about.html", "/legal/privacy.html", "/legal/terms.html"]) {
  for (const width of [320, 375, 414]) {
    test(`${path} at ${width}px: page links stay together, every link ≥ 44 px tall (F039, F063)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path);
      const links = page.locator("nav .links a");
      const tops = await links.evaluateAll((as) => as.map((a) => Math.round(a.getBoundingClientRect().top)));
      expect(tops).toHaveLength(2);
      expect(tops[0]).toBe(tops[1]);
      const heights = await page.locator("nav a, footer a").evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height));
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
      // The logo reads like the app's: regular "Clip", italic "Factory", not bold.
      const brand = await page.locator("nav .brand").evaluate((a) => ({
        weight: getComputedStyle(a).fontWeight,
        style: getComputedStyle(a).fontStyle,
        em: getComputedStyle(a.querySelector("em")!).fontStyle,
        // A visible space between "Clip" and "Factory" (a flex box would collapse it into "ClipFactory").
        space: (() => {
          // Measure the word itself: the text node "Clip " ends in the space being checked.
          const word = a.firstChild!;
          const r = document.createRange();
          r.setStart(word, 0);
          r.setEnd(word, word.textContent!.trimEnd().length);
          return a.querySelector("em")!.getBoundingClientRect().left - r.getBoundingClientRect().right;
        })(),
      }));
      expect(brand.space).toBeGreaterThan(2);
      expect({ weight: brand.weight, style: brand.style, em: brand.em }).toEqual({ weight: "400", style: "normal", em: "italic" });
    });
  }
}
