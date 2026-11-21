// One reference video's page (docs/CONTRACTS.md §45.28): the player, Analyze (with the model and effort shown and a
// just-for-this-run override), the step track while the video analysis agent looks at it, the analysis, "Use in a
// video" (Production › New with it), Talk about it in Chat, rename, and delete with Undo.
import { useCallback, useEffect, useRef, useState } from "react";
import { A } from "../../../components/ui.tsx";
import { usePoll } from "../../../lib/hooks.ts";
import { navigate } from "../../../lib/router.ts";
import { storiesApi } from "../../api/client.ts";
import type { ModelOverride, ProductionJob, ReferenceAnalysis, ReferenceVideo, StoryStep } from "../../api/types.ts";
import { storiesHref } from "../../routes.ts";
import { AiLine, AiSheet } from "../ai.tsx";
import { rememberConversation } from "../device.ts";
import { productionNewHref } from "../handoff.ts";
import { Btn, centerOf, cheer, Chip, clock, Empty, Icon, Progress, sentence, size, Waiting } from "../kit.tsx";
import { effortProblem, findModel, modelLabel, effortLabel, projectEffective, useModels } from "../models.ts";
import { rememberProjectName } from "../project.ts";
import { scheduleDelete } from "../undo.ts";
import { AnalysisView } from "./Analysis.tsx";
import { REF_STATUS } from "./RefList.tsx";
import { localVideo } from "./uploads.ts";

/** The analysis job's own steps (§45.28), used when the server's job is not in the answer. */
export const REF_STEP_LABELS = ["Look at it", "Listen", "Write it up"];

type RefData = { reference: ReferenceVideo; analysis: ReferenceAnalysis | null; job?: ProductionJob | null };

export function RefPage({ ws, refId }: { ws: string; refId: string }) {
  const models = useModels(ws);
  const [data, setData] = useState<RefData | null>(null);
  const [job, setJob] = useState<ProductionJob | null>(null);
  const [problem, setProblem] = useState<{ text: string; missing: boolean } | null>(null);
  const [round, setRound] = useState(0);
  const [override, setOverride] = useState<ModelOverride | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [whyNot, setWhyNot] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const analyzeBtn = useRef<HTMLDivElement>(null);
  const was = useRef<ReferenceVideo["status"] | null>(null);

  const take = useCallback((r: RefData) => {
    setData(r);
    rememberProjectName({ kind: "reference", id: r.reference.refId }, r.reference.title);
    if (r.job !== undefined) setJob(r.job);
    // The moment it is done: a cheer.
    if (was.current === "analyzing" && r.reference.status === "analyzed") cheer(centerOf(analyzeBtn.current));
    was.current = r.reference.status;
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
        <Waiting label="Opening the video…" />
      </section>
    );

  const ref = data.reference;
  const task = models.tasks?.find((t) => t.kind === "reference_analysis")?.effective ?? null;
  const current = projectEffective(task, ref.ai, override);
  const model = findModel(models.models, current.model);
  const effortBad = effortProblem(model, current.effort);
  const src = ref.url ?? localVideo(ref.refId);
  const analyzable = ref.status === "ready" || ref.status === "analyzed" || ref.status === "failed";

  async function analyze() {
    if (busy) return;
    if (!analyzable) return setWhyNot(ref.status === "analyzing" ? "It is being analyzed right now." : "Wait until the video has finished uploading.");
    if (effortBad) return setWhyNot(effortBad);
    setBusy(true);
    setActionProblem(null);
    setWhyNot(null);
    try {
      const body = override && (override.model || override.effort) ? override : undefined;
      const r = await storiesApi().analyzeReference(ws, ref.refId, body);
      setJob(r.job);
      setData((d) => (d ? { ...d, reference: r.reference } : d));
      was.current = r.reference.status;
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
      const next = await storiesApi().patchReference(ws, ref.refId, t);
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
      navigate(storiesHref({ name: "chat_conv", convId: c.convId }));
    } catch (e) {
      setActionProblem(sentence(e, "The chat did not start. Try again."));
    }
  }

  function remove() {
    scheduleDelete({ kind: "reference", id: ref.refId, text: `Deleted “${ref.title}”.`, run: () => storiesApi().deleteReference(ws, ref.refId) });
    navigate(storiesHref({ name: "references" }));
  }

  const steps: StoryStep[] =
    job && job.steps.length ? job.steps : REF_STEP_LABELS.map((label) => ({ key: "storyboard", label, status: ref.status === "analyzing" ? "running" : "pending" }) as StoryStep);
  const failedLine = (job?.status === "failed" && job.error) || "The video analysis agent could not finish this one. Try again.";

  return (
    <section className="st-page st-refs st-ref">
      <A href={storiesHref({ name: "references" })} className="st-chat-back st-chat-back--always">
        <Icon name="back" size={20} />
        All reference videos
      </A>
      <header className="st-ref__head">
        {renaming === null ? (
          <div className="st-chat-conv__title-row">
            <h1 className="st-ref__title">{ref.title}</h1>
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
        <div className={`st-ref-player${src ? "" : " st-ref-player--empty"}`}>
          {src ? (
            <video ref={player} className="st-ref-player__video" src={src} controls playsInline preload="metadata" aria-label={`Play ${ref.title}`} />
          ) : (
            <div className="st-ref-player__none">
              <Icon name="film" size={40} />
              <span>{ref.status === "uploading" ? "The video is still on its way." : "The video plays here."}</span>
            </div>
          )}
        </div>

        <div className="st-ref-side" ref={analyzeBtn}>
          {ref.status === "uploading" ? (
            <div className="st-ref-card2">
              <h2 className="st-ref-block__title">Still uploading</h2>
              <p>This video did not finish uploading. If it was stopped, delete it and upload it again.</p>
            </div>
          ) : ref.status === "analyzing" ? (
            <div className="st-ref-card2" aria-live="polite">
              <h2 className="st-ref-block__title">Analyzing…</h2>
              <p>The video analysis agent is looking at every shot. It takes a few minutes for a long video. You can look at other pages meanwhile.</p>
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
              {job ? <Progress value={job.progress} label="How far the analysis is" /> : <div className="st-ref-busybar" aria-hidden="true" />}
              {ref.analyzedWith || job?.meta.models.length ? (
                <p className="st-chat-ai__note">With {modelLabel(models.models, job?.meta.models[0]?.model ?? ref.analyzedWith?.model)}</p>
              ) : null}
            </div>
          ) : (
            <div className="st-ref-card2">
              {ref.status === "failed" ? (
                <p className="st-chat-note st-chat-note--bad" role="alert">
                  {failedLine}
                </p>
              ) : null}
              <h2 className="st-ref-block__title">{ref.status === "analyzed" ? "Analyze it again" : "Analyze it"}</h2>
              <p>The video analysis agent looks at the shots, the timing, the jokes and the sound. Your videos borrow the ideas, never the characters or the footage.</p>
              <AiLine
                models={models.models}
                current={current}
                override={override}
                onceLabel="Just for this run"
                clearLabel="Use the usual setting"
                onPick={() => setSheet(true)}
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
                    <p className="st-chat-ai__note">{ref.ai.model || ref.ai.effort ? "This video's own setting." : "From Lamo Stories › Settings › AI."}</p>
                  )
                }
              />
              <div className="st-ref-actions">
                <button type="button" className="st-chat-btn st-chat-btn--main" aria-disabled={busy || !analyzable || !!effortBad || undefined} onClick={() => void analyze()}>
                  <Icon name="eye" size={20} />
                  {busy ? "Starting…" : ref.status === "analyzed" ? "Analyze again" : ref.status === "failed" ? "Try again" : "Analyze it"}
                </button>
              </div>
            </div>
          )}
          {whyNot ? (
            <p className="st-chat-note" role="status">
              {whyNot}
            </p>
          ) : null}
          {actionProblem ? (
            <p className="st-chat-note st-chat-note--bad" role="alert">
              {actionProblem}
            </p>
          ) : null}
          <div className="st-ref-actions st-ref-actions--more">
            <button
              type="button"
              className="st-chat-btn st-chat-btn--main"
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
            <p className="st-ref-with">
              Analyzed with {modelLabel(models.models, ref.analyzedWith.model)}
              {ref.analyzedWith.effort ? ` · ${effortLabel(ref.analyzedWith.effort)}` : ""}
            </p>
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
          title="Model and effort for this run"
          models={models.models}
          scope="once"
          scopes={[{ value: "once", label: "Just for this run" }]}
          onScope={() => undefined}
          values={{ model: current.model, effort: current.effort }}
          effortModel={model}
          suggested={models.tasks?.find((t) => t.kind === "reference_analysis")?.suggestedEffort ?? null}
          problem={null}
          saved={null}
          onModel={(key) => setOverride((o) => ({ ...(o ?? {}), model: key }))}
          onEffort={(e) => setOverride((o) => ({ ...(o ?? {}), effort: e as NonNullable<ModelOverride["effort"]> }))}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </section>
  );
}
