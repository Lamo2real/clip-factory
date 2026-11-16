import { expect, test } from "@playwright/test";
import { CLIPS, findOverflow, openClip, resolveRoute, ROUTES, settle, WIDTHS } from "./helpers.ts";

// Nothing may run out of its box, at any width from 320px up, on any screen (docs/CONTRACTS.md §11).
for (const width of WIDTHS) {
  test(`no overflow on any screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const paths: string[] = [];
    for (const r of ROUTES) paths.push(await resolveRoute(page, r));

    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await settle(page);
      const result = await findOverflow(page);
      if (result.page > result.viewport) failures.push(`${path}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
      for (const o of result.items) failures.push(`${path}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
    }

    // States that only appear after interaction: the upload form, an open checklist, a long link, a skill's text.
    await page.goto("/");
    await settle(page);
    // Centre each control first so the fixed tab bar never sits on top of it.
    const pick = async (name: string) => {
      const radio = page.getByRole("radio", { name });
      await radio.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await radio.check({ force: true });
    };
    await pick("Upload a video");
    await pick("Exactly");
    let state = await findOverflow(page);
    for (const o of state.items) failures.push(`/ (upload): ${o.selector} "${o.text}"`);
    await pick("Paste a link");
    await page.getByLabel("YouTube, Twitch or Kick link").fill("https://www.youtube.com/watch?v=" + "x".repeat(300));
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/ (long link): ${o.selector} "${o.text}"`);

    await page.goto("/review");
    await settle(page);
    await page.locator(".checklist__summary").first().click();
    await page.getByRole("tab", { name: "X" }).first().click();
    await page.getByRole("button", { name: "Throw away" }).first().click();
    await page.getByRole("button", { name: "Undo" }).waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/review (open, undo toast): ${o.selector} "${o.text}"`);

    await page.goto("/settings/clip-making/skills");
    await settle(page);
    await page.getByRole("button", { name: "View" }).first().click();
    await page.locator(".code").first().waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings skills (skill open): ${o.selector} "${o.text}"`);

    // Find a setting with results, and with nothing found.
    await page.goto("/settings");
    await settle(page);
    await page.getByLabel("Find a setting").fill("sound");
    await page.locator(".find-hit").first().waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings (search results): ${o.selector} "${o.text}"`);
    await page.getByLabel("Find a setting").fill("x".repeat(80));
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings (nothing found): ${o.selector} "${o.text}"`);
    if (state.page > state.viewport) failures.push(`/settings (nothing found): page scrolls sideways`);

    // Sounds: a long pick and a failed Try it with its toast, then off (with the notes and the "Sounds are off" toast).
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    await page.getByRole("button", { name: /^Error sound 28:/ }).click();
    await page.getByRole("switch", { name: "Make it fail" }).click();
    await page.getByRole("button", { name: "Try it: Sign in" }).click();
    await page.getByText("Wrong password. Try again.").waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings sounds (failed try): ${o.selector} "${o.text}"`);
    if (state.page > state.viewport) failures.push(`/settings sounds: page scrolls sideways`);
    await page.getByRole("switch", { name: "Sounds" }).click();
    await page.getByRole("button", { name: "Try it: Sign in" }).click();
    await page.getByText("Sounds are off. Turn them on to hear it.").waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings sounds (off, try): ${o.selector} "${o.text}"`);
    if (state.page > state.viewport) failures.push(`/settings sounds (off): page scrolls sideways`);

    // The update bar with its area pills, then its progress, on top of Home and Settings.
    for (const path of ["/?update=1", "/settings?update=1", "/settings/look-and-feel/sounds?update=1"]) {
      await page.goto(path);
      await settle(page);
      await page.locator(".update-bar").waitFor();
      await page.waitForTimeout(700);
      state = await findOverflow(page);
      for (const o of state.items) failures.push(`${path} (update bar): ${o.selector} "${o.text}"`);
      const bar = await page.locator(".update-bar").boundingBox();
      if (bar && (bar.x < 0 || bar.x + bar.width > width + 0.5)) failures.push(`${path}: update bar leaves the screen`);
      if (state.page > state.viewport) failures.push(`${path}: page scrolls sideways with the update bar`);
    }

    // Get the app: each device's version (Mac download, iPhone steps, Android steps) fits.
    await page.goto("/get-app");
    await settle(page);
    for (const device of ["Mac", "Windows", "iPhone or iPad", "Android"]) {
      await page.getByRole("button", { name: device, exact: true }).click();
      state = await findOverflow(page);
      for (const o of state.items) failures.push(`/get-app (${device}): ${o.selector} "${o.text}"`);
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
}

test("the sign-in screen fits at 320px and 1440px", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"));
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
    expect(result.page).toBeLessThanOrEqual(result.viewport);
  }
});

// The clip performance page (every calm state is on one of the three clips) and This week (§16.11).
for (const width of [320, 375, 600, 768, 1024, 1440]) {
  test(`clip pages and This week fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const failures: string[] = [];
    const check = async (label: string) => {
      const result = await findOverflow(page);
      if (result.page > result.viewport) failures.push(`${label}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
      for (const o of result.items) failures.push(`${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
    };
    for (const hook of Object.values(CLIPS)) {
      await openClip(page, hook);
      await check(`/clips (${hook})`);
    }
    // After a refresh, with its toast and "Next check in" on the button.
    await page.locator(".perf__refresh").click();
    await page.locator(".toast").first().waitFor();
    await check("/clips (after refresh)");

    for (const path of ["/library?view=week", "/library"]) {
      await page.goto(path);
      await settle(page);
      await check(path);
    }
    await page.goto("/library?view=week");
    await settle(page);
    await page.locator(".week-card").first().getByRole("button", { name: "Best this week" }).click();
    await page.getByText("Learning from your picks…").waitFor();
    await check("/library?view=week (learning)");
    await page.locator(".week__quote").waitFor();
    await check("/library?view=week (learned)");
    await page.getByRole("link", { name: "Earlier week" }).click();
    await settle(page);
    await check("/library?view=week (last week)");
    expect(failures, failures.join("\n")).toEqual([]);
  });
}
