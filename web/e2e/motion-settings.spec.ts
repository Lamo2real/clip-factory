import { expect, test, type Page } from "@playwright/test";
import { ACT_MS } from "../src/lib/motion.ts";
import { settle } from "./helpers.ts";
import { actTransforms, actWidths, MOTION_WIDTHS, noSideScroll, pauseActs, tapAct } from "./motionHelpers.ts";

// Action motion in Settings (docs/CONTRACTS.md §20.11 (c)): search, branches, sounds, skills and Set up posting.
// Mock mode. Each check taps from inside the page (tapAct) so the motion's first frame can be read.

const SETUP = "/settings/posting/setup/youtube";
const WRITTEN = "01JZ8S00000000000000000001"; // "GTA RP hooks", a written .md
/** A 1×1 PNG, for the background picker. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function open(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
}

const act = (page: Page, kind: string) => page.locator(`[data-act="${kind}"]`);

test.describe("motion in Settings (APPLY c)", () => {
  test.use({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });

  test("Find a setting: Ask flies its sparkle at the tap; Clear is a clear", async ({ page }) => {
    await open(page, "/settings");
    await page.getByLabel("Find a setting").first().fill("zzqqxx");
    await expect(page.getByRole("button", { name: "Clear the search" })).toHaveAttribute("data-act", "clear");
    const ask = page.locator(".find__ask");
    await expect(ask).toHaveAttribute("data-act", "send");
    const { cls } = await tapAct(ask);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act", "act--send", "is-play"]));
    await expect(ask.locator(".act")).toHaveClass(/is-idle/, { timeout: ACT_MS.send + 300 });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Clear the search" }).click();
    await expect(page.getByLabel("Find a setting").first()).toHaveValue("");
  });

  test("Check for updates turns its arrow, and the answer does not wait for it", async ({ page }) => {
    await open(page, "/settings/app/updates");
    const button = page.getByRole("button", { name: "Check for updates" });
    await expect(button).toHaveAttribute("data-act", "refresh");
    const { cls } = await tapAct(button);
    expect(cls).toContain("is-play");
    // The toast arrives while the arrow is still turning or just after: nothing is held back for the motion.
    await expect(page.getByText(/You have the newest version|A new version is ready/)).toBeVisible({ timeout: ACT_MS.refresh + 400 });
    await expect(button.locator(".act")).toHaveClass(/is-idle/, { timeout: ACT_MS.refresh + 300 });
  });

  test("Sign out is a disconnect; the steppers add and remove", async ({ page }) => {
    await open(page, "/settings/app/account");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveAttribute("data-act", "disconnect");
    await open(page, "/settings/clip-making/clips");
    await expect(act(page, "add")).toHaveCount(3);
    await expect(act(page, "remove")).toHaveCount(3);
  });

  test("Sounds: a card sends out rings; Try it plays only when it works", async ({ page }) => {
    await open(page, "/settings/look-and-feel/sounds");
    const on = page.getByRole("switch", { name: /^Sounds/ }).first();
    if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
    const card = page.locator(".sound-card").nth(3);
    await expect(card).toHaveAttribute("data-act", "play");
    expect((await tapAct(card)).cls).toContain("is-play");

    const tryIt = page.getByRole("button", { name: "Try it: Sign in" });
    await expect(tryIt).toHaveAttribute("data-act", "play");
    await page.getByRole("switch", { name: "Make it fail" }).click();
    expect((await tapAct(tryIt)).cls).toContain("is-idle");
    await expect(tryIt).toHaveClass(/is-shaking/);
    await page.getByRole("switch", { name: "Make it fail" }).click();
    await page.waitForTimeout(400);
    expect((await tapAct(tryIt)).cls).toContain("is-play");
  });

  test("Background: the picture uploads when picked; Use the colours rewinds on Undo", async ({ page }) => {
    await open(page, "/settings/look-and-feel/background");
    const choose = page.getByRole("button", { name: "Choose a picture" });
    await expect(choose).toHaveAttribute("data-act", "upload");
    // The tap that opens the picker does not play it; the picked file does.
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "bg.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator('[data-act="upload"] .act')).toHaveClass(/is-(play|idle)/);
    await expect(page.getByText("Background set on this device.")).toBeVisible();

    const colours = page.getByRole("button", { name: "Use the colours" });
    await expect(colours).toHaveAttribute("data-act", "undo");
    await colours.click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Use the colours" }).locator(".act")).toHaveClass(/is-rewind/);
  });

  test("YouTube cookies: a bad file fails, a good one uploads, Remove rewinds on Undo", async ({ page }) => {
    await open(page, "/settings/clip-making/youtube");
    const input = page.locator('input[type="file"][accept=".txt,text/plain"]');
    await input.setInputFiles({ name: "cookies.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 ** 2 + 10, "a") });
    await expect(page.locator('[data-act="upload"] .act')).toHaveClass(/is-fail/);
    await page.waitForTimeout(400);
    await input.setInputFiles({ name: "cookies.txt", mimeType: "text/plain", buffer: Buffer.from("# Netscape HTTP Cookie File\n") });
    const remove = page.getByRole("button", { name: "Remove" });
    await expect(remove).toHaveAttribute("data-act", "delete");
    await remove.click();
    await expect(remove).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Remove" }).locator(".act")).toHaveClass(/is-rewind/);
  });

  test("Post to: turning a place on ticks its mark", async ({ page }) => {
    await open(page, "/settings/posting/where");
    const chip = page.locator(".check-chip").nth(1);
    await expect(chip).toHaveAttribute("data-act", "tick");
    if (await chip.evaluate((el) => el.classList.contains("is-on"))) {
      // Turning off is the press only.
      await chip.click();
      await expect(chip).not.toHaveClass(/is-on/);
      await expect(chip.locator(".act")).toHaveClass(/is-idle/);
    }
    const { cls } = await chip.evaluate(async (el: HTMLElement) => {
      el.querySelector("input")!.click();
      await new Promise((r) => setTimeout(r, 0));
      return { cls: el.querySelector(".act")?.className ?? "" };
    });
    expect(cls).toContain("is-play");
    await expect(chip).toHaveClass(/is-on/);
  });

  test("Skills: Write is an add, a wrong file fails, and Undo brings the row back returning", async ({ page }) => {
    await open(page, "/settings/clip-making/skills");
    await expect(page.getByRole("link", { name: "Write a skill" })).toHaveAttribute("data-act", "add");
    await page.getByLabel("Skill file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await expect(page.getByRole("button", { name: "Upload a file" }).locator(".act")).toHaveClass(/is-fail/);

    await open(page, `/settings/clip-making/skills/${WRITTEN}`);
    await page.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete" });
    await expect(confirm).toHaveAttribute("data-act", "delete");
    await confirm.click();
    await expect(page).toHaveURL(/\/settings\/clip-making\/skills$/);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".skill-row", { hasText: "GTA RP hooks" })).toHaveClass(/is-returning/);
  });

  test("Write a skill: Save refused by the form fails; Use the example pastes", async ({ page }) => {
    await open(page, "/settings/clip-making/skills/new");
    const save = page.getByRole("button", { name: "Save skill" });
    await expect(save).toHaveAttribute("data-act", "save");
    await save.click();
    await expect(save.locator(".act")).toHaveClass(/is-fail/);
    await expect(page.getByRole("button", { name: "Use the example" }).first()).toHaveAttribute("data-act", "paste");
  });

  test("Set up posting: Copy, I did this, Paste, Save keys, Check it, Connect", async ({ page }) => {
    await open(page, SETUP);
    await expect(page.getByRole("button", { name: "I did this" }).first()).toHaveAttribute("data-act", "tick");
    await page.locator('[data-step="key-project"] .gstep__head').click();
    const copy = page.locator('[data-step="key-project"] .copy-chip__btn');
    await expect(copy).toHaveAttribute("data-act", "copy");
    expect((await tapAct(copy)).cls).toContain("is-play");
    await expect(page.locator('[data-step="key-project"] .copy-chip')).toHaveClass(/is-copied/);

    await page.locator('[data-step="key-paste"] .gstep__head').click();
    const keys = page.locator('[data-step="key-paste"]');
    await expect(keys.locator('[data-act="paste"]')).toHaveCount(2);
    const saveKeys = keys.getByRole("button", { name: "Save keys" });
    await expect(saveKeys).toHaveAttribute("data-act", "save");
    await keys.getByLabel("Client ID", { exact: true }).fill("123456789012-abcdefghij0123456789klmnopqrst.apps." + "googleusercontent.com");
    await keys.getByLabel("Client secret", { exact: true }).fill("GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12");
    expect((await tapAct(saveKeys)).cls).toContain("is-play");
    const check = keys.getByRole("button", { name: "Check it" });
    await expect(check).toHaveAttribute("data-act", "check");
    expect((await tapAct(check)).cls).toContain("is-play");
    await page.locator('[data-step="connect"] .gstep__head').click();
    await expect(page.getByRole("button", { name: "Connect YouTube", exact: true })).toHaveAttribute("data-act", "connect");
  });

  test("reduced motion (OS): Settings buttons only fade, nothing moves", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "/settings/app/updates");
    const { cls } = await tapAct(page.getByRole("button", { name: "Check for updates" }));
    expect(cls).toContain("is-fade");
    for (const f of [0.25, 0.5, 0.75]) {
      await pauseActs(page, f);
      for (const t of await actTransforms(page)) expect(t).toBe("none");
    }
  });
});

test.describe("motion in Settings: nothing overflows while it plays", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  for (const width of MOTION_WIDTHS) {
    test(`Set up posting and Sounds at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, SETUP);
      await page.locator('[data-step="key-project"] .gstep__head').click();
      await page.locator('[data-step="key-paste"] .gstep__head').click();
      await page.waitForTimeout(300);
      const before = await actWidths(page);
      // Copy and Paste only: they stay on the page (the others navigate, fold their step or sign in).
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-act="copy"], [data-act="paste"]')) el.click();
      });
      await page.waitForTimeout(30);
      await pauseActs(page, 0.5);
      expect(await noSideScroll(page)).toBe(true);
      const during = await actWidths(page);
      // Copy's label turns into "Copied!" (its state, not its motion), so only the others are held to their width.
      for (const [key, w] of Object.entries(before)) if (key in during && !key.startsWith("copy")) expect(during[key], key).toBe(w);

      await open(page, "/settings/look-and-feel/sounds");
      const sw = page.getByRole("switch", { name: /^Sounds/ }).first();
      if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
      await page.evaluate(() => document.querySelector<HTMLElement>(".sound-card")?.click());
      await page.waitForTimeout(30);
      await pauseActs(page, 0.5);
      expect(await noSideScroll(page)).toBe(true);
    });
  }
});
