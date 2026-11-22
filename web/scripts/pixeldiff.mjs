// The pixel test of web/scripts/clips-unchanged.sh (docs/CONTRACTS.md §45.19, §45.35 D20): pixelmatch's
// (github.com/mapbox/pixelmatch, ISC licence, by Mapbox) colour distance and antialiasing test, with includeAA false.
// A pixel differs when its YIQ colour distance from the other picture's is over `threshold` (0..1, 0.1 by default),
// unless it is an antialiased pixel in either picture: an edge pixel between two flat areas whose neighbours both
// pictures share, which text or a curve drawn twice can shade a little differently. Those are counted apart (`aa`),
// never as a difference, so a real change of layout or colour still fails while font smoothing does not. `exact`
// counts every pixel that is not byte-identical, as the script did before. Pixels inside a `mask` box are left out,
// and so are the pixels in `ignore`: where the first picture (the merge base) changes when it is only shot again, so
// a page that moves by itself (a line of text snapping 1 px) is never blamed on the branch.
//
// No imports and plain JavaScript on purpose: the script also runs this file in a browser page (it is put in as a
// classic script there, so `export` is taken off and cfPixelDiff is the global it calls).

/** @typedef {{ x: number; y: number; w: number; h: number }} Box */

/**
 * @param {Uint8ClampedArray | Uint8Array} a RGBA of the first picture
 * @param {Uint8ClampedArray | Uint8Array} b RGBA of the second, the same size
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number; exact?: boolean; mask?: Box[]; ignore?: Uint8Array | null }} [opts] ignore: one byte per
 *   pixel, non-zero where the first picture moves on its own (the kinds of the first picture against itself shot
 *   again): those pixels are left out and counted apart (`moving`)
 * @returns {{ diff: number; aa: number; moving: number; kinds: Uint8Array }} kinds: 0 the same (or masked or moving),
 *   1 antialiased, 2 differs
 */
export function pixelDiff(a, b, width, height, opts = {}) {
  const threshold = opts.threshold ?? 0.1;
  const exact = opts.exact === true;
  const mask = opts.mask ?? [];
  const ignore = opts.ignore ?? null;
  const W = width;
  const H = height;
  const kinds = new Uint8Array(W * H);
  const masked = (x, y) => mask.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);

  const blend = (c, al) => 255 + (c - 255) * al;
  const rgb2y = (r, g, bl) => r * 0.29889531 + g * 0.58662247 + bl * 0.11448223;
  const rgb2i = (r, g, bl) => r * 0.59597799 - g * 0.2741761 - bl * 0.32180189;
  const rgb2q = (r, g, bl) => r * 0.21147017 - g * 0.52261711 + bl * 0.31114694;

  /** pixelmatch's colourDelta: the squared YIQ distance (signed by which is brighter), or the brightness only. */
  const colorDelta = (img1, img2, k, m, yOnly) => {
    let r1 = img1[k];
    let g1 = img1[k + 1];
    let b1 = img1[k + 2];
    let a1 = img1[k + 3];
    let r2 = img2[m];
    let g2 = img2[m + 1];
    let b2 = img2[m + 2];
    let a2 = img2[m + 3];
    if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
    if (a1 < 255) {
      a1 /= 255;
      r1 = blend(r1, a1);
      g1 = blend(g1, a1);
      b1 = blend(b1, a1);
    }
    if (a2 < 255) {
      a2 /= 255;
      r2 = blend(r2, a2);
      g2 = blend(g2, a2);
      b2 = blend(b2, a2);
    }
    const y1 = rgb2y(r1, g1, b1);
    const y2 = rgb2y(r2, g2, b2);
    const y = y1 - y2;
    if (yOnly) return y;
    const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
    const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
    const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    return y1 > y2 ? -delta : delta;
  };

  /** Whether the pixel has more than two neighbours of exactly its colour (it is in a flat area). */
  const hasManySiblings = (img, x1, y1) => {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, W - 1);
    const y2 = Math.min(y1 + 1, H - 1);
    const pos = (y1 * W + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    for (let x = x0; x <= x2; x++)
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue;
        const pos2 = (y * W + x) * 4;
        if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] && img[pos + 2] === img[pos2 + 2] && img[pos + 3] === img[pos2 + 3]) zeroes++;
        if (zeroes > 2) return true;
      }
    return false;
  };

  /** pixelmatch's antialiased(): the pixel sits between its darkest and brightest neighbour, which are in flat areas of both pictures. */
  const antialiased = (img, x1, y1, img2) => {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, W - 1);
    const y2 = Math.min(y1 + 1, H - 1);
    const pos = (y1 * W + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    let min = 0;
    let max = 0;
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (let x = x0; x <= x2; x++)
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue;
        const delta = colorDelta(img, img, pos, (y * W + x) * 4, true);
        if (delta === 0) {
          zeroes++;
          if (zeroes > 2) return false;
        } else if (delta < min) {
          min = delta;
          minX = x;
          minY = y;
        } else if (delta > max) {
          max = delta;
          maxX = x;
          maxY = y;
        }
      }
    if (min === 0 || max === 0) return false;
    return (hasManySiblings(img, minX, minY) && hasManySiblings(img2, minX, minY)) || (hasManySiblings(img, maxX, maxY) && hasManySiblings(img2, maxX, maxY));
  };

  const maxDelta = 35215 * threshold * threshold;
  let diff = 0;
  let aa = 0;
  let moving = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const i = p * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      if (masked(x, y)) continue;
      if (ignore && ignore[p]) {
        moving++;
        continue;
      }
      if (exact) {
        kinds[p] = 2;
        diff++;
        continue;
      }
      if (Math.abs(colorDelta(a, b, i, i, false)) <= maxDelta) continue;
      if (antialiased(a, x, y, b) || antialiased(b, x, y, a)) {
        kinds[p] = 1;
        aa++;
      } else {
        kinds[p] = 2;
        diff++;
      }
    }
  return { diff, aa, moving, kinds };
}
