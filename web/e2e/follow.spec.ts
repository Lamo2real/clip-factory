import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { animationsDone, findOverflow, settle } from "./helpers.ts";

// Settings › Clip making › Streamers I follow (docs/CONTRACTS.md §24.5): a name asks which site, following needs
// "Yes, they said I can", live badges change by themselves, Remove has Undo, the keys a grown-up pastes (Remove keys
// needs a hold), the "Limit how many a day" switch, and Home's Streamers row (only when following someone).

const PATH = "/settings/clip-making/streamers";
type MockWindow = Window & {
  __cfMock?: { follows: { seed(): void; setLive(id: string, live: boolean, viewers?: number): void; endStream(id: string): void } };
};

async function open(page: Page) {
  await page.goto(PATH);
  await settle(page);
}

/** Follows the demo streamers, then opens the page from inside the app (a reload would make a fresh mock). */
async function openSeeded(page: Page) {
  await page.goto("/settings/clip-making");
  await settle(page);
  await page.evaluate(() => (window as MockWindow).__cfMock!.follows.seed());
  await page.locator(`a[href='${PATH}']`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  await settle(page);
}

const row = (page: Page, id: string) => page.locator(`.follow-row[data-follow='${id}']`);

test("a name alone asks which site, and following needs “Yes, they said I can”", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Nobody yet. Find a streamer above and tap Follow.")).toBeVisible();
  await page.getByLabel("Link or name").fill("SpeedySpeedruns");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Where does SpeedySpeedruns stream?")).toBeVisible();
  await expect(page.locator(".follow-which__btn")).toHaveText(["YouTube", "Twitch", "Kick"]);
  await page.locator(".follow-which__btn[data-platform=twitch]").click();
  const card = page.locator(".follow-card");
  await expect(card).toContainText("SpeedySpeedruns");
  await expect(card.locator(".pill")).toHaveText("LIVE · 1.2K watching");
  await expect(card.getByText("Did SpeedySpeedruns say you can make clips of their videos?")).toBeVisible();
  const followButton = card.getByRole("button", { name: "Follow" });
  await expect(followButton).toHaveAttribute("aria-disabled", "true");
  await followButton.dispatchEvent("click"); // an off button explains itself and does nothing
  await expect(row(page, "twitch:speedyspeedruns")).toHaveCount(0);
  await card.getByRole("button", { name: "Yes, they said I can" }).click();
  await expect(card.getByRole("button", { name: "Yes, they said I can" })).toHaveAttribute("aria-pressed", "true");
  await followButton.click();
  await expect(page.getByText("You follow SpeedySpeedruns now!")).toBeVisible();
  await expect(row(page, "twitch:speedyspeedruns")).toContainText("LIVE · 1.2K watching");
  await expect(page.locator(".follow-card")).toHaveCount(0);
});

test("a link to another site is refused without asking anything", async ({ page }) => {
  await open(page);
  await page.getByLabel("Link or name").fill("https://example.com/someone");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("That is not a YouTube, Twitch or Kick link.", { exact: false })).toBeVisible();
  await expect(page.locator(".follow-card, .follow-which")).toHaveCount(0);
});

test("How do I ask? gives a message to copy, and YouTube adds its rule", async ({ page }) => {
  await open(page);
  await page.getByLabel("Link or name").fill("https://www.youtube.com/@ClipCityGames");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("YouTube does not allow downloading videos without permission.")).toBeVisible();
  await page.getByRole("button", { name: "How do I ask?" }).click();
  const sheet = page.getByRole("dialog", { name: "How do I ask?" });
  await expect(sheet).toContainText("Hi Clip City Games!");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
});

test("a Kick streamer can be followed before the keys, and a grown-up's keys fill it in", async ({ page }) => {
  await open(page);
  await page.getByLabel("Link or name").fill("kick.com/RaceCarRick");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.locator(".follow-card")).toContainText("Ask a grown-up to finish Kick setup");
  await page.getByRole("button", { name: "Yes, they said I can" }).click();
  await page.locator(".follow-card").getByRole("button", { name: "Follow" }).click();
  await expect(row(page, "kick:racecarrick")).toContainText("Needs a grown-up");
  const kick = page.locator(".follow-key[data-keys=kick]");
  await expect(kick).toContainText("Needs a grown-up");
  await kick.getByRole("button", { name: "I am the grown-up" }).click();
  await expect(kick.locator(".copy-chip")).toContainText("Webhook address");
  await kick.getByLabel("Client ID").fill("01KICKCLIENT0001");
  await kick.getByLabel("Client Secret").fill("kicksecret-abcdefghijkl");
  await kick.getByRole("button", { name: "Save keys" }).click();
  await expect(page.getByText("Kick keys saved.")).toBeVisible();
  await expect(kick).toContainText("••••ijkl");
  await expect(row(page, "kick:racecarrick")).toContainText("RaceCarRick");
  await expect(row(page, "kick:racecarrick")).toContainText("Offline");
  // Removing the keys needs a hold: a tap does nothing.
  await kick.getByRole("button", { name: "Remove keys" }).click();
  const sheet = page.getByRole("dialog", { name: "Remove the Kick keys?" });
  const hold = sheet.getByRole("button", { name: "Hold to remove" });
  await hold.click();
  await expect(sheet).toBeVisible();
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(1900);
  await page.mouse.up();
  await expect(page.getByText("Kick keys removed.")).toBeVisible();
  await expect(kick).toContainText("Needs a grown-up");
});

test("live badges change by themselves, live first", async ({ page }) => {
  await openSeeded(page);
  await expect(page.locator(".follow-row").first()).toHaveAttribute("data-follow", "twitch:speedyspeedruns");
  await page.evaluate(() => (window as MockWindow).__cfMock!.follows.setLive("twitch:cozycrafts", true, 77));
  await expect(row(page, "twitch:cozycrafts")).toContainText("LIVE · 77 watching");
  await page.evaluate(() => (window as MockWindow).__cfMock!.follows.endStream("twitch:speedyspeedruns"));
  await expect(row(page, "twitch:speedyspeedruns")).toContainText("Offline");
  await expect(row(page, "twitch:speedyspeedruns")).toContainText("Stream ended");
});

test("Remove has Undo; rows say Clips by itself is coming soon (no switch yet)", async ({ page }) => {
  await openSeeded(page);
  const cozy = row(page, "twitch:cozycrafts");
  await expect(cozy).toContainText("Twitch");
  await expect(cozy).toContainText("Clips by itself: coming soon");
  await expect(cozy.getByRole("switch")).toHaveCount(0);
  await cozy.getByRole("button", { name: "Remove CozyCrafts" }).click();
  await expect(cozy).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "twitch:cozycrafts")).toBeVisible();
});

test("Limit how many a day: off means no limit, on shows 1 to 20", async ({ page }) => {
  await open(page);
  const limit = page.getByRole("switch", { name: "Limit how many a day" });
  await expect(limit).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("No limit. Each video costs the same as one you paste.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Most videos a day" })).toHaveCount(0);
  await limit.click();
  const stepper = page.getByRole("group", { name: "Most videos a day" });
  await expect(stepper.locator("output")).toHaveText("3");
  await stepper.getByRole("button", { name: "More: Most videos a day" }).click();
  await expect(stepper.locator("output")).toHaveText("4");
  await limit.click();
  await expect(stepper).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Shortest video" })).toBeVisible();
});

test("Home shows Streamers only when following someone", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await expect(page.locator(".streamers-row")).toHaveCount(0);
  await page.evaluate(() => (window as MockWindow).__cfMock!.follows.seed());
  await page.locator("a[href='/jobs']").filter({ visible: true }).first().click();
  await settle(page);
  await page.locator("a[href='/']").filter({ visible: true }).first().click();
  await settle(page);
  const strip = page.locator(".streamers-row");
  await expect(strip).toContainText("You follow 4 streamers. 1 live now.");
  await expect(strip.locator(".streamer-chip").first()).toContainText("1.2K watching");
  await strip.locator(".streamer-chip").first().click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
});

for (const scheme of ["light", "dark"] as const) {
  test(`fits from 320 to 1920 px with big tap targets and readable text (${scheme})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openSeeded(page);
    const problems: string[] = [];
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
      await animationsDone(page);
      const over = await findOverflow(page);
      if (over.page > over.viewport || over.items.length) problems.push(`${width}: overflow ${JSON.stringify(over).slice(0, 300)}`);
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".follow-row button:not([role=switch]), .follow-add button, .follow-key button"))
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
