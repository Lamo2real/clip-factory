// "Write it myself" in Clips Funded, mock mode (docs/CONTRACTS.md §45.46.9): the owner writes the scenes of what
// happens and the video is made from them. The whole flow (a title and a kind, three scenes, "Who is Max?", a caption
// in each, the preview strip, Make the video, the "Your script" chip and step, the scenes and captions kept word for
// word, Review with the words exactly as written and Change my script), a caption change that runs only the caption
// steps, Paste a script with Scene headings, a driving-safety script with full beam in fog (reported as written,
// Approve held, Fix the words opens the scene), and a phone: the pinned Make the video stays reachable and a problem
// brings its field into view. A new file: the last shard runs every file no shard lists. Nothing leaves the machine.
import { expect, test, type Browser, type Page } from "@playwright/test";

type MockStore = {
  knobs: Record<string, unknown>;
  jobs: { contentId: string; createdAt: string; configuration: { run: string[] } }[];
  scripts: Record<string, { scenes: { sceneId: string; caption: string | null }[]; captions: { id: string; text: string }[] }>;
};
type StoriesWindow = Window & { __cfStoriesMock?: { store?: MockStore } };

async function context(browser: Browser, width: number, height: number, touch: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  return ctx;
}

/** Opens a studio page and waits until its data is in. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** The mock's jobs run in about 3 seconds. */
async function quickJobs(page: Page) {
  await page.evaluate(() => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store) store.knobs.jobSeconds = 3;
  });
}

/** Production › New with Write it myself picked, a title and a kind. */
async function writeItMyself(page: Page, title: string, kind: string) {
  await open(page, "/stories/production/new");
  await quickJobs(page);
  await page.locator(".st-s-pick__opt", { hasText: "Write it myself" }).click();
  await expect(page.getByText("You write what happens. Clips Funded draws it.")).toBeVisible();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await page.locator(".st-s-pick__opt", { hasText: kind }).click();
}

const scene = (page: Page, i: number) => page.locator(".st-sc-scene").nth(i);
const whatBox = (page: Page, i: number) => scene(page, i).getByRole("textbox", { name: "What happens" });
const captionBox = (page: Page, i: number) => scene(page, i).getByRole("textbox", { name: "Caption" });

test("Write it myself: three scenes, Who is Max?, a caption, made, reviewed with the words as written, then a caption changed", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await context(browser, 1280, 900, false);
  const page = await ctx.newPage();
  await writeItMyself(page, "Dash learns to juggle", "Funny");

  await whatBox(page, 0).fill("Dash wakes up late in the kitchen.");
  await captionBox(page, 0).fill("Oh no!");
  await whatBox(page, 1).fill("Max drops every ball.");
  await captionBox(page, 1).fill("Whoops…");
  await page.getByRole("button", { name: "+ Add a scene" }).click();
  await expect(whatBox(page, 2)).toBeFocused();
  await whatBox(page, 2).fill("Dash juggles three balls in the park.");
  await captionBox(page, 2).fill("Ta-da! 🎉");

  // Dash came into the cast from the words; Max is asked about, once.
  await expect(page.locator('.st-s-casttile[aria-pressed="true"]', { hasText: "Dash" })).toHaveCount(1);
  const ask = page.getByRole("group", { name: "Who is Max?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "It's Dash", exact: true }).click();
  await expect(ask).toHaveCount(0);

  // The preview: one tile a scene, in order.
  await expect(page.locator(".st-sc-tile")).toHaveCount(3);
  await expect(page.locator(".st-sc-tile").first()).toContainText("Kitchen");
  await expect(page.locator(".st-sc-tile").first()).toContainText("“Oh no!”");
  await expect(page.locator(".st-sc-total")).toHaveText(/^3 scenes · about \d+ seconds · 3 captions$/);

  await page.locator(".st-make").click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  const storyId = page.url().split("/").pop()!;
  await expect(page.locator(".st-sc-chip")).toHaveCount(0); // said once: the first step is "Your script"
  await expect(page.locator(".st-s-track__step").first()).toContainText("Your script");
  await expect(page.locator(".st-s-track__step", { hasText: "Add your words" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Watch it in Review" })).toBeVisible({ timeout: 30_000 });
  // The video was made from the owner's scenes in their order, each caption on screen exactly as typed (cues w_sN).
  const made = await page.evaluate((id) => {
    const script = (window as StoriesWindow).__cfStoriesMock?.store?.scripts[id];
    return { scenes: script?.scenes.map((s) => [s.sceneId, s.caption]), cues: script?.captions.map((c) => [c.id, c.text]) };
  }, storyId);
  expect(made.scenes).toEqual([
    ["s1", null],
    ["s2", null],
    ["s3", null],
  ]);
  expect(made.cues).toEqual([
    ["w_s1", "Oh no!"],
    ["w_s2", "Whoops…"],
    ["w_s3", "Ta-da! 🎉"],
  ]);

  // Review: the words exactly as written, and Change my script in place of Ask for changes.
  await page.getByRole("link", { name: "Watch it in Review" }).click();
  await expect(page).toHaveURL(new RegExp(`/stories/review/${storyId}$`));
  await expect(page.locator(".st-sc-written__words")).toHaveText(["“Oh no!”", "“Whoops…”", "“Ta-da! 🎉”"]);
  await expect(page.getByRole("button", { name: "Ask for changes" })).toHaveCount(0);
  await page.getByRole("button", { name: "Change my script" }).click();
  const sheet = page.getByRole("dialog", { name: "Change my script" });
  await expect(sheet.locator(".st-sc-scene")).toHaveCount(3);
  await sheet.locator(".st-sc-scene").nth(1).getByRole("textbox", { name: "Caption" }).fill("Butterfingers!");
  await sheet.getByRole("button", { name: "Make it again" }).click();
  await expect(page.getByText("Making it again!")).toBeVisible();
  // Only the caption steps run again.
  const run = await page.evaluate((id) => {
    const jobs = ((window as StoriesWindow).__cfStoriesMock?.store?.jobs ?? []).filter((j) => j.contentId === id);
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.configuration.run ?? [];
  }, storyId);
  expect(run).toEqual(["safety", "captions", "assemble", "preview"]);
  await expect(page.locator(".st-sc-written__words")).toHaveText(["“Oh no!”", "“Butterfingers!”", "“Ta-da! 🎉”"], { timeout: 30_000 });
  await ctx.close();
});

test("Paste a script: Scene headings and a Caption: line fill the list, then it is made", async ({ browser }) => {
  test.setTimeout(60_000);
  const ctx = await context(browser, 1280, 900, false);
  const page = await ctx.newPage();
  await writeItMyself(page, "Dash's breakfast", "Everyday skills");
  await page.getByRole("button", { name: "Paste a script" }).click();
  await page.getByRole("textbox", { name: "Your script" }).fill("Scene 1: Dash wakes up.\nCaption: Morning!\nScene 2: Dash eats toast in the kitchen.");
  await page.getByRole("button", { name: "Make scenes" }).click();
  await expect(page.locator(".st-sc-scene")).toHaveCount(2);
  await expect(whatBox(page, 0)).toHaveValue("Dash wakes up.");
  await expect(captionBox(page, 0)).toHaveValue("Morning!");
  await expect(whatBox(page, 1)).toHaveValue("Dash eats toast in the kitchen.");
  await page.locator(".st-make").click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  await ctx.close();
});

test("a driving-safety script with full beam in fog is reported as written, held from Approve, and Fix the words opens the scene", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 900, false);
  const page = await ctx.newPage();
  await writeItMyself(page, "Foggy drive", "Driving safety");
  await whatBox(page, 0).fill("Nana Rose drives into thick fog.");
  await whatBox(page, 1).fill("Nana Rose puts on full beam in the fog.");
  await captionBox(page, 1).fill("Full beam on!");
  await page.locator(".st-make").click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("link", { name: "Check it in Review" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Check it in Review" }).click();
  const facts = page.locator(".st-s-notice", { hasText: "Fix the facts first." });
  await expect(facts).toContainText("Your scene 2");
  await expect(page.locator(".st-sc-written__words")).toHaveText(["“Full beam on!”"]);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "true");
  await facts.getByRole("button", { name: "Fix the words" }).click();
  const sheet = page.getByRole("dialog", { name: "Change my script" });
  await expect(sheet.locator(".st-sc-scene").nth(1).getByRole("textbox", { name: "What happens" })).toBeFocused();
  await expect(sheet.locator(".st-sc-scene").nth(1).getByRole("textbox", { name: "What happens" })).toHaveValue("Nana Rose puts on full beam in the fog.");
  await ctx.close();
});

test("a car in the cast is in every scene whose words say car or drive, on a phone, and the video has the car in each", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 390, 844, true);
  const page = await ctx.newPage();
  await writeItMyself(page, "Foggy drive home", "Funny");
  await quickJobs(page);
  await whatBox(page, 0).fill("Dash gets in Rosso and drives on a foggy road.");
  await whatBox(page, 1).fill("He turns on the dipped headlights and slows down.");
  await page.getByRole("button", { name: "+ Add a scene" }).click();
  await whatBox(page, 2).fill("Dash parks at home safe.");
  // Rosso came in from the words and is ticked in every scene; scene 2 goes on from scene 1 (who and where)
  await expect(page.locator(".st-sc-joined")).toHaveText("Dash and Rosso are in your scenes, so they're ticked already.");
  const tiles = page.locator(".st-sc-tile");
  await expect(tiles).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await expect(tiles.nth(i).locator(".st-sc-tile__who")).toHaveText("Dash, Rosso");
  await expect(tiles.nth(1).locator(".st-sc-tile__place")).toHaveText("Foggy road");
  await expect(page.locator(".st-sc-idle")).toHaveCount(0);
  await expect(page.getByText("30 to 60 seconds works best.")).toHaveCount(0); // the length part: one number
  await page.locator(".st-make").click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  const storyId = page.url().split("/").pop()!;
  await expect(page.getByRole("link", { name: /in Review$/ })).toBeVisible({ timeout: 30_000 });
  const cars = await page.evaluate((id) => {
    const script = (window as StoriesWindow).__cfStoriesMock?.store?.scripts[id] as unknown as { scenes: { props: { kind: string }[] }[] } | undefined;
    return script?.scenes.map((s) => s.props.filter((p) => p.kind === "car").length);
  }, storyId);
  expect(cars).toEqual([1, 1, 1]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await ctx.close();
});

for (const [w, h] of [
  [390, 844],
  [320, 640],
] as const) {
  test(`phone ${w}: the pinned Make the video stays reachable, and a problem brings its field into view`, async ({ browser }) => {
    const ctx = await context(browser, w, h, true);
    const page = await ctx.newPage();
    await open(page, "/stories/production/new");
    await page.locator(".st-s-pick__opt", { hasText: "Write it myself" }).click();
    await expect(page.locator(".st-make")).toBeInViewport();
    await page.locator(".st-make").click();
    await expect(page.locator(".st-s-actionbar--pin .st-s-notice", { hasText: "Give the video a title." })).toBeInViewport();
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    await title.fill("Dash's day");
    await page.locator(".st-s-pick__opt", { hasText: "Funny" }).click();
    await whatBox(page, 0).fill("Dash naps.");
    await page.locator(".st-make").click();
    await expect(page.locator(".st-s-actionbar--pin .st-s-notice", { hasText: "Write at least 2 scenes." })).toBeInViewport();
    await expect(whatBox(page, 1)).toBeFocused();
    await expect(whatBox(page, 1)).toBeInViewport();
    // Nothing on the page is wider than the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await ctx.close();
  });
}
