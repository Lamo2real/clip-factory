// Renders the app icons (PWA, Apple touch, favicon) with Playwright's Chromium. Run with `npm run icons` after
// changing the mark; the PNGs are committed in public/icons.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(import.meta.dirname, "..");
const out = join(root, "public", "icons");
mkdirSync(out, { recursive: true });

const font = readFileSync(join(root, "node_modules/@fontsource/tinos/files/tinos-latin-400-italic.woff2")).toString("base64");

/** The mark: an italic bone serif C with the vermilion dot, on bottle-green glass. `inset` keeps maskable icons in the safe zone. */
function svg({ size, radius, inset }) {
  const s = size;
  const r = radius * s;
  const pad = inset * s;
  const inner = s - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <style>@font-face{font-family:Tinos;font-style:italic;src:url(data:font/woff2;base64,${font}) format("woff2")}</style>
    <radialGradient id="bg" cx=".3" cy=".25" r=".95">
      <stop offset="0" stop-color="#1B4A3B"/><stop offset="1" stop-color="#0F372B"/>
    </radialGradient>
    <radialGradient id="glow" cx=".85" cy=".9" r=".6">
      <stop offset="0" stop-color="#E8392B" stop-opacity=".45"/><stop offset="1" stop-color="#E8392B" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#EFE7DA" stop-opacity=".35"/><stop offset=".4" stop-color="#EFE7DA" stop-opacity="0"/>
      <stop offset="1" stop-color="#EFE7DA" stop-opacity=".2"/>
    </linearGradient>
  </defs>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#bg)"/>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#glow)"/>
  <rect x="${s * 0.008}" y="${s * 0.008}" width="${s * 0.984}" height="${s * 0.984}" rx="${r}" fill="none" stroke="url(#rim)" stroke-width="${s * 0.016}"/>
  <text x="${pad + inner * 0.43}" y="${pad + inner * 0.79}" text-anchor="middle" font-family="Tinos" font-style="italic"
        font-size="${inner * 0.86}" fill="#EFE7DA">C</text>
  <circle cx="${pad + inner * 0.8}" cy="${pad + inner * 0.2}" r="${inner * 0.062}" fill="#E8392B"/>
</svg>`;
}

const brand = join(root, "public", "brand");
mkdirSync(brand, { recursive: true });

const all = [
  // The square app icon the platforms' developer websites ask for (§17.2): 1024 × 1024, no platform logos.
  { file: "clip-factory-1024.png", size: 1024, radius: 0, inset: 0.1, dir: brand },
  { file: "icon-192.png", size: 192, radius: 0.22, inset: 0.1 },
  { file: "icon-512.png", size: 512, radius: 0.22, inset: 0.1 },
  { file: "maskable-512.png", size: 512, radius: 0, inset: 0.2 },
  { file: "apple-touch-icon.png", size: 180, radius: 0, inset: 0.12 },
  { file: "favicon-32.png", size: 32, radius: 0.22, inset: 0.04 },
];

// `npm run icons -- clip-factory-1024.png` renders just that one.
const only = process.argv.slice(2);
const targets = only.length ? all.filter((t) => only.includes(t.file)) : all;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(t)}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(t.dir ?? out, t.file), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log("wrote", t.file);
}
await browser.close();

writeFileSync(join(root, "public", "favicon.svg"), svg({ size: 64, radius: 0.22, inset: 0.04 }));
console.log("wrote favicon.svg");
