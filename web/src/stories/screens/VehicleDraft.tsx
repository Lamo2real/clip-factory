// Clips Funded › one vehicle draft's page (/stories/vehicles/draft/{draftId}). The design runs on the server, so the
// owner can leave: this page reads the draft every 2 s while it designs (the seconds count from the server's start
// time, so a reload keeps them), shows the photos and words read only, and says "You can leave. It keeps going in
// Vehicles." When it is ready the cartoon vehicles to pick from and the whole editor (Looks, Face, Moves, Sounds, Name
// and personality) come in, with Make more and Design it again; Save makes the vehicle (createCharacter, its photos
// kept with it as today), deletes the draft and goes to the new vehicle. When it stopped: one plain sentence, Try
// again and Delete. Nothing is saved until the owner taps Save.
import "../styles/studio.css";
import "../styles/sd-cars.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { isCar, type CarInput, type CharacterInput, type ModelOverride, type VehicleDraft } from "../api/types.ts";
import { GlassPill } from "../glass/index.ts";
import { storiesGoLater } from "../pane.tsx";
import { storiesHref } from "../routes.ts";
import { merged, ModelMenu, SettingsFix, sendPick, TaskLine, useAiInfo, usualFor } from "../studio/ai.tsx";
import { CarOptions } from "../studio/CarOptions.tsx";
import { CharacterEditor } from "../studio/CharacterEditor.tsx";
import { Busy, celebrate, Notice } from "../studio/kit.tsx";
import {
  ConfirmDelete,
  draftRun,
  draftTitle,
  forgetPhotos,
  kindWord,
  photosToKeep,
  POLL_FAST_MS,
  announcement,
  retryAsMore,
  secondsSince,
  useNow,
} from "../studio/VehicleDrafts.tsx";
import { say } from "../studio/words.ts";
import { MakeIcon } from "./Ideas.tsx";
import { characterHref, keepPhotos } from "./Characters.tsx";

/** The most cartoon vehicles a draft keeps. */
export const MAX_DRAFT_OPTIONS = 4;

const carsOf = (d: VehicleDraft): CarInput[] => d.options.filter(isCar);

export function VehicleDraftPage({ ws, draftId }: { ws: string; draftId: string }) {
  const toast = useToast();
  const info = useAiInfo(ws);
  const usual = usualFor(info, "character_design");
  const [draft, setDraft] = useState<VehicleDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [picked, setPicked] = useState(0);
  const [round, setRound] = useState(0);
  const [saving, setSaving] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  /** set at once when a design starts: a double tap in the same moment starts one */
  const starting = useRef(false);
  const live = useRef(true);
  const box = useRef<HTMLElement>(null);
  const before = useRef<{ status: VehicleDraft["status"] | null; first: string }>({ status: null, first: "" });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const take = useCallback((d: VehicleDraft) => {
    if (live.current) setDraft(d);
  }, []);

  const reload = useCallback(async () => {
    try {
      take(await storiesApi().getVehicleDraft(ws, draftId));
      if (live.current) setProblem(null);
    } catch (e) {
      if (!live.current) return;
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setProblem(say(e, "We could not get this draft."));
      throw e;
    }
  }, [ws, draftId, take]);

  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);

  const designing = draft?.status === "designing";
  usePoll(reload, !gone && (designing || draft === null), POLL_FAST_MS);
  const now = useNow(designing);

  // Ready while the owner watches: one small celebration. A new set starts at the first vehicle; "Make more" keeps the pick.
  useEffect(() => {
    if (!draft) return;
    const was = before.current;
    const first = JSON.stringify(draft.options[0] ?? null);
    if (draft.status === "ready" && was.status === "designing") celebrate(box.current, 90);
    if (draft.status !== "designing" && was.status === "designing") setAnnounce(announcement(draft));
    if (draft.options.length && first !== was.first) {
      setPicked(0);
      setRound((n) => n + 1);
    }
    before.current = { status: draft.status, first };
  }, [draft]);

  async function redesign(more: boolean) {
    if (!draft || starting.current || draft.status === "designing") return;
    starting.current = true;
    setProblem(null);
    try {
      const override = sendPick(info, usual, pick);
      take(await storiesApi().redesignVehicleDraft(ws, draft.draftId, { ...(more ? { more: true } : {}), ...(override ? { override } : {}) }));
    } catch (e) {
      setProblem(say(e, "The helper is busy. Try again in a minute."));
      void reload().catch(() => {});
    } finally {
      starting.current = false;
    }
  }

  async function remove() {
    if (!draft || leaving) return;
    setLeaving(true);
    try {
      await storiesApi().deleteVehicleDraft(ws, draft.draftId);
      forgetPhotos(draft.draftId);
      storiesGoLater(storiesHref({ name: "cars" }), { replace: true });
    } catch (e) {
      setLeaving(false);
      setProblem(say(e, "That draft could not be deleted. Try again."));
    }
  }

  async function save(c: CharacterInput) {
    if (!draft || saving) return;
    setSaving(true);
    setSaveProblem(null);
    try {
      const made = await storiesApi().createCharacter(ws, c);
      celebrate(document.querySelector(".st-s-editor__preview"), 130);
      toast.success(`Say hi to ${made.name}!`);
      setKeeping(true);
      const { photos, missed: lost } = await photosToKeep(draft);
      const missed = (photos.length ? await keepPhotos(ws, made.characterId, photos) : 0) + lost;
      if (missed) toast.info(missed === 1 ? "1 photo didn't stay. Add it on its page." : `${missed} photos didn't stay. Add them on its page.`);
      // The vehicle is saved: its draft goes (a failure here only leaves the draft on the list).
      await storiesApi().deleteVehicleDraft(ws, draft.draftId).catch(() => {});
      forgetPhotos(draft.draftId);
      storiesGoLater(characterHref(made), { replace: true });
    } catch (e) {
      setSaveProblem(say(e));
      setSaving(false);
      setKeeping(false);
    }
  }

  const back = (
    <A href={storiesHref({ name: "cars" })} className="st-s-back st-s-back--orb">
      <span className="st-s-back__orb">‹</span> Vehicles
    </A>
  );

  if (gone)
    return (
      <section className="st-page st-studio st-s-make">
        <Notice tone="bad" action={<A href={storiesHref({ name: "cars" })} className="st-btn">Back to Vehicles</A>}>
          That draft is gone.
        </Notice>
      </section>
    );
  if (!draft)
    return (
      <section className="st-page st-studio st-s-make">
        {problem ? (
          <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void reload().catch(() => {})}>Try again</button>}>
            {problem}
          </Notice>
        ) : (
          <Busy>Getting the draft…</Busy>
        )}
      </section>
    );

  const cars = carsOf(draft);
  const seconds = secondsSince(draft.startedAt, now);
  const outside = draft.photos.filter((p) => p.side !== "inside");
  const inside = draft.photos.filter((p) => p.side === "inside");
  const failed = draft.status === "failed";
  const mainWord = designing ? "Designing…" : failed ? "Try again" : "Design it again";

  return (
    <section className="st-page st-studio st-s-make">
      <span className="st-s-sr" role="status" aria-live="polite">
        {announce}
      </span>
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          {back}
          <h1 className="st-s-head__title">{draft.name.trim() ? draft.name : "New vehicle"}</h1>
          <p className="st-s-head__lede">{kindWord(draft.vehicle)}. {designing ? "Designing it now." : failed ? "It stopped." : "Pick one, then name it."}</p>
        </div>
        <GlassPill icon={<MakeIcon name="delete" size={18} />} onClick={() => (cars.length ? setAsking(true) : void remove())}>
          Delete
        </GlassPill>
      </header>
      <section className="st-s-design st-s-design--car st-glass st-glass--hero" aria-labelledby="st-vd-title" ref={box}>
        <h2 className="st-s-design__title" id="st-vd-title">
          Design with AI
        </h2>
        {draft.photos.length ? (
          <div className="st-vdp__sides">
            {[
              ["Outside", outside],
              ["Inside", inside],
            ].map(([label, list]) =>
              (list as VehicleDraft["photos"]).length ? (
                <figure key={label as string} className="st-vdp__side">
                  <figcaption>{label as string}</figcaption>
                  <ul className="st-vdp__photos">
                    {(list as VehicleDraft["photos"]).map((p) => (
                      <li key={p.assetId}>
                        <img src={p.url} alt={`${label as string} photo`} width={88} height={88} />
                      </li>
                    ))}
                  </ul>
                </figure>
              ) : null,
            )}
          </div>
        ) : null}
        {draft.words ? <p className="st-vdp__words">{draft.words}</p> : null}
        {failed ? (
          <Notice tone="bad" action={<SettingsFix sentence={draft.message} />}>
            {draft.message || "The helper stopped. Tap Try again."}
          </Notice>
        ) : (
          <TaskLine info={info} kind="character_design" run={draftRun(draft, seconds)} expected={merged(info, usual, pick)} />
        )}
        {designing ? <p className="st-vdp__calm">You can leave. It keeps going in Vehicles.</p> : null}
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        <div className="st-s-actionbar">
          <A href={storiesHref({ name: "cars" })} className="st-btn">
            Close
          </A>
          <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} />
          <button type="button" className="st-btn st-btn--main" aria-disabled={designing || undefined} onClick={() => void redesign(failed && retryAsMore(draft))}>
            {mainWord}
          </button>
        </div>
        {cars.length ? (
          <CarOptions options={cars} picked={picked} onPick={setPicked} busy={designing} max={MAX_DRAFT_OPTIONS} onMore={() => void redesign(true)} />
        ) : null}
      </section>
      {cars.length ? (
        <CharacterEditor
          key={`draft:${draft.draftId}:${round}:${picked}`}
          initial={cars[picked] ?? cars[0]!}
          saved={cars[picked] ?? cars[0]!}
          startPart="name"
          mode="new"
          saving={saving}
          onSave={(c) => void save(c)}
          serverProblem={keeping ? <Busy>Saving photos…</Busy> : saveProblem ? <Notice tone="bad">{saveProblem}</Notice> : null}
          hold={!leaving}
        />
      ) : null}
      {asking ? (
        <ConfirmDelete
          draft={{ ...draft, name: draftTitle(draft) }}
          onKeep={() => setAsking(false)}
          onDelete={() => {
            setAsking(false);
            void remove();
          }}
        />
      ) : null}
    </section>
  );
}
