import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

test("paste a link, see the platform, start a job", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const input = page.getByLabel("YouTube, Twitch or Kick link");
  await input.fill("https://www.twitch.tv/videos/2245119876");
  await expect(page.getByText("Twitch video found.")).toBeVisible();
  await input.fill("https://example.com/video");
  await expect(page.getByText("Clip Factory works with YouTube, Twitch and Kick links.")).toBeVisible();
  await input.fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText("YouTube video found.")).toBeVisible();
  await page.getByRole("radio", { name: "Exactly" }).check({ force: true });
  await page.getByRole("button", { name: "More: Number of clips" }).click();
  await page.getByLabel(/Notes for the agent/).fill("#gta6 #launch");
  await page.getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("aiming for 7 clips")).toBeVisible();
  await expect(page.locator(".timeline__step")).toHaveCount(9);
});

test("upload a video with progress", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.getByRole("radio", { name: "Upload a video" }).check({ force: true });
  await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
    name: "stream.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.alloc(1024 * 64),
  });
  await expect(page.getByText("stream.mp4")).toBeVisible();
  await page.getByRole("button", { name: "Make clips" }).click();
  await expect(page.getByRole("progressbar", { name: "Upload progress" })).toBeVisible();
  await expect(page).toHaveURL(/\/jobs\//, { timeout: 15_000 });
});

test("keep a clip with a celebration, throw another away and undo it", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  const cards = page.locator(".review-card");
  const before = await cards.count();
  expect(before).toBeGreaterThan(1);

  await cards.first().getByRole("tab", { name: "X" }).click();
  await cards.first().getByLabel("X caption").fill("Twelve cars, one bridge #gtarp");
  await cards.first().getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.locator("canvas.confetti")).toHaveCount(1);
  await expect(page.getByText(/Kept!/)).toBeVisible();
  await expect(cards).toHaveCount(before - 1);

  // Throw away: no scary dialog, the card goes at once, and Undo brings it back.
  const hook = await cards.first().locator(".review-card__hook").innerText();
  await cards.first().getByRole("button", { name: "Throw away" }).click();
  await expect(cards).toHaveCount(before - 2);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(cards).toHaveCount(before - 1);
  await expect(page.locator(".review-card__hook", { hasText: hook })).toBeVisible();

  // Without Undo it really happens after 8 seconds: the server drops it, so it stays gone on the next visit.
  await cards.first().getByRole("button", { name: "Throw away" }).click();
  await expect(cards).toHaveCount(before - 2);
  await expect(page.getByRole("button", { name: "Undo" })).toBeHidden({ timeout: 10_000 });
  await page.locator("nav.sidebar").getByRole("link", { name: "Home", exact: true }).click();
  await page.locator("nav.sidebar").getByRole("link", { name: /^Review/ }).click();
  await settle(page);
  await expect(cards).toHaveCount(before - 2);

  await page.goto("/library");
  await settle(page);
  await expect(page.getByText("Posts once these accounts are connected").first()).toBeVisible();
});

test("retry a failed job and stop a running one", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Charity marathon" }).click();
  await settle(page);
  await expect(page.getByRole("alert").filter({ hasText: "YouTube blocked" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Starting again from the beginning.")).toBeVisible();

  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Ranked grind" }).click();
  await settle(page);
  // Stop waits 8 seconds for an Undo instead of asking "are you sure?".
  await page.getByRole("button", { name: "Stop job" }).click();
  await expect(page.getByText("Stopping in a few seconds.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Stop job" })).toBeVisible();
  await page.getByRole("button", { name: "Stop job" }).click();
  await expect(page.getByText("Job stopped.")).toBeVisible({ timeout: 12_000 });
});

test("settings: skills, preferences, appearance", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);

  await page.locator('input[type="file"][accept^=".md"]').setInputFiles({
    name: "hooks.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\nname: hooks\ndescription: test\n---\n# Hooks\n"),
  });
  await expect(page.getByText("Added hooks.")).toBeVisible();

  const builtIn = page.locator(".skill", { hasText: "short-form-video-playbook" });
  await expect(builtIn.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
  await builtIn.getByRole("switch").click();
  await expect(builtIn.getByRole("switch")).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: "More: Longest source in hours" }).click();
  await expect(page.locator(".pref", { hasText: "Longest source" }).locator("output")).toHaveText("7");

  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator("html")).toHaveClass(/reduce-motion/);

  await page.locator('input[type="file"][accept=".txt,text/plain"]').setInputFiles({
    name: "cookies.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("# Netscape HTTP Cookie File\n"),
  });
  await expect(page.getByText("YouTube cookies saved.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("sign in, including choosing a new password", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"));
  await page.goto("/");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("That email or password is not right.");

  await page.getByLabel("Email").fill("new@example.com");
  await page.getByLabel("Password").fill("Temporary1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("Use at least 12 characters.");
  await page.getByLabel("New password").fill("A-much-better-pass1");
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("heading", { name: /Clips worth/ })).toBeVisible();
});

test("an expired first-login step goes back to sign-in instead of a dead end", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"));
  await page.goto("/");
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByLabel("Password").fill("Temporary1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("New password")).toBeVisible();

  // "Start again" is always there on the new-password step.
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Password").fill("Temporary1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("New password")).toBeVisible();

  // The owner takes longer than Cognito's 3-minute challenge window.
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 4 * 60_000;
  });
  await page.getByLabel("New password").fill("A-much-better-pass1");
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("That took too long. Sign in again with the password from your invitation.");
  await expect(page.getByLabel("Email")).toHaveValue("new@example.com");
  await page.getByLabel("Password").fill("Temporary1!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New password").fill("A-much-better-pass1");
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("heading", { name: /Clips worth/ })).toBeVisible();
});
