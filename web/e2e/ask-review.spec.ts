// The review fixes for Ask as a full assistant (docs/CONTRACTS.md §28, review of 2026-11-19), in the mock build:
// the tray stays one sideways row on phones and is capped on wider panels; drops and pastes on the markup editor
// never reach the hidden tray; Send and Stop keep keyboard focus; a trackpad pinch zooms the picture, not the page;
// the drawing area is an application for screen readers; the editor's Tab order and radio tool bar; a lost pointer
// never throws; holding Undo opens no menu and tablets show Redo; 44 px take-away targets; one announcement for a
// multi-file drop; the launcher glows under a drag; the search key button; and files leave the mock store when a
// question can't start.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

const FIX = join(import.meta.dirname, "fixtures");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n");
const panel = (page: Page) => page.locator("#help-panel");
const box = (page: Page) => panel(page).getByLabel("Your question");

async function open(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await expect(panel(page)).toBeVisible();
}

type F = { b64: string; name: string; type: string };
const pdf = (name: string): F => ({ b64: PDF.toString("base64"), name, type: "application/pdf" });
const png = (name = "shot.png"): F => ({ b64: readFileSync(join(FIX, "shot.png")).toString("base64"), name, type: "image/png" });

/** Dispatches a drop (dragenter, dragover, drop) or a paste with files on `selector`; returns whether drop/dragover were cancelled. */
async function dispatch(page: Page, selector: string, kind: "drop" | "paste", files: F[]): Promise<boolean[]> {
  return page.evaluate(
    ({ sel, k, list }) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const target = document.querySelector(sel)!;
      if (k === "paste") {
        const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
        if (!e.clipboardData) Object.defineProperty(e, "clipboardData", { value: dt });
        target.dispatchEvent(e);
        return [e.defaultPrevented];
      }
      return ["dragenter", "dragover", "drop"].map((type) => {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      });
    },
    { sel: selector, k: kind, list: files },
  );
}

async function withPicture(page: Page) {
  await open(page);
  await dispatch(page, ".help-panel__log", "drop", [png()]);
  await expect(panel(page).locator(".help-pic__img")).toHaveCount(1, { timeout: 15_000 });
}

async function openEditor(page: Page) {
  await panel(page).getByRole("button", { name: /Mark picture 1/ }).click();
  await expect(page.locator(".mk__canvas")).toBeVisible();
}

test.describe("the tray (C1)", () => {
  for (const size of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    test(`stays one sideways row on a ${size.width} px phone with 8 files`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page);
      await dispatch(page, ".help-panel__log", "drop", Array.from({ length: 8 }, (_, i) => pdf(`file-${i + 1}.pdf`)));
      await expect(panel(page).locator(".ask-file")).toHaveCount(8);
      const tray = panel(page).locator(".ask-tray");
      const tops = await panel(page).locator(".ask-tray > li").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
      expect(tops).toHaveLength(1);
      const trayBox = (await tray.boundingBox())!;
      const panelBox = (await panel(page).boundingBox())!;
      expect(trayBox.height).toBeLessThan(panelBox.height * 0.25);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test("wraps but is capped on a desktop panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await dispatch(page, ".help-panel__log", "drop", Array.from({ length: 10 }, (_, i) => pdf(`file-${i + 1}.pdf`)));
    await expect(panel(page).locator(".ask-file")).toHaveCount(10);
    const h = (await panel(page).locator(".ask-tray").boundingBox())!.height;
    expect(h).toBeLessThanOrEqual(157);
    // The ZIP note is opaque: nothing shows through it.
    await dispatch(page, ".help-panel__log", "drop", [{ b64: Buffer.from("PK\u0003\u0004 zip").toString("base64"), name: "a.zip", type: "application/zip" }]);
    const bg = await panel(page).locator(".help-note").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toMatch(/rgba\(.*,\s*0\.\d+\)$/);
  });
});

test.describe("the markup editor", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("drops and pastes on the editor never add files to the hidden tray (C2)", async ({ page }) => {
    await withPicture(page);
    await openEditor(page);
    const cancelled = await dispatch(page, ".mk__canvas", "drop", [pdf("report.pdf")]);
    expect(cancelled[2]).toBe(true); // the drop is taken (the file is never opened by the browser)
    await dispatch(page, ".mk__canvas", "paste", [pdf("other.pdf")]);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(panel(page).locator(".help-pic:not(.is-leaving)")).toHaveCount(1);
  });

  test("a ctrl+wheel (trackpad pinch) zooms the picture, never the page (C4)", async ({ page }) => {
    await withPicture(page);
    await openEditor(page);
    const prevented = await page.locator(".mk__stage").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -40, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
      el.querySelector("canvas")!.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test("the drawing area is an application, and Tab goes tools, picture, Undo, Redo, Clear, Cancel, Save (C5, C6)", async ({ page }) => {
    await withPicture(page);
    await openEditor(page);
    const c = page.locator(".mk__canvas");
    await expect(c).toHaveAttribute("role", "application");
    await expect(c).toHaveAttribute("aria-roledescription", "drawing area");
    await page.getByRole("radio", { name: "Pen" }).focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.split(" ")[0] || document.activeElement?.textContent?.trim() || ""));
    }
    expect(order[0]).toBe("picture");
    expect(order.slice(1)).toEqual(["Undo", "Redo", "Clear", "Cancel", "Save"]);
  });

  test("the tool bar is one Tab stop and arrow keys choose (C7)", async ({ page }) => {
    await withPicture(page);
    await openEditor(page);
    await expect(page.getByRole("radio", { name: "Box" })).toHaveAttribute("tabindex", "-1");
    await page.getByRole("radio", { name: "Pen" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Box" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Box" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("radio", { name: "Arrow" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Pen" })).toHaveAttribute("tabindex", "-1");
  });

  test("a pointer that is already gone never throws, and the stroke still counts (C8)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await withPicture(page);
    await openEditor(page);
    await page.locator(".mk__canvas").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = (f: number, type: string) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 4242, pointerType: "mouse", button: 0, buttons: 1, clientX: r.x + r.width * f, clientY: r.y + r.height / 2 });
      el.dispatchEvent(at(0.3, "pointerdown"));
      for (const f of [0.4, 0.5, 0.6, 0.7]) el.dispatchEvent(at(f, "pointermove"));
      el.dispatchEvent(at(0.7, "pointerup"));
    });
    await expect(page.locator(".mk [role=status]")).toContainText("1 mark");
    expect(errors).toEqual([]);
  });
});

test.describe("the markup editor on a phone and a tablet (C9)", () => {
  test("holding Undo opens no menu or callout on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withPicture(page);
    await openEditor(page);
    const undo = page.getByRole("button", { name: /^Undo/ });
    const style = await undo.evaluate((el) => {
      const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
      return { select: s.userSelect || s.webkitUserSelect, callout: s.webkitTouchCallout ?? "none" };
    });
    expect(style.select).toBe("none");
    expect(style.callout).toBe("none");
    const prevented = await undo.evaluate((el) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test("a tablet shows Redo as its own button", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await withPicture(page);
    await openEditor(page);
    await expect(page.getByRole("button", { name: "Redo" })).toBeVisible();
  });
});

test.describe("the composer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keyboard focus stays on the button when Send turns into Stop and back (C3)", async ({ page }) => {
    await open(page);
    await box(page).fill("How do I write a terraform module? #long");
    await panel(page).getByRole("button", { name: "Send" }).focus();
    await page.keyboard.press("Enter");
    const stop = panel(page).getByRole("button", { name: "Stop answer" });
    await expect(stop).toBeVisible();
    await expect(stop).toBeFocused();
    await page.keyboard.press("Enter");
    const send = panel(page).getByRole("button", { name: "Send" });
    await expect(send).toBeVisible({ timeout: 10_000 });
    await expect(send).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
  });

  test("the Still using take-away buttons are 44 px targets (C10)", async ({ page }) => {
    await open(page);
    await dispatch(page, ".help-panel__log", "drop", [pdf("report.pdf")]);
    await box(page).fill("What is in this?");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await expect(panel(page).locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    const drop = panel(page).locator(".ask-carry__drop").first();
    await expect(drop).toBeVisible();
    const b = (await drop.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(parseFloat(await panel(page).locator(".ask-carry").evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  });

  test("a screen reader hears how many files a drop added (C11)", async ({ page }) => {
    await open(page);
    await dispatch(page, ".help-panel__log", "drop", [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);
    await expect(panel(page).getByText("3 files added. 3 of 10.")).toBeAttached();
  });

  test("files uploaded for a question that can't start are taken away (A2)", async ({ page }) => {
    await open(page);
    await dispatch(page, ".help-panel__log", "drop", [pdf("report.pdf")]);
    await box(page).fill("What is this? #429");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.evaluate(() => Object.values(window.__cfMockAsk?.files ?? {}).map((f) => f.name))).toEqual([]);
  });

  test("an ordinary question about tokens is answered, not refused (B2)", async ({ page }) => {
    await open(page);
    await box(page).fill("Tell me how to store API keys in Terraform");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await expect(panel(page).locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator(".ask-msg").last()).not.toContainText("can't show passwords");
  });
});

test("the Ask button glows while files are dragged over it (C12)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const launcher = page.locator(".help-launcher");
  await launcher.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "a.pdf", { type: "application/pdf" }));
    const e = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
    if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
    el.dispatchEvent(e);
  });
  await expect(launcher).toHaveClass(/is-drop/);
  await launcher.evaluate((el) => el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: document.body })));
  await expect(launcher).not.toHaveClass(/is-drop/);
});

test("Get a search key is a big button, not a link in a sentence (C13)", async ({ page }) => {
  await page.goto("/settings/app/ask");
  await settle(page);
  await page.getByRole("button", { name: "Take key away" }).click();
  const get = page.getByRole("link", { name: "Get a search key" });
  await expect(get).toBeVisible();
  await expect(get).toHaveClass(/btn/);
  expect((await get.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(get).toHaveAttribute("rel", "noopener noreferrer");
});
