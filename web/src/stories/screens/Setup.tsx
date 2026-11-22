// Lamo Stories › Set up Lamo Stories (docs/CONTRACTS.md §45.29, §45.33): the first-time onboarding. It opens by
// itself the first time Lamo Stories opens (StoriesApp), and from the dashboard until it is finished. Eleven steps,
// each one skippable and doable later: 1 set up the AI, 2 the default model (with Check models), 3 the default effort,
// 4 how videos are made, 5 meet the agents and skills, 6 to 10 connect Instagram, TikTok, YouTube, Facebook and X
// (each with the same card as Social accounts), 11 done (confetti). A ring shows "4 of 11 done" and the list of
// what is left. Making videos never waits for the social steps.
//
// The ticks come from the server: steps 1 to 3 tick when the AI configuration is saved, 4 when a video provider is
// picked, 6 to 10 when that platform is connected; only 5 and 11 are ticked here by hand.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { Glide } from "../../components/Glide.tsx";
import { storiesGoLater } from "../pane.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesSound } from "../prefs.ts";
import { storiesApi } from "../api/client.ts";
import { EFFORT_LABEL, type Effort, type ModelInfo, type Onboarding, type OnboardStep, type Platform, type StoriesAiConfig, type StoriesConfig } from "../api/types.ts";
import {
  celebrate,
  centerOf,
  PLATFORM_NAME,
  starBurst,
  refreshDashboard,
  setOnboarding,
  StButton,
  StError,
  StIcon,
  StLinkButton,
  StLoading,
  StMascot,
  StPick,
  StRing,
  useOnboarding,
  type StIconName,
} from "../ui.tsx";
import { DisconnectedNote, PlatformCard, useSocial } from "./Connections.tsx";
import type { StoriesScreenProps } from "./types.ts";

export const SETUP_ORDER: OnboardStep[] = ["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"];

const ICON: Record<OnboardStep, StIconName> = {
  ai: "bulb",
  model: "star",
  effort: "sliders",
  video: "clapper",
  agents: "face",
  instagram: "plug",
  tiktok: "plug",
  youtube: "plug",
  facebook: "plug",
  x: "plug",
  done: "check",
};

/** Where the setup starts: the first step not done yet (skipped ones count as still to do), else the last. */
export function firstOpen(o: Onboarding): OnboardStep {
  return o.steps.find((s) => s.state === "todo")?.step ?? o.steps.find((s) => s.state !== "done")?.step ?? "done";
}

/** The step after `step` (Done is last). */
export function nextStep(step: OnboardStep): OnboardStep {
  const i = SETUP_ORDER.indexOf(step);
  return SETUP_ORDER[Math.min(SETUP_ORDER.length - 1, i + 1)]!;
}

/** What is left: every step not done, in order (Done itself is not a task). */
export function leftOf(o: Onboarding): Onboarding["steps"] {
  return o.steps.filter((s) => s.state !== "done" && s.step !== "done");
}

/** The step's own buttons at its foot: Back, Skip for now, and its main action (or Next). */
function Foot({ step, busy, onBack, onSkip, children }: { step: OnboardStep; busy: boolean; onBack: (() => void) | null; onSkip: (() => void) | null; children?: ReactNode }) {
  return (
    <div className="st-setup__foot" data-step={step}>
      {onBack ? (
        <StButton quiet disabled={busy} onClick={onBack}>
          Back
        </StButton>
      ) : null}
      {onSkip ? (
        <StButton quiet disabled={busy} onClick={onSkip}>
          Skip for now
        </StButton>
      ) : null}
      {children}
    </div>
  );
}

type Ai = { ai: StoriesAiConfig; models: ModelInfo[] };

function modelLine(m: ModelInfo): string {
  if (m.status === "ok") return `${m.provider} · Works: it answered.`;
  if (m.status === "not_checked") return `${m.provider} · Not checked yet.`;
  return `${m.provider} · ${m.statusLine}`;
}

/** Steps 2 and 3: the default model (with Check models) and the default effort, saved to Lamo Stories' own AI setup. */
function ModelStep({ ws, ai, onSaved, busy, setBusy }: { ws: string; ai: Ai; onSaved: (next: StoriesAiConfig) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [pick, setPick] = useState(ai.ai.defaultModel);
  const [models, setModels] = useState(ai.models);
  const chosen = models.find((m) => m.key === pick);

  const check = async () => {
    setChecking(true);
    try {
      let task = await storiesApi().checkModels(ws);
      for (let i = 0; i < 120 && (task.status === "queued" || task.status === "running"); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        task = await storiesApi().getTask(ws, task.taskId);
      }
      if (task.status === "failed") throw new Error(task.error ?? "Check models did not finish. Tap it again.");
      const fresh = await storiesApi().getAi(ws);
      setModels(fresh.models);
      const ok = fresh.models.filter((m) => m.status === "ok").length;
      toast.success(`${ok} of ${fresh.models.length} models answered.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const save = async (el: HTMLElement) => {
    if (!chosen) return;
    setBusy(true);
    try {
      // The effort stays when the new model offers it; else the model's own default (never a level it lacks).
      const effort = chosen.efforts.includes(ai.ai.defaultEffort) ? ai.ai.defaultEffort : (chosen.defaultEffort ?? chosen.efforts[0] ?? ai.ai.defaultEffort);
      const next = await storiesApi().putAi(ws, { ...ai.ai, defaultModel: chosen.key, defaultEffort: effort });
      celebrate(centerOf(el));
      toast.success(`${chosen.label} is Lamo Stories' default model now.`);
      onSaved(next);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="st-setup__text">
        This model writes the stories, gives ideas and checks the facts, unless you pick another one for a task or an agent later. It is only for
        Lamo Stories: Clip Factory keeps its own.
      </p>
      <StPick<string>
        label="Lamo Stories' default model"
        stack
        value={pick}
        options={models.map((m) => ({ value: m.key, label: m.label, line: modelLine(m) }))}
        onChange={setPick}
      />
      {chosen && chosen.status !== "ok" && chosen.status !== "not_checked" ? (
        <p className="st-note st-note--coral" role="note">
          <StIcon name="alert" size={18} />
          {chosen.label} isn't available right now: {chosen.statusLine} Pick another model, or try again later.
        </p>
      ) : null}
      <div className="st-setup__row">
        <StButton disabled={checking || busy} onClick={() => void check()}>
          <StIcon name="retry" size={18} />
          {checking ? "Checking every model…" : "Check models"}
        </StButton>
        <span className="st-setup__hint">One tiny real call per model, so you see which ones answer.</span>
      </div>
      <SaveBar busy={busy} label={chosen ? `Use ${chosen.label}` : "Use this model"} onSave={save} />
    </>
  );
}

function EffortStep({ ws, ai, onSaved, busy, setBusy }: { ws: string; ai: Ai; onSaved: (next: StoriesAiConfig) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const model = ai.models.find((m) => m.key === ai.ai.defaultModel);
  const offers = model?.efforts ?? [];
  const [pick, setPick] = useState<Effort>(offers.includes(ai.ai.defaultEffort) ? ai.ai.defaultEffort : (model?.defaultEffort ?? offers[0] ?? "high"));
  if (!offers.length)
    return (
      <>
        <p className="st-note st-note--sky" role="note">
          <StIcon name="bulb" size={18} />
          {model?.label ?? "This model"} has no effort setting; it runs at its own level.
        </p>
        <SaveBar
          busy={busy}
          label="Use its own level"
          onSave={async (el) => {
            setBusy(true);
            try {
              const next = await storiesApi().putAi(ws, { ...ai.ai });
              celebrate(centerOf(el));
              onSaved(next);
            } catch (e) {
              toast.error(friendlyMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </>
    );
  return (
    <>
      <p className="st-setup__text">
        How hard {model?.label ?? "the model"} thinks before it answers. Higher is slower and costs more, and is best for storyboards and fact checks.
        You can pick a different level per task later.
      </p>
      <StPick<Effort>
        label="Lamo Stories' default effort"
        value={pick}
        options={offers.map((e) => ({ value: e, label: EFFORT_LABEL[e], line: e === model?.defaultEffort ? "The model's own" : undefined }))}
        onChange={setPick}
      />
      <SaveBar
        busy={busy}
        label={`Use ${EFFORT_LABEL[pick]}`}
        onSave={async (el) => {
          setBusy(true);
          try {
            const next = await storiesApi().putAi(ws, { ...ai.ai, defaultEffort: pick });
            celebrate(centerOf(el));
            toast.success(`Effort set to ${EFFORT_LABEL[pick]}.`);
            onSaved(next);
          } catch (e) {
            toast.error(friendlyMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function SaveBar({ busy, label, onSave }: { busy: boolean; label: string; onSave: (el: HTMLElement) => void | Promise<void> }) {
  return (
    <div className="st-setup__save">
      <StButton
        main
        disabled={busy}
        onClick={(e) => {
          const el = e.currentTarget;
          void onSave(el);
        }}
      >
        <StIcon name="check" size={18} />
        {busy ? "Saving…" : label}
      </StButton>
    </div>
  );
}

/** Step 4: how videos are made (the video provider, §45.31), saved in the workspace's own settings. */
function VideoStep({ ws, onSaved, busy, setBusy }: { ws: string; onSaved: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const w = useLoad(() => storiesApi().getWorkspace(ws), ws, "st-setup-ws");
  const providers = useLoad(() => storiesApi().providers(ws).catch(() => []), ws, "st-setup-providers");
  const config = (w.data?.configuration ?? null) as StoriesConfig | null;
  const [pick, setPick] = useState<StoriesConfig["providers"]["video"] | null>(null);
  const value = pick ?? config?.providers.video ?? "builtin-2d";
  const reel = providers.data?.find((p) => p.id === "nova-reel");
  if (w.error && !w.data) return <StError message={w.error} onRetry={() => void w.reload()} />;
  if (!config) return <StLoading label="Reading the video settings…" />;
  return (
    <>
      <p className="st-setup__text">
        The AI models only write the story. The pictures and the movement are made by a video maker: the built-in animator draws your characters
        the same way in every video.
      </p>
      <StPick<StoriesConfig["providers"]["video"]>
        label="How videos are made"
        stack
        value={value}
        options={[
          { value: "builtin-2d", label: "Built-in animation", line: "On. Cartoons drawn right here, 9:16, 30 frames a second." },
          { value: "nova-reel", label: "Amazon Nova Reel (AI video)", line: reel?.line ?? "Needs a storage place in the USA. Off until you allow it." },
        ]}
        onChange={setPick}
      />
      {value === "nova-reel" ? (
        <p className="st-note st-note--sun" role="note">
          <StIcon name="alert" size={18} />
          Nova Reel is not switched on yet, so videos keep using the built-in animation until it is. Posts made with it get the platforms' AI labels.
        </p>
      ) : null}
      <SaveBar
        busy={busy}
        label="Use this"
        onSave={async (el) => {
          setBusy(true);
          try {
            await storiesApi().patchWorkspace(ws, { configuration: { providers: { ...config.providers, video: value } }, version: w.data!.version });
            celebrate(centerOf(el));
            toast.success(value === "builtin-2d" ? "Videos are made with the built-in animation." : "Saved. Nova Reel starts once it is switched on.");
            onSaved();
          } catch (e) {
            toast.error(friendlyMessage(e));
            void w.reload();
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

/** Step 5: the five agents and their skills (Lamo Stories' own; Clip Factory's skills are never used). */
function AgentsStep({ ws }: { ws: string }) {
  const ai = useLoad(() => storiesApi().getAi(ws), ws, "st-setup-ai");
  const skills = useLoad(() => storiesApi().listSkills(ws).catch(() => null), ws, "st-setup-skills");
  if (ai.error && !ai.data) return <StError message={ai.error} onRetry={() => void ai.reload()} />;
  if (!ai.data) return <StLoading label="Meeting the team…" />;
  const name = (key: string | null) => (key ? (ai.data!.models.find((m) => m.key === key)?.label ?? key) : "the default model");
  return (
    <>
      <p className="st-setup__text">Five helpers work on every video. Each has its own instructions, model, effort and skills. You can change any of them in Settings › Agents.</p>
      <ul className="st-agents">
        {ai.data.agents.map((a) => (
          <li key={a.agentId} className={`st-agent${a.active ? "" : " is-off"}`}>
            <span className="st-agent__face" aria-hidden="true">
              <StMascot mood={a.active ? "wave" : "sleepy"} size={44} tone={a.agentId === "quality_assurance" ? "mint" : a.agentId === "storyboard" ? "sky" : a.agentId === "character" ? "coral" : "sun"} />
            </span>
            <span className="st-agent__text">
              <strong>{a.name}</strong>
              <span>
                {a.active ? "On" : "Off"} · {name(a.model)}
                {skills.data
                  ? ` · ${a.skillIds.map((id) => skills.data!.find((s) => s.skillId === id)?.title ?? id).join(", ") || "no skills"}`
                  : a.skillIds.length
                    ? ` · ${a.skillIds.length} skills`
                    : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Steps 6 to 10: the platform's card, the same as on Social accounts (its app choice, keys and Connect). */
function ConnectStep({ ws, platform }: { ws: string; platform: Platform }) {
  const social = useSocial(ws);
  const [gone, setGone] = useState(false);
  if (social.error && !social.data) return <StError message={social.error} onRetry={() => void social.reload()} />;
  if (!social.data) return <StLoading label="Checking the account…" />;
  const a = social.data.accounts.find((x) => x.platform === platform);
  if (!a) return <StError message="We could not find that account. Open Social accounts." />;
  return (
    <>
      <p className="st-setup__text">
        Connect the {PLATFORM_NAME[platform]} account that gets Lamo Stories' videos. It stays separate from Clip Factory's. You can skip this and
        connect it later.
      </p>
      {gone ? <DisconnectedNote onClose={() => setGone(false)} /> : null}
      <ul className="st-conns st-conns--one">
        <PlatformCard
          ws={ws}
          a={a}
          all={social.data.accounts}
          clips={social.data.clips.find((c) => c.platform === platform)}
          onChanged={social.reload}
          onDisconnected={() => setGone(true)}
        />
      </ul>
    </>
  );
}

const WORDS: Record<OnboardStep, { title: string; lede: string }> = {
  ai: { title: "Set up the AI", lede: "What Lamo Stories uses, and why." },
  model: { title: "Pick your default model", lede: "The AI model Lamo Stories uses unless you say otherwise." },
  effort: { title: "Pick your default effort", lede: "How hard the model thinks." },
  video: { title: "Pick how videos are made", lede: "The video maker, apart from the AI models." },
  agents: { title: "Meet your agents and skills", lede: "The five helpers of your studio." },
  instagram: { title: "Connect Instagram", lede: "Lamo Stories' own Instagram account." },
  tiktok: { title: "Connect TikTok", lede: "Lamo Stories' own TikTok account." },
  youtube: { title: "Connect YouTube", lede: "Lamo Stories' own YouTube channel." },
  facebook: { title: "Connect Facebook", lede: "Lamo Stories' own Facebook Page." },
  x: { title: "Connect X", lede: "Lamo Stories' own X account." },
  done: { title: "Done", lede: "Your studio is ready." },
};

export function SetupScreen({ ws }: StoriesScreenProps) {
  const toast = useToast();
  const ob = useOnboarding(ws);
  const ai = useLoad(() => storiesApi().getAi(ws), ws, "st-setup-ai");
  const [at, setAt] = useState<OnboardStep | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const data = ob.data;

  // Open at the first step still to do, once the server said where things are.
  useEffect(() => {
    if (data && at === null) setAt(firstOpen(data));
  }, [data, at]);

  const step = at ?? "ai";
  const state = data?.steps.find((s) => s.step === step)?.state ?? "todo";
  const left = useMemo(() => (data ? leftOf(data) : []), [data]);

  const go = (to: OnboardStep) => {
    setAt(to);
    requestAnimationFrame(() => panel.current?.focus({ preventScroll: false }));
  };

  const patch = async (body: Parameters<ReturnType<typeof storiesApi>["patchOnboarding"]>[1]) => {
    const next = await storiesApi().patchOnboarding(ws, body);
    setOnboarding(ws, next);
    return next;
  };

  const skip = async () => {
    setBusy(true);
    try {
      await patch({ step, skipped: true });
      toast.success("Skipped. It stays on the list for later.");
      go(nextStep(step));
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const afterSave = async () => {
    await ob.reload();
    void ai.reload();
    void refreshDashboard(ws).catch(() => undefined);
    go(nextStep(step));
  };
  // Steps 2 and 3: the saved AI setup (with its new version) is what the next step starts from at once, never the one
  // from before the save while the reload is on its way (a stale version would be refused).
  const afterAiSave = (next: StoriesAiConfig) => {
    ai.setData((prev) => (prev ? { ...prev, ai: next } : prev));
    void afterSave();
  };

  if (ob.error && !data)
    return (
      <section className="st-page st-setup">
        <h1 className="st-head__title">Set up Lamo Stories</h1>
        <StError message={ob.error} onRetry={() => void ob.reload()} />
      </section>
    );
  if (!data)
    return (
      <section className="st-page st-setup">
        <h1 className="sr-only">Set up Lamo Stories</h1>
        <StLoading label="Getting the setup ready…" />
      </section>
    );

  const i = SETUP_ORDER.indexOf(step);
  const back = i > 0 ? () => go(SETUP_ORDER[i - 1]!) : null;
  const skipFn = step === "done" || state === "done" ? null : () => void skip();

  let body: ReactNode;
  let foot: ReactNode;
  switch (step) {
    case "ai":
      body = (
        <>
          <p className="st-setup__text">
            Lamo Stories is its own studio inside Clip Factory, with its own AI helpers, its own settings and its own social accounts. Nothing you set
            here changes Clip Factory.
          </p>
          <ul className="st-setup__facts">
            <li>
              <StIcon name="bulb" size={20} />
              An AI model writes each story, gives ideas and checks driving-safety facts against checked advice.
            </li>
            <li>
              <StIcon name="clapper" size={20} />A video maker draws and animates it. That is a separate choice.
            </li>
            <li>
              <StIcon name="sliders" size={20} />
              You pick the model and how hard it thinks. Nothing is swapped behind your back.
            </li>
          </ul>
        </>
      );
      foot = (
        <StButton main onClick={() => go("model")}>
          Next
          <StIcon name="chevron" size={18} />
        </StButton>
      );
      break;
    case "model":
    case "effort":
      body =
        ai.error && !ai.data ? (
          <StError message={ai.error} onRetry={() => void ai.reload()} />
        ) : !ai.data ? (
          <StLoading label="Reading the models…" />
        ) : step === "model" ? (
          <ModelStep key={`m${ai.data.ai.version}`} ws={ws} ai={ai.data} busy={busy} setBusy={setBusy} onSaved={afterAiSave} />
        ) : (
          <EffortStep key={`e${ai.data.ai.version}`} ws={ws} ai={ai.data} busy={busy} setBusy={setBusy} onSaved={afterAiSave} />
        );
      foot = state === "done" ? <NextButton onClick={() => go(nextStep(step))} /> : null;
      break;
    case "video":
      body = <VideoStep ws={ws} busy={busy} setBusy={setBusy} onSaved={() => void afterSave()} />;
      foot = state === "done" ? <NextButton onClick={() => go(nextStep(step))} /> : null;
      break;
    case "agents":
      body = <AgentsStep ws={ws} />;
      foot = (
        <StButton
          main
          disabled={busy}
          onClick={async (e) => {
            const el = e.currentTarget;
            setBusy(true);
            try {
              if (state !== "done") {
                await patch({ step: "agents", done: true });
                celebrate(centerOf(el));
              }
              go(nextStep(step));
            } catch (err) {
              toast.error(friendlyMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <StIcon name="check" size={18} />
          {state === "done" ? "Next" : "Got it"}
        </StButton>
      );
      break;
    case "done":
      body = data.finishedAt ? (
        <div className="st-setup__done">
          <StMascot mood="cheer" size={120} />
          <p className="st-setup__text">Lamo Stories is set up. Have fun making videos!</p>
        </div>
      ) : (
        <div className="st-setup__done">
          <StMascot mood="cheer" size={120} tone="mint" />
          <p className="st-setup__text">
            {left.length
              ? `You can start making videos now. ${left.length === 1 ? "One thing is" : `${left.length} things are`} still on the list; the dashboard keeps it until you finish.`
              : "Everything is set up. Tap Finish!"}
          </p>
        </div>
      );
      foot = data.finishedAt ? (
        <StLinkButton href="/stories" main>
          Go to the dashboard
          <StIcon name="chevron" size={18} />
        </StLinkButton>
      ) : (
        <StButton
          main
          disabled={busy}
          onClick={async (e) => {
            const el = e.currentTarget;
            setBusy(true);
            try {
              await patch({ finish: true });
              starBurst(centerOf(el), 140);
              storiesSound("success");
              toast.success("Lamo Stories is set up!");
              void refreshDashboard(ws).catch(() => undefined);
              setTimeout(() => storiesGoLater("/stories"), 1400);
            } catch (err) {
              toast.error(friendlyMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <StIcon name="check" size={18} />
          Finish
        </StButton>
      );
      break;
    default:
      body = <ConnectStep ws={ws} platform={step as Platform} />;
      foot = <NextButton onClick={() => go(nextStep(step))} main={state === "done"} />;
  }

  return (
    <section className="st-page st-setup" data-step={step}>
      <header className="st-setup__head">
        <StRing done={data.done} total={data.total} size={96} />
        <div className="st-setup__intro">
          <h1 className="st-head__title">Set up Lamo Stories</h1>
          <p className="st-head__lede">
            {data.done} of {data.total} done. Skip anything you do not need yet: making videos never waits for it.
          </p>
        </div>
        <StLinkButton href="/stories" className="st-setup__later">
          Do this later
        </StLinkButton>
      </header>

      <div className="st-setup__grid">
        <nav className="st-steps" aria-label="Setup steps">
          <ol className="st-steps__list">
            <Glide active=".st-steps__item.is-on" className="glide--st-steps" as="li" />
            {data.steps.map((s, n) => (
              <li key={s.step}>
                <button
                  type="button"
                  className={`st-steps__item is-${s.state}${s.step === step ? " is-on" : ""}`}
                  aria-current={s.step === step ? "step" : undefined}
                  onClick={() => go(s.step)}
                >
                  <span className="st-steps__mark" aria-hidden="true">
                    {s.state === "done" ? <StIcon name="check" size={18} /> : n + 1}
                  </span>
                  <span className="st-steps__label">{s.label}</span>
                  <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "skipped" ? " (skipped)" : ""}</span>
                  {s.state === "skipped" ? <span className="st-steps__skipped">Later</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="st-setup__panel" ref={panel} tabIndex={-1} aria-labelledby="st-setup-step">
          <p className="st-setup__count">
            Step {i + 1} of {SETUP_ORDER.length}
            {state === "done" ? (
              <span className="st-chip st-chip--mint">Done</span>
            ) : state === "skipped" ? (
              <span className="st-chip st-chip--sun">Skipped for now</span>
            ) : null}
          </p>
          <h2 className="st-setup__title" id="st-setup-step">
            <StIcon name={ICON[step]} size={24} />
            {WORDS[step].title}
          </h2>
          <p className="st-setup__lede">{WORDS[step].lede}</p>
          <div className="st-setup__body">{body}</div>
          <Foot step={step} busy={busy} onBack={back} onSkip={skipFn}>
            {foot}
          </Foot>
        </div>
      </div>

      {left.length ? (
        <section className="st-left" aria-labelledby="st-left-title">
          <h2 className="st-left__title" id="st-left-title">
            What is left
          </h2>
          <ul className="st-left__list">
            {left.map((s) => (
              <li key={s.step}>
                <button type="button" className="st-left__item" onClick={() => go(s.step)}>
                  <StIcon name={ICON[s.step]} size={18} />
                  {s.label}
                  {s.state === "skipped" ? <span className="st-left__tag">skipped</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function NextButton({ onClick, main = true }: { onClick: () => void; main?: boolean }) {
  return (
    <StButton main={main} onClick={onClick}>
      Next
      <StIcon name="chevron" size={18} />
    </StButton>
  );
}
