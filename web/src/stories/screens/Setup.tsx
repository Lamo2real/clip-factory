// Lamo Stories › Set up Lamo Stories (docs/CONTRACTS.md §45.29, §45.33): the first-time onboarding. It opens by
// itself the first time Lamo Stories opens (StoriesApp), and from the dashboard until it is finished. Eleven steps,
// each one skippable and doable later: 1 set up the AI, 2 the default model (with Check models), 3 the default effort,
// 4 how videos are made, 5 meet the agents and skills, 6 to 10 connect Instagram, TikTok, YouTube, Facebook and X
// (each with the same card as Social accounts), 11 done (confetti). A ring shows "4 of 11 done" and the list of
// what is left. Making videos never waits for the social steps.
//
// The ticks come from the server (§45.34): step 1 once Check models ran or the owner tapped "These look right" (step 1
// shows the models and their state), step 2 once he picked the default model, step 3 the default effort (each sent
// as PUT …/ai `picked`), 4 when a video provider is picked, 6 to 10 when that platform is connected (an account that
// is Lamo Clips' own is not); only 5 and 11 are ticked here by hand. Step 2 never saves an effort the owner did not
// pick: a model that does not offer the current effort is held until he picks one in step 3, then both are saved.
//
// Kid-proof words (the owner, 23 Nov: "less text … even an 8 year old should be able to use the app"): each step a
// short title, one plain line, at most a few short sentences, and its one main button; nothing said twice (the ring
// already says how far, a connect step's card already says to use Clips Funded's own account).
import "../styles/social.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { Glide } from "../../components/Glide.tsx";
import { storiesGoLater } from "../pane.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesSound } from "../prefs.ts";
import { storiesApi } from "../api/client.ts";
import { EFFORT_LABEL, type Effort, type ModelInfo, type Onboarding, type OnboardStep, type Platform, type SocialAccount, type StoriesAiConfig, type StoriesConfig } from "../api/types.ts";
import { madeBy, MODEL_STATUS } from "../settings/bits.tsx";
import { aiBody } from "../settings/data.ts";
import { ArcDial, GlassPill } from "../glass/index.ts";
import {
  celebrate,
  centerOf,
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

export function modelLine(m: ModelInfo): string {
  // Who makes it and who runs it ("Anthropic on Amazon Bedrock", §45.35 D8).
  const who = `${madeBy(m)}${m.custom ? " · Added by you" : ""}`;
  if (m.status === "ok") return `${who} · Works: it answered.`;
  if (m.status === "not_checked") return `${who} · Not checked yet.`;
  return `${who} · ${m.statusLine}`;
}

/** Check models from the setup: one tiny real call per model, followed until it finishes; then the fresh models. */
function useCheckModels(ws: string, start: ModelInfo[], onChecked?: (models: ModelInfo[]) => void) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState(start);
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
      onChecked?.(fresh.models);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setChecking(false);
    }
  };
  return { checking, models, check };
}

function CheckRow({ checking, busy, onCheck }: { checking: boolean; busy: boolean; onCheck: () => void }) {
  return (
    <div className="st-setup__row">
      <StButton disabled={checking || busy} onClick={onCheck}>
        <StIcon name="retry" size={18} />
        {checking ? "Checking every model…" : "Check models"}
      </StButton>
      <span className="st-setup__hint">Sends each model one tiny real question.</span>
    </div>
  );
}

/** The same words as Settings › AI (§45.36 E17: one set everywhere). */
const STATE_CHIP: Record<ModelInfo["status"], { label: string; tone: string }> = MODEL_STATUS;

/** Step 1: what Lamo Stories uses, the models and their state, Check models, and "These look right" (§45.34). */
function EnvironmentStep({ ws, ai, onSaved, onChecked, busy, setBusy }: { ws: string; ai: Ai; onSaved: (next: StoriesAiConfig) => void; onChecked: (models: ModelInfo[]) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const { checking, models, check } = useCheckModels(ws, ai.models, onChecked);
  return (
    <>
      <p className="st-setup__text">Clips Funded is its own studio. Nothing you set here changes Clip Factory.</p>
      <ul className="st-setup__facts">
        <li>
          <StIcon name="bulb" size={20} />
          An AI model writes each story and checks the safety facts.
        </li>
        <li>
          <StIcon name="clapper" size={20} />A video maker draws and moves it. You pick that later.
        </li>
        <li>
          <StIcon name="sliders" size={20} />
          You pick the model and how hard it thinks. Nothing swaps by itself.
        </li>
      </ul>
      <h3 className="st-setup__sub">Your AI models</h3>
      <ul className="st-setup__models" aria-label="The AI models and their state">
        {models.map((m) => (
          <li key={m.key} className="st-setup__model" data-status={m.status}>
            <span className="st-setup__model-name">{m.label}</span>
            <span className={`st-chip st-chip--${STATE_CHIP[m.status].tone}`}>{STATE_CHIP[m.status].label}</span>
            <span className="st-setup__model-line">{modelLine(m)}</span>
          </li>
        ))}
      </ul>
      <CheckRow checking={checking} busy={busy} onCheck={() => void check()} />
      <SaveBar
        busy={busy}
        label="These look right"
        onSave={async (el) => {
          setBusy(true);
          try {
            const next = await storiesApi().putAi(ws, aiBody(ai.ai, ai.ai.version, ["environment"]));
            celebrate(centerOf(el));
            toast.success("Great! Next, pick the model Clips Funded uses most.");
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

/** Step 2: the default model (with Check models), saved to Lamo Stories' own AI setup with `picked: ["model"]`. */
function ModelStep({
  ws,
  ai,
  onSaved,
  onHold,
  onChecked,
  busy,
  setBusy,
}: {
  ws: string;
  ai: Ai;
  onSaved: (next: StoriesAiConfig) => void;
  /** the model does not offer the current effort: it waits for the owner's own pick in step 3 */
  onHold: (key: string) => void;
  onChecked: (models: ModelInfo[]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const toast = useToast();
  const [pick, setPick] = useState(ai.ai.defaultModel);
  const { checking, models, check } = useCheckModels(ws, ai.models, onChecked);
  const chosen = models.find((m) => m.key === pick);
  const needsLevel = !!chosen && chosen.efforts.length > 0 && !chosen.efforts.includes(ai.ai.defaultEffort);

  const save = async (el: HTMLElement) => {
    if (!chosen) return;
    // Never an effort the owner did not pick: a model without today's level waits for his pick in the next step.
    if (needsLevel) {
      onHold(chosen.key);
      return;
    }
    setBusy(true);
    try {
      const next = await storiesApi().putAi(ws, aiBody({ ...ai.ai, defaultModel: chosen.key }, ai.ai.version, ["model"]));
      celebrate(centerOf(el));
      toast.success(`${chosen.label} is Clips Funded's default model now.`);
      onSaved(next);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="st-setup__text">It also checks the facts. Clip Factory keeps its own model.</p>
      <StPick<string>
        label="Clips Funded's default model"
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
      {needsLevel ? (
        <p className="st-note st-note--sun" role="note">
          <StIcon name="sliders" size={18} />
          {chosen.label} does not offer {EFFORT_LABEL[ai.ai.defaultEffort]}.
        </p>
      ) : null}
      <CheckRow checking={checking} busy={busy} onCheck={() => void check()} />
      <SaveBar busy={busy} label={chosen ? (needsLevel ? `Use ${chosen.label}: pick its level next` : `Use ${chosen.label}`) : "Use this model"} onSave={save} />
    </>
  );
}

/** Step 3: the default effort (`picked: ["effort"]`), or the held model with the level the owner picks for it. */
function EffortStep({ ws, ai, held, onSaved, busy, setBusy }: { ws: string; ai: Ai; held: string | null; onSaved: (next: StoriesAiConfig) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const model = ai.models.find((m) => m.key === (held ?? ai.ai.defaultModel));
  const offers = model?.efforts ?? [];
  // A held model starts with nothing picked: the owner chooses its level himself.
  const [pick, setPick] = useState<Effort | null>(held ? null : offers.includes(ai.ai.defaultEffort) ? ai.ai.defaultEffort : (model?.defaultEffort ?? offers[0] ?? "high"));
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
              const next = await storiesApi().putAi(ws, aiBody(ai.ai, ai.ai.version, ["effort"]));
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
      {held && model ? (
        <p className="st-note st-note--sun" role="note">
          <StIcon name="sliders" size={18} />
          {model.label} does not offer {EFFORT_LABEL[ai.ai.defaultEffort]}. Pick its level, then both are saved.
        </p>
      ) : null}
      <p className="st-setup__text">Higher is slower and costs more. It is best for storyboards and fact checks.</p>
      <StPick<Effort>
        label="Clips Funded's default effort"
        value={(pick ?? "") as Effort}
        options={offers.map((e) => ({ value: e, label: EFFORT_LABEL[e], line: e === model?.defaultEffort ? "The model's own" : undefined }))}
        onChange={setPick}
      />
      <SaveBar
        busy={busy}
        label={pick ? `Use ${EFFORT_LABEL[pick]}` : "Pick a level first"}
        off={!pick}
        onSave={async (el) => {
          if (!pick || !model) {
            toast.error("Pick a level first.");
            return;
          }
          setBusy(true);
          try {
            const next = await storiesApi().putAi(ws, aiBody({ ...ai.ai, defaultModel: model.key, defaultEffort: pick }, ai.ai.version, held ? ["model", "effort"] : ["effort"]));
            celebrate(centerOf(el));
            toast.success(held ? `${model.label} at ${EFFORT_LABEL[pick]} is your default now.` : `Effort set to ${EFFORT_LABEL[pick]}.`);
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

function SaveBar({ busy, label, onSave, off = false }: { busy: boolean; label: string; onSave: (el: HTMLElement) => void | Promise<void>; off?: boolean }) {
  return (
    <div className="st-setup__save">
      <StButton
        main
        disabled={busy}
        aria-disabled={off || undefined}
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

/** Step 4's line for the built-in animator: it makes every shape (§45.34 "Video size and shape", §45.35 D21). */
export const BUILTIN_LINE = "On. Cartoons drawn right here, tall, square or wide, 30 frames a second.";

/** Step 4: how videos are made (the video provider, §45.31), saved in the workspace's own settings. */
function VideoStep({ ws, onSaved, busy, setBusy }: { ws: string; onSaved: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const toast = useToast();
  const w = useLoad(() => storiesApi().getWorkspace(ws), ws, "st-setup-ws");
  const providers = useLoad(() => storiesApi().providers(ws).catch(() => []), ws, "st-setup-providers");
  const config = (w.data?.configuration ?? null) as StoriesConfig | null;
  const [pick, setPick] = useState<StoriesConfig["providers"]["video"] | null>(null);
  const value = pick ?? config?.providers.video ?? "builtin-2d";
  // §45.37 G7: Amazon ended Nova Reel on 30 Sep 2026, so it is never offered; Luma AI Ray2 makes the AI cut-aways.
  const luma = providers.data?.find((p) => p.id === "luma-ray");
  const ended = value === "nova-reel";
  if (w.error && !w.data) return <StError message={w.error} onRetry={() => void w.reload()} />;
  if (!config) return <StLoading label="Reading the video settings…" />;
  return (
    <>
      <p className="st-setup__text">The AI writes the story. The video maker draws and moves it.</p>
      <StPick<StoriesConfig["providers"]["video"]>
        label="How videos are made"
        stack
        value={value}
        options={[
          { value: "builtin-2d", label: "Built-in animation", line: BUILTIN_LINE },
          { value: "luma-ray", label: "Luma AI Ray2 (AI video)", line: "AI cut-aways (scenes with no character), 5 seconds a shot. Runs in the US (Oregon). It needs its own setup first." },
        ]}
        onChange={setPick}
      />
      {/* An older Nova Reel pick: the ended note below says it all (it never gets ready again, §45.37 G7). */}
      {value === "luma-ray" && luma?.state !== "on" ? (
        <p className="st-note st-note--sun" role="note">
          <StIcon name="alert" size={18} />
          {luma?.line && /\bis not ready yet\b/.test(luma.line) ? `${luma.line} ` : "Luma AI Ray2 is not ready yet. "}
          Until then, new videos, remakes and changes stop. Nothing switches by itself. Pick Built-in animation above to keep making videos. To make it
          ready, tap Try it in Settings › Video: it makes one 5-second test shot. Its posts get the platforms' AI labels.
        </p>
      ) : null}
      {ended ? (
        <div role="status">
          <p className="st-note st-note--coral">
            <StIcon name="alert" size={18} />
            Amazon Nova Reel: Ended by Amazon on 30 Sep 2026. It cannot make videos any more. Pick another way below: nothing switches by itself.
          </p>
          <div className="st-setup__row">
            <StButton main onClick={() => setPick("luma-ray")}>
              Use Luma AI Ray2
            </StButton>
            <StButton quiet onClick={() => setPick("builtin-2d")}>
              Use Built-in animation
            </StButton>
          </div>
        </div>
      ) : null}
      <SaveBar
        busy={busy}
        label="Use this"
        onSave={async (el) => {
          // An ended maker is never saved again: the API would keep an older pick, and nothing could make a video.
          if (ended) {
            toast.error("Amazon Nova Reel has ended. Pick another video maker above.");
            return;
          }
          setBusy(true);
          try {
            // Only the video maker and its model (the maker's first): the API checks only what the body names (§45.37 G1).
            await storiesApi().patchWorkspace(ws, { configuration: { providers: { video: value, videoModel: null } }, version: w.data!.version });
            celebrate(centerOf(el));
            toast.success(value === "builtin-2d" ? "Videos are made with the built-in animation." : "Saved. Luma AI Ray2 works once its setup is finished.");
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
      <p className="st-setup__text">They work on every video. Change them in Settings › Agents.</p>
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

/**
 * Steps 6 to 10: the platform's card, the same as on Social accounts (its app choice, keys and Connect). `line`: the
 * onboarding's own reason the step stays to do (the account is Clip Factory's own, §45.35 D11), said only where the
 * card does not say it already (the card says why for an account that reads same_as_clips).
 */
function ConnectStep({ ws, platform, line }: { ws: string; platform: Platform; line?: string | undefined }) {
  const social = useSocial(ws);
  // The developer app the account used, for the right sentence after a Disconnect (§45.34).
  const [gone, setGone] = useState<{ choice: SocialAccount["app"]["choice"] } | null>(null);
  if (social.error && !social.data) return <StError message={social.error} onRetry={() => void social.reload()} />;
  if (!social.data) return <StLoading label="Checking the account…" />;
  const a = social.data.accounts.find((x) => x.platform === platform);
  if (!a) return <StError message="We could not find that account. Open Social accounts." />;
  return (
    <>
      {/* The card below says up front to use a new account, never Clip Factory's (§45.37 G8), and why an account that
          is Clip Factory's own is stopped; the step's foot has Skip for now: each once, so the step does not say them
          again. */}
      {gone ? <DisconnectedNote choice={gone.choice} onClose={() => setGone(null)} /> : null}
      {line && a.connectionStatus !== "same_as_clips" ? (
        <p className="st-note st-note--coral" role="note">
          <StIcon name="alert" size={18} />
          {line}
        </p>
      ) : null}
      <ul className="st-conns st-conns--one">
        <PlatformCard
          inStep
          ws={ws}
          a={a}
          all={social.data.accounts}
          clips={social.data.clips.find((c) => c.platform === platform)}
          onChanged={social.reload}
          onDisconnected={(_p, choice) => setGone({ choice })}
        />
      </ul>
    </>
  );
}

const WORDS: Record<OnboardStep, { title: string; lede: string }> = {
  ai: { title: "Set up the AI", lede: "What Clips Funded uses, and why." },
  model: { title: "Pick your default model", lede: "The AI that writes your stories." },
  effort: { title: "Pick your default effort", lede: "How hard the model thinks." },
  video: { title: "Pick how videos are made", lede: "The video maker, apart from the AI models." },
  agents: { title: "Meet your agents and skills", lede: "The five helpers of your studio." },
  instagram: { title: "Connect Instagram", lede: "Clips Funded's own Instagram account." },
  tiktok: { title: "Connect TikTok", lede: "Clips Funded's own TikTok account." },
  youtube: { title: "Connect YouTube", lede: "Clips Funded's own YouTube channel." },
  facebook: { title: "Connect Facebook", lede: "Clips Funded's own Facebook Page." },
  x: { title: "Connect X", lede: "Clips Funded's own X account." },
  done: { title: "Done", lede: "Your studio is ready." },
};

export function SetupScreen({ ws }: StoriesScreenProps) {
  const toast = useToast();
  const ob = useOnboarding(ws);
  const ai = useLoad(() => storiesApi().getAi(ws), ws, "st-setup-ai");
  const [at, setAt] = useState<OnboardStep | null>(null);
  const [busy, setBusy] = useState(false);
  // Step 2's model, waiting for the owner's own effort in step 3 (nothing is saved until then).
  const [held, setHeld] = useState<string | null>(null);
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
    setHeld(null);
    ai.setData((prev) => (prev ? { ...prev, ai: next } : prev));
    void afterSave();
  };
  // Check models ticks step 1 (§45.34): the ring follows, and the next steps start from the models' fresh states (a
  // model Bedrock just refused says so in step 2).
  const afterCheck = (models: ModelInfo[]) => {
    ai.setData((prev) => (prev ? { ...prev, models } : prev));
    void ob.reload();
    void refreshDashboard(ws).catch(() => undefined);
  };

  if (ob.error && !data)
    return (
      <section className="st-page st-setup">
        <h1 className="st-head__title">Set up Clips Funded</h1>
        <StError message={ob.error} onRetry={() => void ob.reload()} />
      </section>
    );
  if (!data)
    return (
      <section className="st-page st-setup">
        <h1 className="sr-only">Set up Clips Funded</h1>
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
    case "model":
    case "effort":
      body =
        ai.error && !ai.data ? (
          <StError message={ai.error} onRetry={() => void ai.reload()} />
        ) : !ai.data ? (
          <StLoading label="Reading the models…" />
        ) : step === "ai" ? (
          <EnvironmentStep key={`a${ai.data.ai.version}`} ws={ws} ai={ai.data} busy={busy} setBusy={setBusy} onSaved={afterAiSave} onChecked={afterCheck} />
        ) : step === "model" ? (
          <ModelStep
            key={`m${ai.data.ai.version}`}
            ws={ws}
            ai={ai.data}
            busy={busy}
            setBusy={setBusy}
            onSaved={afterAiSave}
            onChecked={afterCheck}
            onHold={(key) => {
              setHeld(key);
              go("effort");
            }}
          />
        ) : (
          <EffortStep key={`e${ai.data.ai.version}${held ?? ""}`} ws={ws} ai={ai.data} held={held} busy={busy} setBusy={setBusy} onSaved={afterAiSave} />
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
          <p className="st-setup__text">Clips Funded is set up. Have fun making videos!</p>
        </div>
      ) : (
        <div className="st-setup__done">
          <StMascot mood="cheer" size={120} tone="mint" />
          <p className="st-setup__text">
            {left.length
              ? `You can make videos now. ${left.length === 1 ? "One thing is left" : `${left.length} things are left`}: the dashboard keeps ${left.length === 1 ? "it" : "them"} for you.`
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
              toast.success("Clips Funded is set up!");
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
      body = <ConnectStep ws={ws} platform={step as Platform} line={data.steps.find((s) => s.step === step)?.line} />;
      foot = <NextButton onClick={() => go(nextStep(step))} main={state === "done"} />;
  }

  return (
    <section className="st-page st-setup" data-step={step}>
      {/* The hero: the setup's ring (the ArcDial: an orange arc, its white knob, a big light numeral), the title and
          what it means. It keeps the name st-ring, the setup's ring as before. */}
      <header className="st-setup__head st-glass st-glass--hero st-lens">
        <ArcDial className="st-ring st-setup__dial" value={data.done} max={data.total} label={`${data.done} of ${data.total} done`} valueText={`${data.done} of ${data.total} done`}>
          <span className="st-setup__dial-num st-num">{data.done}</span>
          <span className="st-setup__dial-of">of {data.total}</span>
        </ArcDial>
        <h1 className="st-head__title st-setup__heading st-display">Set up Clips Funded</h1>
        <p className="st-head__lede st-setup__intro">
          {data.done} of {data.total} done. Skip any step: videos never wait for it.
        </p>
        <StLinkButton href="/stories" className="st-setup__later">
          Do this later
        </StLinkButton>
      </header>

      <div className="st-setup__grid">
        <nav className="st-steps" aria-label="Setup steps">
          <ol className="st-steps__list st-glass">
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

        <div className="st-setup__panel st-glass" ref={panel} tabIndex={-1} aria-labelledby="st-setup-step">
          <p className="st-setup__count">
            <span className="st-caps">
              Step {i + 1} of {SETUP_ORDER.length}
            </span>
            {state === "done" ? (
              <span className="st-chip st-chip--mint">Done</span>
            ) : state === "skipped" ? (
              <span className="st-chip st-chip--sun">Skipped for now</span>
            ) : null}
          </p>
          <h2 className="st-setup__title" id="st-setup-step">
            <span className="st-setup__title-icon" aria-hidden="true">
              <StIcon name={ICON[step]} size={22} />
            </span>
            <span className="st-display">{WORDS[step].title}</span>
          </h2>
          <p className="st-setup__lede">{WORDS[step].lede}</p>
          <div className="st-setup__body">{body}</div>
          <Foot step={step} busy={busy} onBack={back} onSkip={skipFn}>
            {foot}
          </Foot>
        </div>

        {/* What is left: glass pills, one tap back to each step (in the grid, under the steps). None is cream: the step
            list already marks the open step, so one choice has one cream marker. */}
        {left.length ? (
          <section className="st-left st-glass" aria-labelledby="st-left-title">
            <h2 className="st-left__title st-display" id="st-left-title">
              What is left
            </h2>
            <ul className="st-left__list">
              {left.map((s) => (
                <li key={s.step}>
                  <GlassPill
                    className="st-left__item"
                    icon={<StIcon name={ICON[s.step]} size={18} />}
                    onClick={() => go(s.step)}
                  >
                    <span className="st-left__label">{s.label}</span>
                    {s.state === "skipped" ? <span className="st-left__tag">skipped</span> : null}
                  </GlassPill>
                </li>
              ))}
            </ul>
            {/* A platform held because its account is Lamo Clips' own says why, in the server's words (§45.35 D11). */}
            {left.some((s) => s.line) ? (
              <ul className="st-left__why">
                {left
                  .filter((s) => s.line)
                  .map((s) => (
                    <li key={s.step} className="st-note st-note--coral">
                      <StIcon name="alert" size={18} />
                      {s.line}
                    </li>
                  ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
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
