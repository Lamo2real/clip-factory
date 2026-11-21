// The Lamo Stories engine's on-screen text never loses words (CONTRACTS §45.10, §45.11.5): the safety end card always
// says "Check your local road rules." for every topic of the checked guidance list, captions that pass validation are
// shown whole, and bubbles in a safety story's last seconds keep clear of the end card.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawFrame, normalizeScript, textTrack, validateScript } from "../src/stories/engine/engine.ts";
import { BUBBLE_R } from "../src/stories/engine/bubbles.ts";
import { CAPTION, ENDCARD, endCardLayout, endCardLines, endCardText, fitText, HEADER, LINE_HEIGHT, LOCAL_RULES, shortPublisher, textWidth, wrapText } from "../src/stories/engine/text.ts";
import type { Prim, StoryScript, TextEvent } from "../src/stories/engine/types.ts";

const ROOT = join(import.meta.dirname, "../..");
const ENGINE = join(ROOT, "web/src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

interface Guidance {
  sources: Record<string, { publisher: string; title: string; url: string; section?: string }>;
  topics: { id: string; citations: string[] }[];
}
const guidance = JSON.parse(readFileSync(join(ROOT, "stories/config/guidance.json"), "utf8")) as Guidance;
const publishersOf = (topic: Guidance["topics"][number]) => topic.citations.map((id) => guidance.sources[id]!.publisher);
const allPublishers = [...new Set(Object.values(guidance.sources).map((s) => s.publisher))];

function subsets<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << items.length; mask += 1) out.push(items.filter((_, i) => mask & (1 << i)));
  return out;
}

const words = (text: string) => text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

function expectCard(publishers: string[]): void {
  const text = endCardText(publishers);
  const { lines, size } = endCardLines(text);
  const label = publishers.join(" | ");
  // every word is on the card, and the last line is the local rules sentence on its own
  expect(words(lines.join(" ")), label).toBe(text);
  expect(text, label).toContain(LOCAL_RULES);
  expect(lines[lines.length - 1], label).toBe(LOCAL_RULES);
  expect(text.startsWith("Based on "), label).toBe(true);
  expect(lines.length, label).toBeLessThanOrEqual(ENDCARD.maxLines);
  expect(size, label).toBeGreaterThanOrEqual(40);
  for (const l of lines) expect(textWidth(l, size), `${label}: ${l}`).toBeLessThanOrEqual(ENDCARD.maxW);
}

describe("the safety end card", () => {
  it("says 'Check your local road rules.' whole for every topic of the checked guidance list", () => {
    expect(guidance.topics.length).toBe(12);
    for (const topic of guidance.topics) expectCard(publishersOf(topic));
  });

  it("does so for any set of a topic's sources, and any one, two or three publishers of the list", () => {
    for (const topic of guidance.topics) for (const set of subsets(publishersOf(topic))) expectCard(set);
    for (const a of allPublishers) {
      expectCard([a]);
      for (const b of allPublishers) {
        if (b === a) continue;
        expectCard([a, b]);
        for (const c of allPublishers) if (c !== a && c !== b) expectCard([a, b, c]);
      }
    }
  });

  it("names the publishers in short, plain words", () => {
    expect(shortPublisher("UK Department for Transport (GOV.UK) - The Highway Code")).toBe("The Highway Code");
    expect(shortPublisher("Royal Society for the Prevention of Accidents (RoSPA)")).toBe("RoSPA");
    expect(shortPublisher("New York State Department of Motor Vehicles")).toBe("New York State DMV");
    expect(shortPublisher("California Department of Motor Vehicles")).toBe("California DMV");
    expect(shortPublisher("Ontario Ministry of Transportation (Government of Ontario)")).toBe("Ontario Ministry of Transportation");
    expect(shortPublisher("Transport for NSW (NSW Government)")).toBe("Transport for NSW");
    expect(endCardText([])).toBe(`Based on checked road safety advice. ${LOCAL_RULES}`);
    const brake = guidance.topics.find((t) => t.id === "brake-failure")!;
    expect(endCardText(publishersOf(brake))).toBe(`Based on Ontario Ministry of Transportation, New York State DMV and other road safety advice. ${LOCAL_RULES}`);
  });

  it("is the end card the text track shows, for every topic, with the citations a script carries", () => {
    const base = raw("ice-skid.json");
    for (const topic of guidance.topics) {
      const citations = topic.citations.map((id) => {
        const s = guidance.sources[id]!;
        return { publisher: s.publisher, title: s.title, url: s.url, ...(s.section ? { section: s.section } : {}) };
      });
      const s = valid({ ...base, safety: { topicId: topic.id, citations } });
      const card = textTrack(s).filter((e) => e.kind === "endcard");
      expect(card, topic.id).toHaveLength(1);
      expect(words(card[0]!.text), topic.id).toBe(endCardText(citations.map((c) => c.publisher)));
      expect(card[0]!.text.split("\n").pop(), topic.id).toBe(LOCAL_RULES);
    }
  });

  it("stays inside the last scene, so no other scene's frames depend on it", () => {
    const s = valid(raw("ice-skid.json"));
    const card = textTrack(s).find((e) => e.kind === "endcard")!;
    const lastStart = s.scenes.slice(0, -1).reduce((a, sc) => a + sc.durationSec, 0);
    expect(card.start).toBeGreaterThanOrEqual(lastStart);
    const short = valid({ ...raw("ice-skid.json"), scenes: raw("ice-skid.json").scenes.map((sc, i, all) => (i === all.length - 1 ? { ...sc, durationSec: 2, beats: sc.beats.filter((b) => b.at + b.dur <= 2), sfx: [] } : sc)), captions: [] });
    const total = short.scenes.reduce((a, sc) => a + sc.durationSec, 0);
    const shortCard = textTrack(short).find((e) => e.kind === "endcard")!;
    expect(shortCard.start).toBeCloseTo(total - 2, 6);
  });
});

describe("captions are shown whole", () => {
  const long = [
    "DON'T BRAKE, ACCELERATE OR STEER HARSHLY. THESE CAUSE SKIDS!",
    "WHEN THE REAR SLIDES RIGHT, STEER RIGHT. SMALL MOVES MATTER!",
    "MMMMMMMMMMMM WWWWWWWWWWWW MMMMMMMMMMMM WWWWWWWWWWWW MMMMMMMM",
    "Supercalifragilisticexpialidocious-and-even-longer-wordsxxxx",
    "Stay calm. You can still control the car.",
  ];

  for (const text of long) {
    it(`"${text.slice(0, 30)}…" (${text.length} characters) keeps every word as a caption and as scene text`, () => {
      expect(text.length).toBeLessThanOrEqual(60);
      for (const box of [CAPTION, HEADER]) {
        const { lines, size } = fitText(text, box.sizes, box.maxW, box.maxLines);
        expect(lines.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
        expect(lines.length).toBeLessThanOrEqual(box.maxLines + 1);
        for (const l of lines) expect(textWidth(l, size), l).toBeLessThanOrEqual(box.maxW + 0.5);
        // the block stays in its band of the frame
        const half = (lines.length * size * LINE_HEIGHT) / 2;
        expect(box.y + half).toBeLessThan(box === CAPTION ? 1560 : 480);
      }
    });
  }

  it("in the text track too, for a valid script whose captions are 60 characters long", () => {
    const base = raw("ice-skid.json");
    const s = valid({ ...base, captions: base.captions.map((c, i) => ({ ...c, text: long[i % 2]! })), scenes: base.scenes.map((sc, i) => (i === 1 ? { ...sc, caption: long[2]! } : sc)) });
    const shown = textTrack(s).filter((e): e is TextEvent => e.kind === "caption");
    for (const e of shown) {
      const source = [...long, ...base.captions.map((c) => c.text), ...base.scenes.map((sc) => sc.caption ?? "")].find((t) => t.replace(/\s/g, "") === e.text.replace(/\s/g, ""));
      expect(source, e.text).toBeDefined();
    }
    expect(shown.filter((e) => e.text.replace(/\s/g, "") === long[0]!.replace(/\s/g, "")).length).toBeGreaterThan(0);
    expect(shown.some((e) => e.text.replace(/\s/g, "") === long[2]!.replace(/\s/g, ""))).toBe(true);
  });

  it("wrapText splits a word longer than a line rather than letting it run off the screen", () => {
    const lines = wrapText("W".repeat(60), 64, CAPTION.maxW);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("W".repeat(60));
    for (const l of lines) expect(textWidth(l, 64)).toBeLessThanOrEqual(CAPTION.maxW);
  });
});

describe("bubbles in a safety story's last seconds", () => {
  for (const camera of ["medium", "close", "wide", "push_in"] as const) {
    it(`show below the end card (camera ${camera})`, () => {
      const base = raw("ice-skid.json");
      const scenes = base.scenes.map((sc, i, all) =>
        i === all.length - 1 ? { ...sc, camera, beats: [...sc.beats, { at: 2.2, dur: 1.2, who: "c2", do: "nod" as const, bubble: "heart" as const }] } : sc,
      );
      const s = valid({ ...base, scenes });
      const track = textTrack(s);
      const card = track.find((e) => e.kind === "endcard")!;
      const layout = endCardLayout((s.safety?.citations ?? []).map((c) => c.publisher));
      expect(card.text.split("\n")).toEqual(layout.lines);
      const bubbles = track.filter((e) => e.kind === "bubble" && e.end > card.start);
      expect(bubbles.length).toBeGreaterThan(0);
      for (const b of bubbles) {
        // the balloon (about 1.3 radii tall at its widest) stays below the card's last line
        expect(b.y - BUBBLE_R * 1.3, `${b.text} at ${b.y}`).toBeGreaterThan(layout.bottom);
        // and in the frames no balloon shape reaches into the card while it shows
        const prims = drawFrame(s, Math.round(((Math.max(b.start, card.start) + b.end) / 2) * 30));
        const balloon = prims.filter((p): p is Extract<Prim, { k: "ellipse" | "circle" }> => (p.k === "ellipse" || p.k === "circle") && Math.hypot(p.x - b.x, p.y - b.y) < 4);
        expect(balloon.length).toBeGreaterThan(0);
        for (const p of balloon) expect(p.y - (p.k === "ellipse" ? Math.max(p.rx, p.ry) : p.r)).toBeGreaterThan(layout.bottom);
      }
    });
  }

  it("earlier in the story keep their usual place near the head", () => {
    const s = valid(raw("ice-skid.json"));
    const track = textTrack(s);
    const card = track.find((e) => e.kind === "endcard")!;
    const early = track.filter((e) => e.kind === "bubble" && e.end <= card.start);
    expect(early.length).toBeGreaterThan(0);
    expect(early.some((b) => b.y < endCardLayout(["x"]).bottom + BUBBLE_R)).toBe(true);
  });
});
