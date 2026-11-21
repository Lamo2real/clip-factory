// Lamo Stories engine: where on-screen text goes and how it breaks into lines (captions, scene teaching text, the
// safety end card). Text is never cut: a caption that does not fit its lines at the smallest size gets one more line,
// and the end card shortens the publishers' names before it would ever lose "Check your local road rules.".

/** Captions sit in the platforms' safe area: above the bottom bar of names and buttons, away from the right column. */
export const CAPTION = { x: 520, y: 1400, maxW: 840, sizes: [64, 58, 52, 46, 40], color: "#fff6e5", maxLines: 2 };
/** Scene teaching text: under the platforms' top tabs. */
export const HEADER = { x: 520, y: 330, maxW: 840, sizes: [60, 54, 48, 42, 40], color: "#ffc94a", maxLines: 2 };
/** The safety end card: high up, over the background, so it never covers a face. */
export const ENDCARD = { x: 540, y: 420, maxW: 860, sizes: [52, 48, 44, 40], color: "#fff6e5", seconds: 2.5, maxLines: 4 };
/** When, in the last scene, the end card starts: its last 2.5 s (a scene lasts at least 2 s, so the card never
 * reaches into the scene before, and each scene's frames depend on that scene alone). */
export function endCardFrom(lastSceneSec: number): number {
  return Math.max(0, lastSceneSec - ENDCARD.seconds);
}
/** Line height of every text block, in sizes. */
export const LINE_HEIGHT = 1.18;
/** The sentence every safety video ends on (CONTRACTS §45.11.5). */
export const LOCAL_RULES = "Check your local road rules.";

/** Inter ExtraBold widths in em, roughly: enough to wrap lines before they overflow. */
function charEm(ch: string): number {
  if (ch === " ") return 0.27;
  if ("il.,:;'!|I·•".includes(ch)) return 0.3;
  if ("ftrj()[]-/\"".includes(ch)) return 0.42;
  if ("mwMW@%&".includes(ch)) return 0.92;
  if (ch >= "A" && ch <= "Z") return 0.72;
  if (ch >= "0" && ch <= "9") return 0.63;
  return 0.6;
}

export function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size * 1.04;
}

/** A word wider than a whole line is split into pieces that fit (a long web address, say). */
function pieces(word: string, size: number, maxW: number): string[] {
  if (textWidth(word, size) <= maxW) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur && textWidth(cur + ch, size) > maxW) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Splits text into lines no wider than maxW; two lines are balanced. Every word is kept. */
export function wrapText(text: string, size: number, maxW: number): string[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => pieces(w, size, maxW));
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(next, size) <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 2) {
    let best = lines;
    let bestW = Math.max(...lines.map((l) => textWidth(l, size)));
    for (let i = 1; i < words.length; i += 1) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i).join(" ");
      const wmax = Math.max(textWidth(a, size), textWidth(b, size));
      if (wmax <= maxW && wmax < bestW) {
        best = [a, b];
        bestW = wmax;
      }
    }
    return best;
  }
  return lines;
}

/** Smaller sizes for the rare text that needs more than its lines even at its smallest size (very wide letters). */
const SPARE_SIZES = [36, 32];

/** The biggest size at which the text fits in `maxLines` lines; failing that, one line more at a smaller size; and
 * failing even that, as many lines as it needs. A caption is never cut short. */
export function fitText(text: string, sizes: number[], maxW: number, maxLines: number): { lines: string[]; size: number } {
  const fits = (size: number, most: number) => {
    const lines = wrapText(text, size, maxW);
    return lines.length <= most ? { lines, size } : null;
  };
  for (const size of sizes) {
    const ok = fits(size, maxLines);
    if (ok) return ok;
  }
  const smallest = sizes[sizes.length - 1]!;
  for (const size of [smallest, ...SPARE_SIZES.filter((v) => v < smallest)]) {
    const ok = fits(size, maxLines + 1);
    if (ok) return ok;
  }
  const size = Math.min(smallest, ...SPARE_SIZES);
  return { lines: wrapText(text, size, maxW), size };
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/** How the end card names a publisher: the part after a dash ("… - The Highway Code"), an acronym in brackets
 * ("(RoSPA)"), else the name without its bracketed notes; "Department of Motor Vehicles" is "DMV". */
export function shortPublisher(publisher: string): string {
  const last = publisher.split(/\s+[-–—]\s+/).pop() ?? publisher;
  const acronym = /\(([A-Za-z][A-Za-z.]{1,7})\)/.exec(last)?.[1];
  if (acronym && /[A-Z].*[A-Z]/.test(acronym)) return acronym;
  return last
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\bDepartment of Motor Vehicles\b/g, "DMV")
    .replace(/\s+/g, " ")
    .trim();
}

function names(publishers: string[]): string[] {
  const out: string[] = [];
  for (const p of publishers) {
    const short = shortPublisher(p);
    if (short && !out.some((n) => norm(n) === norm(short))) out.push(short);
  }
  return out;
}

const sentence = (who: string) => `Based on ${who} advice. ${LOCAL_RULES}`;

/** The ways of naming the publishers, the fullest first. */
function credits(who: string[]): string[] {
  if (who.length === 0) return [];
  if (who.length === 1) return [who[0]!];
  const others = `${who[0]} and other road safety`;
  return who.length === 2 ? [`${who[0]} and ${who[1]}`, others] : [`${who[0]}, ${who[1]} and other road safety`, others];
}

/** Each sentence of the end card starts on its own line ("Check your local road rules." stands alone). */
function sentenceLines(text: string): { lines: string[]; size: number } | null {
  const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
  for (const size of ENDCARD.sizes) {
    const lines = sentences.flatMap((t) => wrapText(t, size, ENDCARD.maxW));
    if (lines.length <= ENDCARD.maxLines && lines.every((l) => textWidth(l, size) <= ENDCARD.maxW)) return { lines, size };
  }
  return null;
}

/** "Based on {publisher} advice. Check your local road rules." with the cited publishers, shortened: three or more
 * become "{first}, {second} and other road safety"; when that needs more than four lines, "{first} and other road
 * safety"; with no publisher, "checked road safety". */
export function endCardText(publishers: string[]): string {
  for (const who of credits(names(publishers))) {
    const text = sentence(who);
    if (sentenceLines(text)) return text;
  }
  return sentence("checked road safety");
}

/** The end card's lines and size: never a word dropped. */
export function endCardLines(text: string): { lines: string[]; size: number } {
  return sentenceLines(text) ?? fitText(text, ENDCARD.sizes, ENDCARD.maxW, ENDCARD.maxLines);
}

/** The end card's block: its lines, size, and how far it reaches down the frame (px). */
export function endCardLayout(publishers: string[]): { text: string; lines: string[]; size: number; bottom: number } {
  const text = endCardText(publishers);
  const { lines, size } = endCardLines(text);
  return { text, lines, size, bottom: ENDCARD.y + (lines.length * size * LINE_HEIGHT) / 2 };
}
