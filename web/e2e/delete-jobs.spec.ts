import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Deleting jobs (docs/CONTRACTS.md §34): from a row, from the job page and several at once, each behind one question
// that says what happens, then an 8-second Undo. Clips in Review go only when the box is ticked; a clip whose job is
// gone still links to a page that says so. CF_SHOTS=<folder> also saves the pictures the owner looks at.

const SHOTS = process.env.CF_SHOTS;
const SIZES = [
  { name: "mac", width: 1000, height: 650, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // the sheet's rise and the toast's arrival have settled
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** In-app moves only: the mock's data lives in the page, so a reload or goto would bring every job back. */
async function go(page: Page, href: string) {
  await page.locator(`.sidebar a[href="${href}"]`).first().click();
  await settle(page);
}

const row = (page: Page, title: string) => page.locator(".job-item", { hasText: title });
/** A row's bin: with a mouse it shows on the row under the pointer (or with the keyboard on the row). */
async function bin(page: Page, title: string) {
  await row(page, title).hover();
  return row(page, title).getByRole("button", { name: new RegExp(`Delete job: ${title}`) });
}
const sheet = (page: Page) => page.getByRole("dialog");
const deleteCalls = (page: Page) =>
  page.evaluate(() => {
    const calls = (window as unknown as { __cfMockCalls?: Record<string, number> }).__cfMockCalls ?? {};
    return (calls.deleteJob ?? 0) + (calls.deleteJobs ?? 0);
  });

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("a row's Delete asks first, says what happens, and Undo brings the job back", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await (await bin(page, "Charity marathon")).click();
  const dialog = sheet(page);
  await expect(dialog.getByRole("heading", { name: "Delete this job?" })).toBeVisible();
  await expect(dialog).toContainText("Its working files go away.");
  await expect(dialog).toContainText("Clips you kept or posted stay. Your posts stay up too.");
  await expect(dialog).toContainText("You can undo for 8 seconds.");
  await expect(dialog).not.toContainText("stops first");
  // Keep it is the safe answer: focused first, and Escape means it too.
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row(page, "Charity marathon")).toBeVisible();

  await (await bin(page, "Charity marathon")).click();
  await sheet(page).getByRole("button", { name: "Delete job" }).click();
  await expect(row(page, "Charity marathon")).toHaveCount(0);
  await expect(page.locator(".toast", { hasText: "Job deleted." })).toBeVisible();
  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "Charity marathon")).toBeVisible();
  await page.clock.runFor(9000);
  expect(await deleteCalls(page)).toBe(0); // nothing was sent
});

test("a working job says it stops first, and the delete goes when Undo runs out", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  const before = await page.evaluate(() => document.querySelector(".sidebar__status")?.textContent ?? "");
  await (await bin(page, "Ranked grind")).click();
  await expect(sheet(page)).toContainText("It is still working, so it stops first.");
  await sheet(page).getByRole("button", { name: "Delete job" }).click();
  await expect(row(page, "Ranked grind")).toHaveCount(0);
  // The working count goes down at once, not after the server answers.
  if (before) await expect(page.locator(".sidebar__status")).not.toHaveText(before);
  await page.clock.runFor(9000);
  await expect.poll(() => deleteCalls(page)).toBe(1);
  await go(page, "/");
  await go(page, "/jobs");
  await expect(row(page, "Ranked grind")).toHaveCount(0);
});

test("the Review clips go only when the box is ticked", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  const waiting = await page.locator(".review-card").count();
  await go(page, "/jobs");
  await (await bin(page, "Heist night")).click();
  const toggle = sheet(page).getByRole("switch", { name: /Also delete its 4 clips in Review/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false"); // off unless the owner turns it on
  await expect(sheet(page)).toContainText("They stay in Review.");
  await toggle.click();
  await expect(sheet(page)).toContainText("They go with the job.");
  await sheet(page).getByRole("button", { name: "Delete job" }).click();
  await page.clock.runFor(9000);
  await expect.poll(() => deleteCalls(page)).toBe(1);
  await go(page, "/review");
  await expect(page.locator(".review-card")).toHaveCount(waiting - 4);
});

test("the job page deletes too, and a clip from a deleted job says the job is gone", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Heist night" }).click();
  await settle(page);
  await page.getByRole("button", { name: "Delete job" }).scrollIntoViewIfNeeded();
  await shot(page, "wide-7-job-page");
  await page.getByRole("button", { name: "Delete job" }).click();
  await expect(sheet(page).getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await sheet(page).getByRole("button", { name: "Delete job" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(row(page, "Heist night")).toHaveCount(0);
  await page.clock.runFor(9000);
  await expect.poll(() => deleteCalls(page)).toBe(1);
  // Its clips stayed in Review (box not ticked); each still links to its job, which now says it is gone.
  await go(page, "/review");
  const link = page.getByRole("link", { name: "See the job this clip came from" }).first();
  await link.click();
  await expect(page.getByRole("heading", { name: "This job is gone" })).toBeVisible();
  await expect(page.getByText("Clips you kept from it still work.")).toBeVisible();
});

test("Select picks several jobs, Pick all failed picks the failed ones, and one question deletes them", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.getByRole("button", { name: "Select" }).click();
  const bar = page.getByRole("toolbar", { name: "Picked jobs" });
  await expect(bar).toContainText("Tap the jobs to delete");
  await expect(bar.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("checkbox", { name: /Charity marathon/ }).click();
  await page.getByRole("checkbox", { name: /Live channel/ }).press("Space");
  await expect(bar).toContainText("2 jobs picked");
  await bar.getByRole("button", { name: /Pick all failed/ }).click();
  await expect(bar).toContainText("1 job picked");
  await page.getByRole("checkbox", { name: /Live channel/ }).click();
  await page.getByRole("checkbox", { name: /Ranked grind/ }).click();
  await expect(bar).toContainText("3 jobs picked");
  await bar.getByRole("button", { name: "Delete 3" }).click();
  await expect(sheet(page).getByRole("heading", { name: "Delete 3 jobs?" })).toBeVisible();
  await expect(sheet(page)).toContainText("1 is still working, so it stops first.");
  await sheet(page).getByRole("button", { name: "Delete 3 jobs" }).click();
  await expect(page.locator(".toast", { hasText: "3 jobs deleted." })).toBeVisible();
  await expect(bar).toBeHidden();
  for (const t of ["Charity marathon", "Live channel", "Ranked grind"]) await expect(row(page, t)).toHaveCount(0);
  await page.clock.runFor(9000);
  await expect.poll(() => deleteCalls(page)).toBe(1); // one call for all three
});

test("with the keyboard: Tab to a row shows its bin, and Enter opens the question", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-item", { hasText: "Charity marathon" }).locator(".job-row").focus();
  await page.keyboard.press("Tab");
  const button = row(page, "Charity marathon").getByRole("button", { name: /Delete job/ });
  await expect(button).toBeFocused();
  await expect(button).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(sheet(page).getByRole("heading", { name: "Delete this job?" })).toBeVisible();
});

test("a delete that fails brings the job back and says so", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.evaluate(() => {
    (window as unknown as { __cfMockFaults: { deleteJobFails: number } }).__cfMockFaults.deleteJobFails = 1;
  });
  await (await bin(page, "Charity marathon")).click();
  await sheet(page).getByRole("button", { name: "Delete job" }).click();
  await expect(row(page, "Charity marathon")).toHaveCount(0);
  await page.clock.runFor(9000);
  await expect(row(page, "Charity marathon")).toBeVisible();
  await expect(page.locator(".toast--error")).toContainText("The job is back in your list.");
});

test("a double-click on Keep it or Delete job never opens the job under the sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/jobs");
  await settle(page);
  const title = await page.locator(".job-item").nth(3).locator(".job-row__title").innerText();
  const centre = async (name: string) => {
    const b = (await sheet(page).getByRole("button", { name }).boundingBox())!;
    return [b.x + b.width / 2, b.y + b.height / 2] as const;
  };
  await (await bin(page, title)).click();
  await page.mouse.dblclick(...(await centre("Keep it")));
  await expect(sheet(page)).toBeHidden();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/jobs$/);

  await (await bin(page, title)).click();
  await page.mouse.dblclick(...(await centre("Delete job")));
  await expect(row(page, title)).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/jobs$/);

  // From a job's own page: the second click lands on the list it goes back to, and does nothing there.
  await page.locator(".job-row").first().click();
  await settle(page);
  await page.getByRole("button", { name: "Delete job" }).click();
  await page.mouse.dblclick(...(await centre("Delete job")));
  await expect(page).toHaveURL(/\/jobs$/);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/jobs$/);
});

test("a double tap on Select stays in Select (Make clips never slides under the finger), and Done ends it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");
  await settle(page);
  const select = page.getByRole("button", { name: "Select", exact: true });
  const b = (await select.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(120);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/jobs$/);
  const bar = page.getByRole("toolbar", { name: "Picked jobs" });
  await expect(bar).toBeVisible();
  // The header keeps its buttons where they were: a Cancel sits where Select was (never a "Done" that reads like a
  // confirm, so a child who picked jobs is not surprised that nothing was deleted).
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  const done = page.locator(".jobs-select");
  await expect(done).toHaveText("Cancel");
  const d = (await done.boundingBox())!;
  expect(Math.abs(d.x + d.width / 2 - (b.x + b.width / 2))).toBeLessThan(b.width / 2);
  await done.click();
  await expect(bar).toBeHidden();
  await expect(select).toBeVisible();
});

test("with the keyboard, Select and Cancel keep the focus on the page's controls, never on the body", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.getByRole("button", { name: "Select", exact: true }).focus();
  await page.keyboard.press("Space");
  const bar = page.getByRole("toolbar", { name: "Picked jobs" });
  await expect(bar).toBeVisible();
  await expect(page.locator(".jobs-select")).toBeFocused();
  await expect(page.locator(".jobs-select")).toHaveText("Cancel");
  await bar.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(bar).toBeHidden();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeFocused();
});

for (const size of SIZES) {
  test(`pictures and fit: ${size.name}`, async ({ browser }) => {
    // A phone is a touch screen (its bins always show); the Mac window has a mouse (a bin shows on its row).
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
      isMobile: size.touch,
    });
    const page = await context.newPage();
    await page.goto("/jobs");
    await settle(page);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(wide).toBe(false);
    const shown = await page.locator(".job-item__delete").evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility === "visible").length);
    if (size.touch) expect(shown).toBeGreaterThan(1);
    else expect(shown).toBe(0);
    // The Delete button is a real target (44 px at least) and sits inside its row.
    const button = size.touch ? row(page, "Charity marathon").getByRole("button", { name: /Delete job/ }) : await bin(page, "Charity marathon");
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const card = (await row(page, "Charity marathon").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
    await shot(page, `${size.name}-1-jobs-list`);

    await button.click();
    await expect(sheet(page)).toBeVisible();
    await shot(page, `${size.name}-2-confirm-sheet`);
    await sheet(page).getByRole("button", { name: "Keep it" }).click();

    await (await bin(page, "Heist night")).click();
    await sheet(page).getByRole("switch").click();
    await shot(page, `${size.name}-3-confirm-with-review-clips`);
    await sheet(page).getByRole("button", { name: "Keep it" }).click();

    await page.getByRole("button", { name: "Select" }).click();
    await page.getByRole("checkbox", { name: /Charity marathon/ }).click();
    await page.getByRole("checkbox", { name: /Ranked grind/ }).click();
    const bar = page.getByRole("toolbar", { name: "Picked jobs" });
    await expect(bar).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(size.height);
    await shot(page, `${size.name}-4-select-several`);
    await bar.getByRole("button", { name: "Delete 2" }).click();
    await shot(page, `${size.name}-5-confirm-several`);
    await sheet(page).getByRole("button", { name: "Delete 2 jobs" }).click();
    await expect(page.locator(".toast", { hasText: "2 jobs deleted." })).toBeVisible();
    await shot(page, `${size.name}-6-undo-toast`);
    await context.close();
  });
}
