import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { animationsDone, findOverflow, settle } from "./helpers.ts";

// Settings › Clip making › What it learned (docs/CONTRACTS.md §16.12): read the lessons, turn one off and on, delete
// one after the question, the empty and the not-enough states, and the page at 320 to 1920 px, light and dark.

const PATH = "/settings/clip-making/learned";
type FaultWindow = Window & { __cfMockFaults?: { lessons?: "empty" | "needs-more" } };

async function open(page: Page) {
  await page.goto(PATH);
  await settle(page);
}

/** Sets a lessons fault and opens the page from inside the app (a reload would make a fresh mock). */
async function openWith(page: Page, fault: "empty" | "needs-more") {
  await page.goto("/settings/clip-making");
  await settle(page);
  await page.evaluate((f) => {
    (window as FaultWindow).__cfMockFaults!.lessons = f;
  }, fault);
  await page.locator(`a[href='${PATH}']`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  await settle(page);
}

const lessonCard = (page: Page, text: string) => page.locator(".lesson", { hasText: text });

test("reads every lesson, grouped by creator, with its evidence and winner clips", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Every day Clip Factory checks your clips 7 days after posting.", { exact: false })).toBeVisible();
  const groups = page.locator(".learned__creator");
  await expect(groups).toHaveText(["Big Streamer", "Quiet Corner", "All creators"]);
  const using = lessonCard(page, "Start on the reaction itself");
  await expect(using.locator(".pill")).toHaveText("Using it");
  await expect(using).toContainText("YouTube");
  await expect(using).toContainText("3 of 31 clips did much better than normal");
  await expect(lessonCard(page, "Keep hooks to 5 words").locator(".pill")).toHaveText("Trying it");
  const everyone = lessonCard(page, "Chaos moments");
  await expect(everyone.locator(".pill")).toHaveText("Turned off");
  await expect(everyone).toContainText("3 of 40 clips from all your creators did much better than normal");
  // A lesson that is too old: its chip, a plain note, and only Delete (turning it off or on would change nothing).
  const old = lessonCard(page, "Clips of 20 to 30 seconds");
  await expect(old.locator(".pill")).toHaveText("Too old");
  await expect(old).toContainText("Too old to use. New clips can teach it again.");
  await expect(old.getByRole("button")).toHaveText(["Delete"]);
  await expect(old.locator(".lesson__clip")).toHaveCount(0);
  // One winner clip is never shown under two lessons.
  const hrefs = await page.locator(".lesson__clip").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(new Set(hrefs).size).toBe(hrefs.length);
  await expect(page.locator(".learned__needs")).toHaveText(["YouTube: Needs 12 more posted clips"]);
  // A winner clip opens its own page.
  const link = using.locator(".lesson__clip").first();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/clips\/[0-9A-Z]{26}$/);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test("turns a lesson off and back on", async ({ page }) => {
  await open(page);
  const card = lessonCard(page, "Start on the reaction itself");
  await card.getByRole("button", { name: "Turn off" }).click();
  await expect(card.locator(".pill")).toHaveText("Turned off");
  await expect(page.getByText("Turned off. Clip Factory will not use it.")).toBeVisible();
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.locator(".pill")).toHaveText("Using it");
});

test("deletes a lesson only after the question", async ({ page }) => {
  await open(page);
  const card = lessonCard(page, "Keep hooks to 5 words");
  await card.getByRole("button", { name: "Delete" }).click();
  const sheet = page.getByRole("dialog", { name: "Delete this lesson?" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Keep it" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Deleted. It will not be learned again.")).toBeVisible();
});

test("the empty state before the first check", async ({ page }) => {
  await openWith(page, "empty");
  await expect(page.getByText("Nothing yet. Lessons show up here once your clips have been posted for 7 days.")).toBeVisible();
  await expect(page.locator(".lesson")).toHaveCount(0);
});

test("the not-enough-clips state", async ({ page }) => {
  await openWith(page, "needs-more");
  await expect(page.locator(".learned__creator")).toHaveText(["Quiet Corner"]);
  await expect(page.locator(".learned__needs")).toHaveText(["YouTube: Needs 12 more posted clips"]);
  await expect(page.locator(".lesson")).toHaveCount(0);
});

test("Find a setting reaches it", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  await page.getByLabel("Find a setting").first().fill("lessons");
  const hit = page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first();
  await expect(hit).toContainText("What it learned");
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`${PATH}#what-it-learned$`));
  await expect(page.locator(".lesson").first()).toBeVisible();
});

test("Library links to it instead of repeating it", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  await page.getByRole("link", { name: "See what it learned from your best clips" }).click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
});

for (const scheme of ["light", "dark"] as const) {
  test(`fits from 320 to 1920 px with big tap targets and readable text (${scheme})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const problems: string[] = [];
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
      await open(page);
      await animationsDone(page);
      const over = await findOverflow(page);
      if (over.page > over.viewport || over.items.length) problems.push(`${width}: overflow ${JSON.stringify(over).slice(0, 300)}`);
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".lesson button, .lesson a"))
          .map((el) => ({ text: el.textContent?.trim() ?? "", r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
          .map(({ text, r }) => `${text} ${Math.round(r.width)}x${Math.round(r.height)}`),
      );
      if (small.length) problems.push(`${width}: small targets ${small.join(", ")}`);
      const axe = await new AxeBuilder({ page }).include(".settings-content").withRules(["color-contrast"]).analyze();
      for (const v of axe.violations) for (const n of v.nodes) problems.push(`${width}: contrast ${n.target.join(" ")}`);
    }
    expect(problems).toEqual([]);
  });
}
