// Use it again (docs/CONTRACTS.md §45.52): a made video's whole setup copied into a new video draft (§45.47), so the
// next episode starts from it. Every part stays editable in Make a new video: the script scene by scene (what happens,
// the words on screen, who is in it, the place, in the same order), the cast and its vehicles, the main character and
// the villain, the series, the length, the shape, the look, captions, music, the reference videos and the AI. The
// video it came from is only read, never changed. Pure: the hook that saves the draft and opens it is useReuse() in Reuse.tsx.
import type { Character, OwnScene, Story, StoryScript, VideoDraftForm } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { draftScript } from "./Drafts.tsx";
import { draftFromOwn, OWN } from "./ownScript.ts";

/** A story's title limit (the API's TITLE_MAX). */
export const TITLE_MAX = 80;

/** The statuses of a video that was made to the end (it has a video to start from). */
export const MADE = new Set<Story["status"]>(["review", "needs_check", "approved", "published"]);

export const REUSE_WORDS = {
  button: "Use it again",
  busy: "Copying…",
  done: "Copied. Change what you like.",
  failed: "That video could not be copied. Try again.",
} as const;

/** The next episode's title: a number at the end goes up by one ("Night run 2" → "Night run 3"), else " 2" is added. */
export function nextTitle(title: string): string {
  const t = title.split(/\s+/).filter(Boolean).join(" ") || "Untitled video";
  const m = /^(.*?)(\d{1,6})$/.exec(t);
  const head = m ? m[1]! : `${t} `;
  const tail = m ? String(Number(m[2]) + 1) : "2";
  const room = TITLE_MAX - tail.length;
  const chars = [...head];
  return chars.length <= room ? `${head}${tail}` : `${chars.slice(0, room - 1).join("").trimEnd()} ${tail}`;
}

/** Cut to `max` letters on a word break when one is near, never in the middle of an emoji. */
export function cut(text: string, max: number): string {
  const s = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max).join("");
  const space = head.lastIndexOf(" ");
  return (space > max * 0.6 ? head.slice(0, space) : head).trimEnd();
}

const SETS = new Set<string>(CATALOG.sets.map((s) => s.id));

/** Who is in one scene of a written script: its actors and the cast's cars it shows, as character ids of the cast. */
function whoIn(script: StoryScript, scene: StoryScript["scenes"][number], cast: readonly string[]): string[] {
  const ids: string[] = [];
  for (const a of scene.actors ?? []) {
    const id = script.cast?.[a.castId]?.characterId;
    if (id) ids.push(id);
  }
  for (const p of scene.props ?? []) {
    const id = p.castId ? script.cars?.[p.castId]?.characterId : undefined;
    if (id) ids.push(id);
  }
  return [...new Set(ids)].filter((id) => cast.includes(id)).slice(0, OWN.who);
}

/** What happens in a written scene: its title, then its note when it has one. */
function whatOf(sc: StoryScript["scenes"][number]): string {
  const title = sc.title.trim().replace(/[.!?…:;,]+$/, "");
  const note = (sc.note ?? "").trim();
  if (!note || note.toLowerCase().startsWith(title.toLowerCase())) return note || title;
  return title ? `${title}. ${note}` : note;
}

/** The scenes of a video the AI wrote, as the owner's own script: what happens (the scene's title and note), the
 * words on screen (the scene's caption, else the first caption that shows during it), who is in it and the place, in
 * the video's order. */
export function scenesOfScript(script: StoryScript, cast: readonly string[]): NonNullable<VideoDraftForm["script"]>["scenes"] {
  let start = 0;
  return script.scenes.map((sc) => {
    const from = start;
    start += sc.durationSec || 0;
    const what = cut(whatOf(sc), OWN.what);
    const cue = (script.captions ?? []).find((c) => c.at >= from && c.at < start && c.text.trim());
    const words = sc.caption?.trim() || cue?.text.trim() || "";
    const caption = words ? cut(words, OWN.caption) : "";
    const who = whoIn(script, sc, cast);
    return {
      what,
      ...(caption ? { caption } : {}),
      who,
      ...(SETS.has(sc.set) ? { place: sc.set } : {}),
    };
  });
}

/** The scenes when no script could be read: each scene's title. */
function scenesOfTitles(story: Story): NonNullable<VideoDraftForm["script"]>["scenes"] {
  return story.scenes.map((s) => ({ what: cut(s.title, OWN.what) })).filter((s) => s.what);
}

/**
 * The draft form for the next video made from this one (§45.52): Write it myself, with the video's own scenes; the same
 * cast, roles, series, length, shape, look, captions, music, references and AI. Characters that are gone are left out
 * here, so the form opens without "Some picks are gone".
 */
export function reuseForm(story: Story, script: StoryScript | null, characters: readonly Character[]): VideoDraftForm {
  const known = (id: string) => characters.some((c) => c.characterId === id);
  const cast = story.characterIds.filter(known);
  const form: VideoDraftForm = { source: "script", title: nextTitle(story.title), category: story.category };
  let scenes: NonNullable<VideoDraftForm["script"]> | undefined;
  if (story.ownScript?.scenes?.length) {
    const own = { scenes: story.ownScript.scenes.map((s: OwnScene) => ({ ...s, who: (s.who ?? []).filter(known) })) };
    scenes = draftScript(draftFromOwn(own, cast, characters as Character[]));
  } else if (script?.scenes?.length) {
    scenes = { scenes: scenesOfScript(script, cast) };
  } else if (story.scenes.length) {
    scenes = { scenes: scenesOfTitles(story) };
  }
  if (scenes?.scenes.length) form.script = scenes;
  if (cast.length) form.characterIds = cast;
  const main = story.roles?.mainId;
  if (main && cast.includes(main)) {
    const villain = story.roles?.villainId;
    form.roles = { mainId: main, ...(villain && villain !== main && cast.includes(villain) ? { villainId: villain } : {}) };
  }
  form.seriesId = story.seriesId ?? null;
  form.durationSec = Math.min(90, Math.max(15, Math.round(story.durationSec)));
  if (story.format) form.format = { ...story.format };
  if (story.art) form.art = story.art;
  form.captionsOn = story.captionsOn;
  if (story.musicMood && CATALOG.musicMoods.some((m) => m.id === story.musicMood)) form.musicMood = story.musicMood;
  if (story.referenceIds?.length) form.referenceIds = story.referenceIds.slice(0, 3);
  const ai = story.ai;
  if (ai && (ai.model || ai.effort)) form.ai = { ...(ai.model ? { model: ai.model } : {}), ...(ai.effort ? { effort: ai.effort } : {}) };
  return form;
}
