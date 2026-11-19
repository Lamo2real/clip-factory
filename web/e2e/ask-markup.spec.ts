// The picture markup editor in the mock build (docs/CONTRACTS.md §27.8): open it from a tray picture, draw with the
// pen (mouse, and touch on the phone project), a box and an arrow, undo and clear, Save (the tile's picture changes
// and gets its red pen; the JPEG that is sent has red where the owner drew), keyboard-only drawing and saving, the
// Escape question, the thumb zone on phones, no overflow and the sliding tool bar. Screenshots go to
// CF_ASK_SCREENS too when it is set.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { findOverflow, settle } from "./helpers.ts";

const FIX = join(import.meta.dirname, "fixtures");
const SCREENS = process.env.CF_ASK_SCREENS;
const panel = (page: Page) => page.locator("#help-panel");
const editor = (page: Page) => page.getByRole("dialog", { name: /Mark picture/ });
const canvas = (page: Page) => page.locator(".mk__canvas");

async function openWithPicture(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await expect(panel(page)).toBeVisible();
  const b64 = readFileSync(join(FIX, "shot.png")).toString("base64");
  await page.evaluate((data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    const e = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
    document.querySelector(".help-panel__log")!.dispatchEvent(e);
  }, b64);
  await expect(panel(page).locator(".help-pic__img")).toHaveCount(1, { timeout: 15_000 });
}

async function openEditor(page: Page) {
  await panel(page).getByRole("button", { name: /Mark picture 1/ }).click();
  await expect(editor(page)).toBeVisible();
  await expect(page.locator(".mk__canvas")).toBeVisible();
}

async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const b = (await canvas(page).boundingBox())!;
  const x = (f: number) => b.x + b.width * f;
  const y = (f: number) => b.y + b.height * f;
  await page.mouse.move(x(from[0]), y(from[1]));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x(from[0] + ((to[0] - from[0]) * i) / 8), y(from[1] + ((to[1] - from[1]) * i) / 8));
  await page.mouse.up();
}

/** The share of red pixels around the middle of the JPEG the mock received last. */
async function redInSent(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const files = Object.values(window.__cfMockAsk?.files ?? {}).filter((f) => f.bytes && f.type === "image/jpeg");
    const last = files[files.length - 1];
    if (!last?.bytes) return -1;
    const bmp = await createImageBitmap(new Blob([last.bytes as BlobPart], { type: "image/jpeg" }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const w = Math.round(bmp.width * 0.4);
    const h = Math.round(bmp.height * 0.1);
    const d = ctx.getImageData(Math.round(bmp.width * 0.3), Math.round(bmp.height * 0.45), w, h).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 90) red++;
    return red / (d.length / 4);
  });
}

async function shot(page: Page, name: string, info: { outputPath(n: string): string }) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (SCREENS) {
    mkdirSync(SCREENS, { recursive: true });
    await page.screenshot({ path: join(SCREENS, `${name}.png`) });
  }
}

test.describe("the markup editor on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("pen, box, arrow, undo, clear, then Save: the sent picture has red where drawn", async ({ page }, info) => {
    await openWithPicture(page);
    const before = await panel(page).locator(".help-pic__img").getAttribute("src");
    await openEditor(page);
    // The tool bar slides (Glide) and Pen starts chosen.
    await expect(page.getByRole("radio", { name: "Pen" })).toHaveAttribute("aria-checked", "true");
    await stroke(page, [0.3, 0.5], [0.7, 0.5]);
    await page.getByRole("radio", { name: "Box" }).click();
    await expect(page.locator(".mk-tools")).toHaveClass(/has-glide/);
    await stroke(page, [0.2, 0.2], [0.4, 0.35]);
    await page.getByRole("radio", { name: "Arrow" }).click();
    await stroke(page, [0.8, 0.8], [0.6, 0.6]);
    await expect(page.locator(".mk [role=status]")).toContainText("3 marks");
    await shot(page, "ask-markup-desktop-1440", info);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click(); // Clear can be undone
    await page.getByRole("button", { name: "Save" }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(panel(page).locator(".ask-marked:not(.is-hint)")).toBeVisible();
    expect(await panel(page).locator(".help-pic__img").getAttribute("src")).not.toBe(before);
    await expect(panel(page).getByRole("button", { name: "Mark picture 1 (marked)" })).toBeFocused();
    await panel(page).getByLabel("Your question").fill("What did I mark?");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await expect(panel(page).locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    expect(await redInSent(page)).toBeGreaterThan(0.02);
  });

  test("keyboard only: arrow keys and Enter draw, Cmd/Ctrl+Enter saves", async ({ page }) => {
    await openWithPicture(page);
    await panel(page).getByRole("button", { name: /Mark picture 1/ }).focus();
    await page.keyboard.press("Enter");
    await expect(editor(page)).toBeVisible();
    await canvas(page).focus();
    await page.keyboard.press("Enter");
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator(".mk [role=status]")).toContainText("1 mark");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(editor(page)).toHaveCount(0);
    await expect(panel(page).locator(".ask-marked:not(.is-hint)")).toBeVisible();
  });

  test("Escape with new marks asks first; Keep marking stays, Throw away leaves", async ({ page }) => {
    await openWithPicture(page);
    await openEditor(page);
    await stroke(page, [0.3, 0.3], [0.6, 0.6]);
    await page.keyboard.press("Escape");
    await expect(page.getByText("Throw away your marks?")).toBeVisible();
    await page.getByRole("button", { name: "Keep marking" }).click();
    await expect(editor(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Throw away" }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(panel(page).locator(".ask-marked.is-hint")).toBeVisible();
  });
});

for (const size of [
  { name: "phone-375", width: 375, height: 812 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1920", width: 1920, height: 1080 },
]) {
  test.describe(`the markup editor at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("fits, and Save and Undo sit in the thumb zone on phones and tablets", async ({ page }, info) => {
      await openWithPicture(page);
      await openEditor(page);
      await stroke(page, [0.25, 0.5], [0.75, 0.5]);
      await shot(page, `ask-markup-${size.name}`, info);
      const over = await findOverflow(page);
      expect(over.page).toBeLessThanOrEqual(over.viewport);
      if (size.width < 1024) {
        for (const name of ["Save", /^Undo/]) {
          const b = (await page.getByRole("button", { name }).boundingBox())!;
          expect(b.y, String(name)).toBeGreaterThan(size.height * 0.75 - b.height);
          expect(b.x + b.width / 2, String(name)).toBeGreaterThan(size.width * 0.5);
        }
      }
    });
  });
}

test.describe("the markup editor with less motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("nothing moves in the editor", async ({ page }) => {
    await openWithPicture(page);
    await openEditor(page);
    const running = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".mk, .mk *")).flatMap((el) =>
        el.getAnimations().filter((a) => a.playState === "running").map((a) => `${el.className}: ${(a as CSSAnimation).animationName ?? a.id ?? "web animation"}`),
      ),
    );
    expect(running).toEqual([]);
  });
});
