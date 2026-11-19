import { expect, test, type Page } from "@playwright/test";
import type { Platform } from "../src/api/types.ts";
import { GUIDES, SETUP_ORDER } from "../src/setup/index.ts";
import { animationsDone, CLIPS, findOverflow, launcherSettled, MIXED_SETUP, mixedSetup, openClip, openTodo, settle } from "./helpers.ts";

// The floating "Set up posting" to-do list (docs/CONTRACTS.md §17.13): on every signed-in page, Set up and Skip
// (with a confirm) on every row that is not ready, un-skip, gone with a celebration when everything is ready or
// skipped, back when a platform needs the owner again, the same after a reload, Skip and Un-skip in Settings too, an
// open column from 1440 px, below that a pill on a glass bar (always on screen) and a panel, and never on top of a
// control.

type MockWindow = Window & {
  __cfMock?: { setup: { expireToken(p: Platform): void; reset(): void; finish(p: Platform): void; setCreditsEmpty(empty: boolean): void } };
  __cfMockCalls?: Record<string, number>;
  __cfSoundLog?: { kind: string }[];
};

/** The main signed-in pages (the setup pages themselves show the full list instead). */
const MAIN = ["/", "/jobs", "/review", "/library", "/settings", "/settings/posting", "/settings/posting/where", "/settings/look-and-feel/sounds", "/get-app"];

const finish = (page: Page, list: readonly Platform[]) =>
  page.evaluate((ps) => {
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ps) s.finish(p);
  }, list);

const row = (page: Page, p: Platform) => page.locator(`.setup-todo--rail .todo-row[data-platform='${p}'], .setup-todo-panel .todo-row[data-platform='${p}']`);

/** Skip a platform from the list: Skip, then the glass confirm's Skip {Platform}. */
async function skip(page: Page, p: Platform) {
  const list = await openTodo(page);
  await list.getByRole("button", { name: `Skip ${GUIDES[p].name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `Skip ${GUIDES[p].name}?` });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: `Skip ${GUIDES[p].name}`, exact: true }).click();
  await expect(sheet).toHaveCount(0);
  // The screen changes at once; wait for the (pretend) server to have it before anything reloads.
  await expect.poll(() => savedSkips(page)).toContain(p);
}

/** What the mock server saved (Settings.setupSkipped lives in sessionStorage in mock mode, §17.10). */
const savedSkips = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem("cf-mock-setup-skipped") ?? "[]") as string[]);

/** Starts the page with these platforms already skipped (as if confirmed on an earlier visit). */
const skippedBefore = (page: Page, list: readonly Platform[]) =>
  page.addInitScript((ps) => {
    if (!sessionStorage.getItem("cf-mock-setup-skipped")) sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(ps));
  }, list);

/**
 * Every control the list sits on where it can be seen: under the open column or the pill, and, at the top of the page
 * (where the pill's bar is clear), under the strip. Once the page scrolls, the strip is a frosted bar the page slides
 * under, so what passes there is behind glass, not under the pill (barHolds checks that bar).
 */
async function coveredControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const todo = document.querySelector<HTMLElement>(".setup-todo");
    if (!todo || Number(getComputedStyle(todo).opacity) === 0) return [];
    const bar = document.querySelector<HTMLElement>(".setup-todo-bar");
    if (bar?.classList.contains("is-scrolled")) return [];
    // At the top of the page the strip's bar is clear and takes no taps (from 940 px the page's first row shares it
    // with the pill, §11.1): only a bar that takes taps covers anything.
    const takesTaps = bar !== null && getComputedStyle(bar).pointerEvents !== "none";
    const boxes = [todo.getBoundingClientRect(), ...(bar && takesTaps ? [bar.getBoundingClientRect()] : [])];
    const SEL =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (el.closest(".setup-todo, .setup-todo-scrim, .sr-only, .skip-link, [inert]")) continue;
      // What shows of it: a tab scrolled out of its row (or anything clipped by a scroller) is not on screen there.
      const b = el.getBoundingClientRect();
      const r = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      for (let a = el.parentElement; a; a = a.parentElement) {
        const as = getComputedStyle(a);
        if (as.overflowX === "visible" && as.overflowY === "visible") continue;
        const ab = a.getBoundingClientRect();
        r.left = Math.max(r.left, ab.left);
        r.right = Math.min(r.right, ab.right);
        r.top = Math.max(r.top, ab.top);
        r.bottom = Math.min(r.bottom, ab.bottom);
      }
      if (r.right - r.left < 1 || r.bottom - r.top < 1) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
      if (boxes.some((t) => r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top))
        out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out;
  });
}

/** The cursors the list's own pressable things show (the pill, the rows' buttons, the question): only the arrow is allowed (§20.14). */
const listCursors = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".setup-todo, .setup-todo-panel, .sheet")]
      .flatMap((box) => [box, ...box.querySelectorAll("a, button, [role=button], [tabindex]")])
      .map((el) => getComputedStyle(el).cursor)
      .filter((c) => c !== "default"),
  );

/**
 * After a scroll: waits for the bar to be in the state the scroll asks for, then for its fade (it frosts over a quarter
 * of a second) and the pill's entrance to finish. The bar gets `is-scrolled` from a scroll listener, and the browser
 * sends scroll events with its next frame; on a slow machine (the Linux CI runner draws the glass without a GPU) that
 * frame can come later than any fixed wait, so this waits on the state, never on a clock.
 */
async function still(page: Page) {
  await page.waitForFunction(() => {
    const bar = document.querySelector(".setup-todo-bar");
    if (bar && bar.classList.contains("is-scrolled") !== window.scrollY > 0) return false;
    return Array.from(document.querySelectorAll(".setup-todo-bar, .setup-todo-bar__glass, .setup-todo")).every((el) => el.getAnimations().every((a) => a.playState !== "running"));
  });
}

/**
 * The open list has landed: its drop-in (which starts at 98 % size, so every button measures 2 % small until it ends)
 * and anything moving inside it are over. Waits on the animations themselves, for the same reason as `still`.
 */
async function landed(page: Page) {
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".setup-todo--rail, .setup-todo-panel")).every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== "running")),
  );
}

/** The pill right now: shown, inside the screen, and (once the page has scrolled) on a frosted bar that holds it. */
async function pillState(page: Page) {
  return page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>(".setup-todo__pill")!;
    const aside = pill.closest<HTMLElement>(".setup-todo")!;
    const bar = document.querySelector<HTMLElement>(".setup-todo-bar");
    const p = pill.getBoundingClientRect();
    const b = bar?.getBoundingClientRect();
    // The bar's glass is its child (it runs on below the strip and melts into the page).
    const glass = bar?.querySelector<HTMLElement>(".setup-todo-bar__glass");
    const barStyle = glass ? getComputedStyle(glass) : null;
    return {
      scrollY: window.scrollY,
      shown: Number(getComputedStyle(aside).opacity) === 1 && getComputedStyle(aside).pointerEvents !== "none",
      onScreen: p.top >= 0 && p.left >= 0 && p.right <= innerWidth && p.bottom <= innerHeight,
      barScrolled: !!bar?.classList.contains("is-scrolled"),
      barFrosted: !!barStyle && Number(barStyle.opacity) === 1 && /blur/.test(barStyle.backdropFilter || barStyle.getPropertyValue("-webkit-backdrop-filter")),
      pillOnBar: !!b && p.top >= b.top && p.bottom <= b.bottom && p.left >= b.left && p.right <= b.right,
    };
  });
}

test.describe("the floating setup list at 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows on every main page, and not on the setup pages", async ({ page }) => {
    for (const path of MAIN) {
      await page.goto(path);
      await settle(page);
      await expect(page.locator(".setup-todo--rail"), path).toBeVisible();
      await expect(page.locator(".setup-todo--rail .todo-row"), path).toHaveCount(5);
    }
    for (const path of ["/settings/posting/setup", "/settings/posting/setup/tiktok"]) {
      await page.goto(path);
      await settle(page);
      await expect(page.locator(".setup-todo"), path).toHaveCount(0);
    }
  });

  test("a clip's page keeps its whole width: there the list is the pill on its bar, and the lines still fan out", async ({ page }) => {
    await openClip(page, CLIPS.all);
    await expect(page.locator(".setup-todo")).toHaveAttribute("data-mode", "pill");
    await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "fan");
    expect(await coveredControls(page)).toEqual([]);
    // The pill opens the list as a panel here (no column to unfold).
    await page.locator(".setup-todo__pill").click();
    await expect(page.locator(".setup-todo-panel .todo-row")).toHaveCount(5);
    await page.keyboard.press("Escape");
    // Scrolled, the page slides under the glass bar and the pill stays.
    await page.evaluate(() => window.scrollTo(0, 600));
    await still(page);
    const s = await pillState(page);
    expect(s.scrollY).toBeGreaterThan(0);
    expect(s).toMatchObject({ shown: true, onScreen: true, barScrolled: true, barFrosted: true, pillOnBar: true });
    // Back to Library: the open column again.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator(".setup-todo--rail")).toBeVisible();
  });

  test("Set up opens the right platform's page", async ({ page }) => {
    for (const p of SETUP_ORDER) {
      await page.goto("/library");
      await settle(page);
      await row(page, p).getByRole("link", { name: `Set up ${GUIDES[p].name}` }).click();
      await expect(page).toHaveURL(new RegExp(`/settings/posting/setup/${p}$`));
      await expect(page.getByRole("heading", { level: 1, name: `Set up ${GUIDES[p].name}` })).toBeVisible();
    }
  });

  test("Skip asks first; only a confirmed skip counts; it lasts after a reload; un-skip brings it back", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const tiktok = row(page, "tiktok");
    await tiktok.getByRole("button", { name: "Skip TikTok" }).click();
    const sheet = page.getByRole("dialog", { name: "Skip TikTok?" });
    await expect(sheet).toContainText("You won't post there until you set it up. You can do it later in Settings.");
    // Keep it is the safe answer: first, focused and the strong button; Skip is the quiet one, with no celebration.
    const keep = sheet.getByRole("button", { name: "Keep it" });
    const yes = sheet.getByRole("button", { name: "Skip TikTok" });
    await expect(keep).toBeFocused();
    await expect(keep).toHaveClass(/btn--primary/);
    await expect(yes).toHaveClass(/btn--glass/);
    await expect(yes).not.toHaveAttribute("data-act");
    expect(await sheet.locator(".sheet__actions .btn").allInnerTexts()).toEqual(["Keep it", "Skip TikTok"]);
    // The pointer stays the plain arrow on the list and on the question; hover is what shows a button.
    expect(await listCursors(page)).toEqual([]);
    await keep.click();
    await expect(tiktok).toHaveAttribute("data-state", "not_started");
    // Escape is also "no", and so is a tap outside.
    await tiktok.getByRole("button", { name: "Skip TikTok" }).click();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await tiktok.getByRole("button", { name: "Skip TikTok" }).click();
    await page.locator(".sheet-scrim").click({ position: { x: 8, y: 8 } });
    await expect(sheet).toHaveCount(0);
    await expect(tiktok).toHaveAttribute("data-state", "not_started");
    expect(await savedSkips(page)).toEqual([]);

    await skip(page, "tiktok");
    await expect(tiktok).toHaveAttribute("data-state", "skipped");
    await expect(tiktok).toContainText("Skipped");
    await expect(page.locator(".setup-todo")).toContainText("1/5");

    // Saved on the server: the same after a reload.
    await page.reload();
    await settle(page);
    await expect(row(page, "tiktok")).toHaveAttribute("data-state", "skipped");

    // Un-skip from the list.
    await row(page, "tiktok").getByRole("button", { name: "Un-skip TikTok" }).click();
    await expect(row(page, "tiktok")).toHaveAttribute("data-state", "not_started");
    await expect(page.locator(".setup-todo")).toContainText("0/5");
    await expect.poll(() => savedSkips(page)).not.toContain("tiktok");
  });

  test("a platform that needs you can be skipped too, so skipping every one always ends the list; once ready, its skip is dropped", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    // X connected, but out of credits: it needs the owner.
    await page.evaluate(() => {
      const s = (window as MockWindow).__cfMock!.setup;
      s.setCreditsEmpty(true);
      s.finish("x");
    });
    await expect(row(page, "x")).toHaveAttribute("data-state", "needs_you");
    await expect(row(page, "x")).toContainText("Needs you: one more step");
    await row(page, "x").getByRole("button", { name: "Skip X" }).click();
    const sheet = page.getByRole("dialog", { name: "Skip X?" });
    // X is connected, so the question does not promise that nothing posts there.
    await expect(sheet).toContainText("X is connected but needs one more step. Skip only takes it off this list.");
    await sheet.getByRole("button", { name: "Skip X" }).click();
    await expect(row(page, "x")).toHaveAttribute("data-state", "skipped");
    await expect(row(page, "x").getByRole("button", { name: "Skip X", exact: true })).toHaveCount(0);
    await expect(row(page, "x").getByRole("button", { name: "Un-skip X", exact: true })).toBeVisible();
    await expect(page.locator(".setup-todo")).toContainText("1/5");
    await expect.poll(() => savedSkips(page)).toContain("x");

    for (const p of ["youtube", "tiktok", "instagram", "facebook"] as const) await skip(page, p);
    await expect(page.locator(".setup-todo--done")).toContainText("All skipped. Set them up any time in Settings.");
    // The last Skip went away with the column: the keyboard's place is the page now, not lost.
    await expect(page.locator("#main")).toBeFocused();
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });

    // X gets its credits back: Ready, and its skip goes, so it is no longer hidden as skipped…
    await page.evaluate(() => (window as MockWindow).__cfMock!.setup.setCreditsEmpty(false));
    await expect.poll(() => savedSkips(page)).not.toContain("x");
    await expect(page.locator(".setup-todo")).toHaveCount(0);
    // …so when it needs the owner again, the list comes back with it.
    await page.evaluate(() => (window as MockWindow).__cfMock!.setup.setCreditsEmpty(true));
    await expect(page.locator(".setup-todo--rail")).toBeVisible();
    await expect(row(page, "x")).toHaveAttribute("data-state", "needs_you");
    await expect(page.locator(".setup-todo")).toContainText("4/5");
  });

  test("ready and skipped: it celebrates, slides away, stays gone, and comes back when a platform needs you", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await finish(page, ["youtube", "tiktok", "instagram"]);
    await expect(row(page, "instagram")).toHaveAttribute("data-state", "ready");
    await expect(page.locator(".setup-todo")).toContainText("3/5");
    await skip(page, "facebook");
    await page.evaluate(() => ((window as MockWindow).__cfSoundLog = []));
    await skip(page, "x");

    // The last one: "All set!" with confetti and the success sound, then it slides away.
    await expect(page.locator(".setup-todo--done")).toContainText("All set!");
    await expect(page.locator(".setup-todo--done")).toContainText("Done for now. Skipped ones wait in Settings.");
    await expect(page.locator("canvas.confetti")).toHaveCount(1);
    expect(await page.evaluate(() => ((window as MockWindow).__cfSoundLog ?? []).map((e) => e.kind))).toContain("success");
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });
    // The page takes its room back.
    expect(await page.locator(".shell").evaluate((el) => getComputedStyle(el).paddingRight)).not.toMatch(/^3\d\d/);

    // Gone after a reload too, and Settings still has everything.
    await page.reload();
    await settle(page);
    // The wait is the test: given time, the list does not come back.
    await page.waitForTimeout(400);
    await expect(page.locator(".setup-todo")).toHaveCount(0);
    await page.goto("/settings/posting/setup");
    await settle(page);
    await expect(page.locator("#setup-todo")).toContainText("All done: the list is gone");
    await expect(page.locator("[data-skipped]")).toHaveCount(2);

    // YouTube loses its connection: the list comes back with that row.
    await page.goto("/jobs");
    await settle(page);
    await page.evaluate(() => (window as MockWindow).__cfMock!.setup.expireToken("youtube"));
    await expect(page.locator(".setup-todo--rail")).toBeVisible();
    await expect(row(page, "youtube")).toHaveAttribute("data-state", "needs_you");
    await expect(row(page, "youtube")).toContainText("Needs you: connect again");
    await expect(page.locator(".setup-todo")).toContainText("4/5");
  });

  test('all five ready: "Every place is ready."', async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await finish(page, ["youtube", "tiktok", "instagram", "facebook"]);
    await expect(page.locator(".setup-todo")).toContainText("4/5");
    await finish(page, ["x"]);
    await expect(page.locator(".setup-todo--done")).toContainText("Every place is ready.");
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });
  });

  test("no confetti with reduced motion, still the success sound and the goodbye", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await settle(page);
    await finish(page, ["youtube", "tiktok", "instagram", "facebook"]);
    await expect(page.locator(".setup-todo")).toContainText("4/5");
    await skip(page, "x");
    await expect(page.locator(".setup-todo--done")).toBeVisible();
    await expect(page.locator("canvas.confetti")).toHaveCount(0);
    expect(await page.evaluate(() => ((window as MockWindow).__cfSoundLog ?? []).map((e) => e.kind))).toContain("success");
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });
  });

  test("asks for the setups again on every page change, so it is right even without a live update", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const asked = () => page.evaluate(() => (window as MockWindow).__cfMockCalls?.getSetup ?? 0);
    const before = await asked();
    await page.locator(".sidebar").getByRole("link", { name: "Jobs", exact: true }).click();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect.poll(asked).toBeGreaterThan(before);
    await expect(page.locator(".setup-todo--rail .todo-row")).toHaveCount(5);
  });

  test("folds to a pill and unfolds; the choice stays on this device", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Make the setup list small" }).click();
    await expect(page.locator(".setup-todo__pill")).toContainText("Set up posting");
    await expect(page.locator(".setup-todo__pill")).toContainText("0/5");
    await page.reload();
    await settle(page);
    await expect(page.locator(".setup-todo--rail")).toHaveCount(0);
    await page.locator(".setup-todo__pill").click();
    await expect(page.locator(".setup-todo--rail")).toBeVisible();
  });

  test("Settings › Set up posting: Skip asks there too, the card says Skipped, and Un-skip brings it back", async ({ page }) => {
    await page.goto("/settings/posting/setup");
    await settle(page);
    const ask = page.locator("[data-skip='tiktok']").getByRole("button", { name: "Skip TikTok" });
    await ask.click();
    const sheet = page.getByRole("dialog", { name: "Skip TikTok?" });
    await expect(sheet.getByRole("button", { name: "Keep it" })).toBeFocused();
    await sheet.getByRole("button", { name: "Keep it" }).click();
    await expect(sheet).toHaveCount(0);
    expect(await savedSkips(page)).toEqual([]);

    await ask.click();
    await sheet.getByRole("button", { name: "Skip TikTok" }).click();
    await expect(page.locator("[data-skipped='tiktok']")).toContainText("You won't post to TikTok until you set it up.");
    await expect(page.locator(".setup-card[data-platform='tiktok'] .setup-card__state")).toHaveText("Skipped");
    await expect(page.locator("#setup-todo")).toContainText("On your screen: 1 of 5 done");
    await expect.poll(() => savedSkips(page)).toEqual(["tiktok"]);
    // Ready platforms have nothing to skip.
    await finish(page, ["youtube"]);
    await expect(page.locator(".setup-card[data-platform='youtube'] .setup-card__state")).toHaveText("Ready");
    await expect(page.locator("[data-skip='youtube'], [data-skipped='youtube']")).toHaveCount(0);

    // The floating list agrees, and Un-skip in Settings puts it back.
    await page.goto("/");
    await settle(page);
    await expect(row(page, "tiktok")).toHaveAttribute("data-state", "skipped");
    await page.goto("/settings/posting/setup");
    await settle(page);
    await page.getByRole("button", { name: "Un-skip TikTok" }).click();
    await expect(page.locator("[data-skipped='tiktok']")).toHaveCount(0);
    await expect(page.locator(".setup-card[data-platform='tiktok'] .setup-card__state")).toHaveText("Not started");
    await expect.poll(() => savedSkips(page)).not.toContain("tiktok");
    await page.goto("/");
    await settle(page);
    await expect(row(page, "tiktok")).toHaveAttribute("data-state", "not_started");
  });

  test("on short screens every row and its buttons still show without scrolling; a very short one fades the bottom", async ({ page }) => {
    await page.goto("/library");
    await settle(page);
    const rail = page.locator(".setup-todo--rail");
    const rows = rail.locator(".setup-todo__scroll");
    const fits = () => rows.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    const clearOfAsk = async () => {
      // The Ask pill looks at its spot once the window has stopped changing, and may glide a little: measure it after.
      await launcherSettled(page);
      const a = (await rail.boundingBox())!;
      const ask = (await page.locator(".help-launcher").boundingBox())!;
      return a.y + a.height <= ask.y;
    };
    // 900 px tall: the whole list, with its second line in the head and the line under the rows.
    expect(await fits()).toBe(true);
    await expect(rail.locator(".setup-todo__lede")).toBeVisible();
    await expect(rail.locator(".setup-todo__foot")).toBeInViewport({ ratio: 1 });
    expect(await clearOfAsk()).toBe(true);
    // A 900 px laptop screen inside a browser (about 790), and a 1080p one at 125 % (about 730): packed tighter,
    // every row and both of its buttons still on screen at once.
    for (const [width, height] of [
      [1440, 860],
      [1440, 790],
      [1536, 730],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(fits, { message: `${width}x${height}` }).toBe(true);
      await expect(rows, `${width}x${height}`).not.toHaveClass(/has-more/);
      await expect(rail.locator(".todo-row"), `${width}x${height}`).toHaveCount(5);
      for (const p of SETUP_ORDER) {
        await expect(rail.getByRole("link", { name: `Set up ${GUIDES[p].name}`, exact: true }), `${width}x${height}`).toBeInViewport({ ratio: 1 });
        await expect(rail.getByRole("button", { name: `Skip ${GUIDES[p].name}`, exact: true }), `${width}x${height}`).toBeInViewport({ ratio: 1 });
      }
      for (const b of await rail.locator("a, button").all()) expect((await b.boundingBox())!.height, `${width}x${height}`).toBeGreaterThanOrEqual(44);
      // Nothing between it and the Ask pill.
      expect(await clearOfAsk(), `${width}x${height}`).toBe(true);
    }

    // Too short for all of it: the bottom fades, so the list visibly goes on, and it scrolls to the last button.
    await page.setViewportSize({ width: 1440, height: 600 });
    await expect(rows).toHaveClass(/has-more/);
    await rows.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(rows).not.toHaveClass(/has-more/);
    await expect(rail.getByRole("button", { name: "Skip X" })).toBeInViewport({ ratio: 1 });
    expect(await clearOfAsk()).toBe(true);
  });

  test("the page keeps the room its layouts were made for: the column opens from 1440 px, below that it is the pill", async ({ page }) => {
    const room = () =>
      page.locator(".shell").evaluate((el) => {
        const s = getComputedStyle(el);
        return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      });
    /** The first character of every line the headline breaks into. */
    const lineStarts = () =>
      page.locator(".hero__title").evaluate((el) => {
        const starts: string[] = [];
        let lastTop = -Infinity;
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const text = n.textContent ?? "";
          for (let i = 0; i < text.length; i++) {
            if (!text[i]!.trim()) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const top = Math.round(r.getBoundingClientRect().top);
            if (top > lastTop + 4) starts.push(text[i]!);
            lastTop = Math.max(lastTop, top);
          }
        }
        return starts;
      });
    // What the page gets at 1100 px, where Home's two columns begin (the pill takes no width).
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/");
    await settle(page);
    await expect(page.locator(".setup-todo")).toHaveAttribute("data-mode", "pill");
    const least = await room();

    for (const [width, mode] of [
      [1280, "pill"],
      [1439, "pill"],
      [1440, "rail"],
      [1920, "rail"],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await settle(page);
      await expect(page.locator(".setup-todo"), `${width}`).toHaveAttribute("data-mode", mode);
      expect(await room(), `room for the page at ${width}`).toBeGreaterThanOrEqual(least);
      // Home's headline keeps its full stop with the last word (a squeezed column left it alone on a line).
      expect(await lineStarts(), `headline at ${width}`).not.toContain(".");
      const over = await findOverflow(page);
      expect(over.page, `${width}`).toBeLessThanOrEqual(over.viewport);
      expect(over.items, `${width}`).toEqual([]);
    }
  });
});

// The Ask pill sits under the open list. The list's buttons are controls it must never rest on (§19.8), and nothing
// of the page shows in that corner, so it keeps its place and shows: it never moves or fades out because of what is cut off
// there (a strip of the page that runs on under the column, rows scrolled out of the column on a short window).
test("the Ask pill keeps its corner under the open list at every scroll position", async ({ page }) => {
  test.setTimeout(120_000);
  const settled = () => launcherSettled(page);
  const failures: string[] = [];
  for (const [width, height, path] of [
    [1920, 900, "/library?update=1"],
    [1440, 900, "/library"],
    [1440, 900, "/review"],
    [1440, 600, "/library"],
    [1440, 600, "/settings/look-and-feel/sounds"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(path);
    await settle(page);
    await expect(page.locator(".setup-todo--rail"), path).toBeVisible();
    if (height === 600) await expect(page.locator(".setup-todo__scroll"), path).toHaveClass(/has-more/);
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    for (const y of [0, Math.round(max / 3), Math.round((2 * max) / 3), max]) {
      // Down to the spot and back up a little, so the launcher shows again.
      await page.evaluate(async (top) => {
        window.scrollTo({ top, behavior: "instant" });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        window.scrollTo({ top: Math.max(0, top - 40), behavior: "instant" });
      }, y);
      await settled();
      const state = await page.evaluate(() => {
        const ask = document.querySelector<HTMLElement>(".help-launcher")!;
        const a = ask.getBoundingClientRect();
        const rail = document.querySelector<HTMLElement>(".setup-todo--rail")!.getBoundingClientRect();
        const on: string[] = [];
        for (const c of Array.from(document.querySelectorAll<HTMLElement>(".setup-todo--rail a, .setup-todo--rail button"))) {
          const r = c.getBoundingClientRect();
          // What shows of it: the column cuts off rows that are scrolled out.
          const top = Math.max(r.top, rail.top);
          const bottom = Math.min(r.bottom, rail.bottom);
          if (bottom - top >= 1 && r.left < a.right && r.right > a.left && top < a.bottom && bottom > a.top) on.push(c.getAttribute("aria-label") ?? "");
        }
        return { moved: Math.round(ask.offsetTop - a.top), dodge: ask.dataset.dodge ?? null, hidden: ask.classList.contains("is-hidden"), on, gap: Math.round(a.top - rail.bottom) };
      });
      const at = `${path} ${width}x${height} at ${y}`;
      if (state.dodge !== null || state.hidden) failures.push(`${at}: the Ask pill faded out (${state.dodge})`);
      if (state.moved !== 0) failures.push(`${at}: the Ask pill moved up ${state.moved} px`);
      if (state.on.length) failures.push(`${at}: the Ask pill is on ${state.on.join(", ")}`);
      if (state.gap < 12) failures.push(`${at}: only ${state.gap} px between the list and the Ask pill`);
    }
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

// The list arrives a moment after the page (it waits for the setups). On a device that has seen it, its room is kept
// from the first paint, so the page does not jump when the list shows.
for (const size of [
  { width: 1440, height: 900, mode: "rail" },
  { width: 375, height: 812, mode: "pill" },
] as const) {
  test(`a reload keeps the list's room from the first paint at ${size.width} px`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    // Notes the shell's paddings every time the page changes, from its very first paint on.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cfShellLog: string[] }).__cfShellLog = seen;
      new MutationObserver(() => {
        const shell = document.querySelector(".shell");
        if (!shell) return;
        const s = getComputedStyle(shell);
        const entry = `${s.paddingTop} ${s.paddingRight} ${document.querySelector(".setup-todo__pill, .setup-todo--rail") ? "list" : "no list yet"}`;
        if (seen[seen.length - 1] !== entry) seen.push(entry);
      }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    await page.goto("/library");
    await settle(page);
    await expect(page.locator(".setup-todo")).toHaveAttribute("data-mode", size.mode);
    await expect(page.locator(".setup-todo__pill, .setup-todo--rail")).toBeVisible();
    const paddings = () =>
      page.locator(".shell").evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.paddingTop} ${s.paddingRight}`;
      });
    const withList = await paddings();

    await page.reload();
    await settle(page);
    await expect(page.locator(".setup-todo__pill, .setup-todo--rail")).toBeVisible();
    const log = await page.evaluate(() => (window as unknown as { __cfShellLog: string[] }).__cfShellLog);
    // The page was on screen before the list, already with the list's room, and never moved.
    expect(log[0], log.join(" | ")).toBe(`${withList} no list yet`);
    expect(log[log.length - 1], log.join(" | ")).toBe(`${withList} list`);
    expect(log, log.join(" | ")).toHaveLength(2);
  });
}

// "All set!" where there was no list (the setup pages) floats over the page and takes no room: nothing moves.
for (const size of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`"All set!" on a setup page does not move the page at ${size.width} px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await settle(page);
    await finish(page, ["youtube", "tiktok", "instagram", "facebook"]);
    await expect(page.locator(".setup-todo")).toContainText("4/5");
    await page.goto("/settings/posting/setup/x");
    await settle(page);
    await expect(page.locator(".setup-todo")).toHaveCount(0);
    const where = () =>
      page.evaluate(() => {
        const s = getComputedStyle(document.querySelector(".shell")!);
        const h = document.querySelector("h1")!.getBoundingClientRect();
        return `${s.paddingTop} ${s.paddingRight} ${Math.round(h.top)} ${Math.round(h.width)}`;
      });
    const before = await where();
    await finish(page, ["x"]);
    const done = page.locator(".setup-todo--done");
    await expect(done).toContainText("All set!");
    await expect(done).toHaveAttribute("data-mode", "done");
    for (let i = 0; i < 4; i++) {
      expect(await where(), `while it celebrates (${i})`).toBe(before);
      await page.waitForTimeout(350);
    }
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });
    expect(await where()).toBe(before);
  });
}

test.describe("the floating setup list on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a pill at the top opens the list; it covers neither the header nor the tab bar; Tab stays in the list", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const pill = page.locator(".setup-todo__pill");
    await expect(pill).toContainText("Set up posting");
    await expect(pill).toContainText("0/5");
    const box = (await pill.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const header = (await page.locator(".topbar").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(header.y);
    expect(await coveredControls(page)).toEqual([]);

    await pill.click();
    const panel = page.locator(".setup-todo-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".todo-row")).toHaveCount(5);
    // Measured once the panel has dropped in: where it rests, not a place on its way there.
    await animationsDone(page);
    const tabbar = (await page.locator(".tabbar").boundingBox())!;
    const p = (await panel.boundingBox())!;
    expect(p.y + p.height).toBeLessThanOrEqual(tabbar.y);
    // Phone targets are 48 px (kid-proof), with 8 px between the two buttons of a row.
    for (const b of await panel.locator(".btn, button").all()) {
      const size = (await b.boundingBox())!;
      expect(Math.min(size.width, size.height), await b.getAttribute("aria-label") ?? "").toBeGreaterThanOrEqual(48);
    }
    const gaps = await panel.locator(".todo-row__actions").evaluateAll((rows) =>
      rows.map((r) => {
        const [a, b] = Array.from(r.children).map((c) => c.getBoundingClientRect());
        return a && b ? Math.round(Math.max(b.left - a.right, b.top - a.bottom)) : 8;
      }),
    );
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(8);
    expect(await listCursors(page)).toEqual([]);

    // A real dialog: the page behind it is out of reach while it is open (messages stay tappable)…
    const behind = () =>
      page.evaluate(() => Object.fromEntries([".shell", ".tabbar", ".setup-todo", ".toasts"].map((sel) => [sel, !!document.querySelector(sel)?.closest("[inert]")])));
    expect(await behind()).toEqual({ ".shell": true, ".tabbar": true, ".setup-todo": true, ".toasts": false });
    // …and Tab past the last button comes back to the first, Shift+Tab from the first goes to the last.
    const inPanel = () => page.evaluate(() => !!document.activeElement?.closest(".setup-todo-panel"));
    await expect(panel.getByRole("button", { name: "Close the setup list" })).toBeFocused();
    const stops = await panel.locator("button, a[href]").count();
    for (let i = 0; i < stops + 3; i++) {
      await page.keyboard.press("Tab");
      expect(await inPanel(), `Tab ${i + 1}`).toBe(true);
    }
    await panel.getByRole("button", { name: "Close the setup list" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(panel.getByRole("button", { name: "Skip X" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "Close the setup list" })).toBeFocused();

    // Escape closes it, gives the focus back to the pill and the page back to the owner.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(pill).toBeFocused();
    expect(await behind()).toEqual({ ".shell": false, ".tabbar": false, ".setup-todo": false, ".toasts": false });

    // Set up from the panel goes to the platform, the panel closes, and focus lands on the new page as after any
    // page change.
    await pill.click();
    await panel.getByRole("link", { name: "Set up Instagram" }).click();
    await expect(page).toHaveURL(/\/settings\/posting\/setup\/instagram$/);
    await expect(page.locator(".setup-todo-panel")).toHaveCount(0);
    await expect(page.locator("#main")).toBeFocused();
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    // Back on the page it was opened on, it stays closed until the pill is tapped again.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".setup-todo-panel")).toHaveCount(0);
  });

  test("skip with the confirm on a phone, and it lasts after a reload", async ({ page }) => {
    await page.goto("/review");
    await settle(page);
    await skip(page, "x");
    await expect(row(page, "x")).toHaveAttribute("data-state", "skipped");
    await page.reload();
    await settle(page);
    await expect(page.locator(".setup-todo__pill")).toContainText("1/5");
  });

  test("the pill stays on screen all the way down every page: the page slides under a glass bar", async ({ page }) => {
    for (const path of ["/", "/jobs", "/review", "/library", "/settings"]) {
      await page.goto(path);
      await settle(page);
      for (const y of [0, 200, 400, 600, 800, 1200, 1800, 2400, 99_999]) {
        await page.evaluate((to) => window.scrollTo(0, to), y);
        await still(page);
        const s = await pillState(page);
        expect(s.shown && s.onScreen, `${path} at ${y}: the pill shows`).toBe(true);
        if (s.scrollY > 0) {
          expect(s.barScrolled && s.barFrosted && s.pillOnBar, `${path} at ${y}: on the frosted bar`).toBe(true);
          // The bar takes the taps meant for what is behind the glass.
          expect(await page.locator(".setup-todo-bar").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
        } else {
          expect(await coveredControls(page), `${path} at the top`).toEqual([]);
        }
      }
    }
    // A control the keyboard reaches is scrolled clear of the bar, never left under it: one sits under the bar, and
    // Tab from the control before it brings it out below the bar.
    await page.goto("/library");
    await settle(page);
    const under = await page.evaluate(async () => {
      const all = Array.from(document.querySelectorAll<HTMLElement>("main a[href], main button")).filter((e) => e.getBoundingClientRect().height > 0);
      const target = all[Math.floor(all.length / 2)]!;
      // Cards may still be settling in: put it 20 px from the top until it stays there.
      for (let i = 0; i < 20 && Math.abs(target.getBoundingClientRect().top - 20) > 1; i++) {
        window.scrollBy(0, target.getBoundingClientRect().top - 20);
        await new Promise((r) => setTimeout(r, 100));
      }
      target.setAttribute("data-tab-target", "");
      all[all.indexOf(target) - 1]!.focus({ preventScroll: true });
      return target.getBoundingClientRect().top;
    });
    const bar = (await page.locator(".setup-todo-bar").boundingBox())!;
    expect(under).toBeLessThan(bar.y + bar.height);
    await page.keyboard.press("Tab");
    const target = page.locator("[data-tab-target]");
    await expect(target).toBeFocused();
    await expect.poll(async () => (await target.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  });

  test("the last skip from the panel keeps the keyboard on the page", async ({ page }) => {
    await skippedBefore(page, ["youtube", "tiktok", "instagram", "facebook"]);
    await page.goto("/");
    await settle(page);
    await page.locator(".setup-todo__pill").focus();
    await page.keyboard.press("Enter");
    const panel = page.locator(".setup-todo-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Skip X" }).focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Skip X?" });
    await expect(sheet.getByRole("button", { name: "Keep it" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(sheet.getByRole("button", { name: "Skip X" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".setup-todo--done")).toContainText("All skipped");
    await expect(page.locator("#main")).toBeFocused();
    await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 6_000 });
    await expect(page.locator("#main")).toBeFocused();
  });
});

test("at 320 px the pill still says what it is", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await settle(page);
  const pill = page.locator(".setup-todo__pill");
  await expect(pill.locator(".setup-todo__pill-word")).toBeVisible();
  await expect(pill).toContainText("Set up posting");
  await expect(pill).toContainText("0/5");
  const box = (await pill.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

for (const width of [320, 375, 768, 1024, 1280, 1440, 1920] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`never covers a control and nothing overflows at ${width} px (${scheme})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      const failures: string[] = [];
      for (const path of MAIN) {
        await page.goto(path);
        await settle(page);
        await expect(page.locator(".setup-todo"), path).toBeVisible();
        for (const y of [0, 300, 99_999]) {
          await page.evaluate((to) => window.scrollTo(0, to), y);
          await still(page);
          for (const c of await coveredControls(page)) failures.push(`${path} at scroll ${y}: covers ${c}`);
          if ((await page.locator(".setup-todo__pill").count()) > 0) {
            const s = await pillState(page);
            if (!s.shown || !s.onScreen) failures.push(`${path} at scroll ${y}: the pill is not on screen`);
            if (s.scrollY > 0 && !(s.barScrolled && s.barFrosted && s.pillOnBar)) failures.push(`${path} at scroll ${y}: the pill is not on its frosted bar`);
          }
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await still(page);
        const r = await findOverflow(page);
        if (r.page > r.viewport) failures.push(`${path}: page scrolls sideways (${r.page} > ${r.viewport})`);
        for (const o of r.items) failures.push(`${path}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
      }
      // The open list (panel or column) fits too, with ≥ 44 px targets.
      await page.goto("/");
      await settle(page);
      const list = await openTodo(page);
      await landed(page);
      const r = await findOverflow(page);
      for (const o of r.items) failures.push(`open list: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
      if (r.page > r.viewport) failures.push(`open list: page scrolls sideways`);
      // Targets: 48 px on phones, 44 px from 768 px (--tap).
      const least = width < 768 ? 48 : 44;
      for (const b of await list.locator("a, button").all()) {
        const box = await b.boundingBox();
        if (box && (box.height < least - 0.5 || box.width < least - 0.5)) failures.push(`open list: target ${box.width}x${box.height} is under ${least} px`);
      }
      // The pill (not there while the column is open) is 48 px at every width.
      const pillBox = (await page.locator(".setup-todo__pill").count()) ? await page.locator(".setup-todo__pill").boundingBox() : null;
      if (pillBox && pillBox.height < 47.5) failures.push(`pill: ${pillBox.height} px tall`);
      const overflowing = await list.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>(".todo-row *")).filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).display !== "inline").map((c) => c.className));
      for (const o of overflowing) failures.push(`open list: ${o} overflows`);

      // The same with one row of every kind (a ready row's tick, "In progress: 1 of 23", "Needs you: connect again", Un-skip).
      await mixedSetup(page);
      await page.goto("/");
      await settle(page);
      const mixed = await openTodo(page);
      await landed(page);
      for (const [platform, state] of Object.entries(MIXED_SETUP)) await expect(mixed.locator(`.todo-row[data-platform='${platform}']`)).toHaveAttribute("data-state", state);
      const m = await findOverflow(page);
      for (const o of m.items) failures.push(`open list, every kind of row: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
      if (m.page > m.viewport) failures.push(`open list, every kind of row: page scrolls sideways`);
      for (const b of await mixed.locator("a, button").all()) {
        const box = await b.boundingBox();
        if (box && (box.height < least - 0.5 || box.width < least - 0.5)) failures.push(`open list, every kind of row: target ${box.width}x${box.height} is under ${least} px`);
      }
      const wide = await mixed.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>(".todo-row, .todo-row *")).filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).display !== "inline").map((c) => c.className));
      for (const o of wide) failures.push(`open list, every kind of row: ${o} overflows`);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
}
