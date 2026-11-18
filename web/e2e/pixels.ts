import type { Page } from "@playwright/test";

/** A screenshot's pixels (RGBA, row by row), decoded in the page so no PNG library is needed. */
export interface Pixels {
  width: number;
  height: number;
  data: number[];
}

export async function decode(page: Page, png: Buffer): Promise<Pixels> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, png.toString("base64"));
}

/** The relative luminance-ish grey (0..255) of one pixel. */
export function grey(p: Pixels, x: number, y: number): number {
  const i = (y * p.width + x) * 4;
  return 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
}

/** How busy a picture is: the mean absolute difference between neighbouring pixels (sharp text is high, a blur low). */
export function busyness(p: Pixels): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < p.height; y++)
    for (let x = 1; x < p.width; x++) {
      sum += Math.abs(grey(p, x, y) - grey(p, x - 1, y));
      n++;
    }
  return sum / n;
}

/** The mean grey of each row. */
export function rowMeans(p: Pixels): number[] {
  const out: number[] = [];
  for (let y = 0; y < p.height; y++) {
    let s = 0;
    for (let x = 0; x < p.width; x++) s += grey(p, x, y);
    out.push(s / p.width);
  }
  return out;
}
