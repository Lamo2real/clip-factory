import { expect, test, type Page } from "@playwright/test";
import { findOverflow, WIDTHS } from "./helpers.ts";

// Lamo Stories › Social accounts, round 3 (docs/CONTRACTS.md §45.34) in the mock app: both Meta cards show both
// redirect URIs (Instagram's and Facebook's) with Copy buttons, also once the keys are saved; after a connect the
// page says "Connected as {name} ({handle})" and the card asks "Is this your Lamo Stories {place}?" with Yes and
// Pick another; the line after Disconnect follows the app the account used. Less text (the owner, 23 Nov): each card
// shows its safety line, its account and one main button; the rest is in one More fold (opened here where a test needs
// what is in it). Lamo Stories is switched on with cf.storiesPreview = 1.

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
/** A card's one More fold (its line). */
const moreOf = (card: ReturnType<typeof cardOf>) => card.locator(".st-conn__more > summary");

test("less text: each card shows its safety line, its account and one main button; More opens with the keyboard", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) {
    const card = cardOf(page, name);
    await expect(card.locator(".st-conn__new")).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
    await expect(card.locator(":scope > details")).toHaveCount(1);
    await expect(card.locator(".st-conn__more")).not.toHaveAttribute("open", "");
    expect(await card.locator(".st-btn--main:visible").count(), name).toBeLessThanOrEqual(1);
    await expect(card.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  }
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

test("less text, a brand-new studio: each fold stays closed, its line says to set up the app first, and Connect opens it", async ({ page }) => {
  await on(page);
  await page.addInitScript(() => ((window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/connections");
  await ready(page);
  for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) {
    const card = cardOf(page, name);
    await expect(card.locator(".st-conn__more")).not.toHaveAttribute("open", "");
    await expect(moreOf(card)).toHaveText(`First, set up the app for ${name}`);
  }
  const yt = cardOf(page, "YouTube");
  await expect(yt.getByRole("radiogroup", { name: "Which YouTube app Clips Funded uses" })).toBeHidden();
  // aria-disabled, so force; centred first, so the phone's tab bar is not the thing under the tap.
  const connect = yt.getByRole("button", { name: "Connect YouTube" });
  await connect.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await connect.click({ force: true });
  await expect(page.locator(".toast").filter({ hasText: "Pick which YouTube app Clips Funded uses first." })).toBeVisible();
  await expect(yt.getByRole("radiogroup", { name: "Which YouTube app Clips Funded uses" })).toBeVisible();
  const o = await findOverflow(page);
  expect(o.page, "@390: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items, "@390").toEqual([]);
});

test("both Meta cards show both redirect URIs to copy, also once the keys are saved, and nothing overflows", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  for (const name of ["Instagram", "Facebook"]) {
    const card = cardOf(page, name);
    await moreOf(card).click();
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
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clips Funded (@fundedclips)." })).toBeVisible();
  const ask = yt.getByRole("group", { name: "Is this your Clips Funded channel?" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Is this your Clips Funded channel?");
  // Pick another connects again, and asks again.
  await ask.getByRole("button", { name: "Pick another channel" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Connected as Clips Funded (@fundedclips)." }).first()).toBeVisible();
  await expect(yt.getByRole("group", { name: "Is this your Clips Funded channel?" })).toBeVisible();
  await yt.getByRole("button", { name: "Yes, that's it" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Great! Clips Funded posts to this YouTube channel (Clips Funded)." })).toBeVisible();
  await expect(yt.locator(".st-intended")).toHaveCount(0);
  await expect(page.locator("canvas.confetti").first()).toBeAttached();
});

test("a connect finished by picking the Instagram account from the list asks whether it is the Lamo Stories account", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/stories/connections");
  await ready(page);
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
  const fb = cardOf(page, "Facebook");
  await fb.getByRole("button", { name: "Connect Facebook" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
  await fb.getByRole("button", { name: /^Clips Funded/ }).click();
  await expect(fb.locator(".st-chip").first()).toHaveText("Connected");
  // Picked from the list: the card asks first whether this is the Lamo Stories Page (§45.34).
  await fb.getByRole("group", { name: "Is this your Clips Funded Page?" }).getByRole("button", { name: "Yes, that's it" }).click();
  await moreOf(fb).click();
  await fb.getByRole("button", { name: "Disconnect" }).click();
  await fb.getByRole("button", { name: "Yes, disconnect" }).click();
  await expect(page.getByText("To remove Clips Funded completely, remove your Clips Funded app in the account's own settings. Clip Factory is not affected.")).toBeVisible();
  await page.getByRole("button", { name: "Hide this note" }).click();
  const yt = cardOf(page, "YouTube");
  await moreOf(yt).click();
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
  // (Check now is in each card's More fold.)
  await moreOf(ig).click();
  await expect(ig.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(ig.getByRole("button", { name: /Check now/ })).toHaveCount(0);
  await moreOf(cardOf(page, "YouTube")).click();
  await expect(cardOf(page, "YouTube").getByRole("button", { name: /Check now/ })).toBeVisible();
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

test("round 5: one name for the other app, ids and developer words one tap away, cards that flow by their height (§45.36 E13, E14, E18)", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories/connections");
  await ready(page);
  // E13: "Clip Factory" everywhere, never "Lamo Clips".
  const words = await page.locator(".st-connections").evaluate((el) => (el as HTMLElement).innerText);
  expect(words).toContain("Clip Factory");
  expect(words).not.toContain("Lamo Clips");
  // E18: in each column every card starts right under the one above it (16 px apart), never under an empty area and
  // never over the card above it.
  const columnsNow = async () => {
    const boxes = await page.locator(".st-conns > .st-conn").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), top: r.top, bottom: r.bottom })));
    const columns = new Map<number, { top: number; bottom: number }[]>();
    for (const b of boxes) columns.set(b.x, [...(columns.get(b.x) ?? []), b]);
    for (const col of columns.values()) col.sort((a, b) => a.top - b.top);
    return [...columns.values()];
  };
  const gapsOf = (columns: { top: number; bottom: number }[][]) => columns.flatMap((col) => col.slice(1).map((c, i) => c.top - col[i]!.bottom));
  /** The E18 checks on the cards as they are now; returns the empty area under the shortest column. */
  const flowsByHeight = async (when: string) => {
    const columns = await columnsNow();
    expect(columns.length, `${when}: the cards sit in more than one column at 1440`).toBeGreaterThan(1);
    for (const gap of gapsOf(columns)) {
      expect(gap, `${when}: the gap above a card`).toBeLessThanOrEqual(17);
      expect(gap, `${when}: a card never over the one above it`).toBeGreaterThanOrEqual(15);
    }
    // Each card went into the shortest column: the empty area under the shortest column is never taller than the last
    // card of the tallest one (that card could not have gone anywhere shorter).
    const ends = columns.map((col) => ({ bottom: col.at(-1)!.bottom, last: col.at(-1)!.bottom - col.at(-1)!.top }));
    const tallest = ends.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    const shortest = Math.min(...ends.map((e) => e.bottom));
    expect(tallest.bottom - shortest, `${when}: the empty area under the shortest column`).toBeLessThanOrEqual(tallest.last + 16);
    return tallest.bottom - shortest;
  };
  // The deal itself, as the page dealt the cards: less empty than before, when Instagram stood alone 721 px short.
  // Measured before E14 below opens YouTube's More fold: that card then grows and keeps its column
  // by design (the next test), so the empty area grows by as much. Measured after it, this check raced the page's next
  // frame: it held only while the cards under the grown one were not laid out again yet, which a page busy with Clip
  // Factory's hidden backdrop still drifting under Clips Funded made likely; settled, the same layout leaves 724 px.
  // (Measured once the cards' rise-in has ended, so no card is caught on its way up.)
  await page.locator(".st-conns > .st-conn").evaluateAll((els) => Promise.all(els.flatMap((e) => e.getAnimations()).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  expect(await flowsByHeight("as dealt"), "less empty than the columns left before").toBeLessThan(700);
  // E14: the account's id is not on screen until the card's More fold is opened; then it is, one tap away.
  const yt = cardOf(page, "YouTube");
  await expect(yt.locator(".st-who__id")).toBeHidden();
  await moreOf(yt).click();
  await expect(yt.locator(".st-who__id code")).toBeVisible();
  await expect(yt.locator(".st-who__id code")).toHaveText(/^UC/);
  // The Meta card's More fold says what to do in plain words first; Facebook Login's own words are folded again.
  const insta = cardOf(page, "Instagram");
  await expect(insta.getByText("Copy these two addresses into your Meta app's settings", { exact: false })).toBeHidden();
  await moreOf(insta).click();
  await expect(insta.getByText("Copy these two addresses into your Meta app's settings", { exact: false })).toBeVisible();
  await expect(insta.getByText("Valid OAuth Redirect URIs", { exact: false })).toBeHidden();
  const tiktok = cardOf(page, "TikTok");
  await expect(tiktok.getByText("Sandbox", { exact: false })).toBeHidden();
  // YouTube's and Instagram's cards have grown: the cards under them move down with them (never left under them), and
  // E18 holds again.
  await expect.poll(async () => Math.min(...gapsOf(await columnsNow())), { message: "the cards under the grown cards move down with them" }).toBeGreaterThanOrEqual(15);
  await flowsByHeight("after YouTube's and Instagram's cards grew");
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
      // (Change app is in the card's More fold: opening it grows the card too.)
      await moreOf(card).click();
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
  // (Away from it: TikTok's card is at the top of its column now, so the page goes to the bottom. The cards are short
  // with their More folds closed: opened, they make the page long enough to leave TikTok's card behind.)
  for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) await moreOf(cardOf(page, name)).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(tiktok).not.toBeInViewport();
  await bar.getByRole("button", { name: "Show me" }).click();
  // (It glides there.)
  await expect.poll(() => tiktok.evaluate((el) => Math.round(el.getBoundingClientRect().top)), { timeout: 6000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(() => tiktok.evaluate((el) => el.getBoundingClientRect().top < innerHeight / 2), { timeout: 6000 }).toBe(true);
  await expect(tiktok).toBeInViewport();
  await expect(tiktok).toBeFocused();
});
