import { expect, test, type Page } from "@playwright/test";
import { findOverflow } from "./helpers.ts";

// Lamo Stories › Set up Lamo Stories, steps 1 and 2 (docs/CONTRACTS.md §45.34) in the mock app: Check models in
// step 1 ticks it, and step 2 starts from the models' fresh states (a model that just answered says so), never the
// ones loaded before the check. Lamo Stories is switched on with cf.storiesPreview = 1; the mock's `fresh` knob is a
// brand-new studio.

async function fresh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
  });
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test("after Check models in step 1, step 2 starts from the models' fresh states", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/setup");
  await ready(page);
  await expect(page.locator("#st-setup-step")).toHaveText("Set up the AI");
  const sonnet = page.locator(".st-setup__model").filter({ hasText: "Claude Sonnet 5.5" });
  await expect(sonnet).toContainText("Not checked yet");
  await page.getByRole("button", { name: "Check models" }).click();
  await expect(page.locator(".toast").filter({ hasText: "5 of 6 models answered." })).toBeVisible({ timeout: 10_000 });
  await expect(sonnet).toContainText("Works");
  await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "1 of 11 done");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("#st-setup-step")).toHaveText("Pick your default model");
  const radio = page.getByRole("radiogroup", { name: "Clips Funded's default model" }).getByRole("radio", { name: /Claude Sonnet 5.5/ });
  await expect(radio).toContainText("Works: it answered.");
  await expect(radio).not.toContainText("Not checked yet");
  const o = await findOverflow(page);
  expect(o.page, "the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items).toEqual([]);
});

test("round 4: step 4 says the built-in animator makes tall, square or wide videos; a platform that is Lamo Clips' own says why (§45.35 D11, D21)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/setup");
  await ready(page);
  await page.getByRole("navigation", { name: "Setup steps" }).getByRole("button", { name: /Pick how videos are made/ }).click();
  const builtin = page.getByRole("radiogroup", { name: "How videos are made" }).getByRole("radio", { name: /^Built-in animation/ });
  await expect(builtin).toContainText("On. Cartoons drawn right here, tall, square or wide, 30 frames a second.");
  await expect(builtin).not.toContainText("9:16");
  // The seed's X account is Lamo Clips' own: the step stays to do, and What is left says why in the server's words.
  const why = page.locator(".st-left__why");
  await expect(why).toContainText("This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(250);
  const o = await findOverflow(page);
  expect(o.page).toBeLessThanOrEqual(o.viewport);
  expect(o.items).toEqual([]);
});

test("round 5: after Finish with steps skipped, the dashboard keeps what is left, and Settings opens the setup again (§45.36 E15)", async ({ page }) => {
  // The owner, 24 Nov: "if i skip on a platform setup then i dont want to see it anywhere except in settings or
  // social accounts tab". A platform skipped says Skipped and leaves every count and list; a step of another kind
  // skipped says Later and stays on what is left.
  test.setTimeout(120_000);
  await fresh(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/setup");
  await ready(page);
  const ring = page.locator(".st-setup__head .st-ring");
  const foot = page.locator(".st-setup__foot");
  const step = page.locator("#st-setup-step");
  // a step by its own name (a done step also says "(done)" for screen readers, so "Done" alone would match it)
  const item = (name: string) => page.locator(".st-steps__item").filter({ has: page.locator(".st-steps__label").getByText(name, { exact: true }) });
  const rail = page.getByRole("navigation", { name: "Clips Funded" });
  // 1 to 3: the AI, its default model and its default effort.
  await expect(step).toHaveText("Set up the AI");
  await page.getByRole("button", { name: "These look right" }).click();
  await expect(ring).toHaveAttribute("aria-label", "1 of 11 done");
  await expect(step).toHaveText("Pick your default model");
  await page.getByRole("radio", { name: /Claude Fable 5.2/ }).click();
  await page.getByRole("button", { name: "Use Claude Fable 5.2" }).click();
  await expect(ring).toHaveAttribute("aria-label", "2 of 11 done");
  await expect(step).toHaveText("Pick your default effort");
  await page.getByRole("radio", { name: "Maximum" }).click();
  await page.getByRole("button", { name: "Use Maximum" }).click();
  await expect(ring).toHaveAttribute("aria-label", "3 of 11 done");
  // 4: skipped for later: it says Later and still counts.
  await expect(step).toHaveText("Pick how videos are made");
  await foot.getByRole("button", { name: "Skip for now" }).click();
  await expect(item("Pick how videos are made")).toContainText("Later");
  await expect(ring).toHaveAttribute("aria-label", "3 of 11 done");
  // 5: the agents.
  await expect(step).toHaveText("Meet your agents and skills");
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(ring).toHaveAttribute("aria-label", "4 of 11 done");
  // 6 to 10: every platform skipped: each says Skipped and leaves the count.
  let total = 11;
  for (const name of ["Instagram", "TikTok", "YouTube", "Facebook", "X"]) {
    await expect(step).toHaveText(`Connect ${name}`);
    await foot.getByRole("button", { name: "Skip for now" }).click();
    total -= 1;
    await expect(item(`Connect ${name}`)).toContainText("Skipped");
    await expect(item(`Connect ${name}`)).not.toContainText("Later");
    await expect(ring).toHaveAttribute("aria-label", `4 of ${total} done`);
    if (name === "Instagram") await expect(page.locator(".toast").filter({ hasText: "Skipped. It stays in Social accounts." }).first()).toBeVisible();
  }
  // A skipped platform's own step offers Un-skip instead of Skip for now.
  await item("Connect X").click();
  await expect(page.locator(".st-setup__count .st-chip")).toHaveText("Skipped");
  await expect(foot.getByRole("button", { name: "Un-skip" })).toBeVisible();
  await expect(foot.getByRole("button", { name: "Skip for now" })).toHaveCount(0);
  // 11: Finish, with only the step skipped for later left.
  await item("Done").click();
  await expect(step).toHaveText("Done");
  await expect(page.locator(".st-setup__done")).toContainText("One thing is left");
  await foot.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/stories$/, { timeout: 8000 });
  await ready(page);
  // The dashboard keeps only that step: no Connect step, and no count of places that were all skipped.
  const left = page.locator(".st-setupcard--left");
  await expect(left).toBeVisible();
  await expect(left.getByRole("heading", { level: 2 })).toHaveText("Finish setting up: 1 left");
  await expect(left.locator(".st-setupcard__list li")).toHaveText(["Pick how videos are made"]);
  await expect(page.locator(".st-dash")).not.toContainText(/Connect (Instagram|TikTok|YouTube|Facebook|X)\b/);
  const accounts = page.locator(".st-tile").filter({ hasText: "Connected accounts" });
  await expect(accounts).toContainText("Nothing to connect.");
  await expect(accounts.locator(".st-accounts__row")).toHaveCount(0);
  await expect(left.getByRole("link", { name: "Open setup" })).toHaveAttribute("href", "/stories/setup");
  // Settings agrees, and always has the way back (the same page load: the pretend server keeps what was done).
  await rail.getByRole("link", { name: "Settings", exact: true }).click();
  await ready(page);
  await expect(page.locator(".st-stg-head__setup-left")).toHaveText("1 step left");
  await page.getByRole("link", { name: "Open setup again" }).click();
  await expect(page).toHaveURL(/\/stories\/setup$/);
  await ready(page);
  // It opens on the step skipped for later, never on a skipped platform. Doing it leaves nothing.
  await expect(step).toHaveText("Pick how videos are made");
  await page.getByRole("button", { name: "Use this" }).click();
  await expect(ring).toHaveAttribute("aria-label", "6 of 6 done");
  await rail.getByRole("link", { name: "Dashboard", exact: true }).click();
  await ready(page);
  await expect(page.locator(".st-dash")).toBeVisible();
  await expect(page.locator(".st-setupcard")).toHaveCount(0);
  await rail.getByRole("link", { name: "Settings", exact: true }).click();
  await ready(page);
  await expect(page.getByRole("link", { name: "Open setup again" })).toBeVisible();
  await expect(page.locator(".st-stg-head__setup-left")).toHaveCount(0);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/stories");
    await ready(page);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
});
