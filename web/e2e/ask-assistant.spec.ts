// Ask as a full assistant in the mock build (docs/CONTRACTS.md §28): streaming answers with a status line, sources,
// live links only when allowed, app buttons with the spotlight, Stop, general questions with code and tables, the
// setup-state question with a web source, web search not set up, files by paperclip, drop (panel and launcher) and
// paste, long pasted text as a TXT file, the thumb zone, no overflow, no edges, reduced motion, and screenshots at
// five sizes in light and dark. Set CF_ASK_SCREENS to a folder to also save the owner's screenshots there.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle } from "./helpers.ts";

const SIZES = [
  { name: "phone-375", width: 375, height: 812 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
] as const;
const FIX = join(import.meta.dirname, "fixtures");
const SCREENS = process.env.CF_ASK_SCREENS;

const panel = (page: Page) => page.locator("#help-panel");
const box = (page: Page) => panel(page).getByLabel("Your question");
const answers = (page: Page) => panel(page).locator(".ask-msg");
const tiles = (page: Page) => panel(page).locator(".help-pic:not(.is-leaving)");

async function open(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Add a file" })).toBeVisible();
}

async function ask(page: Page, text: string) {
  await box(page).fill(text);
  await panel(page).getByRole("button", { name: "Send" }).click();
}

async function answered(page: Page) {
  await expect(answers(page).last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
}

function fileArg(name: string, type: string, bytes?: Buffer) {
  const data = bytes ?? readFileSync(join(FIX, name));
  return { b64: data.toString("base64"), name, type };
}

/** A tiny but real PDF, DOCX and ZIP for the tray (the mock only needs the bytes and the name). */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n");
const DOCX = Buffer.from("PK\u0003\u0004 fake docx bytes for the tray");
const ZIP = Buffer.from("PK\u0003\u0004 fake zip");

async function dispatchFiles(page: Page, selector: string, kind: "drop" | "paste", files: { b64: string; name: string; type: string }[]) {
  await page.evaluate(
    ({ selector: sel, kind: k, files: list }) => {
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
        return;
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
        target.dispatchEvent(e);
      }
    },
    { selector, kind, files },
  );
}

async function shot(page: Page, name: string, info: { outputPath(n: string): string }) {
  const file = `${name}.png`;
  await page.screenshot({ path: info.outputPath(file) });
  if (SCREENS) {
    mkdirSync(SCREENS, { recursive: true });
    await page.screenshot({ path: join(SCREENS, file) });
  }
}

test.describe("Ask as a full assistant", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("streams an app answer: status, words before done, sources, then Open buttons with the spotlight", async ({ page }) => {
    await open(page);
    await ask(page, "How do I change my click sound?");
    const a = answers(page).last();
    await expect(a.locator(".ask-status")).toBeVisible();
    // The first words show before the answer is done.
    await expect(a.locator(".ask-answer")).toBeVisible();
    await expect(a).toHaveAttribute("aria-busy", "true");
    await answered(page);
    await expect(a.locator(".ask-sources")).toContainText("Clip Factory guide");
    const button = a.locator(".help-actions .btn").first();
    await expect(button).toBeVisible();
    await expect(button).toHaveClass(/btn--primary/);
    await button.click();
    await expect(page).toHaveURL(/\/settings\//);
    await expect(page.locator(".help-ring")).toBeVisible();
  });

  test("a general question: a code block with Copy, and a table", async ({ page }) => {
    await open(page);
    await ask(page, "How do I write a terraform module?");
    await answered(page);
    const a = answers(page).last();
    await expect(a.locator(".ask-code pre code")).toContainText('resource "aws_s3_bucket"');
    await expect(a.locator(".ask-code").getByRole("button", { name: "Copy" })).toBeVisible();
    await ask(page, "A quick pasta recipe please");
    await answered(page);
    await expect(answers(page).last().locator("table.md__table th").first()).toHaveText("What");
  });

  test("the setup question uses his setup and a web source; links go live only when done", async ({ page }) => {
    await open(page);
    await ask(page, "I made the Meta app, what now? #search");
    const a = answers(page).last();
    await expect(a.locator(".ask-status")).toContainText(/Searching the web|Reading developers.example.test|Checking your setup/, { timeout: 10_000 });
    await expect(a.locator(".ask-cite")).toHaveCount(0); // sources arrive at the end
    await answered(page);
    await expect(a.locator(".ask-cite")).toHaveText("1");
    const link = a.locator(".ask-source__link");
    await expect(link).toHaveAttribute("href", "https://developers.example.test/docs/instagram/app-review");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(a.locator(".help-actions .btn")).toHaveCount(1);
  });

  test("Stop ends the answer", async ({ page }) => {
    await open(page);
    await ask(page, "How do I write a terraform module? #long");
    const stop = panel(page).getByRole("button", { name: "Stop answer" });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(panel(page).getByRole("button", { name: "Send" })).toBeVisible({ timeout: 10_000 });
    const starts = await page.evaluate(() => window.__cfMockAsk?.stops.length ?? 0);
    expect(starts).toBe(1);
  });

  test("web search not set up: says so once and offers Turn on web search, which lights the setting", async ({ page }) => {
    await open(page);
    await ask(page, "What are Meta's newest steps? #nokey");
    await answered(page);
    const a = answers(page).last();
    await expect(a.locator(".ask-answer")).toContainText("I can't search the web yet.");
    const turnOn = a.getByRole("button", { name: "Turn on web search" });
    await expect(turnOn).toBeVisible();
    await turnOn.click();
    await expect(page).toHaveURL(/\/settings\/app\/ask/);
    await expect(page.locator('[data-help="ask-web-setup"]')).toBeVisible();
    await expect(page.locator(".help-ring")).toBeVisible();
  });

  test("the search key card saves and takes away a key without showing it again", async ({ page }) => {
    await page.goto("/settings/app/ask");
    await settle(page);
    await page.getByRole("button", { name: "Take key away" }).click();
    await expect(page.getByText("Web search is off.")).toBeVisible();
    const input = page.getByLabel("Your search key");
    await input.fill("bad-key");
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByText("That key didn't work. Check you copied all of it.")).toBeVisible();
    await input.fill("good-key-123");
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByText("Web search is on.").first()).toBeVisible();
    await expect(page.getByLabel("Your search key")).toHaveCount(0);
  });

  test("files by drop: a picture thumbnail, PDF and DOCX tiles, a refused ZIP", async ({ page }) => {
    await open(page);
    await dispatchFiles(page, ".help-panel__log", "drop", [
      fileArg("shot.png", "image/png"),
      fileArg("report.pdf", "application/pdf", PDF),
      fileArg("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", DOCX),
      fileArg("bundle.zip", "application/zip", ZIP),
    ]);
    await expect(panel(page).locator(".help-note")).toContainText("I can't read .ZIP files. Unzip it and add the files inside.");
    await expect(tiles(page)).toHaveCount(3);
    await expect(panel(page).locator(".help-pic.is-busy")).toHaveCount(0, { timeout: 15_000 });
    const img = panel(page).locator(".help-pic__img").first();
    await expect(img).toHaveAttribute("src", /^blob:/);
    const pdf = panel(page).locator(".ask-file", { hasText: "report.pdf" });
    await expect(pdf.locator(".ask-file__format")).toHaveText("PDF");
    await expect(pdf.locator(".ask-file__size")).toHaveText(/bytes|KB/);
    await expect(panel(page).locator(".ask-file", { hasText: "notes.docx" }).locator(".ask-file__format")).toHaveText("DOCX");
    await ask(page, "What is in these?");
    await answered(page);
    await expect(answers(page).last().locator(".ask-answer")).toContainText("I read report.pdf: 3 pages.");
    const got = await page.evaluate(() => Object.values(window.__cfMockAsk?.files ?? {}).map((f) => [f.name, f.bytes?.length ?? 0]));
    expect(got.map(([n]) => n)).toEqual(expect.arrayContaining(["shot.png", "report.pdf", "notes.docx"]));
    // A follow-up carries the files along.
    await expect(panel(page).locator(".ask-carry")).toContainText("report.pdf");
  });

  test("files dropped on the launcher open Ask with them in the tray", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await dispatchFiles(page, ".help-launcher", "drop", [fileArg("report.pdf", "application/pdf", PDF)]);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator(".ask-file", { hasText: "report.pdf" })).toBeVisible();
  });

  test("paste: a picture, long text as a TXT file, short text as words", async ({ page }) => {
    await open(page);
    await dispatchFiles(page, ".help-panel__input", "paste", [fileArg("shot.png", "image/png")]);
    await expect(panel(page).locator(".help-pic__img")).toHaveCount(1, { timeout: 15_000 });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "word ".repeat(1000));
      const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      if (!e.clipboardData) Object.defineProperty(e, "clipboardData", { value: dt });
      document.querySelector(".help-panel__input")!.dispatchEvent(e);
    });
    await expect(panel(page).locator(".ask-file", { hasText: "Pasted text.txt" }).locator(".ask-file__format")).toHaveText("TXT");
    await expect(panel(page).locator(".help-note")).toContainText("That was long, so I added it as a file.");
    await box(page).focus();
    await page.keyboard.insertText("short words");
    await expect(box(page)).toHaveValue("short words");
  });

  test("falls back to the plain answer when the assistant is off", async ({ page }) => {
    await open(page);
    await ask(page, "Where do I change my click sound? #off");
    await expect(panel(page).locator(".help-msg--bot").last()).toBeVisible({ timeout: 15_000 });
    await expect(answers(page)).toHaveCount(0);
  });
});

for (const size of SIZES) {
  test.describe(`Ask assistant at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("thumb zone, no overflow, no edges", async ({ page }) => {
      await open(page);
      if (size.width < 1024) {
        const v = page.viewportSize()!;
        for (const name of ["Send", "Add a file"]) {
          const b = (await panel(page).getByRole("button", { name }).boundingBox())!;
          expect(b.y + b.height, name).toBeGreaterThan(v.height * 0.6);
        }
      }
      await dispatchFiles(page, ".help-panel__log", "drop", Array.from({ length: 10 }, (_, i) => fileArg(`file-${i}-with-a-long-name.txt`, "text/plain", Buffer.from(`hello ${i}`))));
      await expect(tiles(page)).toHaveCount(10);
      await ask(page, "How do I write a terraform module?");
      await answered(page);
      const over = await findOverflow(page);
      expect(over.page, JSON.stringify(over.items.slice(0, 3))).toBeLessThanOrEqual(over.viewport);
      expect(await visibleEdges(page)).toEqual([]);
    });

    for (const scheme of ["light", "dark"] as const) {
      test(`screenshots in ${scheme}`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page);
        await shot(page, `ask-empty-${size.name}-${scheme}`, info);
        await dispatchFiles(page, ".help-panel__log", "drop", [fileArg("shot.png", "image/png"), fileArg("report.pdf", "application/pdf", PDF)]);
        await expect(panel(page).locator(".help-pic.is-busy")).toHaveCount(0, { timeout: 15_000 });
        await shot(page, `ask-files-tray-${size.name}-${scheme}`, info);
        for (const left of [1, 0]) {
          await tiles(page).first().getByRole("button", { name: /Take away/ }).click();
          await expect(panel(page).locator(".help-pic")).toHaveCount(left);
        }
        await ask(page, "I made the Meta app, what now? #search");
        await answered(page);
        await shot(page, `ask-stream-${size.name}-${scheme}`, info);
        await ask(page, "How do I change my click sound?");
        await answered(page);
        await shot(page, `ask-app-answer-${size.name}-${scheme}`, info);
      });
    }
  });
}

test.describe("Ask with less motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("nothing moves while an answer streams", async ({ page }) => {
    await open(page);
    await ask(page, "How do I write a terraform module?");
    await expect(answers(page).last().locator(".ask-answer")).toBeVisible();
    // The paper plane keeps its 300 ms fade with less motion (§20.6), so it is left out. Less motion clamps every
    // other transition to 1 ms (base.css); one that has just started is still "running" until the next frame on a
    // busy machine, so only animations longer than that count.
    await expect(panel(page).getByRole("button", { name: "Stop answer" })).toBeVisible();
    const running = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#help-panel *"))
        .filter((el) => !el.closest(".fly-btn"))
        .flatMap((el) => el.getAnimations().filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration ?? 0) > 1).map((a) => `${el.className}: ${(a as CSSAnimation).animationName ?? "transition"}`)),
    );
    expect(running).toEqual([]);
  });
});
