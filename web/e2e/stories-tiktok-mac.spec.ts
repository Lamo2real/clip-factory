// Clips Funded › My Mac posts TikTok (docs/CONTRACTS.md §47.10) in the mock app: the owner turns the switch on in
// Social accounts › TikTok, taps Post it on an approved video, and the TikTok row follows the Mac (played by the mock's
// knobs, window.__cfStoriesMock.mac): Waiting for your Mac → Posting… → Posted by your Mac · Everyone. A stopped post
// has Try again; one the Mac pressed but couldn't confirm has It's on TikTok, with its link. Nothing leaves the machine.
import { expect, test, type Page } from "@playwright/test";

type MacWindow = Window & {
  __cfStoriesMock?: {
    mac?: {
      claim: (id?: string) => unknown;
      step: (step: string, id?: string) => unknown;
      done: (id?: string, link?: string) => unknown;
      stopped: (reason: string, needsYou?: boolean, id?: string) => unknown;
    };
  };
};

const APPROVED = "01JSTST0000000000000000003";
const LINK = "https://www.tiktok.com/@funded.clips/video/7400000000000000001";

async function start(page: Page, knobs: Record<string, unknown>) {
  await page.addInitScript((k) => {
    localStorage.setItem("cf.storiesPreview", "1");
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: k };
  }, knobs);
}

/** Moves inside the app like a tap on a link (a reload would start the in-memory mock afresh). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function reviewReady(page: Page) {
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
}

/** Post it with TikTok only, then closes the sent sheet. */
async function postTikTok(page: Page) {
  await page.getByRole("button", { name: "Post it", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post it" });
  await sheet.locator("button.st-s-place", { hasText: "TikTok" }).click();
  await expect(sheet.locator(".st-s-tiktok")).toContainText("Your Mac posts it for everyone, with the AI label.");
  await expect(sheet.locator(".st-s-tiktok")).not.toContainText("Who can see it");
  await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
  const sent = page.getByRole("dialog", { name: /Sending your video|Posted!/ });
  await expect(sent).toContainText("Waiting for your Mac");
  await sent.locator(".st-s-sheet__actions .st-btn--main").click();
}

const row = (page: Page) => page.locator(".st-s-postspanel .st-s-post").filter({ has: page.locator("strong", { hasText: /^TikTok$/ }) });
/** The mock's Mac, as the helper would: `steps` run in order (claim, a step, done or stopped). */
type Step = ["claim"] | ["step", string] | ["done"] | ["stopped", string];
const mac = (page: Page, ...steps: Step[]) =>
  page.evaluate((list) => {
    const m = (window as MacWindow).__cfStoriesMock!.mac!;
    for (const [name, arg] of list as [string, string?][]) {
      if (name === "claim") m.claim();
      else if (name === "step") m.step(arg!);
      else if (name === "done") m.done();
      else m.stopped(arg!);
    }
  }, steps);

test("turn it on, Post it, and the TikTok row follows the Mac to Posted by your Mac · Everyone", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, { macConnected: true, macHelper: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/connections");
  const card = page.locator("#tiktok-mac");
  await expect(card).toContainText("Off. Your Mac doesn't post TikTok.", { timeout: 20_000 });
  await card.getByRole("switch", { name: "My Mac posts TikTok" }).click();
  await expect(card).toContainText("On. Post it hands TikTok to your Mac. It posts for everyone, with the AI label.");
  await expect(card).toContainText("logged in as @funded.clips");
  await expect(card).toContainText("To stop it, turn the switch off. Your Mac stops at once.");

  await go(page, `/stories/review/${APPROVED}`);
  await reviewReady(page);
  await postTikTok(page);
  await expect(row(page)).toContainText("Waiting for your Mac · next");

  await mac(page, ["claim"]);
  await expect(row(page)).toContainText("Posting…", { timeout: 20_000 });
  await mac(page, ["step", "uploading"], ["step", "pressing"], ["done"]);
  await expect(row(page)).toContainText("Posted by your Mac · Everyone", { timeout: 20_000 });
  await expect(row(page).getByRole("link", { name: /^Open/ })).toHaveAttribute("href", /tiktok\.com\/@funded\.clips\/video\//);
});

test("a stopped post has Try again; one the Mac pressed but couldn't confirm has It's on TikTok", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, { macOn: true, macConnected: true, macHelper: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/stories/review/${APPROVED}`);
  await reviewReady(page);
  await postTikTok(page);
  await expect(row(page)).toContainText("Waiting for your Mac");

  await mac(page, ["claim"], ["stopped", "TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again."]);
  await expect(row(page)).toContainText("Didn't work: TikTok's upload page looks different", { timeout: 20_000 });
  await row(page).getByRole("button", { name: "Try again" }).click();
  await expect(row(page)).toContainText("Waiting for your Mac");

  await mac(page, ["claim"], ["step", "pressing"], ["stopped", "Lost the page."]);
  await expect(row(page)).toContainText("Not sure it posted · look on your TikTok", { timeout: 20_000 });
  await expect(row(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
  await row(page).getByRole("button", { name: "It's on TikTok" }).click();
  await row(page).getByLabel("Its link on TikTok").fill(LINK);
  await row(page).getByRole("button", { name: "Save" }).click();
  await expect(row(page)).toContainText("On your TikTok");
  await expect(row(page).getByRole("link", { name: /^Open/ })).toHaveAttribute("href", LINK);
});
