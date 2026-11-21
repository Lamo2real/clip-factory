// The creative director's buttons (docs/CONTRACTS.md §45.27, ADR-78): what it cannot do itself (make a video,
// remake a scene, look at a reference video, save a character or an idea, open a page) comes back as a button, and
// nothing happens until the owner taps it. Each tap calls the normal Lamo Stories route, exactly as the owner's own
// tap on that page would; "Make the video" only opens Production › New filled in (the video is made when the owner
// taps Make the video there). A button whose details do not make sense says so instead of guessing.
//
// The payloads (what the agent puts in `actions[].payload`):
//   make_video        { ideaId?, brief?: { title, logline, category }, characterIds?, durationSec?, referenceIds? }
//   remake_scene      { storyId, sceneIds: string[], note? }
//   analyze_reference { refId }
//   save_character    { character: CharacterInput }
//   save_idea         { idea: IdeaInput }
//   open              { href: "/stories/…" } or { kind: "idea" | "story" | "character" | "reference", id }
import { useState, type MouseEvent } from "react";
import { navigate } from "../../lib/router.ts";
import { A } from "../../components/ui.tsx";
import { storiesApi } from "../api/client.ts";
import type { CharacterInput, ChatAction, IdeaCategory, IdeaInput, ProjectRef } from "../api/types.ts";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { isStoriesPath, matchStories } from "../routes.ts";
import { CATEGORIES, productionNewHref, type ProductionPrefill } from "./handoff.ts";
import { Btn, centerOf, cheer, Icon, sentence, type IconName } from "./kit.tsx";
import { projectHref } from "./project.ts";

export type ActionPlan =
  | { kind: "go"; href: string }
  | { kind: "call"; run: (ws: string) => Promise<{ text: string; href: string; link: string }> }
  | { kind: "broken" };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const ids = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every(isId) ? (v as string[]) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export const BROKEN = "This button does not have what it needs. Ask the director again.";

function safeHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 300 || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  const [path = "", search = ""] = href.split("?");
  if (!isStoriesPath(path)) return null;
  return matchStories(path, search ? `?${search}` : "").name === "not_found" ? null : href;
}

/** What a tap on this button does. Pure, so it is easy to test. */
export function planFor(action: ChatAction): ActionPlan {
  const p = obj(action.payload) ?? {};
  switch (action.kind) {
    case "make_video": {
      const refs = ids(p.referenceIds);
      const cast = ids(p.characterIds);
      if (!refs || !cast || (p.ideaId !== undefined && !isId(p.ideaId))) return { kind: "broken" };
      const prefill: ProductionPrefill = { ideaId: (p.ideaId as string | undefined) ?? null, referenceIds: refs, characterIds: cast };
      if (typeof p.durationSec === "number") prefill.durationSec = p.durationSec;
      const b = obj(p.brief);
      if (b) {
        if (typeof b.title !== "string" || typeof b.logline !== "string" || !CATEGORIES.includes(b.category as IdeaCategory)) return { kind: "broken" };
        prefill.brief = { title: b.title, logline: b.logline, category: b.category as IdeaCategory };
      }
      return { kind: "go", href: productionNewHref(prefill) };
    }
    case "remake_scene": {
      const scenes = ids(p.sceneIds);
      if (!isId(p.storyId) || !scenes || !scenes.length || (p.note !== undefined && typeof p.note !== "string")) return { kind: "broken" };
      const storyId = p.storyId;
      const note = typeof p.note === "string" && p.note.trim() ? p.note.trim().slice(0, 500) : undefined;
      return {
        kind: "call",
        run: async (ws) => {
          await storiesApi().requestChanges(ws, storyId, note ? { sceneIds: scenes, note } : { sceneIds: scenes });
          return { text: scenes.length === 1 ? "Remaking that scene now!" : "Remaking those scenes now!", href: projectHref({ kind: "story", id: storyId }), link: "Watch it being made" };
        },
      };
    }
    case "analyze_reference": {
      if (!isId(p.refId)) return { kind: "broken" };
      const refId = p.refId;
      return {
        kind: "call",
        run: async (ws) => {
          await storiesApi().analyzeReference(ws, refId);
          return { text: "Looking at the video now!", href: projectHref({ kind: "reference", id: refId }), link: "Open the reference video" };
        },
      };
    }
    case "save_character": {
      const c = obj(p.character);
      if (!c || typeof c.name !== "string" || !c.name.trim() || !obj(c.look)) return { kind: "broken" };
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
      const i = obj(p.idea);
      if (!i || typeof i.title !== "string" || typeof i.logline !== "string" || !CATEGORIES.includes(i.category as IdeaCategory)) return { kind: "broken" };
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

const ICON: Record<ChatAction["kind"], IconName> = {
  make_video: "clapper",
  remake_scene: "retry",
  analyze_reference: "eye",
  save_character: "face",
  save_idea: "bulb",
  open: "chevron",
};

/** Taps that already worked, so a page change does not offer the same save twice. */
const done = new Map<string, { text: string; href: string; link: string }>();

export function forgetActions(): void {
  done.clear();
}

export function ActionCard({ ws, action, id }: { ws: string; action: ChatAction; id: string }) {
  const plan = planFor(action);
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; text: string; href: string; link: string } | { kind: "failed"; text: string }>(() => {
    const was = done.get(id);
    return was ? { kind: "done", ...was } : { kind: "idle" };
  });
  const payload = obj(action.payload) ?? {};
  const character = action.kind === "save_character" ? (obj(payload.character) as CharacterInput | null) : null;
  const idea = action.kind === "save_idea" ? obj(payload.idea) : null;

  async function tap(e: MouseEvent<HTMLButtonElement>) {
    if (plan.kind === "broken" || state.kind === "busy") return;
    if (plan.kind === "go") return navigate(plan.href);
    const at = centerOf(e.currentTarget);
    setState({ kind: "busy" });
    try {
      const result = await plan.run(ws);
      done.set(id, result);
      setState({ kind: "done", ...result });
      cheer(at);
    } catch (err) {
      setState({ kind: "failed", text: sentence(err) });
    }
  }

  return (
    <div className={`st-chat-action st-chat-action--${action.kind}`}>
      {character && obj(character.look) ? (
        <div className="st-chat-action__show">
          <CharacterPreview look={character.look} movementStyle={character.movementStyle ?? "bouncy"} size={88} label={`How ${character.name} looks`} />
          <div className="st-chat-action__words">
            <strong>{character.name}</strong>
            {typeof character.description === "string" && character.description ? <span>{character.description}</span> : null}
          </div>
        </div>
      ) : null}
      {idea && typeof idea.title === "string" ? (
        <div className="st-chat-action__words">
          <strong>{idea.title}</strong>
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
        <Btn main={action.kind !== "open"} icon={state.kind === "failed" ? "retry" : ICON[action.kind]} off={plan.kind === "broken" || state.kind === "busy"} onClick={tap}>
          {state.kind === "busy" ? "Working on it…" : state.kind === "failed" ? "Try again" : action.label}
        </Btn>
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
