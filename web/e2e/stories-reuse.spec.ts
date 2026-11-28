// Clips Funded › Use it again (docs/CONTRACTS.md §45.52), in mock mode. The owner's words of 27 Nov: "pick any
// previously uploaded video, open its complete setup, edit any of it, and then render and upload it as a new video.
// The original stays unchanged." The flow, end to end on the published seed video "The sandwich tower":
// * Production's Made row has Use it again; one tap opens Make a new video on a new draft;
// * the form holds the video's setup: Write it myself with its scenes in order, its cast, its length and music;
// * the owner changes scene 1 and adds a vehicle, makes the video, approves it and posts it (Posted!);
// * the new video has the changed script and the vehicle; the video it came from is exactly as it was.
// Clips Funded is switched on with cf.storiesPreview = 1; nothing leaves the machine.
import { expect, test, type Page } from "@playwright/test";

const PUBLISHED = "01JSTST0000000000000000004";
const ROSSO = "01JSTCH0000000000000000005";

type Story = { storyId: string; title: string; status: string; characterIds: string[]; scriptVersion: number; version: number; seriesId?: string; ownScript?: { scenes: { what: string; caption?: string | null }[] } };
type MockWindow = Window & {
  __cfStoriesMock?: {
    knobs?: Record<string, unknown>;
    store?: { knobs: Record<string, unknown>; stories: Story[]; drafts: { draftId: string; name: string }[]; social: { connectionStatus: string; accountName: string | null; platform: string }[] };
  };
};

async function settle(page: Page) {
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
}

const stories = (page: Page) => page.evaluate(() => structuredClone((window as MockWindow).__cfStoriesMock!.store!.stories));

for (const [w, h, touch] of [
  [390, 844, true],
  [1280, 800, false],
] as const)
  test(`use a posted video again: its setup opens as a new draft, edited, made and posted; the old one is unchanged (${w})`, async ({ browser }) => {
    test.setTimeout(150_000);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    await ctx.addInitScript(() => {
      localStorage.setItem("cf.storiesPreview", "1");
      (window as MockWindow).__cfStoriesMock = { knobs: { jobSeconds: 3, publishMs: 300 } };
    });
    const page = await ctx.newPage();
    await page.goto("/stories/production");
    await settle(page);
    const before = (await stories(page)).find((s) => s.storyId === PUBLISHED)!;
    expect(before.status).toBe("published");

    // 1. Use it again, from the Made row.
    const row = page.locator(".st-s-run", { hasText: before.title }).filter({ has: page.getByRole("button", { name: `Use it again: ${before.title}` }) });
    await row.getByRole("button", { name: `Use it again: ${before.title}` }).click();
    await expect(page).toHaveURL(/\/stories\/production\/new\?draft=[0-9A-Z]{26}$/);
    await settle(page);
    await expect(page.getByText("Copied. Change what you like.")).toBeVisible();

    // 2. The whole setup is there: Write it myself, the scenes in order, the next title, the same cast.
    await expect(page.getByRole("radiogroup", { name: "Where the idea comes from" }).getByRole("radio", { name: "Write it myself" })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(`${before.title} 2`);
    const what = page.locator(".st-sc-scene").getByRole("textbox", { name: "What happens" });
    const n = await what.count();
    expect(n).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < n; i++) expect((await what.nth(i).inputValue()).trim().length).toBeGreaterThan(0);
    for (const id of before.characterIds) {
      const name = await page.evaluate((cid) => (window as unknown as { __cfStoriesMock: { store: { characters: { characterId: string; name: string }[] } } }).__cfStoriesMock.store.characters.find((c) => c.characterId === cid)?.name, id);
      await expect(page.locator('.st-s-casttile[aria-pressed="true"]', { hasText: name! }).first()).toBeVisible();
    }

    // 3. Change the script a little and bring a vehicle in.
    await what.first().fill("Pip and Dash drive Rosso to the sandwich shop.");
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: "Rosso" }).click();
    await expect(page.locator('.st-cast__cars .st-s-casttile[aria-pressed="true"]', { hasText: "Rosso" })).toHaveCount(1);

    // 4. Make it, approve it, post it.
    await page.locator(".st-make").click();
    await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/, { timeout: 20_000 });
    const newId = page.url().split("/").pop()!;
    expect(newId).not.toBe(PUBLISHED);
    await expect(page.getByRole("link", { name: "Watch it in Review" })).toBeVisible({ timeout: 40_000 });
    await page.getByRole("link", { name: "Watch it in Review" }).click();
    await settle(page);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator(".st-s-head__lede")).toContainText("Approved");
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Post it" });
    await sheet.locator("button.st-s-place").first().click();
    await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
    await expect(page.getByRole("dialog", { name: "Posted!" })).toBeVisible({ timeout: 30_000 });

    // 5. The new video carries the edit and the vehicle; the old one is exactly as it was; the draft is used up.
    const after = await stories(page);
    const made = after.find((s) => s.storyId === newId)!;
    expect(made.title).toBe(`${before.title} 2`);
    expect(made.characterIds).toContain(ROSSO);
    for (const id of before.characterIds) expect(made.characterIds).toContain(id);
    expect(made.ownScript?.scenes[0]?.what).toBe("Pip and Dash drive Rosso to the sandwich shop.");
    expect(made.ownScript?.scenes.length).toBe(n);
    expect(made.seriesId).toBe(before.seriesId);
    expect(after.find((s) => s.storyId === PUBLISHED)).toEqual(before);
    const drafts = await page.evaluate(() => (window as MockWindow).__cfStoriesMock!.store!.drafts.length);
    expect(drafts).toBe(0);
    await ctx.close();
  });
