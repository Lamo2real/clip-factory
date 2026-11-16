import { expect, test, type Page } from "@playwright/test";
import { findOverflow, settle } from "./helpers.ts";

// Skills in Settings (docs/CONTRACTS.md §18): create, read, update and delete (with Undo), on a phone and a desktop.
// Mock mode: the fixture skills have fixed ids, so their pages can be opened by address and reloaded.
const LIST = "/settings/clip-making/skills";
const WRITTEN = "01JZ8S00000000000000000001"; // "GTA RP hooks", a written .md
const ZIP = "01JZ8S00000000000000000002"; // "Brand voice", a .zip
const TRICKY = "01JZ8S00000000000000000003"; // "Safety test", <script> and a javascript: link inside
const BUILTIN = "builtin-short-form-video-playbook";

async function open(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
}

/** Nothing runs out of its box and the page never scrolls sideways. */
async function fits(page: Page, label: string) {
  const result = await findOverflow(page);
  const failures = result.items.map((o) => `${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
  if (result.page > result.viewport) failures.push(`${label}: page scrolls sideways (${result.page}px > ${result.viewport}px)`);
  expect(failures, failures.join("\n")).toEqual([]);
}

const row = (page: Page, title: string) => page.locator(".skill-row", { hasText: title });
/** Up one level: the big Back button on phones, the breadcrumb on wider screens (it is hidden from 768 px). */
async function up(page: Page, to: string) {
  const back = page.getByRole("link", { name: `Back to ${to}` });
  if (await back.isVisible()) await back.click();
  else await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: to, exact: true }).click();
}

for (const size of [
  { name: "phone", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  test.describe(`skills on a ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("create: write a skill, with a duplicate-name hint, confetti and its own page", async ({ page }) => {
      await open(page, LIST);
      await fits(page, "skills list");
      await page.getByRole("link", { name: "Write a skill" }).click();
      await expect(page).toHaveURL(/\/settings\/clip-making\/skills\/new$/);
      await settle(page);
      await expect(page.getByRole("heading", { level: 1, name: "Write a skill" })).toBeVisible();

      // A name already used says so under the first question, before saving.
      await page.getByLabel("What is the skill called?").fill("Brand voice");
      await expect(page.getByText("You already have a skill called Brand voice. Pick another name.")).toBeVisible();
      await fits(page, "write (duplicate)");
      // Saving anyway is refused right there, and nothing is sent.
      await page.getByRole("button", { name: "Save skill" }).click();
      await expect(page).toHaveURL(/\/skills\/new$/);
      await expect(page.getByLabel("What is the skill called?")).toBeFocused();

      // A built-in's name is Clip Factory's, not "yours".
      await page.getByLabel("What is the skill called?").fill("Short form video playbook");
      await expect(page.getByText("Clip Factory already has a skill called Short form video playbook. Pick another name.")).toBeVisible();

      await page.getByLabel("What is the skill called?").fill("Funny moments first");
      await expect(page.getByText("You already have a skill called")).toHaveCount(0);
      // "Use the example" fills the other two.
      await page.getByRole("button", { name: "Use the example" }).first().click();
      await expect(page.getByLabel("When should Clip Factory use it?")).toHaveValue("Every time it picks moments from my Minecraft videos.");
      await page.getByRole("button", { name: "Use the example" }).click();
      await expect(page.getByLabel("What should it do?")).toHaveValue(/Pick the moments where I laugh the loudest/);
      await fits(page, "write (filled)");

      await page.getByRole("button", { name: "Save skill" }).click();
      await expect(page.locator("canvas.confetti")).toBeAttached();
      await expect(page.getByText("Your skill is ready. Clip Factory will use it every time.")).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/clip-making\/skills\/[0-9A-HJKMNP-TV-Z]{26}$/);
      await settle(page);
      await expect(page.getByRole("heading", { level: 1, name: "Funny moments first" })).toBeVisible();
      await expect(page.locator(".md")).toContainText("Pick the moments where I laugh the loudest.");

      await up(page, "Skills");
      await expect(page).toHaveURL(new RegExp(`${LIST}$`));
      await settle(page);
      await expect(row(page, "Funny moments first")).toContainText("Always used");
    });

    test("read: the skill drawn safely, every skill always used, built-ins read-only", async ({ page }) => {
      await open(page, LIST);
      await expect(page.getByRole("switch")).toHaveCount(0);
      // Rows say where a skill came from in words, never ".md", ".zip" or "KB".
      for (const r of await page.locator(".skill-row__meta").all()) await expect(r).not.toContainText(/\.(md|zip)\b|\bKB\b/);
      await expect(page.locator(".skill-row")).toHaveCount(4);
      for (const r of await page.locator(".skill-row").all()) await expect(r).toContainText("Always used");

      await row(page, "Safety test").click();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${TRICKY}$`));
      await settle(page);
      await expect(page.getByRole("heading", { level: 1, name: "Safety test" })).toBeVisible();
      const md = page.locator(".md");
      // The file's first heading only repeats the title, so it is left out.
      await expect(md.getByRole("heading", { name: "Safety test" })).toHaveCount(0);
      await expect(md.getByText("<script>alert(1)</script>")).toBeVisible();
      await expect(md.getByText("<img src=x onerror=alert(2)>")).toBeVisible();
      await expect(md.locator("script, img")).toHaveCount(0);
      await expect(md.getByRole("link", { name: "tap this" })).toHaveCount(0);
      await expect(md.getByText("tap this")).toBeVisible();
      const help = md.getByRole("link", { name: "Clip Factory help" });
      await expect(help).toHaveAttribute("href", "https://example.com/help");
      await expect(help).toHaveAttribute("rel", "noopener noreferrer nofollow");
      await expect(md.getByText("Picture: a cat")).toBeVisible();
      // A picture's raw address is never printed.
      await expect(md).not.toContainText("example.com/cat.png");
      await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
      // The file's header is not shown: no slug, no repeated description, no "---".
      await expect(page.getByRole("complementary", { name: "About this skill" })).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("safety-test");
      await expect(md).not.toContainText("---");
      await expect(md).not.toContainText("tricky bits");
      await expect(page.getByRole("switch")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
      await fits(page, "skill page");

      // No file jargon: words for where it came from.
      await expect(page.locator(".skill-meta")).toContainText("From a file · Changed");

      // A written skill: the slug never shows, the title shows once, and the instructions come first.
      await open(page, `${LIST}/${WRITTEN}`);
      await expect(page.locator("main")).not.toContainText("gta-rp-hooks");
      await expect(md.getByRole("heading", { name: "GTA RP hooks" })).toHaveCount(0);
      await expect(page.locator(".skill-meta")).toContainText("Written by you · Changed");
      await expect(md.locator("li").first()).toContainText("Lead with the character");
      await fits(page, "written skill page");

      // A zip lists its other files.
      await open(page, `${LIST}/${ZIP}`);
      await expect(page.locator(".skill-meta")).toContainText("From a file with 2 extra files");
      await expect(page.getByRole("heading", { name: "Other files in this skill" })).toBeVisible();
      await expect(page.getByText("examples/sign-off.txt")).toBeVisible();

      // Built in: readable, no Edit, no Delete; its edit address goes back to it.
      await open(page, `${LIST}/${BUILTIN}`);
      await expect(page.getByRole("heading", { level: 1, name: "Short form video playbook" })).toBeVisible();
      await expect(page.getByText("You can read it, but not change or delete it.")).toBeVisible();
      await expect(page.locator(".skill-meta")).toContainText("Comes with Clip Factory");
      await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
      await expect(page.locator(".md ol li")).toHaveCount(4);
      await fits(page, "built-in page");
      await page.goto(`${LIST}/${BUILTIN}/edit`);
      await expect(page).toHaveURL(new RegExp(`${LIST}/${BUILTIN}$`));
      await expect(page.getByText("Built-in skills can be read, but not changed.")).toBeVisible();

      // An address that cannot be a skill, and one that is gone.
      for (const bad of [`${LIST}/nope`, `${LIST}/01JZ8S0000000000000000ZZZZ`]) {
        await open(page, bad);
        await expect(page.getByRole("heading", { name: "We could not find that skill" }).first()).toBeVisible();
        await expect(page.getByRole("link", { name: "Back to Skills" }).last()).toBeVisible();
        await fits(page, `not found ${bad}`);
      }
    });

    test("update: edit, a change from another screen, replace a zip, reload, Back, leave without saving", async ({ page }) => {
      await open(page, `${LIST}/${WRITTEN}`);
      await page.getByRole("link", { name: "Edit" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}/edit$`));
      await settle(page);
      await expect(page.getByLabel("What is the skill called?")).toHaveValue("GTA RP hooks");
      await fits(page, "edit");

      // The description box grows to show every saved word (Brand voice's runs to three lines on a phone).
      await open(page, `${LIST}/${ZIP}/edit`);
      const desc = page.getByLabel("When should Clip Factory use it?");
      await expect(desc).toHaveValue(/sign-off line/);
      const box = await desc.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(box.scroll).toBeLessThanOrEqual(box.client + 2);
      await desc.fill("x ".repeat(300));
      const grown = await desc.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(grown.scroll).toBeLessThanOrEqual(grown.client + 2);
      await desc.fill("The channel's tone: dry, quick, never mean. Banned words and the sign-off line.");
      await open(page, `${LIST}/${WRITTEN}/edit`);

      // Edit → Save → the new words are shown.
      await page.getByLabel("What should it do?").fill("Keep police chases short.");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}$`));
      await settle(page);
      await expect(page.locator(".md")).toContainText("Keep police chases short.");

      // Changed on another screen: Use the newest.
      await open(page, `${LIST}/${WRITTEN}/edit`);
      await page.evaluate((id) => (window as unknown as { __cfMock: { bumpSkillVersion(id: string): number } }).__cfMock.bumpSkillVersion(id), WRITTEN);
      await page.getByLabel("What should it do?").fill("Mine.");
      await page.getByRole("button", { name: "Save changes" }).click();
      const sheet = page.getByRole("dialog", { name: "This skill was changed somewhere else" });
      await expect(sheet).toBeVisible();
      await fits(page, "conflict sheet");
      await sheet.getByRole("button", { name: "Use the newest" }).click();
      await expect(sheet).toBeHidden();
      await expect(page.getByLabel("What should it do?")).toHaveValue(/Changed on another screen\./);

      // …and Save mine anyway.
      await page.evaluate((id) => (window as unknown as { __cfMock: { bumpSkillVersion(id: string): number } }).__cfMock.bumpSkillVersion(id), WRITTEN);
      await page.getByLabel("What should it do?").fill("Mine wins.");
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Save mine anyway" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}$`));
      await settle(page);
      await expect(page.locator(".md")).toContainText("Mine wins.");
      await expect(page.locator(".md")).not.toContainText("Changed on another screen.");

      // A zip: Replace the whole file.
      await open(page, `${LIST}/${ZIP}/edit`);
      await page.locator('input[type="file"][aria-label="New skill file"]').setInputFiles({
        name: "funny-voice.zip",
        mimeType: "application/zip",
        buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]),
      });
      await expect(page).toHaveURL(new RegExp(`${LIST}/${ZIP}$`));
      await settle(page);
      await expect(page.getByRole("heading", { level: 1, name: "Funny voice" })).toBeVisible();

      // Deep link and reload of /edit; Back goes one level up each time.
      await open(page, `${LIST}/${WRITTEN}/edit`);
      await page.reload();
      await settle(page);
      await expect(page.getByLabel("What is the skill called?")).toHaveValue("GTA RP hooks");
      await up(page, "GTA RP hooks");
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}$`));
      await settle(page);
      await up(page, "Skills");
      await expect(page).toHaveURL(new RegExp(`${LIST}$`));

      // Leave without saving?
      await open(page, `${LIST}/${WRITTEN}/edit`);
      await page.getByLabel("When should Clip Factory use it?").fill("Only on Fridays.");
      await page.getByRole("link", { name: "Cancel" }).click();
      const leave = page.getByRole("dialog", { name: "Leave without saving?" });
      await expect(leave).toBeVisible();
      await expect(leave.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await fits(page, "leave sheet");
      await leave.getByRole("button", { name: "Keep editing" }).click();
      await expect(page).toHaveURL(/\/edit$/);
      await expect(page.getByLabel("When should Clip Factory use it?")).toHaveValue("Only on Fridays.");
      await up(page, "GTA RP hooks");
      await expect(leave).toBeVisible();
      await leave.getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}$`));
    });

    test("delete: a small sheet, Undo for 8 seconds, the DELETE only when it ends", async ({ page }) => {
      const deletes = () => page.evaluate(() => (window as unknown as { __cfMockCalls: Record<string, number> }).__cfMockCalls.deleteSkill ?? 0);
      await open(page, `${LIST}/${TRICKY}`);
      await page.getByRole("button", { name: "Delete" }).click();
      const sheet = page.getByRole("dialog", { name: "Delete Safety test?" });
      await expect(sheet).toContainText("Clip Factory will stop using it.");
      // Nearly solid glass: the page behind does not show through the question.
      const look = await sheet.evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, scrim: getComputedStyle(el.parentElement!).backgroundColor }));
      expect(look.bg).toMatch(/0\.95\)/);
      expect(look.scrim).toMatch(/0\.4\)/);
      await expect(sheet.getByRole("button", { name: "Keep it" })).toBeFocused();
      await fits(page, "delete sheet");
      await sheet.getByRole("button", { name: "Keep it" }).click();
      await expect(sheet).toBeHidden();

      await page.getByRole("button", { name: "Delete" }).click();
      await sheet.getByRole("button", { name: "Delete" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}$`));
      await settle(page);
      await expect(row(page, "Safety test")).toHaveCount(0);
      await expect(page.getByText("Deleted Safety test.")).toBeVisible();
      await fits(page, "skills list (undo toast)");
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(row(page, "Safety test")).toHaveCount(1);
      // Back in its place (owner skills by name: brand-voice, gta-rp-hooks, safety-test).
      await expect(page.locator(".skill-row__title")).toHaveText(["Short form video playbook", "Brand voice", "GTA RP hooks", "Safety test"]);
      expect(await deletes()).toBe(0);

      await row(page, "Safety test").click();
      await settle(page);
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await expect(row(page, "Safety test")).toHaveCount(0);
      expect(await deletes()).toBe(0);
      await expect.poll(deletes, { timeout: 12_000, intervals: [500] }).toBe(1);
      await expect(page.getByText("Deleted Safety test.")).toBeHidden();
      await expect(row(page, "Safety test")).toHaveCount(0);
    });

    test("delete, then Back during Undo: says it was just deleted, and Undo brings it back", async ({ page }) => {
      await open(page, `${LIST}/${WRITTEN}`);
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await expect(page).toHaveURL(new RegExp(`${LIST}$`));
      await settle(page);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${LIST}/${WRITTEN}$`));
      await expect(page.getByRole("heading", { name: "You just deleted this skill" }).first()).toBeVisible();
      await expect(page.getByText("Tap Undo at the bottom to bring it back.")).toBeVisible();
      await expect(page.getByText("link has a typo")).toHaveCount(0);
      await fits(page, "just deleted");
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "GTA RP hooks" })).toBeVisible();
    });

    test("upload with a name already used: words that fit an upload", async ({ page }) => {
      await open(page, LIST);
      const file = page.locator('input[type="file"][aria-label="Skill file"]');
      await file.setInputFiles({ name: "Brand voice.zip", mimeType: "application/zip", buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]) });
      await expect(page.getByText("You already have a skill called Brand voice. To change it, open it and tap Replace the whole file.")).toBeVisible();
      await expect(page.getByText("Pick another name")).toHaveCount(0);
      await fits(page, "upload clash");
      await file.setInputFiles({ name: "Short form video playbook.md", mimeType: "text/markdown", buffer: Buffer.from("# x\n") });
      await expect(page.getByText(/^Clip Factory already has a skill called Short form video playbook\. Change the name inside your file/)).toBeVisible();
    });
  });
}
