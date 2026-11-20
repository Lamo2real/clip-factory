import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveRoute, settle } from "./helpers.ts";

// Notifications (docs/CONTRACTS.md §32.8) on an iPhone-sized screen: a Safari tab shows the Home Screen steps and never
// asks; the Home Screen app asks inside the tap, subscribes and saves the device; the choices save; Send a test
// reaches the device; a working job's page offers it once. The browser's permission prompt and push service are
// stand-ins (no real push leaves the machine). CF_PUSH_SHOTS=<dir> also saves the screens at 390x844.

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const SHOTS = process.env.CF_PUSH_SHOTS;

test.use({ viewport: { width: 390, height: 844 }, userAgent: IPHONE, isMobile: true, hasTouch: true });

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The Home Screen app: standalone, with a stand-in permission prompt and push service. */
async function homeScreenApp(page: Page, answer: NotificationPermission = "granted") {
  await page.addInitScript((answer) => {
    const w = window as unknown as Record<string, unknown>;
    let permission: NotificationPermission = "default";
    const asked: string[] = [];
    w.__cfAsked = asked;
    w.__cfMockPushes = [];
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    const realMatch = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("display-mode: standalone") ? ({ ...realMatch(q), matches: true } as MediaQueryList) : realMatch(q));
    w.Notification = {
      get permission() {
        return permission;
      },
      requestPermission: () => {
        asked.push("permission");
        permission = answer;
        return Promise.resolve(answer);
      },
    };
    let sub: unknown = null;
    const pushManager = {
      getSubscription: async () => sub,
      subscribe: async () => {
        asked.push("subscribe");
        sub = {
          endpoint: "https://web.push.apple.com/QGuQyavXutnMH7vvR",
          toJSON: () => ({ endpoint: "https://web.push.apple.com/QGuQyavXutnMH7vvR", keys: { p256dh: "p", auth: "a" } }),
          unsubscribe: async () => {
            sub = null;
            return true;
          },
        };
        return sub;
      },
    };
    if (!("PushManager" in window)) w.PushManager = function PushManager() {};
    Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => ({ pushManager }), configurable: true });
  }, answer);
}

test("in a Safari tab on iPhone: the Home Screen steps, never a prompt", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).Notification;
  });
  await page.goto("/settings/app/notifications");
  await settle(page);
  await expect(page.getByText("Add Clip Factory to your Home Screen first.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
  await shot(page, "1-safari-tab-add-to-home-screen");
});

test("in the Home Screen app: Turn on asks in the tap, then it is on and a test arrives", async ({ page }) => {
  await homeScreenApp(page);
  await page.goto("/settings/app/notifications");
  await settle(page);
  await expect(page.locator("#notify-device")).toContainText("Off");
  await shot(page, "2-settings-turn-on");

  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("This device gets them, even when Clip Factory is closed.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __cfAsked: string[] }).__cfAsked)).toEqual(["permission", "subscribe"]);
  await expect(page.locator("#notify-device")).toContainText("On");

  // Every step is off by default; turning it on saves at once.
  const steps = page.locator('button[role="switch"][aria-labelledby="notify-steps-name"]');
  await expect(steps).toHaveAttribute("aria-checked", "false");
  await steps.click();
  await expect(steps).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Send a test" }).click();
  await expect(page.getByText("Sent. Look for it in a few seconds.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __cfMockPushes: unknown[] }).__cfMockPushes)).toEqual([
    { title: "Clip Factory", body: "Notifications are on 🎉" },
  ]);
  await expect(page.getByText("Lock Screen widgets only come with App Store apps.")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "3-settings-on");
  await page.locator("#notify-lock-screen").scrollIntoViewIfNeeded();
  await shot(page, "4-settings-lock-screen-note");
});

test("Don't Allow says where to turn them back on", async ({ page }) => {
  await homeScreenApp(page, "denied");
  await page.goto("/settings/app/notifications");
  await settle(page);
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Turn them on in Settings > Notifications > Clip Factory.")).toBeVisible();
  await shot(page, "5-settings-refused");
});

test("a working job's page offers it once", async ({ page }) => {
  await homeScreenApp(page);
  const href = await resolveRoute(page, "/jobs/:running");
  await page.locator(`a[href="${href}"]`).first().click();
  await settle(page);
  const card = page.locator(".notify-card");
  await expect(card).toContainText("Get told when your clips are ready, even with the app closed.");
  await card.scrollIntoViewIfNeeded();
  await shot(page, "6-job-page-prompt");
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toHaveCount(0);
});
