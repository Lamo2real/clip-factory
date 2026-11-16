import { expect, test, type Page } from "@playwright/test";
import { CLIPS, openClip, settle } from "./helpers.ts";
import { actTransforms, actWidths, MOTION_WIDTHS, noSideScroll, pauseActs, tapAct } from "./motionHelpers.ts";

// Action motion (docs/CONTRACTS.md §20.11 (b)): Library, This week, the clip's numbers and Ask Clip Factory.

const panel = (page: Page) => page.getByRole("dialog", { name: "Ask Clip Factory" });

async function openHelp(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.locator(".help-launcher").click();
  await expect(panel(page)).toBeVisible();
}

test.describe("motion: library, clip and help (APPLY b)", () => {
  test("Library: Show bumps the chosen label; Try again turns while it keeps", async ({ page }) => {
    await page.goto("/library");
    await settle(page);
    await page.getByRole("radio", { name: "Posted", exact: true }).check({ force: true });
    await expect(page.locator(".segmented__opt.is-on .act")).toHaveClass(/act--toggle/);
    await page.getByRole("radio", { name: "All", exact: true }).check({ force: true });

    const card = page.locator(".lib-card", { hasText: "This clip has not started posting yet." });
    const again = card.getByRole("button", { name: "Try again" });
    await expect(again).toHaveAttribute("data-act", "retry");
    const { cls } = await tapAct(again);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act--retry", "is-play"]));
    // The keep happens at the tap; the motion never holds it up.
    await expect(page.getByText(/Kept! It posts as soon as your accounts are connected/)).toBeVisible();
  });

  test("This week: the arrows slide, the newest week only nudges, the star spins on and settles off", async ({ page }) => {
    await page.goto("/library?view=week");
    await settle(page);
    const later = page.getByRole("button", { name: "Later week" });
    await expect(later).toHaveAttribute("data-act", "next");
    const nudge = await tapAct(later);
    // A nudge (CSS keyframes, §20.9), not a shake: no failure, no slide.
    expect(nudge.cls.split(" ")).toEqual(expect.arrayContaining(["act--nudge", "is-play"]));
    expect(nudge.cls).not.toContain("is-fail");
    await expect(later.locator(".act")).toHaveClass(/is-idle/);
    await expect(page.getByText("This is the newest week. Tap the left arrow to see earlier weeks.")).toBeVisible();

    const star = page.locator(".week-card").first().getByRole("button", { name: "Best this week" });
    const was = await star.getAttribute("aria-pressed");
    const on = await tapAct(star);
    expect(on.cls.split(" ")).toEqual(expect.arrayContaining(["act--star", "is-play"]));
    await expect(star).not.toHaveAttribute("aria-pressed", was ?? "");
    await expect(star.locator(".act")).toHaveClass(/is-idle/, { timeout: 900 });
    await tapAct(star);
    await expect(star).toHaveAttribute("aria-pressed", was ?? "");

    const earlier = page.getByRole("link", { name: "Earlier week" });
    await expect(earlier).toHaveAttribute("data-act", "prev");
    const prev = await tapAct(earlier);
    expect(prev.cls.split(" ")).toEqual(expect.arrayContaining(["act--prev", "is-play"]));
    await expect(page).toHaveURL(/week=\d{4}-W\d{2}$/);
    await expect(later).not.toHaveAttribute("aria-disabled", "true");
    const next = await tapAct(later);
    expect(next.cls.split(" ")).toEqual(expect.arrayContaining(["act--next", "is-play"]));
    await expect(page).toHaveURL(/\/library\?view=week$/);
  });

  test("Clip: Refresh numbers turns while the check starts at the tap; the star spins", async ({ page }) => {
    await openClip(page, CLIPS.all);
    const refresh = page.locator(".perf__refresh");
    await expect(refresh).toHaveAttribute("data-act", "refresh");
    const { cls } = await tapAct(refresh);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act--refresh", "is-play"]));
    await expect(page.locator(".toast").filter({ hasText: /^Checking all 5 apps now\.$/ })).toBeVisible();

    const star = page.getByRole("button", { name: "Best this week" });
    await expect(star).toHaveAttribute("data-act", "star");
    const s = await tapAct(star);
    expect(s.cls.split(" ")).toEqual(expect.arrayContaining(["act--star", "is-play"]));
    await expect(page.getByText("Saved. Clip Factory will learn from your picks.")).toBeVisible();
  });

  test("Ask: a chip launches the plane, Start over turns, Copy the help code copies (and shakes when it cannot)", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openHelp(page);
    const send = panel(page).locator(".help-panel__ask");
    await panel(page).locator(".help-chip").first().click();
    await expect(send.locator(".fly")).toHaveClass(/is-flying/);
    await expect(send.locator(".fly__trail")).toHaveCount(1);
    await expect(panel(page).locator(".help-msg--bot").last()).toBeVisible();

    const restart = panel(page).getByRole("button", { name: "Start over" });
    await expect(restart).toHaveAttribute("data-act", "refresh");
    const r = await tapAct(restart);
    expect(r.cls.split(" ")).toEqual(expect.arrayContaining(["act--refresh", "is-play"]));
    await expect(panel(page).locator(".help-chip")).toHaveCount(3);

    const box = panel(page).getByLabel("Your question");
    await box.fill("#503 What does Keep do?");
    await box.press("Enter");
    const copy = panel(page).getByRole("button", { name: "Something went wrong? Copy the help code" });
    await expect(copy).toHaveAttribute("data-act", "copy");
    const c = await tapAct(copy);
    expect(c.cls.split(" ")).toEqual(expect.arrayContaining(["act--copy", "is-play"]));
    await expect(page.getByText("Copied. Send this code to whoever helps you with Clip Factory.")).toBeVisible();

    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("no"));
    });
    await page.waitForTimeout(400);
    await tapAct(copy);
    await expect(copy.locator(".act")).toHaveClass(/is-fail/);
  });

  test("reduced motion: Refresh numbers and the star only fade", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openClip(page, CLIPS.all);
    const refresh = await tapAct(page.locator(".perf__refresh"));
    expect(refresh.cls.split(" ")).toContain("is-fade");
    const star = await tapAct(page.getByRole("button", { name: "Best this week" }));
    expect(star.cls.split(" ")).toContain("is-fade");
    for (const f of [0.25, 0.5, 0.75]) {
      await pauseActs(page, f);
      expect((await actTransforms(page)).filter((t) => t !== "none"), `at ${f}`).toEqual([]);
    }
  });

  for (const width of MOTION_WIDTHS) {
    test(`nothing overflows or grows mid-animation at ${width}px (This week and Clip)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/library?view=week");
      await settle(page);
      let before = await actWidths(page);
      await tapAct(page.locator(".week-card").first().getByRole("button", { name: "Best this week" }));
      for (const f of [0.25, 0.5, 0.75]) {
        await pauseActs(page, f);
        expect(await noSideScroll(page), `week side scroll at ${f}`).toBe(true);
        expect(await actWidths(page), `week widths at ${f}`).toEqual(before);
      }

      await openClip(page, CLIPS.mixed);
      // Refresh's label changes at the tap ("Checking…"), so only the star's width is held still.
      const steady = async () => Object.fromEntries(Object.entries(await actWidths(page)).filter(([k]) => !k.startsWith("refresh")));
      before = await steady();
      await tapAct(page.getByRole("button", { name: "Best this week" }));
      await tapAct(page.locator(".perf__refresh"));
      for (const f of [0.25, 0.5, 0.75]) {
        await pauseActs(page, f);
        expect(await noSideScroll(page), `clip side scroll at ${f}`).toBe(true);
        expect(await steady(), `clip widths at ${f}`).toEqual(before);
      }
    });
  }
});
