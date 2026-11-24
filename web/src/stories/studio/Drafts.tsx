// Clips Funded › saved video drafts (docs/CONTRACTS.md §45.47). A draft is a saved "Make a new video" form, kept on
// the server (its own VDRAFT# item, never a story). This file holds what Make a new video and the Production list share:
// the list with Delete and Undo (useDrafts), one draft's row (Open, Delete), the "Your drafts (N)" fold, and the two
// ways between the form's scenes and a draft's (the scene keys are made again on open, never saved).
import { useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { VideoDraft, VideoDraftForm } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { SIcon } from "../settings/bits.tsx";
import { newScene, written, type ScriptDraft } from "./ownScript.ts";
import { ago, DRAFT_WORDS, say } from "./words.ts";

/** How long after the last change a draft saves itself (§45.47 D3). */
export const AUTOSAVE_MS = 2000;

/** The workspace's drafts, newest change first, with Delete (a toast with Undo; the real delete when it is gone). */
export function useDrafts(ws: string) {
  const toast = useToast();
  const list = useLoad(async () => (await storiesApi().listVideoDrafts(ws)).items, ws);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  function remove(d: VideoDraft) {
    setHidden((h) => new Set(h).add(d.draftId));
    const back = () =>
      setHidden((h) => {
        const n = new Set(h);
        n.delete(d.draftId);
        return n;
      });
    toast.undo(DRAFT_WORDS.deleted(d.name), {
      onUndo: back,
      onCommit: () => {
        storiesApi()
          .deleteVideoDraft(ws, d.draftId)
          .then(() => list.setData((all) => (all ? all.filter((x) => x.draftId !== d.draftId) : all)))
          .catch((e) => {
            back();
            toast.error(say(e, "That draft could not be deleted. Try again."));
          });
      },
    });
  }

  return { items: (list.data ?? []).filter((d) => !hidden.has(d.draftId)), loaded: !!list.data, error: list.error, reload: list.reload, remove };
}

/** One draft: its name, how old its last change is, Open and Delete. */
export function DraftRow({ draft, onDelete }: { draft: VideoDraft; onDelete: () => void }) {
  const href = storiesHref({ name: "production_new", ideaId: null, draftId: draft.draftId });
  return (
    <li className="st-s-run st-glass st-vd-row">
      <span className="st-s-run__cover" aria-hidden="true">
        <span className="st-s-run__blank" />
      </span>
      <span className="st-s-run__body">
        <span className="st-s-run__top">
          <A href={href} className="st-s-run__title">
            {draft.name}
          </A>
        </span>
        <span className="st-s-run__meta">{ago(draft.updatedAt)}</span>
      </span>
      <span className="st-s-run__go">
        <button type="button" className="st-btn" aria-label={`${DRAFT_WORDS.remove} ${draft.name}`} onClick={onDelete}>
          <SIcon name="trash" size={20} />
          {DRAFT_WORDS.remove}
        </button>
        <A href={href} className="st-btn" aria-label={`${DRAFT_WORDS.open} ${draft.name}`}>
          {DRAFT_WORDS.open}
        </A>
      </span>
    </li>
  );
}

/** "Your drafts (N)" at the top of Make a new video: folded, and only when there is one (the open draft is not listed). */
export function DraftsFold({ drafts, onDelete }: { drafts: VideoDraft[]; onDelete: (d: VideoDraft) => void }) {
  if (!drafts.length) return null;
  return (
    <details className="st-sc-sofar st-vd-drafts">
      <summary className="st-sc-sofar__sum">{DRAFT_WORDS.fold(drafts.length)}</summary>
      <ul className="st-s-runs">
        {drafts.map((d) => (
          <DraftRow key={d.draftId} draft={d} onDelete={() => onDelete(d)} />
        ))}
      </ul>
    </details>
  );
}

/** The owner's scenes as a draft keeps them (only up to the last written one; no keys; a place picked by hand kept). */
export function draftScript(script: ScriptDraft): VideoDraftForm["script"] | undefined {
  const last = script.scenes.reduce((n, s, i) => (written(s) ? i : n), -1);
  if (last < 0) return undefined;
  const scenes = script.scenes
    .slice(0, last + 1)
    .map((s) => ({ what: s.what, ...(s.caption ? { caption: s.caption } : {}), ...(s.who ? { who: [...s.who] } : {}), ...(s.place ? { place: s.place } : {}) }));
  return { scenes, ...(Object.keys(script.answers).length ? { answers: { ...script.answers } } : {}) };
}

/** A draft's scenes back as the form's: new keys, the Who kept to the characters that still exist. */
export function scriptOfDraft(saved: VideoDraftForm["script"], known: (id: string) => boolean): { script: ScriptDraft; dropped: boolean } {
  let dropped = false;
  const scenes = (saved?.scenes ?? []).map((s) => {
    const scene = newScene(s.what ?? "", s.caption ?? "");
    if (s.who) {
      const who = s.who.filter(known);
      if (who.length !== s.who.length) dropped = true;
      scene.who = who;
    }
    scene.place = s.place ?? null;
    return scene;
  });
  while (scenes.length < 2) scenes.push(newScene());
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved?.answers ?? {})) {
    // an answer naming a character that is gone is asked again
    if (v === "out" || v === "seen" || known(v)) answers[k] = v;
    else dropped = true;
  }
  return { script: { scenes, answers }, dropped };
}
