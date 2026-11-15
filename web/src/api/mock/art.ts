// Synthetic covers and thumbnails for mock mode, drawn as SVG so the demo needs no image files.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const toData = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

interface Scene {
  sky: [string, string];
  glow: string;
  ground: string;
}

const SCENES: Scene[] = [
  { sky: ["#2b3a28", "#7d9468"], glow: "#e8412c", ground: "#1e2a1b" },
  { sky: ["#3a1f1a", "#c4553e"], glow: "#f7c59f", ground: "#22150f" },
  { sky: ["#1d2b3a", "#5f7f99"], glow: "#9caf88", ground: "#121a22" },
  { sky: ["#3b3424", "#b59a5b"], glow: "#e8412c", ground: "#1f1b12" },
  { sky: ["#2a2333", "#7a6492"], glow: "#f7f5ef", ground: "#18141e" },
  { sky: ["#1f3330", "#5c9a8b"], glow: "#f2a65a", ground: "#122019" },
];

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** A 9:16 cover: a moody abstract "frame", the facecam box on top and the hook in a caption band. */
export function coverArt(seed: number, hook: string, layout: "facecam_top" | "blur_fill"): string {
  const s = SCENES[seed % SCENES.length]!;
  const lines = wrap(hook.toUpperCase(), 16);
  const text = lines
    .map(
      (l, i) =>
        `<text x="270" y="${150 + i * 54}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="44" fill="#fff" stroke="#000" stroke-width="6" paint-order="stroke">${esc(l)}</text>`,
    )
    .join("");
  const cam =
    layout === "facecam_top"
      ? `<rect x="40" y="300" width="460" height="260" rx="18" fill="${s.ground}" opacity=".85"/><circle cx="270" cy="410" r="62" fill="${s.sky[1]}"/><rect x="190" y="470" width="160" height="90" rx="40" fill="${s.sky[1]}"/>`
      : `<rect x="0" y="330" width="540" height="300" fill="${s.ground}" opacity=".6"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 960" width="540" height="960">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${s.sky[0]}"/><stop offset="1" stop-color="${s.sky[1]}"/></linearGradient>
<radialGradient id="r" cx=".7" cy=".72" r=".5"><stop offset="0" stop-color="${s.glow}" stop-opacity=".85"/><stop offset="1" stop-color="${s.glow}" stop-opacity="0"/></radialGradient></defs>
<rect width="540" height="960" fill="url(#g)"/><rect width="540" height="960" fill="url(#r)"/>
<path d="M0 760 L120 690 L210 730 L330 640 L540 720 L540 960 L0 960Z" fill="${s.ground}" opacity=".9"/>
<path d="M60 960 L250 700 L290 700 L480 960Z" fill="${s.glow}" opacity=".18"/>
${cam}${text}</svg>`;
  return toData(svg);
}

/** A 16:9 source thumbnail. */
export function thumbArt(seed: number, label: string): string {
  const s = SCENES[seed % SCENES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s.sky[0]}"/><stop offset="1" stop-color="${s.sky[1]}"/></linearGradient>
<radialGradient id="r" cx=".25" cy=".3" r=".6"><stop offset="0" stop-color="${s.glow}" stop-opacity=".7"/><stop offset="1" stop-color="${s.glow}" stop-opacity="0"/></radialGradient></defs>
<rect width="640" height="360" fill="url(#g)"/><rect width="640" height="360" fill="url(#r)"/>
<path d="M0 280 L160 220 L300 260 L460 200 L640 250 L640 360 L0 360Z" fill="${s.ground}"/>
<text x="608" y="320" text-anchor="end" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="34" fill="#fff">${esc(label.toUpperCase())}</text></svg>`;
  return toData(svg);
}
