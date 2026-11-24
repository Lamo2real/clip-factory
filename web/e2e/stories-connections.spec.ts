import { expect, test, type Page } from "@playwright/test";
import { findOverflow, WIDTHS } from "./helpers.ts";

// Lamo Stories › Social accounts, round 3 (docs/CONTRACTS.md §45.34) in the mock app: both Meta cards show both
// redirect URIs (Instagram's and Facebook's) with Copy buttons, also once the keys are saved; after a connect the
// page says "Connected as {name} ({handle})" and the card asks "Is this your Lamo Stories {place}?" with Yes and
// Pick another; the line after Disconnect follows the app the account used. Less text (the owner, 23 Nov): each card
// shows its account, its safety line while an account is still to connect or fix, and one main button (Set up the app
// while the developer app is not ready); the rest is in one More fold (opened here where a test needs what is in it).
// Organized (the owner, 24 Nov: like Clip Factory's Set up posting): Social accounts is a header, a progress card and
// one row per platform; each row opens the platform's own page (/stories/connections/<p>) with its card, and the OAuth
// return lands there. Lamo Stories is switched on with cf.storiesPreview = 1.

async function on(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const NAMES = ["YouTube", "TikTok", "Instagram", "Facebook", "X"] as const;
type Name = (typeof NAMES)[number];
const SLUG: Record<Name, string> = { YouTube: "youtube", TikTok: "tiktok", Instagram: "instagram", Facebook: "facebook", X: "x" };

/** A platform's own page, opened from its address. */
async function openPage(page: Page, name: Name) {
  await page.goto(`/stories/connections/${SLUG[name]}`);
  await ready(page);
  await expect(page.locator("section.st-social-one")).toHaveAttribute("data-platform", SLUG[name]);
}
/** A platform's own page, opened from its row on Social accounts (no reload: the pretend app keeps what it holds). */
async function openRow(page: Page, name: Name) {
  if (!/\/stories\/connections$/.test(new URL(page.url()).pathname)) {
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
  }
  await rowOf(page, name).locator("a.st-social-row").click();
  await expect(page).toHaveURL(new RegExp(`/stories/connections/${SLUG[name]}$`));
  await expect(page.locator("section.st-social-one")).toHaveAttribute("data-platform", SLUG[name]);
}

const cardOf = (page: Page, name: string) => page.locator(".st-conn").filter({ has: page.getByRole("heading", { name, exact: true }) });
const rowOf = (page: Page, name: Name) => page.locator(`.st-social-row-wrap[data-platform="${SLUG[name]}"]`);
/** A card's one More fold (its line). */
const moreOf = (card: ReturnType<typeof cardOf>) => card.locator(".st-conn__more > summary");

test("the list: a header, the count, and five rows in order, each opening its platform's own page", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  await expect(page.locator("header.st-social-head h1")).toHaveText("Social accounts");
  await expect(page.locator(".st-social-progress h2")).toHaveText("1 of 5 ready");
  await expect(page.locator(".st-social-rows > li")).toHaveCount(5);
  expect(await page.locator(".st-social-rows > li").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.platform))).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
  // No card on the list: the rows are the way on, and there is no orange main button.
  await expect(page.locator(".st-conn")).toHaveCount(0);
  await expect(page.locator(".st-connections .st-btn--main")).toHaveCount(0);
  await expect(rowOf(page, "YouTube")).toHaveAttribute("data-state", "ready");
  await expect(rowOf(page, "YouTube").locator(".st-chip")).toHaveText("Ready");
  await expect(rowOf(page, "TikTok").locator(".st-social-row__line")).toHaveText("Connect again.");
  await openRow(page, "TikTok");
  await expect(cardOf(page, "TikTok")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveText("Social accounts › TikTok");
  const o = await findOverflow(page);
  expect(o.page, "@390: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@390").toEqual([]);
});

test("less text: each card shows its account, its safety line while one is to fix, and one main button; More opens with the keyboard", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of NAMES) {
    await openPage(page, name);
    const card = cardOf(page, name);
    // The connected YouTube is fine: it does not say the safety line again (the page's own line says it at the top).
    if (name === "YouTube") await expect(card.locator(".st-conn__new")).toHaveCount(0);
    else await expect(card.locator(".st-conn__new")).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
    await expect(card.locator(":scope > details")).toHaveCount(1);
    await expect(card.locator(".st-conn__more")).not.toHaveAttribute("open", "");
    expect(await card.locator(".st-btn--main:visible").count(), name).toBeLessThanOrEqual(1);
    await expect(card.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  }
  await openPage(page, "YouTube");
  const yt = cardOf(page, "YouTube");
  await expect(yt.locator(".st-who")).toContainText("@fundedclips");
  await expect(yt.getByRole("button", { name: "Pick another channel" })).toBeVisible();
  // More opens and closes from the keyboard; Check now and Disconnect are in it.
  await moreOf(yt).focus();
  await page.keyboard.press("Enter");
  await expect(yt.getByRole("button", { name: "Check now" })).toBeVisible();
  await expect(yt.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(yt.locator(".st-auth")).toContainText("Allowed: Clips Funded may post here.");
  await page.keyboard.press("Space");
  await expect(yt.getByRole("button", { name: "Check now" })).toBeHidden();
  const o = await findOverflow(page);
  expect(o.page, "@390: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@390").toEqual([]);
});

test("less text, a brand-new studio: Set up the app is each card's one main button, and opens the app's choice on the card", async ({ page }) => {
  await on(page);
  await page.addInitScript(() => ((window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } }));
  await page.setViewportSize({ width: 390, height: 844 });
  // The list: nothing is set up yet, so every row says how long it takes.
  await page.goto("/stories/connections");
  await ready(page);
  await expect(page.locator(".st-social-progress h2")).toHaveText("0 of 5 ready");
  await expect(rowOf(page, "X").locator(".st-social-row__line")).toHaveText("About 15 minutes · Costs a little");
  for (const name of NAMES) await expect(rowOf(page, name), name).toHaveAttribute("data-state", "not_started");
  for (const name of NAMES) {
    await openPage(page, name);
    const card = cardOf(page, name);
    await expect(card.locator(".st-conn__more")).not.toHaveAttribute("open", "");
    await expect(moreOf(card)).toHaveText(`More for ${name}`);
    await expect(card.locator(".st-conn__new")).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
    // No Connect that cannot work yet: the one main button is the first step.
    await expect(card.getByRole("button", { name: `Connect ${name}` })).toHaveCount(0);
    await expect(card.getByRole("button", { name: `Set up the app for ${name}` })).toHaveClass(/st-btn--main/);
    expect(await card.locator(".st-btn--main:visible").count(), name).toBe(1);
  }
  await openPage(page, "YouTube");
  const yt = cardOf(page, "YouTube");
  await expect(yt.getByRole("radiogroup", { name: "Which YouTube app Clips Funded uses" })).toHaveCount(0);
  // Centred first, so the phone's tab bar is not the thing under the tap.
  const setUp = yt.getByRole("button", { name: "Set up the app for YouTube" });
  await setUp.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await setUp.click();
  await expect(setUp).toHaveAttribute("aria-expanded", "true");
  await expect(yt.getByRole("radiogroup", { name: "Which YouTube app Clips Funded uses" })).toBeVisible();
  // Only the choice opens: what YouTube allows and Clip Factory's own account stay in More.
  await expect(yt.locator(".st-conn__setup")).not.toContainText("What YouTube allows");
  await expect(yt.locator(".st-conn__setup")).not.toContainText("Clip Factory posts to");
  const o = await findOverflow(page);
  expect(o.page, "@390: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@390").toEqual([]);
});

test("both Meta cards show both redirect URIs to copy, also once the keys are saved, and nothing overflows", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const name of ["Instagram", "Facebook"] as const) {
    await openPage(page, name);
    const card = cardOf(page, name);
    await moreOf(card).click();
    await expect(card.locator(".st-app")).toContainText("Uses its own Meta app");
    await expect(card.locator(".st-copy__value")).toHaveText([/\/v1\/stories-oauth\/instagram\/callback$/, /\/v1\/stories-oauth\/facebook\/callback$/]);
    await expect(card.getByRole("button", { name: "Copy Instagram's redirect URI" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Copy Facebook's redirect URI" })).toBeVisible();
    await expect(card).toContainText("Valid OAuth Redirect URIs");
  }
  // The platform's page with its fold open, then the list.
  for (const where of ["Facebook's page", "the list"]) {
    if (where === "the list") {
      await page.goto("/stories/connections");
      await ready(page);
    }
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const o = await findOverflow(page);
      expect(o.page, `${where} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
      expect(o.items, `${where} @${width}`).toEqual([]);
    }
  }
});

test("after a connect: the return lands on the platform's page, Connected as {name} ({handle}), and the card asks whether it is the Lamo Stories channel", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  await openRow(page, "YouTube");
  const yt = cardOf(page, "YouTube");
  await yt.getByRole("button", { name: "Pick another channel" }).click();
  // The OAuth return (/stories/connections?platform=youtube&result=connected…) opens YouTube's page, whose address is
  // its own once the result is said.
  await expect(page).toHaveURL(/\/stories\/connections\/youtube$/);
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clips Funded (@fundedclips)." })).toBeVisible();
  const ask = yt.getByRole("group", { name: "Is this your Clips Funded channel?" });
  await expect(ask).toBeVisible();
  // While it asks, the card says again to use a new account made for Clips Funded.
  await expect(yt.locator(".st-conn__new")).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
  // Pick another connects again, and asks again.
  await ask.getByRole("button", { name: "Pick another channel" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clips Funded (@fundedclips)." }).first()).toBeVisible();
  await expect(yt.getByRole("group", { name: "Is this your Clips Funded channel?" })).toBeVisible();
  await expect(page).toHaveURL(/\/stories\/connections\/youtube$/);
  await yt.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clips Funded posts to this YouTube channel (Clips Funded)." })).toBeVisible();
  await expect(yt.locator(".st-intended")).toHaveCount(0);
  await expect(page.locator("canvas.confetti").first()).toBeAttached();
});

test("the OAuth landing address opens the platform's page and says the result once", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections?platform=tiktok&result=denied&ws=stories");
  await ready(page);
  await expect(page).toHaveURL(/\/stories\/connections\/tiktok$/);
  await expect(page.locator("section.st-social-one")).toHaveAttribute("data-platform", "tiktok");
  await expect(page.locator(".toast").filter({ hasText: "You pressed cancel. Tap Connect TikTok to try again." })).toBeVisible();
  // The rail marks Social accounts on the platform's page.
  await expect(page.locator(".st-rail .st-rail__item", { hasText: "Social accounts" })).toHaveAttribute("aria-current", "page");
});

test("a connect finished by picking the Instagram account from the list asks whether it is the Lamo Stories account", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await openPage(page, "Instagram");
  const ig = cardOf(page, "Instagram");
  await ig.locator(".st-choose").getByRole("button", { name: /funded\.clips/ }).click();
  const ask = ig.getByRole("group", { name: "Is this your Clips Funded account?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Connected as funded.clips.");
  const o = await findOverflow(page);
  expect(o.page, "@320: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@320").toEqual([]);
  await ask.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clips Funded posts to this Instagram account (funded.clips)." })).toBeVisible();
  await expect(ig.locator(".st-intended")).toHaveCount(0);
});

test("after Disconnect, an own Meta app gets the Lamo Stories line, Clip Factory's app keeps its own", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  await openRow(page, "Facebook");
  const fb = cardOf(page, "Facebook");
  await fb.getByRole("button", { name: "Connect Facebook" }).click();
  await expect(page).toHaveURL(/\/stories\/connections\/facebook$/);
  await fb.getByRole("button", { name: /^Clips Funded/ }).click();
  await expect(fb.locator(".st-chip").first()).toHaveText("Connected");
  // Picked from the list: the card asks first whether this is the Lamo Stories Page (§45.34).
  await fb.getByRole("group", { name: "Is this your Clips Funded Page?" }).getByRole("button", { name: "Yes, that's it" }).click();
  await moreOf(fb).click();
  await fb.getByRole("button", { name: "Disconnect" }).click();
  await fb.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByText("To remove Clips Funded completely, remove your Clips Funded app in the account's own settings. Clip Factory is not affected.")).toBeVisible();
  await page.getByRole("button", { name: "Hide this note" }).click();
  await openRow(page, "YouTube");
  const yt = cardOf(page, "YouTube");
  await moreOf(yt).click();
  await yt.getByRole("button", { name: "Disconnect" }).click();
  await yt.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByText("To remove Clip Factory from this account completely, remove the app in the account's own settings.")).toBeVisible();
});

test("round 4: no Check now while the account is still to be picked, and one toast per pick (§45.35 D21)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, "YouTube");
  await moreOf(cardOf(page, "YouTube")).click();
  await expect(cardOf(page, "YouTube").getByRole("button", { name: /Check now/ })).toBeVisible();
  await openRow(page, "Instagram");
  const ig = cardOf(page, "Instagram");
  await expect(ig.locator(".st-choose")).toBeVisible();
  // (Check now is in each card's More fold.)
  await moreOf(ig).click();
  await expect(ig.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(ig.getByRole("button", { name: /Check now/ })).toHaveCount(0);
  // Every toast from here on.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof HTMLElement) for (const t of [n, ...Array.from(n.querySelectorAll(".toast__text"))]) if (t.matches(".toast__text")) w.__toasts.push(t.textContent?.trim() ?? "");
    }).observe(document.body, { childList: true, subtree: true });
  });
  await ig.locator(".st-choose").getByRole("button", { name: /funded\.clips/ }).click();
  const ask = ig.getByRole("group", { name: "Is this your Clips Funded account?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clips Funded posts to this Instagram account (funded.clips)." })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).toEqual(["Great! Clips Funded posts to this Instagram account (funded.clips)."]);
  // Connected now: Check now is back.
  await expect(ig.getByRole("button", { name: /Check now/ })).toBeVisible();
});

test("round 5: one name for the other app, ids and developer words one tap away, rows in two columns (§45.36 E13, E14, E18)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  // E13: "Clip Factory" everywhere, never "Lamo Clips": on the list and on every platform's page.
  const words = await page.locator(".st-connections").evaluate((el) => (el as HTMLElement).innerText);
  expect(words).toContain("Clip Factory");
  expect(words).not.toContain("Lamo Clips");
  // E18, now rows: two a line at 1440, in order, the rows of one line the same height, 16 px between them. (Measured
  // once the rows' rise-in has ended, so no row is caught on its way up.)
  await page.locator(".st-social-rows > li").evaluateAll((els) => Promise.all(els.flatMap((e) => e.getAnimations()).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const boxes = await page.locator(".st-social-rows > li").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), top: Math.round(r.top), height: Math.round(r.height), bottom: r.bottom })));
  expect(new Set(boxes.map((b) => b.x)).size, "two columns at 1440").toBe(2);
  for (let i = 0; i + 1 < boxes.length; i += 2) {
    expect(boxes[i]!.top, `line ${i / 2 + 1}: side by side`).toBe(boxes[i + 1]!.top);
    expect(Math.abs(boxes[i]!.height - boxes[i + 1]!.height), `line ${i / 2 + 1}: the same height`).toBeLessThanOrEqual(1);
  }
  for (let i = 2; i < boxes.length; i++) {
    const gap = boxes[i]!.top - boxes[i - 2]!.bottom;
    expect(gap, "the gap above a row").toBeLessThanOrEqual(17);
    expect(gap, "a row never over the one above it").toBeGreaterThanOrEqual(15);
  }
  for (const name of NAMES) {
    await openRow(page, name);
    const text = await page.locator(".st-connections").evaluate((el) => (el as HTMLElement).innerText);
    expect(text, name).not.toContain("Lamo Clips");
  }
  // E14: the account's id is not on screen until the card's More fold is opened; then it is, one tap away.
  await openRow(page, "YouTube");
  const yt = cardOf(page, "YouTube");
  await expect(yt.locator(".st-who__id")).toBeHidden();
  await moreOf(yt).click();
  await expect(yt.locator(".st-who__id code")).toBeVisible();
  await expect(yt.locator(".st-who__id code")).toHaveText(/^UC/);
  // The Meta card's More fold says what to do in plain words first; Facebook Login's own words are folded again.
  await openRow(page, "Instagram");
  const insta = cardOf(page, "Instagram");
  await expect(insta.getByText("Copy these two addresses into your Meta app's settings", { exact: false })).toBeHidden();
  await moreOf(insta).click();
  await expect(insta.getByText("Copy these two addresses into your Meta app's settings", { exact: false })).toBeVisible();
  await expect(insta.getByText("Valid OAuth Redirect URIs", { exact: false })).toBeHidden();
  await openRow(page, "TikTok");
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok.getByText("Sandbox", { exact: false })).toBeHidden();
  for (const where of ["TikTok's page", "the list"]) {
    if (where === "the list") await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Social accounts" }).click();
    for (const width of [320, 768, 1024, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const o = await findOverflow(page);
      expect(o.page, `${where} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
      expect(o.items, `${where} @${width}`).toEqual([]);
    }
  }
});

test("round 5: a row or a card that grows never moves another one to another column (§45.36 E18)", async ({ page }) => {
  await on(page);
  for (const width of [1100, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/stories/connections");
    await ready(page);
    const xs = () => page.locator(".st-social-rows > li").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
    const before = await xs();
    // A row grows while it asks whether to skip: the others keep their column, and its line stays the same height.
    for (const name of ["TikTok", "Instagram", "Facebook", "X"] as const) {
      await rowOf(page, name).getByRole("button", { name: `Skip ${name}`, exact: true }).click();
      await expect(rowOf(page, name).getByRole("group", { name: `Skip ${name}?` })).toBeVisible();
      await page.waitForTimeout(250);
      expect(await xs(), `@${width}: Skip on ${name}`).toEqual(before);
      const heights = await page.locator(".st-social-rows > li").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), height: Math.round(r.height) })));
      for (let i = 0; i + 1 < heights.length; i += 2)
        if (heights[i]!.top === heights[i + 1]!.top) expect(Math.abs(heights[i]!.height - heights[i + 1]!.height), `@${width}: line ${i / 2 + 1} after ${name} grew`).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
      await expect(rowOf(page, name).getByRole("group", { name: `Skip ${name}?` })).toHaveCount(0);
    }
    // A card that grows (Change app, in its More fold) stays one column on its own page, and nothing goes sideways.
    for (const [name, button] of [
      ["YouTube", "Change app"],
      ["TikTok", "Change app"],
      ["Instagram", "New keys"],
      ["X", "Change app"],
    ] as const) {
      await openRow(page, name);
      const card = cardOf(page, name);
      const x = await card.evaluate((el) => Math.round(el.getBoundingClientRect().x));
      await moreOf(card).click();
      await card.getByRole("button", { name: button, exact: true }).click();
      await page.waitForTimeout(250);
      expect(await card.evaluate((el) => Math.round(el.getBoundingClientRect().x)), `@${width}: Change app on ${name}`).toBe(x);
      const o = await findOverflow(page);
      expect(o.page, `@${width}: ${name}'s page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
      expect(o.items, `@${width}: ${name}`).toEqual([]);
    }
  }
});

test("round 5: reconnecting clears the old warning (§45.36 E18)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, "TikTok");
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok).toContainText("The TikTok app keys changed. Connect again.");
  await tiktok.getByRole("button", { name: "Connect again" }).click();
  await expect(tiktok.locator(".st-chip").first()).toHaveText("Connected");
  await expect(tiktok).not.toContainText("app keys changed");
});

test("skip from a row asks first, and the skipped platform stays here with Un-skip", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  const x = rowOf(page, "X");
  await x.getByRole("button", { name: "Skip X", exact: true }).click();
  const ask = x.getByRole("group", { name: "Skip X?" });
  await expect(ask).toBeVisible();
  // Keep it is the first answer and has focus.
  await expect(ask.getByRole("button", { name: "Keep it" })).toBeFocused();
  await ask.getByRole("button", { name: "Keep it" }).click();
  await expect(ask).toHaveCount(0);
  await expect(x).toHaveAttribute("data-state", "needs_you");
  await x.getByRole("button", { name: "Skip X", exact: true }).click();
  await x.getByRole("group", { name: "Skip X?" }).getByRole("button", { name: "Skip X" }).click();
  await expect(x).toHaveAttribute("data-state", "skipped");
  await expect(x.locator(".st-chip")).toHaveText("Skipped");
  await expect(page.locator(".st-social-progress h2")).toHaveText("1 of 4 ready");
  await expect(page.locator(".toast").filter({ hasText: "Skipped. You can un-skip it here." })).toBeVisible();
  // Its own page says so, with Un-skip.
  await openRow(page, "X");
  await expect(page.locator(".st-social-one__skipped")).toContainText("You skipped X. You won't post there until you set it up.");
  await page.getByRole("button", { name: "Un-skip X" }).click();
  await expect(page.locator(".st-social-one__skipped")).toHaveCount(0);
  await expect(page.locator(".toast").filter({ hasText: "X is back." })).toBeVisible();
});

test("round 5: on a platform's page the Needs you bar never sends the owner there again; Show me brings the card into view (§45.36 E17)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/stories/ideas");
  await ready(page);
  // Only the account problems are left (no stuck post), so the first thing that needs him is TikTok's sign-in.
  await page.evaluate(() => {
    const store = (window as unknown as { __cfStoriesMock?: { store?: { publishing: { publishingStatus: string }[] } } }).__cfStoriesMock?.store;
    if (store) store.publishing = store.publishing.filter((j) => j.publishingStatus !== "needs_attention" && j.publishingStatus !== "failed");
  });
  await page.waitForTimeout(2100);
  await page.locator(".st-rail .st-rail__item", { hasText: "Dashboard" }).click();
  const bar = page.getByRole("complementary", { name: "Needs you" });
  await expect(bar).toContainText("TikTok");
  // Elsewhere: Fix it opens TikTok's own page on Social accounts.
  await expect(bar.getByRole("link", { name: "Fix it" })).toHaveAttribute("href", "/stories/connections/tiktok");
  // On Social accounts' list: Fix it still opens TikTok's page (the list has rows, its card is on its page).
  await page.locator(".st-rail .st-rail__item", { hasText: "Social accounts" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
  await expect(bar.getByRole("link", { name: "Fix it" })).toHaveAttribute("href", "/stories/connections/tiktok");
  await bar.getByRole("link", { name: "Fix it" }).click();
  await expect(page).toHaveURL(/\/stories\/connections\/tiktok$/);
  await expect(bar).toContainText("below");
  expect(await bar.evaluate((el) => (el as HTMLElement).innerText)).not.toContain("Social accounts");
  await expect(bar.getByRole("link", { name: "Fix it" })).toHaveCount(0);
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok).toBeAttached();
  // (Away from it: with its More fold open the card is long, so at the bottom of the page its top is out of view.)
  await moreOf(tiktok).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => tiktok.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 6000 }).toBeLessThan(0);
  await bar.getByRole("button", { name: "Show me" }).click();
  // (It glides there.)
  await expect.poll(() => tiktok.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 6000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(() => tiktok.evaluate((el) => el.getBoundingClientRect().top < innerHeight / 2), { timeout: 6000 }).toBe(true);
  await expect(tiktok).toBeInViewport();
  await expect(tiktok).toBeFocused();
});
