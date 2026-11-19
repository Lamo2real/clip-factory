import { expect, test, type Page } from "@playwright/test";
import type { Platform } from "../src/api/types.ts";
import { MOCK_VALUES } from "../src/api/mock/setup.ts";
import { maskKey } from "../src/lib/keyFormats.ts";
import { allSteps, checkedOnText, GUIDES, resolveValue, resultCopy, SETUP_ORDER, stepNumber, type GuideStep } from "../src/setup/index.ts";
import { animationsDone, findOverflow, openTodo, settle } from "./helpers.ts";

// The posting setup, clicked through for every platform on a phone and on a desktop (docs/CONTRACTS.md §17.12):
// the floating setup list (§17.13) → Set up posting → the platform's steps → keys → Check it → Connect on the pretend consent page →
// connected with confetti; Cancel, a dead token, Disconnect with Undo, and a reload that resumes.

type MockWindow = Window & {
  __cfMock?: { setup: { expireToken(p: Platform): void; reset(): void; finish(p: Platform): void } };
};

const KEYS: Record<Platform, { clientId: string; clientSecret: string; configId?: string }> = {
  youtube: { clientId: "123456789012-abcdefghij0123456789klmnopqrst.apps." + "googleusercontent.com", clientSecret: "GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12" },
  tiktok: { clientId: "awx1y2z3b4c5d6e7", clientSecret: "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe" },
  instagram: { clientId: "1234567890123456", clientSecret: "0123456789abcdef0123456789abcdef", configId: "9876543210987654" },
  facebook: { clientId: "2345678901234567", clientSecret: "fedcba9876543210fedcba9876543210", configId: "1122334455667788" },
  x: { clientId: "dGhpc2lzYWNsaWVudGlkMTIz", clientSecret: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" },
};
const LABELS: Record<Platform, string[]> = {
  youtube: ["Client ID", "Client secret"],
  tiktok: ["Client key", "Client secret"],
  instagram: ["App ID", "App secret", "Configuration ID"],
  facebook: ["App ID", "App secret", "Configuration ID"],
  x: ["Client ID", "Client Secret"],
};
/** Meta asks which account; the journey picks the second one. */
const CHOICE: Partial<Record<Platform, string>> = { instagram: "@clipfactory.backup", facebook: "Clip Factory Fans" };

const SIZES = [
  { name: "phone", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);
const soundKinds = (page: Page) => page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind));
/** Every choice in a setup picker is a real tap target (≥ 44 px tall). */
async function pickerTargets(page: Page, id: string, label: string, failures: string[]) {
  await animationsDone(page);
  const sizes = await step(page, id)
    .locator(".gstep__picker .segmented__opt")
    .evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim() ?? "", ...e.getBoundingClientRect().toJSON() }) as { text: string; height: number; width: number }));
  if (!sizes.length) failures.push(`${label}: no picker in ${id}`);
  for (const o of sizes) if (o.height < 43.5) failures.push(`${label}: "${o.text}" is ${Math.round(o.height)} px tall`);
}
const tomatoes = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });

async function noOverflow(page: Page, label: string, failures: string[]) {
  const r = await findOverflow(page);
  if (r.page > r.viewport) failures.push(`${label}: page scrolls sideways (${r.page}px > ${r.viewport}px)`);
  for (const o of r.items) failures.push(`${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
}

/** The current step is this one, open, with its main action as the one main vermilion button. */
async function expectCurrent(page: Page, s: GuideStep) {
  const card = step(page, s.id);
  await expect(card).toHaveClass(/is-current/);
  await expect(card.locator(".gstep__head")).toHaveAttribute("aria-expanded", "true");
}

async function checkOpen(page: Page, s: GuideStep, vermilion: boolean) {
  if (!s.open) return;
  const link = step(page, s.id).locator("a.gstep__open");
  await expect(link).toHaveAttribute("href", s.open.url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  if (vermilion) await expect(link).toHaveClass(/btn--primary/);
}

async function pasteKeys(page: Page, platform: Platform, failures: string[]) {
  const card = step(page, "key-paste");
  const keys = KEYS[platform];
  const [idLabel, secretLabel, configLabel] = LABELS[platform];
  const save = card.getByRole("button", { name: "Save keys" });
  // A bad key: a friendly sentence under the box, and Save keys stays off.
  await card.getByLabel(idLabel!, { exact: true }).fill(keys.clientId);
  await card.getByLabel(secretLabel!, { exact: true }).fill("nope");
  await expect(card.getByText(/^That does not look right\./)).toBeVisible();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await noOverflow(page, `${platform} (bad key)`, failures);
  // Pressing it anyway does nothing (centred first, so the phone's tab bar is never under the finger).
  await save.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await save.click({ force: true });
  await expect(card.locator(".key-saved")).toHaveCount(0);
  // Good keys save, and only masked hints come back.
  await card.getByLabel(secretLabel!, { exact: true }).fill(keys.clientSecret);
  if (configLabel) await card.getByLabel(configLabel, { exact: true }).fill(`https://www.facebook.com/v27.0/dialog/oauth?config_id=${keys.configId}&x=1`);
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await expect(save).toHaveClass(/btn--primary/);
  await save.click();
  await expect(card.locator(".key-saved")).toBeVisible();
  await expect(card.locator(".key-saved")).toContainText(maskKey("clientId", keys.clientId));
  await expect(card.locator(".key-saved")).toContainText(maskKey("clientSecret", keys.clientSecret));
  await expect(card.locator("input.key-field__input")).toHaveCount(0);
  await expect(page.getByText(keys.clientSecret)).toHaveCount(0);
  await expect(card).toHaveAttribute("data-done", "true");
  // Check it.
  await card.getByRole("button", { name: "Check it" }).click();
  await expect(card.locator(".check-it__result")).toHaveText(`Your keys work. Now press Connect ${GUIDES[platform].name}.`);
}

async function upload(page: Page, id: string, name: string) {
  await step(page, id)
    .locator("input[type=file]")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`tiktok-developers-site-verification=${name}`) });
  await expect(step(page, id).locator(".upload-box__file", { hasText: name })).toBeVisible();
}

/** Connect → the pretend consent page → Allow (and, for Meta, pick an account) → back, connected. */
async function connect(page: Page, platform: Platform, button: string) {
  const name = GUIDES[platform].name;
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.waitForURL(new RegExp(`/mock-oauth/${platform}\\?state=`));
  await expect(page.getByRole("heading", { level: 1, name: `Pretend ${name}` })).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(new RegExp(`/settings/posting/setup/${platform}(\\?result=\\w+)?$`));
  const choice = CHOICE[platform];
  if (choice) {
    await expect(page.getByRole("heading", { name: "Pick the account your clips go to" })).toBeVisible();
    expect(await soundKinds(page), "no sound before a tap").toEqual([]);
    await page.getByRole("button", { name: choice }).click();
  }
  await expect(page.locator("canvas.confetti")).toBeAttached();
  await expect(page.locator(".result-card--ok")).toContainText(`Connected as ${choice ?? (platform === "facebook" ? "Clip Factory Clips" : "@")}`);
  await expect(page).toHaveURL(new RegExp(`/settings/posting/setup/${platform}$`));
  if (choice) {
    // Picking the account is a tap: the click sound and the success sound answer it.
    await expect.poll(() => soundKinds(page)).toEqual(["tap", "success"]);
  } else {
    // Back from the platform the page has not been touched: silence until the owner's first tap, then the cheer.
    await page.waitForTimeout(300);
    expect(await soundKinds(page), "no sound before a tap").toEqual([]);
    await page.locator(".result-card--ok .result-card__title").click();
    await expect.poll(() => soundKinds(page)).toEqual(["success"]);
    // Only once.
    await page.locator(".result-card--ok .result-card__title").click();
    await page.waitForTimeout(150);
    expect(await soundKinds(page)).toEqual(["success"]);
  }
}

for (const size of SIZES) {
  test.describe(`setup at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, permissions: ["clipboard-read", "clipboard-write"] });

    for (const platform of SETUP_ORDER) {
      const guide = GUIDES[platform];
      test(`${guide.name}: every step, keys, Check it, Connect, reconnect and Disconnect`, async ({ page }) => {
        test.setTimeout(240_000);
        const failures: string[] = [];
        const steps = allSteps(guide);

        // Home shows the floating setup list (§17.13) until every platform is ready or skipped.
        await page.goto("/");
        await settle(page);
        await expect(page.locator(".setup-todo")).toContainText("0/5");
        const todo = await openTodo(page);
        await expect(todo.getByRole("link", { name: `Set up ${guide.name}` })).toHaveAttribute("href", `/settings/posting/setup/${platform}`);

        // Set up posting → the platform's page.
        await page.goto("/settings/posting/setup");
        await settle(page);
        await expect(page.getByText("0 of 5 ready")).toBeVisible();
        await noOverflow(page, "list", failures);
        await page.locator(`.setup-card[data-platform='${platform}']`).click();
        await expect(page).toHaveURL(new RegExp(`/settings/posting/setup/${platform}$`));
        await settle(page);
        await expect(page.getByRole("heading", { level: 1, name: `Set up ${guide.name}` })).toBeVisible();
        await expect(page.getByText(`Steps checked on ${checkedOnText(guide)}`)).toBeVisible();
        // Nothing done yet: the page stays at the top, so the title, the time and the date are on screen.
        await page.waitForTimeout(700);
        await expect(page.getByRole("heading", { level: 1, name: `Set up ${guide.name}` })).toBeInViewport();
        await expect(page.locator(".setup-head__meta")).toBeInViewport();
        await expect(page.locator(".setup-head__checked")).toBeInViewport();
        // The ring is a percentage, so it never clashes with the step numbers.
        await expect(page.locator(".setup-head .ring__text")).toHaveText("0%");
        await noOverflow(page, `${platform} page`, failures);

        let copied = false;
        let resumed = false;
        for (const s of steps) {
          if (s.optional) continue;
          await expectCurrent(page, s);
          await checkOpen(page, s, true);
          expect(await tomatoes(page).count(), `${s.id}: one vermilion`).toBeLessThanOrEqual(1);

          // Copy puts the exact value on the clipboard (once per journey is enough).
          if (s.copy?.length && !copied) {
            copied = true;
            const chip = s.copy[0]!;
            await step(page, s.id).getByRole("button", { name: `Copy ${chip.label}` }).click();
            await expect(step(page, s.id).getByText("Copied!")).toBeVisible();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(resolveValue(chip.value, platform, MOCK_VALUES));
          }

          if (s.auto === "keys") {
            await pasteKeys(page, platform, failures);
            continue;
          }
          if (s.auto === "files") {
            await upload(page, s.id, "tiktokAbCd1234.txt");
            await expect(step(page, s.id)).toHaveAttribute("data-done", "true");
            continue;
          }
          if (s.auto === "connected") {
            const button = page.getByRole("button", { name: `Connect ${guide.name}`, exact: true });
            await expect(button).toHaveClass(/btn--primary/);
            // Cancel on the platform: a calm sentence, and Connect again.
            await button.click();
            await page.waitForURL(new RegExp(`/mock-oauth/${platform}`));
            await page.getByRole("button", { name: "Cancel" }).click();
            await page.waitForURL(new RegExp(`/settings/posting/setup/${platform}(\\?result=denied)?$`));
            await expect(page.getByText(resultCopy(platform).denied)).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`/settings/posting/setup/${platform}$`));
            await settle(page);
            await connect(page, platform, `Connect ${guide.name}`);
            await expect(page.locator(".setup-head [role=progressbar]")).toHaveAttribute("aria-valuenow", "100");
            await settle(page);
            await noOverflow(page, `${platform} connected`, failures);
            continue;
          }

          if (s.upload) await upload(page, s.id, "tiktokSandbox5678.txt");
          if (s.extra === "youtube-privacy" || s.extra === "tiktok-review") await pickerTargets(page, s.id, `${platform} ${size.width}px`, failures);
          if (s.extra === "youtube-privacy") {
            await step(page, s.id).getByRole("radio", { name: "Only people with the link" }).evaluate((el) => el.closest("label")!.scrollIntoView({ block: "center" }));
            await step(page, s.id).getByRole("radio", { name: "Only people with the link" }).check({ force: true });
            await expect(step(page, s.id).getByRole("radio", { name: "Only people with the link" })).toBeChecked();
          }
          if (s.extra === "tiktok-review") {
            await step(page, s.id).getByRole("radio", { name: "In review" }).evaluate((el) => el.closest("label")!.scrollIntoView({ block: "center" }));
            await step(page, s.id).getByRole("radio", { name: "In review" }).check({ force: true });
            await expect(step(page, s.id)).toContainText("TikTok is checking your app. This can take days.");
          }
          if (s.id === "public-audit") await expect(step(page, s.id)).toContainText("Works now, but your TikTok posts stay private until TikTok says yes.");
          if (s.id === "public-live") await expect(step(page, s.id)).toContainText("only you can see your Facebook Reels");
          if (s.id === "public-credits") await expect(step(page, s.id)).toContainText("Works now. Posts are public straight away.");

          await step(page, s.id).getByRole("button", { name: "I did this" }).click();
          await expect(step(page, s.id)).toHaveAttribute("data-done", "true");
          // The tick is saved (the mock server keeps it in sessionStorage) before anything reloads.
          await page.waitForFunction(
            ([p, id]) => (JSON.parse(sessionStorage.getItem("cf-mock-setup") ?? "{}")[p]?.stepsDone ?? []).includes(id),
            [platform, s.id] as const,
          );

          // After Get ready: a reload opens the page at the first step that is not done.
          if (!resumed && s.id === guide.parts[0]!.steps.at(-1)!.id) {
            resumed = true;
            await page.reload();
            await settle(page);
            const next = guide.parts[1]!.steps[0]!;
            await expectCurrent(page, next);
            for (const done of guide.parts[0]!.steps) await expect(step(page, done.id)).toHaveAttribute("data-done", "true");
          }
        }

        // Optional steps open on a tap; their Open buttons go to the exact page too.
        for (const s of steps.filter((x) => x.optional && x.open)) {
          await step(page, s.id).locator(".gstep__head").click();
          await checkOpen(page, s, false);
        }

        // The list says Ready (or that posts stay private) for this platform.
        await page.goto("/settings/posting/setup");
        await settle(page);
        await expect(page.getByText("1 of 5 ready")).toBeVisible();
        await expect(page.locator(`.setup-card[data-platform='${platform}'] .setup-card__state`)).toHaveText(
          platform === "tiktok" ? "Works now, posts stay private" : "Ready",
        );
        if (platform === "tiktok")
          await expect(page.locator(".setup-card[data-platform='tiktok']")).toContainText("Works now, posts stay private");

        // The platform logs Clip Factory out: Connect again is the one main vermilion button, and it works.
        await page.evaluate((p) => (window as MockWindow).__cfMock!.setup.expireToken(p), platform);
        await page.goto(`/settings/posting/setup/${platform}`);
        await settle(page);
        const again = page.getByRole("button", { name: "Connect again" });
        await expect(again).toHaveClass(/btn--primary/);
        await expect(tomatoes(page)).toHaveCount(1);
        await expect(page.locator(".done-panel")).toContainText("logged Clip Factory out");
        await connect(page, platform, "Connect again");

        // Disconnect waits 8 seconds for Undo; Undo keeps the account.
        await settle(page);
        await page.locator(".done-panel").getByRole("button", { name: "Disconnect" }).click();
        await expect(page.getByText(`Disconnecting ${guide.name}…`).first()).toBeVisible();
        await page.getByRole("button", { name: "Undo" }).click();
        await page.waitForTimeout(8_600);
        await page.reload();
        await settle(page);
        await expect(page.locator(".done-panel")).toBeVisible();
        // Without Undo, it is gone after 8 seconds (the keys stay).
        await page.locator(".done-panel").getByRole("button", { name: "Disconnect" }).click();
        await page.waitForTimeout(8_800);
        await expect(page.locator(".done-panel")).toHaveCount(0);
        await expect(step(page, "connect")).not.toHaveAttribute("data-done", "true");
        await expect(step(page, "key-paste")).toHaveAttribute("data-done", "true");

        expect(failures, failures.join("\n")).toEqual([]);
      });
    }

    test("all five ready: the floating setup list leaves and the list says 5 of 5", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await expect(page.locator(".setup-todo")).toBeVisible();
      await page.evaluate(() => {
        const s = (window as MockWindow).__cfMock!.setup;
        for (const p of ["youtube", "tiktok", "instagram", "facebook"] as const) s.finish(p);
      });
      await page.reload();
      await settle(page);
      await expect(page.locator(".setup-todo")).toContainText("4/5");
      const todo = await openTodo(page);
      await expect(todo.locator(".todo-row[data-state='ready']")).toHaveCount(4);
      await todo.getByRole("link", { name: "Set up X" }).click();
      await expect(page).toHaveURL(/\/settings\/posting\/setup\/x$/);
      await page.evaluate(() => (window as MockWindow).__cfMock!.setup.finish("x"));
      await page.goto("/");
      await settle(page);
      // It celebrates ("All set!"), then slides away.
      await expect(page.locator(".setup-todo")).toHaveCount(0, { timeout: 10_000 });
      await page.goto("/settings/posting/setup");
      await settle(page);
      await expect(page.getByText("5 of 5 ready")).toBeVisible();
      await expect(page.locator(".setup-card.is-ready")).toHaveCount(5);
    });
  });
}

// Tap targets a tablet or desktop owner uses on every setup page: the breadcrumb (the way back up) and the pickers.
for (const size of [
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`setup tap targets are at least 44 px at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const failures: string[] = [];
    for (const platform of SETUP_ORDER) {
      await page.goto(`/settings/posting/setup/${platform}`);
      await settle(page);
      // Measured at rest: mid-slide a 44 px crumb can read 43.99999 px (a fractional translate).
      await animationsDone(page);
      const crumbs = await page
        .locator(".crumbs__link, .crumbs__here")
        .filter({ visible: true })
        .evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim() ?? "", ...e.getBoundingClientRect().toJSON() }) as { text: string; width: number; height: number }));
      if (!crumbs.length) failures.push(`${platform}: no breadcrumb`);
      for (const c of crumbs) if (c.height < 43.5 || c.width < 43.5) failures.push(`${platform}: crumb "${c.text}" is ${Math.round(c.width)}x${Math.round(c.height)}`);
      for (const id of platform === "youtube" ? ["public-privacy"] : platform === "tiktok" ? ["public-review"] : []) {
        await step(page, id).locator(".gstep__head").click();
        await pickerTargets(page, id, `${platform} ${size.width}px`, failures);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

test("on a phone each picker choice is its own full-width row", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings/posting/setup/tiktok");
  await settle(page);
  await step(page, "public-review").locator(".gstep__head").click();
  const picker = step(page, "public-review").locator(".gstep__picker .segmented");
  // Measured once the step has unfolded.
  await expect(picker).toBeVisible();
  await animationsDone(page);
  const box = (await picker.boundingBox())!;
  const opts = await picker.locator(".segmented__opt").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(opts).toHaveLength(4);
  for (const o of opts) {
    expect(o.height).toBeGreaterThanOrEqual(44);
    expect(o.width).toBeGreaterThan(box.width - 16);
  }
  // One per row, top to bottom.
  for (let i = 1; i < opts.length; i++) expect(opts[i]!.top).toBeGreaterThanOrEqual(opts[i - 1]!.bottom - 1);
});

test("a fresh page stays at the top; a started one reopens at its step", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings/posting/setup");
  await settle(page);
  await page.locator(".setup-card[data-platform='youtube']").click();
  await settle(page);
  // The wait is the test: given time, the page has not scrolled itself anywhere.
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("heading", { level: 1, name: "Set up YouTube" })).toBeInViewport();
  for (const id of ["ready-channel", "ready-computer", "key-console", "key-project"]) {
    await step(page, id).getByRole("button", { name: "I did this" }).click();
    await expect(step(page, id)).toHaveAttribute("data-done", "true");
  }
  await page.waitForFunction(() => (JSON.parse(sessionStorage.getItem("cf-mock-setup") ?? "{}").youtube?.stepsDone ?? []).length === 4);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.reload();
  await settle(page);
  await expect(step(page, "key-data-api")).toBeInViewport();
});

test("a Connect that comes back with a problem says what to do, and where", async ({ page }) => {
  await page.goto("/settings/posting/setup/youtube?result=keys_wrong");
  await settle(page);
  await expect(page.getByText("The key does not work. Copy the Client ID and secret again (step 11).")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/posting\/setup\/youtube$/);
  await page.getByRole("button", { name: "Go to step 11" }).click();
  await expect(step(page, "key-client").locator(".gstep__head")).toHaveAttribute("aria-expanded", "true");
  // An unknown code is never shown as it is.
  await page.goto("/settings/posting/setup/x?result=%3Cscript%3E");
  await settle(page);
  await expect(page.getByText("Something went wrong. Press Connect X again.")).toBeVisible();
});

test("a stale consent page answers expired, and Connect needs keys first", async ({ page }) => {
  await page.goto("/mock-oauth/tiktok?state=v1.old");
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/\/settings\/posting\/setup\/tiktok$/);
  await expect(page.getByText("That took too long. Press Connect TikTok again.")).toBeVisible();
  await page.locator("[data-step='connect'] .gstep__head").click();
  await expect(page.getByRole("button", { name: "Connect TikTok", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(`Paste your keys first (step ${stepNumber(GUIDES.tiktok, "key-paste")}). Then this button works.`)).toBeVisible();
});

// Ask's "Open Instagram step 2" button (§28.4): #step-{id} opens that step and brings it into view.
test("a #step-{id} link opens that step and brings it into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/posting/setup/instagram#step-ready-page");
  await settle(page);
  const card = step(page, "ready-page");
  await expect(card).toHaveClass(/is-open/);
  await expect(card).toBeInViewport();
  await expect(card).toHaveAttribute("data-help", "step-ready-page");
  await expect(card).toContainText("Manage connection");
  // A step id of another guide does nothing.
  await page.goto("/settings/posting/setup/facebook#step-key-config-nope");
  await settle(page);
  await expect(page.getByRole("heading", { level: 1, name: "Set up Facebook" })).toBeInViewport();
});
