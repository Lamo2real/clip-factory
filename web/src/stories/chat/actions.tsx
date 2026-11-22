// The creative director's buttons (docs/CONTRACTS.md §45.27, ADR-78): what it cannot do itself (make a video,
// remake a scene, look at a reference video, save a character or an idea, open a page) comes back as a button, and
// nothing happens until the owner taps it. Each tap calls the normal Lamo Stories route, exactly as the owner's own
// tap on that page would; "Make the video" only opens Production › New filled in (the video is made when the owner
// taps Make the video there). A button whose details do not make sense says so instead of guessing.
//
// The payloads (what Lamo Stories' agent puts in `actions[].payload`, stories/agent/…/chat/tools.py):
//   make_video        { story: StoryInput } (the agent's shape), or the same keys at the top level:
//                     { ideaId?, brief?: { title, logline, category }, characterIds?, durationSec?, referenceIds? }
//   remake_scene      { storyId, sceneIds: string[] (may be empty), note? }: a note, scene ids or both
//   analyze_reference { refId }
//   save_character    { character: CharacterInput }
//   save_idea         { idea: IdeaInput } (POST …/ideas), or { ideaId, patch: Partial<IdeaInput> } (PATCH …/ideas/{id})
//   open              { href: "/stories/…" } or { kind: "idea" | "story" | "character" | "reference", id }
//
// Production › New reads `?idea=`, `?ref=`, `?cast=` and `?sec=` (StoriesPage.production_new, §45.34), so "Make the
// video" opens it with the idea, the reference videos, the cast and the length picked. A short concept is saved as an
// idea on the tap (one the same as it is reused), so its words arrive through `idea`.
//
// "Remake these scenes" and "Analyze this reference video" carry the studio's model menu (§45.34): the usual for
// scene_rewrite or reference_analysis (with the video's own setting), prefilled with the override the message itself
// was sent with, and sent as that run's `override` (never saved).
import "../styles/studio.css";
import { useState, type MouseEvent } from "react";
import { navigate } from "../../lib/router.ts";
import { useLoad } from "../../lib/hooks.ts";
import { A } from "../../components/ui.tsx";
import { storiesApi } from "../api/client.ts";
import { storiesGoLater } from "../pane.tsx";
import type { AiSetting, CharacterInput, ChatAction, IdeaCategory, IdeaInput, ModelOverride, ProjectRef, TaskKind } from "../api/types.ts";
import { cleanPick, LISTED_INFO, ModelMenu, storyUsual, type AiInfo } from "../studio/ai.tsx";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { isStoriesPath, matchStories } from "../routes.ts";
import { CATEGORIES, productionNewHref, type ProductionPrefill } from "./handoff.ts";
import { Btn, centerOf, cheer, Icon, sentence, type IconName } from "./kit.tsx";
import { projectHref } from "./project.ts";

/** What a tap did: the words, the link to see it, and whether the page goes there at once. */
export interface ActionResult {
  text: string;
  href: string;
  link: string;
  /** go straight to `href` after the cheer (Make the video: Production › New) */
  go?: boolean;
}

/** `override`: the model and effort picked on the card for this one run (remake_scene, analyze_reference; never saved). */
export type ActionPlan = { kind: "go"; href: string } | { kind: "call"; run: (ws: string, override?: ModelOverride) => Promise<ActionResult> } | { kind: "broken" };

/** The task a button's run asks a model for, when its card carries the model menu (§45.34). */
export function taskOf(action: ChatAction): TaskKind | null {
  if (action.kind === "remake_scene") return "scene_rewrite";
  if (action.kind === "analyze_reference") return "reference_analysis";
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const ids = (v: unknown): string[] | null => (v === undefined || v === null ? [] : Array.isArray(v) && v.every(isId) ? (v as string[]) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isCategory = (v: unknown): v is IdeaCategory => CATEGORIES.includes(v as IdeaCategory);

export const BROKEN = "This button does not have what it needs. Ask the director again.";

function safeHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 300 || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  const [path = "", search = ""] = href.split("?");
  if (!isStoriesPath(path)) return null;
  return matchStories(path, search ? `?${search}` : "").name === "not_found" ? null : href;
}

const IDEA_KEYS = ["title", "logline", "category", "characterIds", "concept"];

/** A change to an idea the agent may send (PATCH …/ideas/{id}): only an idea's own fields, at least one. */
function ideaPatch(v: unknown): Partial<IdeaInput> | null {
  const p = obj(v);
  if (!p || !Object.keys(p).length || Object.keys(p).some((k) => !IDEA_KEYS.includes(k))) return null;
  if ("title" in p && !text(p.title)) return null;
  if ("logline" in p && !text(p.logline)) return null;
  if ("category" in p && !isCategory(p.category)) return null;
  if ("characterIds" in p && !ids(p.characterIds)) return null;
  if ("concept" in p && !obj(p.concept)) return null;
  return p as Partial<IdeaInput>;
}

/** The short concept as a saved idea: the same one if it is already saved, else a new one (the owner's tap). */
async function ideaFor(ws: string, brief: { title: string; logline: string; category: IdeaCategory }, cast: string[]): Promise<string> {
  const api = storiesApi();
  const same = (await api.listIdeas(ws, "saved").catch(() => [])).find((i) => i.title === brief.title && i.logline === brief.logline && i.category === brief.category);
  if (same) return same.ideaId;
  const made = await api.createIdea(ws, { ...brief, ...(cast.length ? { characterIds: cast } : {}), source: "ai" });
  return made.ideaId;
}

function makeVideo(p: Record<string, unknown>): ActionPlan {
  // The agent sends { story: StoryInput }; the same keys at the top level are read too.
  const s = obj(p.story) ?? p;
  const refs = ids(s.referenceIds);
  const cast = ids(s.characterIds);
  if (!refs || !cast || (s.ideaId !== undefined && s.ideaId !== null && !isId(s.ideaId))) return { kind: "broken" };
  if (s.durationSec !== undefined && s.durationSec !== null && typeof s.durationSec !== "number") return { kind: "broken" };
  const prefill: ProductionPrefill = { ideaId: isId(s.ideaId) ? s.ideaId : null, referenceIds: refs, characterIds: cast };
  if (typeof s.durationSec === "number") prefill.durationSec = Math.round(s.durationSec);
  const b = obj(s.brief);
  if (s.brief !== undefined && s.brief !== null && !b) return { kind: "broken" };
  if (b && !prefill.ideaId) {
    if (!text(b.title) || !text(b.logline) || !isCategory(b.category)) return { kind: "broken" };
    const brief = { title: b.title.trim().slice(0, 80), logline: b.logline.trim().slice(0, 280), category: b.category };
    return {
      kind: "call",
      run: async (ws) => {
        const ideaId = await ideaFor(ws, brief, cast);
        return { text: "Saved it as an idea. Production is open with it.", href: productionNewHref({ ...prefill, ideaId }), link: "Open Production", go: true };
      },
    };
  }
  return { kind: "go", href: productionNewHref(prefill) };
}

/** What a tap on this button does. Pure until it runs, so it is easy to test. */
export function planFor(action: ChatAction): ActionPlan {
  const p = obj(action.payload) ?? {};
  switch (action.kind) {
    case "make_video":
      return makeVideo(p);
    case "remake_scene": {
      // A note, scene ids or both (POST …/changes): scene ids alone are a new take, a note alone changes the story.
      const scenes = ids(p.sceneIds);
      if (!isId(p.storyId) || !scenes || (p.note !== undefined && p.note !== null && typeof p.note !== "string")) return { kind: "broken" };
      const storyId = p.storyId;
      const note = typeof p.note === "string" && p.note.trim() ? p.note.trim().slice(0, 500) : undefined;
      if (!scenes.length && !note) return { kind: "broken" };
      const body: { sceneIds?: string[]; note?: string } = {};
      if (scenes.length) body.sceneIds = scenes;
      if (note) body.note = note;
      return {
        kind: "call",
        run: async (ws, override) => {
          await storiesApi().requestChanges(ws, storyId, override ? { ...body, override } : body);
          return {
            text: !scenes.length ? "Making those changes now!" : scenes.length === 1 && !note ? "Remaking that scene now!" : "Remaking those scenes now!",
            href: projectHref({ kind: "story", id: storyId }),
            link: "Watch it being made",
          };
        },
      };
    }
    case "analyze_reference": {
      if (!isId(p.refId)) return { kind: "broken" };
      const refId = p.refId;
      return {
        kind: "call",
        run: async (ws, override) => {
          if (override) await storiesApi().analyzeReference(ws, refId, override);
          else await storiesApi().analyzeReference(ws, refId);
          return { text: "Looking at the video now!", href: projectHref({ kind: "reference", id: refId }), link: "Open the reference video" };
        },
      };
    }
    case "save_character": {
      const c = obj(p.character);
      if (!c || !text(c.name) || !obj(c.look)) return { kind: "broken" };
      const character = c as unknown as CharacterInput;
      return {
        kind: "call",
        run: async (ws) => {
          const saved = await storiesApi().createCharacter(ws, character);
          return { text: `Saved ${saved.name}!`, href: projectHref({ kind: "character", id: saved.characterId }), link: `Open ${saved.name}` };
        },
      };
    }
    case "save_idea": {
      if (p.idea === undefined && isId(p.ideaId)) {
        // A change to a saved idea (a driving-safety one goes through the owner's tap, so the API checks its advice).
        const patch = ideaPatch(p.patch);
        if (!patch) return { kind: "broken" };
        const ideaId = p.ideaId;
        return {
          kind: "call",
          run: async (ws) => {
            await storiesApi().patchIdea(ws, ideaId, patch);
            return { text: "Saved the change!", href: "/stories/ideas", link: "Open Ideas" };
          },
        };
      }
      const i = obj(p.idea);
      if (!i || !text(i.title) || !text(i.logline) || !isCategory(i.category) || ("characterIds" in i && !ids(i.characterIds))) return { kind: "broken" };
      const idea = { ...(i as unknown as IdeaInput), source: "ai" as const };
      return {
        kind: "call",
        run: async (ws) => {
          await storiesApi().createIdea(ws, idea);
          return { text: "Saved the idea!", href: "/stories/ideas", link: "Open Ideas" };
        },
      };
    }
    case "open": {
      const href = safeHref(p.href);
      if (href) return { kind: "go", href };
      if (["idea", "story", "character", "reference"].includes(p.kind as string) && isId(p.id)) return { kind: "go", href: projectHref({ kind: p.kind as ProjectRef["kind"], id: p.id }) };
      return { kind: "broken" };
    }
  }
  return { kind: "broken" };
}

/** The words on a button whose label is missing or not words. */
const LABEL: Record<ChatAction["kind"], string> = {
  make_video: "Make the video",
  remake_scene: "Make these changes",
  analyze_reference: "Analyze this video",
  save_character: "Save this character",
  save_idea: "Save this idea",
  open: "Open it",
};

const ICON: Record<ChatAction["kind"], IconName> = {
  make_video: "clapper",
  remake_scene: "retry",
  analyze_reference: "eye",
  save_character: "face",
  save_idea: "bulb",
  open: "chevron",
};

/** Taps that already worked, so a page change does not offer the same save twice. */
const done = new Map<string, ActionResult>();

export function forgetActions(): void {
  done.clear();
}

type CardState = { kind: "idle" | "busy" } | ({ kind: "done" } & ActionResult) | { kind: "failed"; text: string };

/** The video's or the reference video's own setting (§45.25 level 2), which a run of it uses before the task's. */
async function ownSetting(ws: string, action: ChatAction): Promise<AiSetting | null> {
  const p = obj(action.payload) ?? {};
  if (action.kind === "remake_scene" && isId(p.storyId)) return (await storiesApi().getStory(ws, p.storyId)).story.ai;
  if (action.kind === "analyze_reference" && isId(p.refId)) return (await storiesApi().getReference(ws, p.refId)).reference.ai;
  return null;
}

export function ActionCard({
  ws,
  action,
  id,
  info = LISTED_INFO,
  once = null,
}: {
  ws: string;
  action: ChatAction;
  id: string;
  /** Lamo Stories' models and tasks (the model menu on "Remake these scenes" and "Analyze this reference video") */
  info?: AiInfo;
  /** the "just this message" choice the message was sent with: the menu starts from it */
  once?: ModelOverride | null;
}) {
  const plan = planFor(action);
  const [state, setState] = useState<CardState>(() => {
    const was = done.get(id);
    return was ? { kind: "done", ...was } : { kind: "idle" };
  });
  const task = plan.kind === "call" ? taskOf(action) : null;
  const [pick, setPick] = useState<ModelOverride | null>(() => cleanPick(once) ?? null);
  const own = useLoad(() => (task ? ownSetting(ws, action).catch(() => null) : Promise.resolve(null)), `${ws}|${id}|${task ?? ""}`);
  const payload = obj(action.payload) ?? {};
  // What the button saves, shown only when its details make sense (a name that is not words is never drawn).
  const character = action.kind === "save_character" && plan.kind !== "broken" ? (obj(payload.character) as CharacterInput | null) : null;
  const idea = action.kind === "save_idea" && plan.kind !== "broken" ? (obj(payload.idea) ?? obj(payload.patch)) : null;

  async function tap(e: MouseEvent<HTMLButtonElement>) {
    if (plan.kind === "broken" || state.kind === "busy") return;
    if (plan.kind === "go") return navigate(plan.href);
    const at = centerOf(e.currentTarget);
    setState({ kind: "busy" });
    try {
      const result = await plan.run(ws, task ? cleanPick(pick) : undefined);
      done.set(id, result);
      setState({ kind: "done", ...result });
      cheer(at);
      // After the wait: never while Clip Factory is on screen (it happens once Lamo Stories is back, §45.35 D17).
      if (result.go) storiesGoLater(result.href);
    } catch (err) {
      setState({ kind: "failed", text: sentence(err) });
    }
  }

  return (
    <div className={`st-chat-action st-chat-action--${action.kind}`}>
      {character && typeof character.name === "string" && obj(character.look) ? (
        <div className="st-chat-action__show">
          <CharacterPreview look={character.look} movementStyle={character.movementStyle ?? "bouncy"} size={88} label={`How ${character.name} looks`} />
          <div className="st-chat-action__words">
            <strong>{character.name}</strong>
            {typeof character.description === "string" && character.description ? <span>{character.description}</span> : null}
          </div>
        </div>
      ) : null}
      {idea && (typeof idea.title === "string" || typeof idea.logline === "string") ? (
        <div className="st-chat-action__words">
          {typeof idea.title === "string" ? <strong>{idea.title}</strong> : null}
          {typeof idea.logline === "string" ? <span>{idea.logline}</span> : null}
        </div>
      ) : null}
      {state.kind === "done" ? (
        <p className="st-chat-action__done" role="status">
          <Icon name="check" size={20} />
          <span>{state.text}</span>
          <A href={state.href} className="st-chat-link">
            {state.link}
          </A>
        </p>
      ) : (
        <div className="st-chat-action__row">
          <Btn main={action.kind !== "open"} icon={state.kind === "failed" ? "retry" : ICON[action.kind]} off={plan.kind === "broken" || state.kind === "busy"} onClick={tap}>
            {state.kind === "busy" ? "Working on it…" : state.kind === "failed" ? "Try again" : typeof action.label === "string" && action.label.trim() ? action.label : (LABEL[action.kind] ?? "Open it")}
          </Btn>
          {task ? (
            <ModelMenu
              info={info}
              usual={storyUsual(info, { ai: own.data ?? { model: null, effort: null } }, task)}
              value={pick}
              onChange={setPick}
              title={task === "scene_rewrite" ? "Model and effort for these scenes" : "Model and effort for this analysis"}
              note="Just for this run. Your settings stay the same."
              className="st-chat-action__ai"
            />
          ) : null}
        </div>
      )}
      {plan.kind === "broken" ? <p className="st-chat-note st-chat-note--bad">{BROKEN}</p> : null}
      {state.kind === "failed" ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {state.text}
        </p>
      ) : null}
    </div>
  );
}
