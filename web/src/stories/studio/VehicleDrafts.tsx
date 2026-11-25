// Clips Funded › vehicle drafts (the owner: "when i click design … i should be able to go into elsewhere in the app and
// the car process should still be running under vehicles as a draft until its either successful or failed"). A vehicle
// draft is one "Design with AI" run for a new vehicle, kept on the server: it owns the design task and says how it is
// going. This file holds what the Vehicles list and the draft's own page share: the gentle polling (every 2 s while
// anything is designing, else every 20 s, and again the moment the tab is seen), the eased progress, the seconds that
// keep counting from the server's start time (so a reload does not start them over), the card, and the photos a new
// vehicle keeps (the files stay in this tab for Save; a draft opened later fetches them again).
import "../styles/sd-vdrafts.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { AiTask, VehicleDraft } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { modelLine, type AiInfo, type useAiTask } from "./ai.tsx";
import { celebrate, ProgressBar, StSheet, Tag } from "./kit.tsx";
import type { Photo } from "./Photos.tsx";
import { VEHICLE_KINDS } from "./VehicleKind.tsx";
import { say } from "./words.ts";

/** How often the draft list is read while any draft is designing, and when none is. */
export const POLL_FAST_MS = 2000;
export const POLL_SLOW_MS = 20_000;

export const pollEvery = (items: readonly Pick<VehicleDraft, "status">[]): number => (items.some((d) => d.status === "designing") ? POLL_FAST_MS : POLL_SLOW_MS);

/** A run is about this long (the progress bar's pace); it never says 100% before the draft is ready. */
const EXPECTED_SEC = 40;

/**
 * The eased bar for a run that has taken `seconds`: slow at the start, fast in the middle, slow again near the end, and
 * always a little short of full (it creeps on after the expected time, but never reaches 1; only "Ready" fills it).
 */
export function easedProgress(seconds: number): number {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const x = Math.min(1, t / EXPECTED_SEC);
  const smooth = x * x * x * (x * (x * 6 - 15) + 10); // smootherstep: 0 to 1, flat at both ends
  const late = Math.max(0, t - EXPECTED_SEC);
  return 0.9 * smooth + 0.08 * (1 - Math.exp(-late / 60));
}

/** Whole seconds since the server started the run (never negative, so a clock a little behind shows 0). */
export function secondsSince(startedAt: string | null | undefined, now = Date.now()): number {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 1000));
}

export const STATUS_WORD: Record<VehicleDraft["status"], string> = { designing: "Designing", ready: "Ready", failed: "Stopped" };

/** The kind in words ("Truck"). */
export const kindWord = (v: VehicleDraft["vehicle"]): string => VEHICLE_KINDS.find((k) => k.value === v)?.label ?? "Vehicle";

/** A draft's name, or "New vehicle". */
export const draftTitle = (d: Pick<VehicleDraft, "name">): string => d.name.trim() || "New vehicle";

/** Ticks once a second while `on` (the seconds of a run keep counting). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The drafts' ways to say it is ready, once: the ids whose draft turned from designing to ready on this screen. */
export function turnedReady(before: ReadonlyMap<string, VehicleDraft["status"]>, now: readonly VehicleDraft[]): string[] {
  return now.filter((d) => d.status === "ready" && before.get(d.draftId) === "designing").map((d) => d.draftId);
}

/** The most cartoon vehicles a draft keeps (the server's limit). */
const MAX_KEPT = 4;

/** Try again after a failed run: a draft that has options (a failed Make more) runs as more, else it designs fresh. */
export const retryAsMore = (d: Pick<VehicleDraft, "options">): boolean => d.options.length > 0 && d.options.length < MAX_KEPT;

/** The sentence a screen reader hears when a draft turns ready or stopped while watched. */
export const announcement = (d: Pick<VehicleDraft, "name" | "status">): string => `${draftTitle(d)} is ${d.status === "ready" ? "ready" : "stopped"}.`;

/** The drafts that turned from designing to ready or stopped since `before`. */
export function turnedDone(before: ReadonlyMap<string, VehicleDraft["status"]>, now: readonly VehicleDraft[]): VehicleDraft[] {
  return now.filter((d) => d.status !== "designing" && before.get(d.draftId) === "designing");
}

/** The vehicle drafts of a workspace, newest first, kept fresh: fast while one designs, slow when none does. */
export function useVehicleDrafts(ws: string) {
  const toast = useToast();
  const [items, setItems] = useState<VehicleDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef(new Map<string, VehicleDraft["status"]>());
  const gone = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const take = useCallback((list: VehicleDraft[]) => {
    const shown = list.filter((d) => !gone.current.has(d.draftId));
    const ready = turnedReady(seen.current, shown);
    const done = turnedDone(seen.current, shown);
    if (done.length) setAnnounce(done.map(announcement).join(" "));
    seen.current = new Map(shown.map((d) => [d.draftId, d.status]));
    if (ready.length) setFresh((f) => new Set([...f, ...ready]));
    setItems(shown);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await storiesApi().listVehicleDrafts(ws);
      if (live.current) take(r.items);
    } catch (e) {
      // A failed first read shows no drafts (not a stall); the poll keeps trying.
      if (live.current) {
        setError(say(e, "We could not get your vehicle drafts."));
        setItems((all) => all ?? []);
      }
    }
  }, [ws, take]);

  useEffect(() => {
    setItems(null);
    seen.current = new Map();
    void reload();
  }, [reload]);

  usePoll(reload, true, pollEvery(items ?? []));

  /** Delete (the card is gone at once; a failure brings it back). */
  const remove = useCallback(
    async (d: VehicleDraft) => {
      gone.current.add(d.draftId);
      setItems((all) => (all ? all.filter((x) => x.draftId !== d.draftId) : all));
      try {
        await storiesApi().deleteVehicleDraft(ws, d.draftId);
      } catch (e) {
        gone.current.delete(d.draftId);
        toast.error(say(e, "That draft could not be deleted. Try again."));
        void reload();
      }
    },
    [ws, toast, reload],
  );

  /** Try again / Design it again: the stored design runs once more. A 409 ("still designing") is just read again. */
  const again = useCallback(
    async (d: VehicleDraft) => {
      try {
        const next = await storiesApi().redesignVehicleDraft(ws, d.draftId, retryAsMore(d) ? { more: true } : {});
        if (live.current) setItems((all) => (all ? all.map((x) => (x.draftId === next.draftId ? next : x)) : all));
        seen.current.set(next.draftId, next.status);
      } catch (e) {
        toast.error(say(e, "The helper is busy. Try again in a minute."));
        void reload();
      }
    },
    [ws, toast, reload],
  );

  return { items: items ?? [], loaded: items !== null, error, reload, remove, again, fresh, announce };
}

/** The draft as a task, so the one TaskLine wording ("Designing your character with <model> · <effort>… N s") serves it. */
export function draftRun(d: VehicleDraft, seconds: number): ReturnType<typeof useAiTask> {
  const phase = d.status === "designing" ? "working" : d.status === "ready" ? "done" : "failed";
  const task: AiTask = {
    taskId: d.taskId,
    kind: "character_design",
    status: d.status === "designing" ? "running" : d.status === "ready" ? "done" : "failed",
    model: d.model,
    effort: (d.effort as AiTask["effort"]) ?? null,
    effortApplied: d.effort ? true : null,
    result: null,
    createdAt: d.startedAt,
    updatedAt: d.updatedAt,
  };
  return { task, phase, problem: d.message, seconds, start: async () => {}, retry: () => {}, reset: () => {} };
}

/** The model line of a card ("Claude Opus 5.5 · High effort"), or the plain wait while the helper is not named yet. */
export function cardLine(info: AiInfo, d: VehicleDraft): string {
  return d.model ? modelLine(info, d.model, (d.effort as AiTask["effort"]) ?? null, d.effort ? true : null) : "your usual model and effort";
}

/** A sheet before a finished draft goes: its cartoon vehicles go with it. */
export function ConfirmDelete({ draft, onKeep, onDelete }: { draft: VehicleDraft; onKeep: () => void; onDelete: () => void }) {
  return (
    <StSheet
      title="Delete this draft?"
      onClose={onKeep}
      actions={
        <>
          <button type="button" className="st-btn" onClick={onKeep}>
            Keep it
          </button>
          <button type="button" className="st-btn st-btn--main" onClick={onDelete}>
            Delete
          </button>
        </>
      }
    >
      <p>
        {draftTitle(draft)} has {draft.options.length} cartoon {draft.options.length === 1 ? "vehicle" : "vehicles"} to pick from. They go.
      </p>
    </StSheet>
  );
}

/** One draft on the Vehicles list: the kind, the first photos, one word of status and what goes with it. */
export function VehicleDraftCard({
  draft,
  info,
  celebrateNow,
  onTryAgain,
  onDelete,
}: {
  draft: VehicleDraft;
  info: AiInfo;
  /** it turned ready while the owner was watching: a small celebration, once */
  celebrateNow: boolean;
  onTryAgain: () => void;
  onDelete: () => void;
}) {
  const box = useRef<HTMLLIElement>(null);
  const done = useRef(false);
  const designing = draft.status === "designing";
  const now = useNow(designing);
  const seconds = secondsSince(draft.startedAt, now);
  useEffect(() => {
    if (!celebrateNow || done.current) return;
    done.current = true;
    celebrate(box.current, 70);
  }, [celebrateNow]);
  const href = storiesHref({ name: "car_draft", draftId: draft.draftId });
  const photos = useMemo(() => draft.photos.slice(0, 3), [draft.photos]);
  return (
    <li ref={box} className={`st-glass st-lens st-vdc st-vdc--${draft.status}`} data-status={draft.status}>
      <A href={href} className="st-vdc__main" aria-label={`${draftTitle(draft)}. ${STATUS_WORD[draft.status]}.`}>
        <span className="st-vdc__photos" aria-hidden="true">
          {photos.length ? photos.map((p) => <img key={p.assetId} src={p.url} alt="" width={56} height={56} />) : <span className="st-vdc__blank" />}
        </span>
        <span className="st-vdc__body">
          <span className="st-vdc__name">{draftTitle(draft)}</span>
          <span className="st-vdc__tags">
            <Tag tone="coral">{kindWord(draft.vehicle)}</Tag>
            <Tag tone={draft.status === "ready" ? "mint" : draft.status === "failed" ? "sun" : "sky"}>{STATUS_WORD[draft.status]}</Tag>
          </span>
          {designing ? (
            <span className="st-vdc__wait">
              <ProgressBar value={easedProgress(seconds)} label="Designing your vehicle" />
              <span className="st-vdc__line">
                <span className="st-s-ai-secs" style={{ minWidth: `calc(${String(seconds).length}ch + 0.75em)` }}>
                  {seconds} s
                </span>{" "}
                · {cardLine(info, draft)}
              </span>
            </span>
          ) : draft.status === "ready" ? (
            <span className="st-vdc__line">Pick one.</span>
          ) : (
            <span className="st-vdc__line st-vdc__line--bad">{draft.message || "The helper stopped."}</span>
          )}
        </span>
      </A>
      <span className="st-vdc__actions">
        {draft.status === "failed" ? (
          <button type="button" className="st-btn st-btn--main" onClick={onTryAgain}>
            Try again
          </button>
        ) : null}
        <button type="button" className="st-btn" aria-label={`Delete ${draftTitle(draft)}`} onClick={onDelete}>
          Delete
        </button>
      </span>
    </li>
  );
}

// ---- the photos a new vehicle keeps -------------------------------------------------------------------------------

const kept = new Map<string, Photo[]>();

/** The photos a draft was made from (their files stay in this tab so Save can keep them with the vehicle). */
export function rememberPhotos(draftId: string, photos: Photo[]): void {
  kept.set(draftId, photos.filter((p) => p.state === "ready" && p.file.size > 0));
}

export function recallPhotos(draftId: string): Photo[] {
  return kept.get(draftId) ?? [];
}

export function forgetPhotos(draftId: string): void {
  kept.delete(draftId);
}

/**
 * The photos to keep with a saved vehicle: the files this tab still holds, else each draft photo read again from its
 * address (best effort: one that cannot be read is left out, and Save says how many did not stay).
 */
export async function photosToKeep(draft: VehicleDraft): Promise<{ photos: Photo[]; missed: number }> {
  const held = recallPhotos(draft.draftId);
  if (held.length) return { photos: held, missed: Math.max(0, draft.photos.length - held.length) };
  const photos: Photo[] = [];
  let missed = 0;
  for (const p of draft.photos) {
    try {
      const blob = await (await fetch(p.url)).blob();
      const type = blob.type || "image/jpeg";
      photos.push({ key: `kept-${p.assetId}`, assetId: p.assetId, url: p.url, state: "ready", file: new File([blob], `photo-${photos.length + 1}.${type.split("/")[1] ?? "jpg"}`, { type }), ...(p.side === "inside" ? { side: "inside" as const } : {}) });
    } catch {
      missed += 1;
    }
  }
  return { photos, missed };
}
