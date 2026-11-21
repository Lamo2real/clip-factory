import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle } from "./helpers.ts";

// Does this clip fit the campaign? (docs/CONTRACTS.md §39.3, §39.5), in mock mode: the fit block for each verdict on
// a campaign clip's Review card, with its one vermilion and Upload on or off by canUpload; Fix it for me with its
// Undo; a wait that clears by itself; the copy arriving by live news; I read them. They're OK; the clip page's block
// and its fold; and every screen: no sideways scroll, no edges, big targets, the arrow cursor, AA contrast, reduced
// motion, the phone's main button on the right, Ask never over it.

const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;

type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { cr?: Knobs; setup?: Knobs; jobs?: Knobs } };

async function start(page: Page, flags: { remake?: boolean | "fail"; fresh?: boolean } = {}) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("cf-e2e-cr-fit")) return;
    sessionStorage.setItem("cf-e2e-cr-fit", "1");
    if (f.remake) sessionStorage.setItem("cf-mock-cr-remake", f.remake === "fail" ? "fail" : "on");
    if (f.fresh) sessionStorage.setItem("cf-mock-cr-start", "fresh");
  }, flags);
}
const knob = (page: Page, group: "cr" | "jobs" | "setup", fn: string, ...args: unknown[]) =>
  page.evaluate(([g, fn, args]) => (window as MockWin).__cfMock![g as "cr"]![fn as string]!(...(args as unknown[])), [group, fn, args] as const);
const tomatoes = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });
/** In-app navigation: the pretend app keeps its new jobs and clips in this page only (a reload starts over). */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

/** FaZe Clips' campaign clips of one new job, on /review?job= (the first card is a campaign clip). */
async function campaignClips(page: Page, link = VIDEO) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.jobs && !!(window as MockWin).__cfMock?.setup);
  await knob(page, "setup", "finish", "youtube");
  await knob(page, "setup", "finish", "instagram");
  await page.goto(`/?campaign=${FAZE}`);
  await settle(page);
  await page.getByLabel("YouTube, Twitch or Kick link").fill(link);
  await page.locator("form.newjob").getByRole("button", { name: "Make campaign clips", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await knob(page, "jobs", "finish");
  await page.getByRole("link", { name: "Check these clips" }).click();
  await expect(page).toHaveURL(/\/review\?job=/);
  const card = page.locator(".review-list__item").first().locator(".review-card");
  await expect(card.locator(".cr-fit")).toBeVisible();
  const clipId = ((await card.getAttribute("aria-labelledby")) ?? "").replace(/^hook-/, "");
  return { card, clipId };
}

test.describe("the fit block on Review", () => {
  test.use(DESKTOP);

  test("fits: Can earn, the ok items folded, Upload the one vermilion; Fix it for me with an 8 s Undo", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page);
    const { card } = await campaignClips(page);
    const fit = card.locator(".cr-fit");
    await expect(fit).toContainText("Campaign clip · FaZe Clips");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Can earn on FaZe Clips");
    await expect(fit).toContainText("After it posts, Clip Factory sends it to Content Rewards by itself.");
    await expect(fit.locator("summary", { hasText: /See what's right \(\d+\)/ })).toBeVisible();
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/^Upload to 2$/);
    // He deletes a tag: still Can earn, and the optional Fix it for me puts it back.
    await card.locator("[data-place='instagram'] summary").click();
    const ig = card.getByLabel("Instagram caption");
    const was = await ig.inputValue();
    await ig.fill(was.replace("#FaZe", "").trim());
    await expect(fit).toContainText("The Instagram words are missing #FaZe. I'll put it back when it uploads.");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Can earn on FaZe Clips");
    const fix = fit.getByRole("button", { name: "Fix it for me" });
    await expect(fix).toHaveClass(/btn--glass/);
    await fix.click();
    await expect(page.getByText("Fixed: #FaZe is back.")).toBeVisible();
    await expect(ig).toHaveValue(/#FaZe/);
    await expect(fit).not.toContainText("missing #FaZe");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(ig).not.toHaveValue(/#FaZe\b/);
  });

  test("wait: Wait a little, Upload off with its words and still the vermilion; it turns on by itself", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    await knob(page, "cr", "hold", FAZE, true);
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Wait a little for FaZe Clips");
    await expect(fit).toContainText("Content Rewards wants the brand to check your other clips first.");
    await expect(fit).toContainText("Keep it here. Upload turns on by itself when it can go.");
    const upload = card.getByRole("button", { name: /^Upload to 2$/ });
    await expect(upload).toHaveAttribute("aria-disabled", "true");
    await expect(upload).toHaveClass(/btn--primary/);
    await expect(card.locator(".upload-going")).toContainText("Content Rewards wants the brand to check your other clips first.");
    await expect(tomatoes(page)).toHaveCount(1);
    await knob(page, "cr", "hold", FAZE, false);
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Can earn on FaZe Clips");
    await expect(upload).not.toHaveAttribute("aria-disabled", "true");
  });

  test("doesn't fit: the length; Make new clips for this campaign is the vermilion (with this video's link), Upload off", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    await knob(page, "cr", "setRules", FAZE, { lengthMinSec: 5, lengthMaxSec: 10 });
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("This clip can't earn on FaZe Clips");
    await expect(fit).toContainText(/This clip is \d+ seconds\. FaZe Clips takes 5 to 10 seconds\./);
    const main = fit.getByRole("link", { name: "Make new clips for this campaign" });
    await expect(main).toHaveClass(/btn--primary/);
    await expect(main).toHaveAttribute("href", `/?campaign=${FAZE}&link=${encodeURIComponent(VIDEO)}`);
    const upload = card.getByRole("button", { name: /^Upload to 2$/ });
    await expect(upload).toHaveClass(/btn--glass/);
    // Held, not dead (aria-disabled): a tap says why.
    await upload.click({ force: true });
    await expect(page.locator(".toast").filter({ hasText: "This clip can't earn on FaZe Clips." })).toHaveCount(1);
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
    await main.click();
    await expect(page).toHaveURL(new RegExp(`/\\?campaign=${FAZE}&link=`));
    await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue(VIDEO);
  });

  test("One thing first: no place Content Rewards knows; its button is the vermilion and Upload is off", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    await knob(page, "cr", "unlink", "youtube");
    await knob(page, "cr", "unlink", "instagram");
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("One thing first for FaZe Clips");
    await expect(fit).toContainText("Add YouTube in Content Rewards first. Then tap I added it.");
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(fit.locator(".btn--primary")).toHaveText(/Open Content Rewards settings/);
    // One thing at a time: the first todo only, one Open (never twice), and its own green I added it right there.
    await expect(fit).not.toContainText("Instagram account");
    await expect(fit.getByRole("link", { name: /Open Content Rewards settings/ })).toHaveCount(1);
    const added = fit.getByRole("button", { name: "I added it" });
    await expect(added).toHaveClass(/btn--leaf/);
    await added.click();
    await expect(fit.locator(".cr-fit__headline")).not.toHaveText("One thing first for FaZe Clips");
    await expect(fit).not.toContainText("Add YouTube in Content Rewards first.");
  });

  test("the block leads the card: above what the clip is and its Upload, on a phone and on a wide screen", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const fit = (await card.locator(".cr-fit").boundingBox())!;
      const head = (await card.locator(".review-card__head").boundingBox())!;
      const upload = (await card.getByRole("button", { name: /^Upload to 2$/ }).boundingBox())!;
      expect(fit.y, `${width}: the block starts above the clip's words`).toBeLessThan(head.y);
      expect(fit.y + fit.height, `${width}: the block ends above Upload`).toBeLessThanOrEqual(upload.y);
    }
  });

  test("a Kick video on FaZe Clips (YouTube and Twitch only): can't earn, with its reason and Make new clips", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page, "https://kick.com/video/3b7f2c1e-faze-clutch");
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("This clip can't earn on FaZe Clips");
    await expect(fit).toContainText("FaZe Clips doesn't pay for clips of Kick videos.");
    // The doesn't-fit block says only why: no send note under a can't-earn headline.
    await expect(fit).not.toContainText("After it posts");
    const main = fit.getByRole("link", { name: "Make new clips for this campaign" });
    await expect(main).toHaveClass(/btn--primary/);
    await expect(main).toHaveAttribute("href", `/?campaign=${FAZE}`);
  });

  test("a copy whose job failed: Making… goes away and Make a FaZe Clips copy comes back", async ({ page }) => {
    await start(page, { remake: "fail" });
    const { card, clipId } = await campaignClips(page);
    await knob(page, "jobs", "checklist", clipId, "disclosure", false);
    const fit = card.locator(".cr-fit");
    const make = fit.getByRole("button", { name: "Make a FaZe Clips copy" });
    await expect(make).toHaveClass(/btn--primary/);
    await make.click();
    await expect(fit).toContainText("Making a FaZe Clips copy… It shows here in about 3 minutes.");
    await expect(make).toHaveCount(0);
    await expect(card.locator(".upload-going")).toContainText("Making a FaZe Clips copy…");
    // The copy's job fails (the pretend agent): the block reads that job and offers the copy again.
    await expect(fit).not.toContainText("Making a FaZe Clips copy…", { timeout: 15_000 });
    await expect(fit.getByRole("button", { name: "Make a FaZe Clips copy" })).toHaveClass(/btn--primary/);
    await expect(card.locator(".upload-going")).toContainText("Tap Make a FaZe Clips copy first.");
    // The clip page reads the same job: the button, not Making… for good.
    await go(page, `/clips/${clipId}`);
    await expect(page.locator(".cr-clip-fit").getByRole("button", { name: "Make a FaZe Clips copy" })).toBeVisible();
    await expect(page.locator(".cr-clip-fit")).not.toContainText("Making a FaZe Clips copy…");
  });

  test("a copy: Make a FaZe Clips copy is the vermilion; the copy arrives right below by live news", async ({ page }) => {
    await start(page, { remake: true });
    const { card, clipId } = await campaignClips(page);
    await knob(page, "jobs", "checklist", clipId, "disclosure", false);
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("FaZe Clips needs a copy of this clip");
    await expect(fit).toContainText("“Paid partnership” isn't on the video.");
    const make = fit.getByRole("button", { name: "Make a FaZe Clips copy" });
    await expect(make).toHaveClass(/btn--primary/);
    await expect(card.getByRole("button", { name: /^Upload to 2$/ })).toHaveClass(/btn--glass/);
    await expect(card.locator(".upload-going")).toContainText("Tap Make a FaZe Clips copy first.");
    const before = await page.locator(".review-list__item").count();
    await make.click();
    await expect(fit).toContainText("Making a FaZe Clips copy… It shows here in about 3 minutes.");
    await expect(page.locator(".review-list__item")).toHaveCount(before + 1, { timeout: 15_000 });
    await expect(fit).toContainText("The FaZe Clips copy is ready, right below.");
    const copy = page.locator(".review-list__item").nth(1).locator(".review-card");
    await expect(copy.locator(".cr-fit__headline")).toHaveText("Can earn on FaZe Clips");
  });

  test("can't tell: I couldn't check these, Read the rules once, I read them folds it (this device), a new line opens it", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    await knob(page, "cr", "setRules", FAZE, { uncertain: ["Clips must feel organic", "No other brands on screen"] });
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Check 2 things, then upload");
    await expect(fit).toContainText("I couldn't check these:");
    await expect(fit.getByRole("link", { name: "Read the rules" })).toHaveCount(1);
    await expect(fit.getByRole("link", { name: "Read the rules" })).toHaveAttribute("href", `/campaigns/${FAZE}#rules`);
    const upload = card.getByRole("button", { name: /^Upload to 2$/ });
    await expect(upload).toHaveClass(/btn--primary/);
    await fit.getByRole("button", { name: "I read them. They're OK" }).click();
    await expect(fit.locator(".cr-fit__headline")).toHaveText("You checked these for FaZe Clips");
    await expect(fit.locator("summary", { hasText: "You checked this (2)" })).toBeVisible();
    await expect(upload).toHaveClass(/btn--primary/);
    // Kept on this device: away and back, it is still checked.
    const review = page.url().replace(/^https?:\/\/[^/]+/, "");
    await go(page, "/");
    await go(page, review);
    await expect(page.locator(".review-list__item").first().locator(".cr-fit__headline")).toHaveText("You checked these for FaZe Clips");
    await knob(page, "cr", "setRules", FAZE, { uncertain: ["Clips must feel organic", "Show the game's logo"] });
    await expect(page.locator(".review-list__item").first().locator(".cr-fit__headline")).toHaveText("Check 2 things, then upload");
    // Read the rules lands on the card's rules.
    await page.locator(".review-list__item").first().getByRole("link", { name: "Read the rules" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${FAZE}#rules$`));
    await expect(page.locator("#rules")).toBeInViewport();
  });

  test("Check 1 thing: I couldn't check these: heads only its own line, the other lines sit apart with room between", async ({ page }) => {
    await start(page);
    const { card } = await campaignClips(page);
    await knob(page, "cr", "setRules", FAZE, { uncertain: ["Clips must feel organic"] });
    const fit = card.locator(".cr-fit");
    await expect(fit.locator(".cr-fit__headline")).toHaveText("Check 1 thing, then upload");
    const group = fit.locator(".cr-fit__checks");
    await expect(group.locator(".cr-fit__lead")).toHaveText("I couldn't check these:");
    // The heading's own list holds exactly its line; every other line of the block is outside the group.
    await expect(group.locator(".cr-fit__line")).toHaveCount(1);
    await expect(group.locator(".cr-fit__line[data-state='check']")).toHaveCount(1);
    await expect(group.locator("ul")).toHaveAttribute("aria-labelledby", (await group.locator(".cr-fit__lead").getAttribute("id"))!);
    const geo = await fit.evaluate((el) => {
      const g = el.querySelector(".cr-fit__checks")!.getBoundingClientRect();
      const others = [...el.querySelectorAll(":scope > .cr-fit__lines > .cr-fit__line")].map((li) => li.getBoundingClientRect());
      const lines = [...el.querySelectorAll(":scope > .cr-fit__checks .cr-fit__line")].map((li) => li.getBoundingClientRect());
      const gap = parseFloat(getComputedStyle(el.querySelector(".cr-fit__checks .cr-fit__lines")!).rowGap) || 0;
      return { bottom: g.bottom, others: others.map((r) => r.top), inside: lines.every((r) => r.top >= g.top && r.bottom <= g.bottom), withinGap: gap };
    });
    expect(geo.inside).toBe(true);
    expect(geo.others.length, "the send note (and any fix) after the group").toBeGreaterThan(0);
    // Clear room between the group and the next line: more than the gap between two lines of one list.
    for (const top of geo.others) expect(top - geo.bottom).toBeGreaterThan(geo.withinGap + 4);
    expect(await visibleEdges(page).then((e) => e.filter((x) => /cr-fit/.test(x)))).toEqual([]);
  });

  test("the job page: Campaign clips · FaZe Clips · Following its rules; Library: a Campaign chip on campaign clips only", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await page.waitForFunction(() => !!(window as MockWin).__cfMock?.jobs && !!(window as MockWin).__cfMock?.setup);
    await knob(page, "setup", "finish", "youtube");
    await knob(page, "setup", "finish", "instagram");
    // The count the strip names is the campaign's own rules, as its card lists them.
    await go(page, `/campaigns/${FAZE}`);
    const rules = await page.locator("#rules [data-help='cr-rules'] .cr-ticks li").count();
    expect(rules).toBeGreaterThan(1);
    await go(page, `/?campaign=${FAZE}`);
    await page.getByLabel("YouTube, Twitch or Kick link").fill(VIDEO);
    await page.locator("form.newjob").getByRole("button", { name: "Make campaign clips", exact: true }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
    const strip = page.locator(".cr-job [data-cr='job-strip']");
    await expect(strip).toHaveText(`Campaign clips · FaZe Clips · Following ${rules} rules`);
    await expect(strip.getByRole("link", { name: "FaZe Clips" })).toHaveAttribute("href", `/campaigns/${FAZE}`);
    await expect(page.locator(".cr-job")).not.toContainText("on Content Rewards");
    // Narrow phones: the strip wraps, but each dot stays with the words after it (never alone at a line's end), the
    // coin sits on the first line, and a long campaign name wraps inside its link, never past the strip's edge.
    const stripLines = () =>
      strip.evaluate((h) => {
        const box = h.querySelector(".cr-job__strip")!;
        const rows = new Map<number, string>();
        const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        const r = document.createRange();
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          for (let i = 0; i < n.textContent!.length; i++) {
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const at = r.getClientRects()[0];
            if (at) rows.set(Math.round(at.top / 8), (rows.get(Math.round(at.top / 8)) ?? "") + n.textContent![i]);
          }
        }
        r.selectNodeContents(box.firstChild!);
        const words = r.getBoundingClientRect();
        const coin = h.querySelector(".icon")!.getBoundingClientRect();
        return {
          lines: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.trim()),
          coinOff: Math.abs(coin.top + coin.height / 2 - (words.top + words.height / 2)),
          over: box.scrollWidth - box.clientWidth,
        };
      });
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const got = await stripLines();
      expect(got.lines.length, `${width}: wraps`).toBeGreaterThan(1);
      for (const l of got.lines) expect(l, `${width}: a dot alone at a line's end`).not.toMatch(/·$/);
      expect(got.coinOff, `${width}: the coin on the first line`).toBeLessThanOrEqual(3);
      expect(got.over, `${width}: past the edge`).toBeLessThanOrEqual(0);
    }
    await strip.getByRole("link").evaluate((a) => (a.textContent = "The Very Long Campaign Name For Summer Sneaker Drop Clips"));
    const long = await stripLines();
    expect(long.over, "a long name past the edge").toBeLessThanOrEqual(0);
    for (const l of long.lines) expect(l).not.toMatch(/·$/);
    await strip.getByRole("link").evaluate((a) => (a.textContent = "FaZe Clips"));
    await page.setViewportSize(DESKTOP.viewport);
    // Upload the first campaign clip, then Library shows it with the small Campaign chip; normal clips carry none.
    await knob(page, "jobs", "finish");
    await page.getByRole("link", { name: "Check these clips" }).click();
    await expect(page).toHaveURL(/\/review\?job=/);
    const card = page.locator(".review-list__item").first().locator(".review-card");
    await expect(card.locator(".cr-fit")).toBeVisible();
    const clipId = ((await card.getAttribute("aria-labelledby")) ?? "").replace(/^hook-/, "");
    const mine = card.getByRole("button", { name: "Use my settings" });
    if (await mine.count()) await mine.click();
    await card.getByRole("button", { name: /^Upload to \d/ }).click();
    await expect(page.getByText(/Uploading to \d places?!/)).toBeVisible();
    await go(page, "/library");
    const libCard = page.locator(".lib-card").filter({ has: page.locator(`#lib-${clipId}`) });
    await expect(libCard.locator("[data-cr='campaign-chip']")).toHaveText("Campaign");
    expect(await page.locator(".lib-card").count()).toBeGreaterThan(1);
    await expect(page.locator("[data-cr='campaign-chip']")).toHaveCount(1);
  });

  test("the clip page: the same block while it waits in Review; a normal clip's fold Can it earn on your campaigns?", async ({ page }) => {
    await start(page, { remake: true });
    const { clipId } = await campaignClips(page);
    await go(page, `/clips/${clipId}`);
    await expect(page.locator(".cr-clip-fit .cr-fit__headline")).toHaveText("Can earn on FaZe Clips");
    await expect(page.locator(".cr-clip-fit__all")).toHaveCount(0);
    // No numbers yet because it waits in Review: the page sends him to Review, where it can be uploaded.
    const empty = page.locator(".empty");
    if (await empty.count()) {
      await expect(empty).toContainText("It waits in Review. Upload it there first.");
      await expect(empty.getByRole("link", { name: "Go to Review" })).toHaveClass(/btn--primary/);
      await expect(empty.getByRole("link", { name: "Go to Library" })).toHaveCount(0);
    }
    // A normal clip waiting in Review: the could-earn line, and the fold, closed by default.
    await go(page, "/review");
    const normal = page.locator(".review-card").filter({ has: page.locator(".cr-suggest") }).first();
    const id = ((await normal.getAttribute("aria-labelledby")) ?? "").replace(/^hook-/, "");
    await go(page, `/clips/${id}`);
    await expect(page.locator(".cr-suggest")).toContainText(/This clip could earn money on .+\./);
    const fold = page.locator(".cr-clip-fit__all");
    await expect(fold).toBeVisible();
    await expect(fold).not.toHaveAttribute("open", "");
    await fold.locator("summary").click();
    await expect(fold.locator("li").first()).toContainText(/(Can earn|can't earn|Check|Wait|needs a copy|One thing|Almost)/);
  });

  test("Home at /?campaign= with one campaign ready: no Which campaign bar", async ({ page }) => {
    await start(page, { fresh: true });
    await page.goto("/");
    await page.waitForFunction(() => !!(window as MockWin).__cfMock?.cr);
    await knob(page, "setup", "finish", "youtube");
    await knob(page, "cr", "connect");
    await page.goto("/campaigns");
    await settle(page);
    await page.getByLabel("Paste a Content Rewards campaign link").fill(`https://contentrewards.com/c/campaigns/${FAZE}`);
    await page.getByRole("button", { name: "Add campaign" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${FAZE}$`));
    await knob(page, "cr", "join", FAZE);
    await page.goto(`/?campaign=${FAZE}`);
    await settle(page);
    await expect(page.locator(".cr-way")).toContainText("Campaign clips · FaZe Clips");
    await expect(page.locator(".cr-for")).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const)
  for (const [name, use] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ] as const)
    test.describe(`the fit's screens, ${name}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme, reducedMotion: "reduce" });
      test("no sideways scroll, no edges, big targets, the arrow cursor, AA contrast, one vermilion on the right, Ask clear of it", async ({ page }) => {
        test.setTimeout(120_000);
        const phone = name === "phone";
        await start(page, { remake: true });
        const { clipId } = await campaignClips(page);
        const failures: string[] = [];
        for (const path of [page.url().replace(/^https?:\/\/[^/]+/, ""), `/clips/${clipId}`, `/?campaign=${FAZE}`]) {
          await go(page, path);
          await expect(page.locator(".cr-fit, .cr-suggest, .cr-way, .cr-clip-fit").first()).toBeVisible();
          await page.waitForTimeout(400);
          const o = await findOverflow(page);
          if (o.page > o.viewport) failures.push(`${path}: sideways scroll ${o.page} > ${o.viewport}`);
          for (const e of (await visibleEdges(page)).filter((x) => /cr-/.test(x))) failures.push(`${path}: edge ${e}`);
          const bad = await page.evaluate((min) => {
            const out: string[] = [];
            for (const e of document.querySelectorAll<HTMLElement>(".cr-fit button, .cr-fit a.btn, .cr-fit summary, .cr-suggest button, .cr-way a.btn, .cr-clip-fit summary")) {
              const b = e.getBoundingClientRect();
              if (!b.width) continue;
              if (b.height < min - 0.5) out.push(`"${e.textContent?.trim().slice(0, 30)}" is ${Math.round(b.height)} px`);
              const cur = getComputedStyle(e).cursor;
              if (cur !== "auto" && cur !== "default") out.push(`"${e.textContent?.trim().slice(0, 30)}" has cursor ${cur}`);
            }
            // Reduced motion: nothing in the fit moves.
            for (const a of document.getAnimations()) {
              const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
              if (t?.closest(".cr-fit, .cr-suggest, .cr-way") && a.playState === "running") out.push(`an animation runs on ${t.className}`);
            }
            return out;
          }, phone ? 48 : 44);
          for (const b of bad) failures.push(`${path}: ${b}`);
          const reds = await tomatoes(page).count();
          if (reds > 1) failures.push(`${path}: ${reds} vermilion buttons`);
          const axe = await new AxeBuilder({ page }).include(".cr-fit, .cr-suggest, .cr-way, .cr-clip-fit").withRules(["color-contrast"]).analyze();
          for (const v of axe.violations) for (const n of v.nodes) failures.push(`${path}: contrast ${n.target.join(" ")}`);
          const main = tomatoes(page).first();
          if (phone && (await main.count())) {
            await main.scrollIntoViewIfNeeded();
            const box = (await main.boundingBox())!;
            if (box.x + box.width < page.viewportSize()!.width / 2) failures.push(`${path}: the main button is not on the right`);
            const ask = await page.locator(".help-launcher").boundingBox();
            if (ask && ask.x < box.x + box.width && box.x < ask.x + ask.width && ask.y < box.y + box.height && box.y < ask.y + ask.height)
              failures.push(`${path}: Ask sits over the main button`);
          }
        }
        expect(failures, failures.join("\n")).toEqual([]);
      });
    });

test("no sideways scroll from 320 to 1920 on Review with the fit block and the campaign way", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, { remake: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { clipId } = await campaignClips(page);
  const review = page.url().replace(/^https?:\/\/[^/]+/, "");
  const failures: string[] = [];
  for (const width of [320, 360, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [review, `/clips/${clipId}`, `/?campaign=${FAZE}`]) {
      await go(page, path);
      const o = await findOverflow(page);
      if (o.page > o.viewport) failures.push(`${width} ${path}: ${o.page} > ${o.viewport}`);
    }
  }
  expect(failures).toEqual([]);
});
