import { expect, test } from "@playwright/test";
import { animationsDone, CLIPS, findOverflow, openClip, resolveRoute, ROUTES, settle, SETUP_ROUTES, WIDTHS } from "./helpers.ts";

const SKILL_PAGES = { written: "01JZ8S00000000000000000001", zip: "01JZ8S00000000000000000002", tricky: "01JZ8S00000000000000000003" };

// Nothing may run out of its box, at any width from 320px up, on any screen (docs/CONTRACTS.md §11).
for (const width of WIDTHS) {
  test(`no overflow on any screen at ${width}px`, async ({ page }) => {
    // A long walk through many screens: on CI's machines the widest sizes take close to 2 minutes, so the
    // usual 2-minute limit would cut a passing run short.
    test.setTimeout(300_000);
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
    await pick("Pick a video");
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

    // A skill's page with tricky text (raw HTML, long lines), and the delete sheet over it.
    await page.goto(`/settings/clip-making/skills/${SKILL_PAGES.tricky}`);
    await settle(page);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").waitFor();
    state = await findOverflow(page);
    for (const o of state.items) failures.push(`/settings skill (delete sheet): ${o.selector} "${o.text}"`);

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
    // The "no" shake moves the button 6 px for 320 ms; measure once it has stopped, not mid-shake.
    await page.waitForFunction(() => !document.getAnimations().some((x) => (x as CSSAnimation).animationName === "try-shake" && x.playState === "running"));
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
      await animationsDone(page); // the bar slides in
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
      // The panel's entrance and the paper plane's flight are over first (the plane flies out of its box on purpose).
      await animationsDone(page);
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

// The Skills branch and its pages (§18.7): list, write, a skill (with its markdown), its edit form, at every size.
for (const width of [320, 375, 600, 768, 1024, 1440, 1920]) {
  test(`skills pages fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const failures: string[] = [];
    const check = async (label: string) => {
      const result = await findOverflow(page);
      if (result.page > result.viewport) failures.push(`${label}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
      for (const o of result.items) failures.push(`${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
    };
    const base = "/settings/clip-making/skills";
    for (const path of [
      base,
      `${base}/new`,
      `${base}/${SKILL_PAGES.written}`,
      `${base}/${SKILL_PAGES.zip}`,
      `${base}/${SKILL_PAGES.tricky}`,
      `${base}/builtin-short-form-video-playbook`,
      `${base}/${SKILL_PAGES.written}/edit`,
      `${base}/${SKILL_PAGES.zip}/edit`,
      `${base}/nope`,
    ]) {
      await page.goto(path);
      await settle(page);
      await check(path);
    }
    // Long unbroken words in every field, with their counters and hints.
    await page.goto(`${base}/new`);
    await settle(page);
    await page.getByLabel("What is the skill called?").fill("W".repeat(70));
    await page.getByLabel("When should Clip Factory use it?").fill("x".repeat(400));
    await page.getByLabel("What should it do?").fill("https://example.com/" + "y".repeat(600));
    await page.getByRole("button", { name: "Save skill" }).click();
    await check(`${base}/new (long words, errors)`);
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

// The posting setup (docs/CONTRACTS.md §17.12): every platform page with a step open, a wrong key, the account
// picker, a connected platform with "When it's done", a result card, and the Post to TikTok sheet.
type SetupKnobs = { finish(p: string): void; askToChoose(p: string): void; setAudit(a: boolean): void };
for (const width of WIDTHS) {
  test(`the posting setup and the TikTok sheet fit at ${width}px`, async ({ page }) => {
    // A long walk through many screens: on CI's machines the widest sizes take close to 2 minutes, so the
    // usual 2-minute limit would cut a passing run short.
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    const failures: string[] = [];
    const check = async (label: string) => {
      const result = await findOverflow(page);
      if (result.page > result.viewport) failures.push(`${label}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
      for (const o of result.items) failures.push(`${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
    };
    for (const path of SETUP_ROUTES) {
      await page.goto(path);
      await settle(page);
      // Open every step, so every Copy chip, hint and box is measured.
      const ids = await page.locator("[data-step]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step!));
      for (const id of ids) {
        const head = page.locator(`[data-step='${id}'] .gstep__head`);
        if ((await head.getAttribute("aria-expanded")) === "false") {
          await head.evaluate((el) => el.scrollIntoView({ block: "center" }));
          await head.click();
        }
      }
      await check(`${path} (all steps open)`);
    }
    await page.goto("/settings/posting/setup/instagram");
    await settle(page);
    await page.locator("[data-step='key-paste'] .gstep__head").click();
    await page.getByLabel("App secret", { exact: true }).fill("not-a-secret-at-all-" + "x".repeat(60));
    await check("instagram (wrong key)");
    await page.evaluate(() => {
      const s = (window as unknown as { __cfMock: { setup: SetupKnobs } }).__cfMock.setup;
      s.askToChoose("instagram");
      s.finish("youtube");
      s.finish("x");
      s.finish("tiktok");
      s.setAudit(true);
    });
    await page.reload();
    await settle(page);
    await page.locator(".choose").waitFor();
    await check("instagram (pick an account)");
    for (const path of ["/settings/posting/setup/youtube", "/settings/posting/setup/x#x-cost", "/settings/posting/setup/facebook?result=no_pages"]) {
      await page.goto(path);
      await settle(page);
      await check(`${path} (connected or result)`);
    }
    await page.goto("/settings/posting/setup");
    await settle(page);
    await check("/settings/posting/setup (3 ready)");
    await page.goto("/");
    await settle(page);
    await check("/ (setup list)");

    await page.goto("/review");
    await settle(page);
    const keep = page.locator(".review-card").first().getByRole("button", { name: "Keep", exact: true });
    await keep.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await keep.click();
    const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
    await sheet.getByLabel("Who can see it").waitFor();
    await sheet.getByRole("switch", { name: "Commercial content" }).click();
    await sheet.getByRole("checkbox", { name: /^Branded content/ }).check();
    await check("/review (Post to TikTok sheet)");
    const box = await sheet.boundingBox();
    if (box && (box.x < 0 || box.x + box.width > width + 0.5)) failures.push("/review: the TikTok sheet leaves the screen");
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

// Ask Clip Factory's panel (docs/CONTRACTS.md §19.11): open, with an answer, at every width it must fit.
for (const width of [320, 375, 768, 1024, 1440, 1920]) {
  test(`the Ask Clip Factory panel fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?update=1");
    await settle(page);
    // This checks the panel, not the launcher: at some widths the launcher has stepped aside from a control under it
    // (Home's "Working now" card, §19.8 dodge), so it is pressed directly.
    await page.getByRole("button", { name: "Ask Clip Factory" }).dispatchEvent("click");
    const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
    const failures: string[] = [];
    const check = async (label: string) => {
      const result = await findOverflow(page);
      if (result.page > result.viewport) failures.push(`${label}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
      for (const o of result.items) failures.push(`${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
      const box = (await panel.boundingBox())!;
      if (box.x < 0 || box.x + box.width > width + 0.5) failures.push(`${label}: the panel leaves the screen`);
    };
    await check("empty");
    const box = panel.getByLabel("Your question");
    await box.fill("How many views did my best clip get this week?");
    await box.press("Enter");
    await panel.locator(".help-actions").last().waitFor();
    await box.fill("x".repeat(260));
    await check("answer and a long question");
    // Five lines: the field stops at four and scrolls; the paper plane stays inside its right end.
    await box.fill("one\ntwo\nthree\nfour\nfive");
    await check("a five-line question");
    await animationsDone(page);
    const field = (await box.boundingBox())!;
    const plane = (await panel.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
    const whole = (await panel.boundingBox())!;
    if (field.width < whole.width - 24) failures.push(`the field is not full width (${field.width} of ${whole.width})`);
    if (plane.x + plane.width > field.x + field.width || plane.y + plane.height > field.y + field.height)
      failures.push("the paper plane leaves the field");
    expect(failures, failures.join("\n")).toEqual([]);
  });
}
