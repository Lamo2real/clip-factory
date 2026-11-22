// One reference video's page (docs/CONTRACTS.md §45.28, §45.34): the player, Analyze (with the model and effort shown
// and its provider, a just-for-this-run override, and "Keep with this video": the video's own setting, saved with
// PATCH …/references/{refId} { ai }), the step track while the video analysis agent looks at it, the analysis, "Use in
// a video" (Production › New with it picked: `?ref=`), Talk about it in Chat, rename, and delete with Undo.
//
// GET …/references/{refId} answers { reference, analysis, job } (§45.34): the analysis job of currentJobId, else the
// latest one. So the page draws each step's own state and progress (Look at it, Listen, Write it up) and, when a run
// stops, the job's own reason ("{Model} isn't available right now: …"), after a reload too. Without a job in the
// answer (an older API): `failed` is a failure, and a video that goes back to `analyzed` with the very same analysis
// as before was a re-run that did not finish (Lamo Stories' agent keeps the last analysis then).
//
// A video whose file was cleared to save space (§45.34 "Keeping and clearing files", §45.35 D9: the API says
// `fileRemoved`, and leaves `url` out) says "The video was removed to save space. Its study stays." when its study is
// kept (`studyKept`), else only "The video was removed to save space." (the 30- and 90-day rules also clear videos
// that were never studied). It is not analyzed again (the API refuses it); a kept study and "Use in a video" stay.
import { useCallback, useEffect, useRef, useState } from "react";
import { A } from "../../../components/ui.tsx";
import { usePoll } from "../../../lib/hooks.ts";
import { navigate } from "../../../lib/router.ts";
import { storiesApi } from "../../api/client.ts";
import { cx } from "../../glass/index.ts";
import { storiesGoLater } from "../../pane.tsx";
import { REF_STEP_LABEL, REF_STEP_ORDER, type AiSetting, type ModelOverride, type ProductionJob, type ReferenceAnalysis, type ReferenceVideo, type StoryStep } from "../../api/types.ts";
import { storiesHref } from "../../routes.ts";
import { AiLine, AiSheet, DEFAULT, type AiScope } from "../ai.tsx";
import { rememberConversation } from "../device.ts";
import { FixIt } from "../fixit.tsx";
import { productionNewHref } from "../handoff.ts";
import { Btn, centerOf, cheer, Chip, clock, Empty, Icon, Progress, sentence, size, Waiting } from "../kit.tsx";
import { effortProblem, findModel, modelLabel, effortLabel, projectEffective, useModels, withOverride } from "../models.ts";
import { rememberProjectName } from "../project.ts";
import { modelIdLine, modelName, modelOf, sendPick, unusableWords, usableUsual, type AiInfo, type Usual } from "../../studio/ai.tsx";
import { referencesChanged } from "../../studio/hooks.ts";
import { TechDetails } from "../../studio/kit.tsx";
import { scheduleDelete } from "../undo.ts";
import { AnalysisView } from "./Analysis.tsx";
import { RefPlayer } from "./Player.tsx";
import { REF_STATUS } from "./RefList.tsx";
import { localVideo } from "./uploads.ts";

/** The analysis job's own steps (§45.28, §45.34), used when the server's job is not in the answer. */
export const REF_STEP_LABELS = REF_STEP_ORDER.map((k) => REF_STEP_LABEL[k]);

type RefData = { reference: ReferenceVideo; analysis: ReferenceAnalysis | null; job?: ProductionJob | null };

/** A failure whose reason the page does not know (the contract's answer has no job). */
export const ANALYSIS_FAILED = "The video analysis agent could not finish this one. Try again, or pick another model.";
/** A re-run that ended with the last analysis kept. */
export const RERUN_FAILED = "The new analysis did not finish, so this is still the last one. Try again, or pick another model.";
/** A re-run that stopped with its own reason (the job in the answer, §45.34): the reason follows this. */
const RERUN_LEAD = "The new analysis did not finish, so this is still the last one.";
/** A video whose file was cleared by the keep setting (§45.34): the study stays. */
export const FILE_REMOVED = "The video was removed to save space. Its study stays.";
/** A video whose file was cleared before it was ever studied (§45.35 D9): there is no study to keep. */
export const FILE_REMOVED_NO_STUDY = "The video was removed to save space.";

/**
 * Whether the keep setting cleared this video's file, and whether its study stays (§45.35 D9). The API says both
 * (`fileRemoved`, `studyKept`); an older one only leaves `url` out of a video past uploading, and then a study the page
 * has is the one kept.
 */
export function removedState(ref: Pick<ReferenceVideo, "status" | "url" | "fileRemoved" | "studyKept">, analysis: ReferenceAnalysis | null | undefined): { removed: boolean; studyKept: boolean; line: string | null } {
  const removed = typeof ref.fileRemoved === "boolean" ? ref.fileRemoved : ref.status !== "uploading" && !ref.url;
  if (!removed) return { removed: false, studyKept: false, line: null };
  const studyKept = typeof ref.studyKept === "boolean" ? ref.studyKept : !!analysis;
  return { removed: true, studyKept, line: studyKept ? FILE_REMOVED : FILE_REMOVED_NO_STUDY };
}

const same = (a: ReferenceAnalysis | null | undefined) => (a ? JSON.stringify(a) : null);

export function RefPage({ ws, refId }: { ws: string; refId: string }) {
  const models = useModels(ws);
  const [data, setData] = useState<RefData | null>(null);
  /** The analysis job as the last answer carried it (null when the answer had none). */
  const [job, setJob] = useState<ProductionJob | null>(null);
  /** The job the Analyze tap started: only its model is shown (its steps are not followed, it is not news). */
  const [started, setStarted] = useState<ProductionJob | null>(null);
  const [problem, setProblem] = useState<{ text: string; missing: boolean } | null>(null);
  const [round, setRound] = useState(0);
  const [override, setOverride] = useState<ModelOverride | null>(null);
  const [sheet, setSheet] = useState(false);
  /** Where the sheet's choice goes: this run only, or kept with this video (§45.34 "Keep with this video"). */
  const [scope, setScope] = useState<AiScope>("once");
  const [keepNote, setKeepNote] = useState<{ saved: string | null; problem: string | null }>({ saved: null, problem: null });
  /**
   * "Keep with this video" saves on every tap. The setting as last picked (null: as the server last said), so the next
   * tap builds on it and never on an older answer; and the saves sent, so only the newest one's answer is shown.
   */
  const [keptNow, setKeptNow] = useState<AiSetting | null>(null);
  const keeping = useRef<{ picked: AiSetting | null; sent: number; saved: number; answer: ReferenceVideo | null }>({ picked: null, sent: 0, saved: 0, answer: null });
  const [busy, setBusy] = useState(false);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [whyNot, setWhyNot] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const analyzeBtn = useRef<HTMLDivElement>(null);
  const was = useRef<ReferenceVideo["status"] | null>(null);
  /** The analysis as it was when this run began (undefined while no run is followed). */
  const before = useRef<string | null | undefined>(undefined);
  /** How the last run this page followed ended, when it did not work. */
  const [failed, setFailed] = useState<string | null>(null);

  const take = useCallback((r: RefData) => {
    setData(r);
    rememberProjectName({ kind: "reference", id: r.reference.refId }, r.reference.title);
    // Only an answer that carries the job draws its steps; otherwise the job of the Analyze tap is no longer news.
    const live = r.job ?? null;
    setJob(live);
    const status = r.reference.status;
    if (status === "analyzing" && before.current === undefined) before.current = same(r.analysis);
    // A study that started or ended changes what Production can pick (§45.36 E2).
    if (was.current !== null && was.current !== status) referencesChanged();
    if (was.current === "analyzing" && status !== "analyzing") {
      const old = before.current;
      before.current = undefined;
      const ended = live && ["ready", "failed", "canceled", "needs_check"].includes(live.status) ? live : null;
      const bad = ended ? ended.status !== "ready" : status === "failed" || (status === "analyzed" && typeof old === "string" && old === same(r.analysis));
      if (bad) setFailed(ended?.error ? (status === "analyzed" ? `${RERUN_LEAD} ${ended.error}` : ended.error) : status === "analyzed" ? RERUN_FAILED : ANALYSIS_FAILED);
      else {
        // The moment it is done: a cheer.
        setFailed(null);
        cheer(centerOf(analyzeBtn.current));
      }
    }
    was.current = status;
  }, []);

  useEffect(() => {
    let live = true;
    setProblem(null);
    storiesApi()
      .getReference(ws, refId)
      .then((r) => live && take(r as RefData))
      .catch((e: unknown) => {
        if (!live) return;
        const missing = (e as { code?: string })?.code === "not_found";
        setProblem({ text: missing ? "We could not find that reference video. It may have been deleted." : sentence(e, "The reference video did not load. Try again."), missing });
      });
    return () => {
      live = false;
    };
  }, [ws, refId, round, take]);

  usePoll(
    async () => {
      take((await storiesApi().getReference(ws, refId)) as RefData);
    },
    data?.reference.status === "analyzing",
    2000,
  );

  if (problem)
    return (
      <section className="st-page st-refs">
        <A href={storiesHref({ name: "references" })} className="st-chat-back st-chat-back--always">
          <Icon name="back" size={20} />
          All reference videos
        </A>
        <h1 className="sr-only">Reference video</h1>
        <Empty
          card
          mood="oops"
          title={problem.missing ? "That video is gone" : "It did not load"}
          action={
            problem.missing ? null : (
              <Btn main icon="retry" onClick={() => setRound((n) => n + 1)}>
                Try again
              </Btn>
            )
          }
        >
          {problem.text}
        </Empty>
      </section>
    );
  if (!data)
    return (
      <section className="st-page st-refs">
        <h1 className="sr-only">Reference video</h1>
        <Waiting plate label="Opening the video…" />
      </section>
    );

  const ref = data.reference;
  const task = models.tasks?.find((t) => t.kind === "reference_analysis")?.effective ?? null;
  // The analysis' usual skips a model the studio knows cannot be used, unless this video keeps that model on purpose:
  // then it shows with its status (§45.36 E12). The line shows what Analyze sends.
  const aiInfo: AiInfo = { models: models.models, tasks: models.tasks ?? [], live: !!models.tasks, ...(models.ai?.defaultModel ? { defaultModel: models.ai.defaultModel } : {}) };
  const base = projectEffective(task, ref.ai, null);
  const refUsual: Usual = { model: base.model, effort: base.effort, effortApplied: task?.effortApplied ?? true, from: ref.ai.model || ref.ai.effort ? "project" : (task?.from ?? "default"), modelKept: !!ref.ai.model };
  const usable = usableUsual(aiInfo, refUsual);
  const skipped = usable.skipped && !override?.model ? modelOf(aiInfo, usable.skipped) : null;
  const current = skipped ? withOverride(usable, override) : projectEffective(task, ref.ai, override);
  const model = findModel(models.models, current.model);
  const effortBad = effortProblem(model, current.effort);
  // The keep setting cleared the file (§45.34, §45.35 D9).
  const cleared = removedState(ref, data.analysis);
  const removed = cleared.removed;
  // The file itself when it was sent from this device this visit, else the server's link; never once the file was
  // cleared (§45.36 E18: the page then says so, with the D9 sentence).
  const src = removed ? null : (localVideo(ref.refId) ?? ref.url ?? null);
  const analyzable = !removed && (ref.status === "ready" || ref.status === "analyzed" || ref.status === "failed");

  async function analyze() {
    if (busy) return;
    // A cleared file: the line above the button already says why.
    if (removed) return;
    if (!analyzable) return setWhyNot(ref.status === "analyzing" ? "It is being analyzed right now." : "Wait until the video has finished uploading.");
    if (effortBad) return setWhyNot(effortBad);
    setBusy(true);
    setActionProblem(null);
    setWhyNot(null);
    try {
      // The pick, or the stand-in the line shows for a usual model that cannot be used (this run only, §45.36 E12).
      const body = sendPick(aiInfo, refUsual, override);
      const analysisBefore = same(data?.analysis);
      const r = await storiesApi().analyzeReference(ws, ref.refId, body);
      setFailed(null);
      before.current = analysisBefore;
      if (r.job.status === "failed" || r.reference.status === "failed") {
        // Refused at the start: its sentence at once.
        before.current = undefined;
        setFailed(r.job.error || ANALYSIS_FAILED);
      }
      setJob(null);
      setStarted(r.job);
      setData((d) => (d ? { ...d, reference: r.reference } : d));
      was.current = r.reference.status;
      referencesChanged();
      setOverride(null);
    } catch (e) {
      setActionProblem(sentence(e, "The analysis did not start. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    if (renaming === null) return;
    const t = renaming.trim();
    if (!t) return setRenameProblem("Give it a name first.");
    if (t.length > 80) return setRenameProblem("Keep the name under 80 letters.");
    try {
      const next = await storiesApi().patchReference(ws, ref.refId, { title: t });
      setData((d) => (d ? { ...d, reference: next } : d));
      rememberProjectName({ kind: "reference", id: next.refId }, next.title);
      setRenaming(null);
      setRenameProblem(null);
    } catch (e) {
      setRenameProblem(sentence(e, "The name did not save. Try again."));
    }
  }

  async function talk() {
    setActionProblem(null);
    try {
      const c = await storiesApi().createConversation(ws, { title: `About ${ref.title}`.slice(0, 80), projectRef: { kind: "reference", id: ref.refId } });
      rememberConversation(c.convId);
      // After the wait: never while Clip Factory is on screen (it happens once Lamo Stories is back, §45.35 D17).
      storiesGoLater(storiesHref({ name: "chat_conv", convId: c.convId }));
    } catch (e) {
      setActionProblem(sentence(e, "The chat did not start. Try again."));
    }
  }

  function remove() {
    scheduleDelete({
      kind: "reference",
      id: ref.refId,
      text: `Deleted “${ref.title}”.`,
      run: async () => {
        await storiesApi().deleteReferenceVideo(ws, ref.refId);
        referencesChanged();
      },
    });
    storiesGoLater(storiesHref({ name: "references" }));
  }

  /** The video's own setting as the sheet shows it: the last pick while its save is on the way. */
  const keptAi = (): AiSetting => keeping.current.picked ?? ref.ai;

  /**
   * "Keep with this video": the video's own model and effort, saved with it (every analysis of it uses it). Each tap
   * sends the whole setting, built from the last pick; only the newest save's answer is shown.
   */
  async function keep(next: AiSetting) {
    const k = keeping.current;
    k.sent += 1;
    const seq = k.sent;
    k.picked = next;
    setKeptNow(next);
    setKeepNote({ saved: null, problem: null });
    let problem: string | null = null;
    try {
      const saved = await storiesApi().patchReference(ws, ref.refId, { ai: next });
      if (seq > k.saved) {
        k.saved = seq;
        k.answer = saved;
      }
    } catch (e) {
      problem = sentence(e, "That did not save. Try again.");
    }
    if (seq !== k.sent) return; // a newer tap's save is on the way: its answer is the one shown
    const answer = k.answer;
    k.picked = null;
    k.answer = null;
    setKeptNow(null);
    if (answer) setData((d) => (d ? { ...d, reference: answer } : d));
    setKeepNote(problem ? { saved: null, problem } : { saved: next.model || next.effort ? "Kept with this video." : "This video uses the usual setting again.", problem: null });
  }

  /** A model picked to keep: the kept effort stays only when that model offers it (else the usual effort). */
  function keepModel(key: string) {
    const base = keptAi();
    const modelKey = key === DEFAULT ? null : key;
    const runs = findModel(models.models, modelKey ?? task?.model ?? null);
    const effort = base.effort && runs && runs.efforts.includes(base.effort) ? base.effort : null;
    void keep({ model: modelKey, effort });
  }

  function openSheet() {
    setKeepNote({ saved: null, problem: null });
    setScope("once");
    setSheet(true);
  }

  const steps: StoryStep[] =
    job && job.steps.length
      ? job.steps.map((st) => ({ ...st, label: st.label || REF_STEP_LABEL[st.key as keyof typeof REF_STEP_LABEL] || st.key }))
      : REF_STEP_ORDER.map((key) => ({ key, label: REF_STEP_LABEL[key], status: ref.status === "analyzing" ? "running" : "pending" }));
  // The run that just stopped (followed here), else what the job in the answer says (after a reload too).
  const jobFailed = job && job.status === "failed" ? job.error || ANALYSIS_FAILED : null;
  const rerunStopped = jobFailed ? (jobFailed === ANALYSIS_FAILED ? RERUN_FAILED : `${RERUN_LEAD} ${jobFailed}`) : null;
  const failedLine = ref.status === "failed" ? failed || jobFailed || ANALYSIS_FAILED : ref.status === "analyzed" ? (failed ?? rerunStopped) : null;
  const stoppedSteps = !!job && job.status === "failed" && job.steps.length > 0;
  const kept = keptNow ?? ref.ai;
  const keepValues = { model: kept.model ?? DEFAULT, effort: kept.effort ?? DEFAULT };

  return (
    <section className="st-page st-refs st-ref">
      <A href={storiesHref({ name: "references" })} className="st-chat-back st-chat-back--always">
        <Icon name="back" size={20} />
        All reference videos
      </A>
      <header className="st-ref__head st-plate">
        {renaming === null ? (
          <div className="st-chat-conv__title-row">
            <h1 className="st-ref__title st-display">{ref.title}</h1>
            <Btn quiet icon="pencil" label={`Rename ${ref.title}`} onClick={() => setRenaming(ref.title)} />
          </div>
        ) : (
          <div className="st-chat-rename">
            <h1 className="sr-only">{ref.title}</h1>
            <label className="st-chat-field">
              <span className="st-chat-field__label">Name of this video</span>
              <input
                className="st-chat-input"
                value={renaming}
                maxLength={80}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            </label>
            <div className="st-chat-rename__buttons">
              <Btn quiet onClick={() => setRenaming(null)}>
                Cancel
              </Btn>
              <Btn main onClick={() => void saveTitle()}>
                Save
              </Btn>
            </div>
            {renameProblem ? (
              <p className="st-chat-note st-chat-note--bad" role="alert">
                {renameProblem}
              </p>
            ) : null}
          </div>
        )}
        <p className="st-ref__meta">
          <Chip tone={REF_STATUS[ref.status].tone}>{REF_STATUS[ref.status].text}</Chip>
          <span>{[ref.durationSec ? clock(ref.durationSec) : null, ref.bytes ? size(ref.bytes) : null].filter(Boolean).join(" · ")}</span>
        </p>
      </header>

      <div className="st-ref-layout">
        <div className={cx("st-ref-player st-glass st-glass--hero st-lens", !src && "st-ref-player--empty")}>
          {src ? (
            <RefPlayer videoRef={player} src={src} title={ref.title} />
          ) : (
            <div className="st-ref-player__none">
              <Icon name="film" size={40} />
              <span>{ref.status === "uploading" ? "The video is still on its way." : removed ? cleared.line : "The video plays here."}</span>
            </div>
          )}
        </div>

        <div className="st-ref-side" ref={analyzeBtn}>
          {ref.status === "uploading" ? (
            <div className="st-ref-card2 st-glass">
              <h2 className="st-ref-block__title">Still uploading</h2>
              <p>This video did not finish uploading. If it was stopped, delete it and upload it again.</p>
            </div>
          ) : ref.status === "analyzing" ? (
            <div className="st-ref-card2 st-glass" aria-live="polite">
              <h2 className="st-ref-block__title">Analyzing…</h2>
              <p>The video analysis agent is looking at every shot. It takes a few minutes for a long video. You can look at other pages meanwhile.</p>
              <div className={cx("st-ref-run", job && "st-ref-run--dial")}>
                <ol className="st-ref-track" aria-label="Steps">
                  {steps.map((s, i) => (
                    <li key={`${s.label}-${i}`} className={`st-ref-track__step is-${s.status}`}>
                      <span className="st-ref-track__mark" aria-hidden="true">
                        {s.status === "done" ? <Icon name="check" size={18} /> : i + 1}
                      </span>
                      <span className="st-ref-track__label">{s.label}</span>
                      <span className="sr-only">{s.status === "done" ? "done" : s.status === "running" ? "working on it" : "next"}</span>
                      {s.message ? <span className="st-ref-track__msg">{s.message}</span> : null}
                    </li>
                  ))}
                </ol>
                {/* The job's own progress: the arc with the white knob beside the steps. */}
                {job ? <Progress dial value={job.progress} label="How far the analysis is" /> : null}
              </div>
              {/* The short gap before the job answers: the moving bar, never a dial stuck at 0. */}
              {job ? null : <div className="st-ref-busybar" aria-hidden="true" />}
              {(job ?? started)?.meta.models[0] ? (
                <>
                  <p className="st-chat-ai__note">
                    With {modelLabel(models.models, (job ?? started)!.meta.models[0]!.model)}
                    {(job ?? started)!.meta.models[0]!.effort ? ` · ${effortLabel((job ?? started)!.meta.models[0]!.effort)}` : ""}
                  </p>
                  <ModelIdFold record={(job ?? started)!.meta.models[0]!} />
                </>
              ) : null}
            </div>
          ) : (
            <div className="st-ref-card2 st-glass">
              {failedLine ? (
                <div className="st-chat-note st-chat-note--bad st-chat-note--row st-ref-failed" role="alert">
                  <span>{failedLine}</span>
                  <FixIt text={failedLine} onPickModel={openSheet} pick />
                </div>
              ) : null}
              {failedLine && stoppedSteps ? (
                <ol className="st-ref-track st-ref-track--stopped" aria-label="How far it got">
                  {steps.map((st, i) => (
                    <li key={`${st.key}-${i}`} className={`st-ref-track__step is-${st.status}`}>
                      <span className="st-ref-track__mark" aria-hidden="true">
                        {st.status === "done" ? <Icon name="check" size={18} /> : st.status === "failed" ? "!" : i + 1}
                      </span>
                      <span className="st-ref-track__label">{st.label}</span>
                      <span className="sr-only">{st.status === "done" ? "done" : st.status === "failed" ? "stopped here" : "not reached"}</span>
                      {st.status === "failed" && st.message ? <span className="st-ref-track__msg">{st.message}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              <h2 className="st-ref-block__title">{ref.status === "analyzed" ? "Analyze it again" : "Analyze it"}</h2>
              <p>The video analysis agent looks at the shots, the timing, the jokes and the sound. Your videos borrow the ideas, never the characters or the footage.</p>
              {removed ? (
                <p className="st-chat-note st-ref-removed" role="status">
                  {ref.status === "analyzed" ? "The video file is gone, so it cannot be analyzed again." : "The video file is gone, so it cannot be analyzed."}
                </p>
              ) : null}
              <AiLine
                models={models.models}
                current={current}
                override={override}
                onceLabel="Just for this run"
                clearLabel="Use the usual setting"
                onPick={openSheet}
                onClearOverride={() => setOverride(null)}
                hint={
                  models.problem ? (
                    <p className="st-chat-ai__note">
                      {models.problem}{" "}
                      <button type="button" className="st-chat-linkbtn" onClick={models.reload}>
                        Try again
                      </button>
                    </p>
                  ) : (
                    <p className="st-chat-ai__note">
                      {skipped ? `${unusableWords(skipped)}, so this analysis uses ${modelName(aiInfo, usable.model)}. ` : ""}
                      {ref.ai.model || ref.ai.effort ? "Kept with this video (its own setting)." : "From Lamo Stories › Settings › AI."}
                    </p>
                  )
                }
              />
              <div className="st-ref-actions">
                {/* One main action at a time: Analyze until the video is analyzed, then "Use in a video". */}
                <button type="button" className={cx("st-chat-btn", ref.status !== "analyzed" && "st-chat-btn--main")} aria-disabled={busy || !analyzable || !!effortBad || undefined} onClick={() => void analyze()}>
                  <Icon name="eye" size={20} />
                  {busy ? "Starting…" : ref.status === "analyzed" ? "Analyze again" : ref.status === "failed" ? "Try again" : "Analyze it"}
                </button>
              </div>
            </div>
          )}
          {whyNot ? (
            <p className="st-chat-note st-plate" role="status">
              {whyNot}
            </p>
          ) : null}
          {actionProblem ? (
            <div className="st-chat-note st-chat-note--bad st-chat-note--row st-plate" role="alert">
              <span>{actionProblem}</span>
              <FixIt text={actionProblem} onPickModel={openSheet} />
            </div>
          ) : null}
          <div className="st-ref-actions st-ref-actions--more">
            <button
              type="button"
              className={cx("st-chat-btn", ref.status === "analyzed" && "st-chat-btn--main")}
              aria-disabled={ref.status !== "analyzed" || undefined}
              onClick={() => {
                if (ref.status !== "analyzed") return setWhyNot("Analyze it first, then use it in a video.");
                navigate(productionNewHref({ referenceIds: [ref.refId] }));
              }}
            >
              <Icon name="clapper" size={20} />
              Use in a video
            </button>
            <Btn icon="chat" onClick={() => void talk()}>
              Talk about it in Chat
            </Btn>
            <Btn danger icon="trash" onClick={remove}>
              Delete
            </Btn>
          </div>
        </div>
      </div>

      {ref.status === "analyzed" && data.analysis ? (
        <>
          {ref.analyzedWith ? (
            <div className="st-ref-withbox st-plate">
              <p className="st-ref-with">
                Analyzed with {modelLabel(models.models, ref.analyzedWith.model)}
                {ref.analyzedWith.effort ? ` · ${effortLabel(ref.analyzedWith.effort)}` : ""}
              </p>
              <ModelIdFold record={(job ?? data.job ?? started)?.meta.models.find((m) => m.model === ref.analyzedWith!.model && !m.failed) ?? null} />
            </div>
          ) : null}
          <AnalysisView
            analysis={data.analysis}
            durationSec={ref.durationSec}
            onSeek={
              src
                ? (sec) => {
                    const v = player.current;
                    if (!v) return;
                    v.currentTime = sec;
                    v.scrollIntoView?.({ block: "center", behavior: "smooth" });
                    void v.play?.().catch(() => undefined);
                  }
                : null
            }
          />
        </>
      ) : null}

      {sheet ? (
        <AiSheet
          title={scope === "keep" ? "Model and effort for this video" : "Model and effort for this run"}
          models={models.models}
          scope={scope}
          scopes={[
            { value: "once", label: "Just for this run" },
            { value: "keep", label: "Keep with this video" },
          ]}
          onScope={(next) => {
            setKeepNote({ saved: null, problem: null });
            setScope(next === "keep" ? "keep" : "once");
          }}
          values={scope === "keep" ? keepValues : { model: current.model, effort: current.effort }}
          effortModel={scope === "keep" ? findModel(models.models, kept.model ?? task?.model ?? current.model) : model}
          suggested={models.tasks?.find((t) => t.kind === "reference_analysis")?.suggestedEffort ?? null}
          problem={scope === "keep" ? keepNote.problem : null}
          saved={scope === "keep" ? keepNote.saved : null}
          onModel={(key) => {
            if (scope === "keep") keepModel(key);
            else setOverride((o) => ({ ...(o ?? {}), model: key }));
          }}
          onEffort={(e) => {
            if (scope === "keep") void keep({ model: keptAi().model, effort: e === DEFAULT ? null : (e as NonNullable<AiSetting["effort"]>) });
            else setOverride((o) => ({ ...(o ?? {}), effort: e as NonNullable<ModelOverride["effort"]> }));
          }}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </section>
  );
}

/** The exact model and Region an analysis called, behind "Technical details" like every model record (§45.36 E8, E14). */
function ModelIdFold({ record }: { record: { modelId?: string | null; region?: string | null } | null | undefined }) {
  const id = record ? modelIdLine(record) : null;
  if (!id) return null;
  return (
    <TechDetails className="st-ref-tech">
      <p className="st-s-used__id">{id}</p>
    </TechDetails>
  );
}
