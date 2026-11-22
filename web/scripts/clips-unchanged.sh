#!/usr/bin/env bash
# Clip Factory, pixel for pixel (docs/CONTRACTS.md §45.19). Builds the mock app of the merge base and of this branch
# on this one machine (Mac and CI render fonts differently, so both shots must come from the same machine), serves
# both, and screenshots Clip Factory's main pages (/, /jobs, /review, /library, /money, /settings) at 390×844,
# 1000×600, 1000×650, 1000×720 and 1440×900 (sidebar open and folded) with a fixed clock, fixed mock data and no
# motion. Twice: with Lamo Stories switched off every pixel must match; switched on (cf.storiesPreview = 1) every
# pixel outside the workspace switcher's own box must match. The lead runs it on the switch PR and in the final check.
#
#   web/scripts/clips-unchanged.sh [base-ref] [--out <dir>] [--sizes 390x844,1440x900]
#
# base-ref defaults to the merge base of HEAD and origin/main. --out keeps before, after and a diff picture (the
# differing pixels in red) of every shot that differs. A pair that differs is shot again (CF_TRIES, default 3): a
# few mock pages move on their own (live job progress), so only a difference every pair shows counts. Exits 1 when
# any shot differs. Nothing leaves the machine:
# the mock build talks to no server, and the only network use is `npm ci` for the base checkout's packages.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # web/
repo="$(cd "$here/.." && pwd)"
base=""
out=""
sizes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --sizes) sizes="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) base="$1"; shift ;;
  esac
done
[ -n "$base" ] || base="$(git -C "$repo" merge-base HEAD origin/main)"

work="$(mktemp -d "${TMPDIR:-/tmp}/clips-unchanged.XXXXXX")"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  git -C "$repo" worktree remove --force "$work/base" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "Base: $(git -C "$repo" rev-parse --short "$base")  Branch: $(git -C "$repo" rev-parse --short HEAD)"
git -C "$repo" worktree add --detach "$work/base" "$base" >/dev/null 2>&1

# The base's own packages (the same lock file: reuse this checkout's, else install its own).
if cmp -s "$here/package-lock.json" "$work/base/web/package-lock.json" && [ -d "$here/node_modules" ]; then
  ln -s "$here/node_modules" "$work/base/web/node_modules"
else
  (cd "$work/base/web" && npm ci --no-audit --no-fund >/dev/null)
fi
[ -d "$here/node_modules" ] || (cd "$here" && npm ci --no-audit --no-fund >/dev/null)

echo "Building the base's mock app…"
(cd "$work/base/web" && npm run build:mock >/dev/null 2>&1)
echo "Building this branch's mock app…"
(cd "$here" && npm run build:mock >/dev/null 2>&1)

free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }
p1="$(free_port)"; p2="$(free_port)"
while [ "$p2" = "$p1" ]; do p2="$(free_port)"; done
(cd "$work/base/web" && exec npx vite preview --outDir dist-mock --port "$p1" --strictPort >/dev/null 2>&1) & pids+=($!)
(cd "$here" && exec npx vite preview --outDir dist-mock --port "$p2" --strictPort >/dev/null 2>&1) & pids+=($!)
for p in "$p1" "$p2"; do
  for _ in $(seq 1 60); do curl -fsS "http://localhost:$p/" >/dev/null 2>&1 && break; sleep 0.5; done
done

# The comparison itself (Playwright from this checkout's packages).
cat > "$work/compare.mjs" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.CF_PLAYWRIGHT).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const urls = args.filter((a, i) => !a.startsWith("--") && !["--out", "--sizes"].includes(args[i - 1] ?? ""));
if (urls.length !== 2) {
  console.error("usage: compare <before-url> <after-url> [--stories-on] [--out <dir>] [--sizes 390x844,1000x650,1440x900]");
  process.exit(2);
}
const [before, after] = urls.map((u) => u.replace(/\/+$/, ""));
const storiesOn = flag("--stories-on");
const out = value("--out");
const PAGES = ["/", "/jobs", "/review", "/library", "/money", "/settings"];
const SIZES = (value("--sizes") ?? "390x844,1000x600,1000x650,1000x720,1440x900").split(",").map((s) => s.split("x").map(Number));
/** A fixed moment, so every "2 h ago" and every chart reads the same in both runs. */
const CLOCK = new Date("2026-11-21T12:00:00.000Z");
const TRIES = Number(process.env.CF_TRIES || 3);
const STILL = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

if (out) mkdirSync(out, { recursive: true });

async function shot(browser, base, path, [w, h], folded, on) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", deviceScaleFactor: 1 });
  await ctx.addInitScript(
    ([flagOn, fold, still]) => {
      // The same mock data in both runs: the mock's random picks come from one fixed seed.
      let seed = 0x5eed1234;
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      localStorage.clear();
      if (flagOn) localStorage.setItem("cf.storiesPreview", "1");
      if (fold) localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
      const add = () => {
        const style = document.createElement("style");
        style.textContent = still;
        document.head.append(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    },
    [on, folded, STILL],
  );
  const page = await ctx.newPage();
  await page.clock.setFixedTime(CLOCK);
  await page.goto(base + path);
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot"), undefined, { timeout: 20_000 });
  await page.locator(w < 768 ? ".topbar .live-dot" : ".sidebar__live .live-dot").waitFor({ timeout: 8_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  const mask = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".ws-switch-host"))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width) + 1, h: Math.ceil(r.height) + 1 })),
  );
  // The page has settled when two shots in a row are the same (a late label or a check that finishes).
  let png = await page.screenshot({ type: "png" });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(450);
    const again = await page.screenshot({ type: "png" });
    if (again.equals(png)) break;
    png = again;
  }
  await ctx.close();
  return { png, mask };
}

/** Counts differing pixels in a blank page (the browser decodes the PNGs), outside the masked boxes. */
async function compare(page, a, b, mask) {
  return page.evaluate(
    async ({ a, b, mask }) => {
      const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { diff: -1, size: `${ia.width}×${ia.height} vs ${ib.width}×${ib.height}`, png: null };
      const read = (img) => {
        const c = new OffscreenCanvas(img.width, img.height);
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, img.width, img.height);
      };
      const da = read(ia);
      const db = read(ib);
      const outImg = new ImageData(ia.width, ia.height);
      const masked = (x, y) => mask.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
      let diff = 0;
      for (let y = 0; y < ia.height; y++)
        for (let x = 0; x < ia.width; x++) {
          const i = (y * ia.width + x) * 4;
          const same = da.data[i] === db.data[i] && da.data[i + 1] === db.data[i + 1] && da.data[i + 2] === db.data[i + 2] && da.data[i + 3] === db.data[i + 3];
          const skip = !same && masked(x, y);
          if (!same && !skip) diff++;
          outImg.data[i] = !same && !skip ? 255 : da.data[i] / 3;
          outImg.data[i + 1] = !same && !skip ? 0 : da.data[i + 1] / 3;
          outImg.data[i + 2] = !same && !skip ? 0 : da.data[i + 2] / 3;
          outImg.data[i + 3] = 255;
        }
      let png = null;
      if (diff > 0) {
        const c = new OffscreenCanvas(ia.width, ia.height);
        c.getContext("2d").putImageData(outImg, 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        png = btoa(s);
      }
      return { diff, size: `${ia.width}×${ia.height}`, png };
    },
    { a: a.toString("base64"), b: b.toString("base64"), mask },
  );
}

const browser = await chromium.launch();
const blank = await (await browser.newContext()).newPage();
let failed = 0;
const rows = [];
for (const size of SIZES)
  for (const folded of size[0] >= 768 ? [false, true] : [false])
    for (const path of PAGES) {
      // A few mock pages move on their own (live job progress, timed numbers), so one pair can differ by chance:
      // a differing pair is shot again, up to TRIES times, and only a difference every pair shows is reported.
      let a, b, r;
      for (let t = 0; t < TRIES; t++) {
        a = await shot(browser, before, path, size, folded, false);
        b = await shot(browser, after, path, size, folded, storiesOn);
        r = await compare(blank, a.png, b.png, storiesOn ? b.mask : []);
        if (r.diff === 0) break;
      }
      const name = `${path === "/" ? "home" : path.slice(1)}-${size[0]}x${size[1]}${folded ? "-folded" : ""}`;
      if (r.diff !== 0) failed++;
      rows.push(`${r.diff === 0 ? "same" : "DIFF"}  ${name.padEnd(28)} ${r.diff < 0 ? `size ${r.size}` : `${r.diff} px differ`}${storiesOn && b.mask.length ? ` (switcher box left out: ${b.mask.map((m) => `${m.w}×${m.h} at ${m.x},${m.y}`).join(", ")})` : ""}`);
      console.log(rows.at(-1));
      if (out && r.diff !== 0) {
        writeFileSync(join(out, `${name}-before.png`), a.png);
        writeFileSync(join(out, `${name}-after.png`), b.png);
        if (r.png) writeFileSync(join(out, `${name}-diff.png`), Buffer.from(r.png, "base64"));
      }
    }
await browser.close();
console.log(failed ? `\n${failed} of ${rows.length} shots differ.` : `\nAll ${rows.length} shots match pixel for pixel${storiesOn ? " outside the switcher" : ""}.`);
process.exit(failed ? 1 : 0);
NODE

export CF_PLAYWRIGHT="$here/node_modules/@playwright/test/index.mjs"
args=()
[ -n "$out" ] && args+=(--out "$out")
[ -n "$sizes" ] && args+=(--sizes "$sizes")
status=0
echo; echo "Lamo Stories switched off: every pixel must match."
node "$work/compare.mjs" "http://localhost:$p1" "http://localhost:$p2" "${args[@]+"${args[@]}"}" || status=1
echo; echo "Lamo Stories switched on: every pixel outside the switcher must match."
node "$work/compare.mjs" "http://localhost:$p1" "http://localhost:$p2" --stories-on "${args[@]+"${args[@]}"}" || status=1
exit "$status"
