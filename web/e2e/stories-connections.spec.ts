import { expect, test, type Page } from "@playwright/test";
import { findOverflow, WIDTHS } from "./helpers.ts";

// Lamo Stories › Social accounts, round 3 (docs/CONTRACTS.md §45.34) in the mock app: both Meta cards show both
// redirect URIs (Instagram's and Facebook's) with Copy buttons, also once the keys are saved; after a connect the
// page says "Connected as {name} ({handle})" and the card asks "Is this your Lamo Stories {place}?" with Yes and
// Pick another; the line after Disconnect follows the app the account used. Lamo Stories is switched on with
// cf.storiesPreview = 1.

async function on(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const cardOf = (page: Page, name: string) => page.locator(".st-conn").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("both Meta cards show both redirect URIs to copy, also once the keys are saved, and nothing overflows", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  for (const name of ["Instagram", "Facebook"]) {
    const card = cardOf(page, name);
    await expect(card.locator(".st-app")).toContainText("Uses its own Meta app");
    await expect(card.locator(".st-copy__value")).toHaveText([/\/v1\/stories-oauth\/instagram\/callback$/, /\/v1\/stories-oauth\/facebook\/callback$/]);
    await expect(card.getByRole("button", { name: "Copy Instagram's redirect URI" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Copy Facebook's redirect URI" })).toBeVisible();
    await expect(card).toContainText("Valid OAuth Redirect URIs");
  }
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
});

test("after a connect: Connected as {name} ({handle}), and the card asks whether it is the Lamo Stories channel", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  const yt = cardOf(page, "YouTube");
  await yt.getByRole("button", { name: "Pick another channel" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clip Factory Stories (@lamostories)." })).toBeVisible();
  const ask = yt.getByRole("group", { name: "Is this your Clip Factory Stories channel?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Clip Factory Stories posts only here, never to Clip Factory's.");
  // Pick another connects again, and asks again.
  await ask.getByRole("button", { name: "Pick another channel" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clip Factory Stories (@lamostories)." }).first()).toBeVisible();
  await expect(yt.getByRole("group", { name: "Is this your Clip Factory Stories channel?" })).toBeVisible();
  await yt.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clip Factory Stories posts to this YouTube channel (Clip Factory Stories)." })).toBeVisible();
  await expect(yt.locator(".st-intended")).toHaveCount(0);
  await expect(page.locator("canvas.confetti").first()).toBeAttached();
});

test("a connect finished by picking the Instagram account from the list asks whether it is the Lamo Stories account", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/stories/connections");
  await ready(page);
  const ig = cardOf(page, "Instagram");
  await ig.locator(".st-choose").getByRole("button", { name: /lamo\.stories/ }).click();
  const ask = ig.getByRole("group", { name: "Is this your Clip Factory Stories account?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Connected as lamo.stories.");
  const o = await findOverflow(page);
  expect(o.page, "@320: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@320").toEqual([]);
  await ask.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clip Factory Stories posts to this Instagram account (lamo.stories)." })).toBeVisible();
  await expect(ig.locator(".st-intended")).toHaveCount(0);
});

test("after Disconnect, an own Meta app gets the Lamo Stories line, Clip Factory's app keeps its own", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  const fb = cardOf(page, "Facebook");
  await fb.getByRole("button", { name: "Connect Facebook" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
  await fb.getByRole("button", { name: /^Clip Factory Stories/ }).click();
  await expect(fb.locator(".st-chip").first()).toHaveText("Connected");
  // Picked from the list: the card asks first whether this is the Lamo Stories Page (§45.34).
  await fb.getByRole("group", { name: "Is this your Clip Factory Stories Page?" }).getByRole("button", { name: "Yes, that's it" }).click();
  await fb.getByRole("button", { name: "Disconnect" }).click();
  await fb.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByText("To remove Clip Factory Stories completely, remove your Clip Factory Stories app in the account's own settings. Clip Factory is not affected.")).toBeVisible();
  await page.getByRole("button", { name: "Hide this note" }).click();
  const yt = cardOf(page, "YouTube");
  await yt.getByRole("button", { name: "Disconnect" }).click();
  await yt.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByText("To remove Clip Factory from this account completely, remove the app in the account's own settings.")).toBeVisible();
});

test("round 4: no Check now while the account is still to be picked, and one toast per pick (§45.35 D21)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  const ig = cardOf(page, "Instagram");
  await expect(ig.locator(".st-choose")).toBeVisible();
  await expect(ig.getByRole("button", { name: /Check now/ })).toHaveCount(0);
  await expect(cardOf(page, "YouTube").getByRole("button", { name: /Check now/ })).toBeVisible();
  // Every toast from here on.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof HTMLElement) for (const t of [n, ...Array.from(n.querySelectorAll(".toast__text"))]) if (t.matches(".toast__text")) w.__toasts.push(t.textContent?.trim() ?? "");
    }).observe(document.body, { childList: true, subtree: true });
  });
  await ig.locator(".st-choose").getByRole("button", { name: /lamo\.stories/ }).click();
  const ask = ig.getByRole("group", { name: "Is this your Clip Factory Stories account?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clip Factory Stories posts to this Instagram account (lamo.stories)." })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).toEqual(["Great! Clip Factory Stories posts to this Instagram account (lamo.stories)."]);
  // Connected now: Check now is back.
  await expect(ig.getByRole("button", { name: /Check now/ })).toBeVisible();
});

test("round 5: one name for the other app, ids and developer words one tap away, cards that flow by their height (§45.36 E13, E14, E18)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  // E13: "Clip Factory" everywhere, never "Lamo Clips".
  const words = await page.locator(".st-connections").evaluate((el) => (el as HTMLElement).innerText);
  expect(words).toContain("Clip Factory");
  expect(words).not.toContain("Lamo Clips");
  // E14: the account's id is not on screen until Technical details is opened; then it is, one tap away.
  const yt = cardOf(page, "YouTube");
  await expect(yt.locator(".st-who__id")).toBeHidden();
  await yt.locator(".st-who").getByText("Technical details").click();
  await expect(yt.locator(".st-who__id code")).toBeVisible();
  await expect(yt.locator(".st-who__id code")).toHaveText(/^UC/);
  // The Meta card's first lines say what to do in plain words; Facebook Login's own words are folded.
  const insta = cardOf(page, "Instagram");
  await expect(insta.getByText("Copy these two addresses into your Meta app's settings", { exact: false })).toBeVisible();
  await expect(insta.getByText("Valid OAuth Redirect URIs", { exact: false })).toBeHidden();
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok.getByText("Sandbox", { exact: false })).toBeHidden();
  // E18: in each column every card starts right under the one above it (16 px apart), never under an empty area.
  const boxes = await page.locator(".st-conns > .st-conn").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), top: r.top, bottom: r.bottom })));
  const columns = new Map<number, { top: number; bottom: number }[]>();
  for (const b of boxes) columns.set(b.x, [...(columns.get(b.x) ?? []), b]);
  expect(columns.size, "the cards sit in more than one column at 1440").toBeGreaterThan(1);
  for (const col of columns.values()) {
    col.sort((a, b) => a.top - b.top);
    for (let i = 1; i < col.length; i++) expect(col[i]!.top - col[i - 1]!.bottom, "the gap above a card").toBeLessThanOrEqual(17);
  }
  // Each card went into the shortest column: the empty area under the shortest column is never taller than the last
  // card of the tallest one (that card could not have gone anywhere shorter). Before, Instagram stood alone 721 px short.
  const ends = [...columns.values()].map((col) => ({ bottom: col.at(-1)!.bottom, last: col.at(-1)!.bottom - col.at(-1)!.top }));
  const tallest = ends.reduce((a, b) => (b.bottom > a.bottom ? b : a));
  const shortest = Math.min(...ends.map((e) => e.bottom));
  expect(tallest.bottom - shortest, "the empty area under the shortest column").toBeLessThanOrEqual(tallest.last + 16);
  expect(tallest.bottom - shortest, "less empty than the columns left before").toBeLessThan(700);
  for (const width of [320, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
});

test("round 5: a card that grows never moves another card to another column (§45.36 E18)", async ({ page }) => {
  await on(page);
  for (const width of [1100, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/stories/connections");
    await ready(page);
    const xs = () => page.locator(".st-conns > .st-conn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
    const before = await xs();
    for (const [name, button] of [
      ["YouTube", "Change app"],
      ["TikTok", "Change app"],
      ["Instagram", "New keys"],
      ["X", "Change app"],
    ] as const) {
      const card = cardOf(page, name);
      await card.getByRole("button", { name: button, exact: true }).click();
      await page.waitForTimeout(250);
      expect(await xs(), `@${width}: Change app on ${name}`).toEqual(before);
      // Every card still starts right under the one above it in its column.
      const boxes = await page.locator(".st-conns > .st-conn").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), top: r.top, bottom: r.bottom })));
      for (const x of new Set(boxes.map((b) => b.x))) {
        const col = boxes.filter((b) => b.x === x).sort((a, b) => a.top - b.top);
        for (let i = 1; i < col.length; i++) expect(col[i]!.top - col[i - 1]!.bottom, `@${width}: the gap above a card after ${name} grew`).toBeLessThanOrEqual(17);
      }
      await page.goto("/stories/connections");
      await ready(page);
    }
  }
});

test("round 5: reconnecting clears the old warning (§45.36 E18)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok).toContainText("The TikTok app keys changed. Connect again.");
  await tiktok.getByRole("button", { name: "Reconnect" }).click();
  await expect(tiktok.locator(".st-chip").first()).toHaveText("Connected");
  await expect(tiktok).not.toContainText("app keys changed");
});

test("round 5: on Social accounts the Needs you bar never sends the owner there again; Show me brings the card into view (§45.36 E17)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 720 });
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
  // Elsewhere: Fix it opens Social accounts.
  await expect(bar.getByRole("link", { name: "Fix it" })).toHaveAttribute("href", "/stories/connections");
  await page.locator(".st-rail .st-rail__item", { hasText: "Social accounts" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
  await expect(bar).toContainText("below");
  expect(await bar.evaluate((el) => (el as HTMLElement).innerText)).not.toContain("Social accounts");
  await expect(bar.getByRole("link", { name: "Fix it" })).toHaveCount(0);
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok).toBeAttached();
  // (Away from it: TikTok's card is at the top of its column now, so the page goes to the bottom.)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(tiktok).not.toBeInViewport();
  await bar.getByRole("button", { name: "Show me" }).click();
  // (It glides there.)
  await expect.poll(() => tiktok.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 6000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(() => tiktok.evaluate((el) => el.getBoundingClientRect().top < innerHeight / 2), { timeout: 6000 }).toBe(true);
  await expect(tiktok).toBeInViewport();
  await expect(tiktok).toBeFocused();
});
