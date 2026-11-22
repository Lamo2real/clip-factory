// One platform's setup page (docs/CONTRACTS.md §17.1): Get ready, Make your {Platform} key, Connect, Go public,
// each a checklist of big numbered steps that reopens at the first step not done; then "When it's done".
// Connect runs in the same tab and comes back here with ?result=…, read once and removed from the address.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { ConnectResult, Platform, ReviewState, YoutubePrivacy } from "../../../api/types.ts";
import { useSession } from "../../../app/session.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { PlatformMark } from "../../../components/PlatformMark.tsx";
import { ProgressRing } from "../../../components/ProgressRing.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button, ErrorPanel, LinkButton, Segmented, Skeleton } from "../../../components/ui.tsx";
import { backLabel, backLink, parseBack, type BackLink } from "../../../lib/backLink.ts";
import { burst } from "../../../lib/confetti.ts";
import { useAction } from "../../../lib/motion.ts";
import { config } from "../../../lib/config.ts";
import { X_MONTHLY_USD } from "../../../lib/metrics.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { useHash } from "../../../lib/router.ts";
import { progressOf, stepDone } from "../../../lib/setupProgress.ts";
import { cheerOnNextTap } from "../../../lib/sound.ts";
import { sounds } from "../../../lib/sounds.ts";
import {
  allSteps,
  checkedOnText,
  gateLine,
  GUIDES,
  isResultCode,
  resolveValue,
  resultCopy,
  resultStep,
  stepNumber,
  timeLine,
  YOUTUBE_PRIVACY_LABEL,
  type GuideStep,
} from "../../../setup/index.ts";
import { Rich } from "./bits.tsx";
import { ChooseAccount } from "./ChooseAccount.tsx";
import { CheckIt, KeyForm } from "./KeyForm.tsx";
import { StepCard } from "./StepCard.tsx";
import { useConnecting } from "./useConnecting.ts";
import { useSetup } from "./useSetup.ts";
import { VerificationUpload } from "./VerificationUpload.tsx";

/** The X leaf (§16.8): what X costs, from the shared constant mirroring platforms.json. */
const xLeaf = `X charges a little for every number check. Clip Factory stops at $${X_MONTHLY_USD} a month.`;

/** Reads `?result=` once and takes it out of the address, so a reload does not celebrate again. */
function takeResult(): ConnectResult | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  const code = q.get("result");
  if (!q.has("result")) return null;
  q.delete("result");
  const rest = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return isResultCode(code) ? code : "error";
}

/**
 * `?back=` (§39.1): the page the owner came from. It is kept for this tab while the platform's own sign-in runs, so
 * the page still knows the way back when the platform sends him here again with `?result=`.
 */
function takeBack(platform: Platform): BackLink | null {
  if (typeof location === "undefined") return null;
  const key = `cf-setup-back:${platform}`;
  const here = backLink(location.search);
  try {
    if (here) sessionStorage.setItem(key, here.href);
    else if (new URLSearchParams(location.search).has("result")) return parseBack(sessionStorage.getItem(key) ?? "");
    else sessionStorage.removeItem(key);
  } catch {
    /* no storage: the way back holds for this visit only */
  }
  return here;
}

export function SetupPlatform({ platform }: { platform: Platform }) {
  const [back] = useState(() => takeBack(platform));
  const guide = GUIDES[platform];
  const { data, error, reload, put } = useSetup();
  const setup = data?.platforms.find((p) => p.platform === platform) ?? null;
  const values = data?.values ?? null;
  const callbackBase = useMemo(() => {
    try {
      return config().oauthCallbackBase;
    } catch {
      return undefined;
    }
  }, []);
  const toast = useToast();
  const { me, saveSettings } = useSession();
  const hash = useHash();
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const celebrated = useRef(false);
  const cancelCheer = useRef<(() => void) | null>(null);
  const scrolledTo = useRef<string | null>(null);
  // Kept here: Disconnect plays at the tap and rewinds if Undo is tapped (§20.7).
  const disconnectAct = useAction("disconnect");

  // Stops by itself in the desktop app, where the platform opens in the system browser and this page stays.
  const { connecting, start: startConnecting, opened: openedPlatform, stop: stopConnecting } = useConnecting(setup?.account);
  const progress = progressOf(guide, setup);
  const reconnect = setup?.account.status === "needs_reconnect";
  const choosing = setup?.account.status === "choose_account" && (setup.account.choices?.length ?? 0) > 0;
  // The step whose main action is the vermilion button: the current one, unless the account needs connecting again.
  // With a way back (§39.1), once the platform is connected the back button is the next step.
  const backMain = !!back && setup?.account.status === "connected";
  const mainStep = reconnect || choosing || backMain ? null : (progress.current?.id ?? null);

  // ?result= from the platform: read once on arrival.
  useEffect(() => {
    const code = takeResult();
    if (!code) return;
    setResult(code);
    if (code !== "connected" && code !== "choose") sounds.play("deny");
    window.scrollTo({ top: 0 });
  }, []);

  // Back from the platform: on a small phone the header fills the first screen, so the answer (the result card or
  // the account picker) is brought into view instead of waiting below the fold.
  const shownResult = useRef(false);
  useEffect(() => {
    if (!result || !setup || shownResult.current) return;
    const t = setTimeout(() => {
      const card = document.querySelector<HTMLElement>(".setup-page .result-card, .setup-page .choose");
      if (!card) return;
      shownResult.current = true;
      // The phone's bottom bar covers the last ~110 px.
      const r = card.getBoundingClientRect();
      if (r.top >= 0 && r.top + Math.min(r.height, 220) <= window.innerHeight - 110) return;
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 96), behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [result, setup, choosing]);

  // Connected: confetti and a toast (once the account's name is known). The page has just loaded after the
  // platform sent the owner back, so the success sound waits for their first tap (sounds only ever answer a tap).
  useEffect(() => {
    if (result !== "connected" || !setup || celebrated.current) return;
    celebrated.current = true;
    burst(undefined, 140);
    toast.success(resultCopy(platform)[result]);
    cancelCheer.current = cheerOnNextTap(sounds);
  }, [result, setup, platform, toast]);
  useEffect(() => () => cancelCheer.current?.(), []);

  // Resume where the owner left off: bring the current step into view (once per step), or an apple's anchor.
  const currentId = progress.current?.id ?? null;
  // #step-{id}: Ask's "Open step N" button (docs/CONTRACTS.md §28.4). Only a step of this guide counts.
  const stepAnchor = hash?.startsWith("step-") && guide && allSteps(guide).some((s) => `step-${s.id}` === hash) ? hash.slice(5) : null;
  useEffect(() => {
    if (!setup || result) return;
    // A fresh page stays at the top, so the owner sees which platform this is and how long it takes.
    const target =
      hash && (["youtube-privacy", "x-cost"].includes(hash) || stepAnchor) ? hash : currentId && progress.done > 0 ? `step-${currentId}` : null;
    if (!target || scrolledTo.current === target) return;
    // Marked as done only when the scroll really runs: a refetch inside the delay must not cancel it for good.
    const t = setTimeout(() => {
      scrolledTo.current = target;
      document.getElementById(target)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, 160);
    return () => clearTimeout(t);
  }, [setup, currentId, hash, result, progress.done, stepAnchor]);

  // An anchor (#youtube-privacy, #x-cost, or #step-{id} from an Ask button) opens the step that holds it.
  const anchorStep = hash === "youtube-privacy" ? "public-privacy" : hash === "x-cost" ? "ready-card" : stepAnchor;

  const isOpen = (step: GuideStep) => {
    if (closed.has(step.id)) return false;
    if (opened.has(step.id) || anchorStep === step.id) return true;
    return !reconnect && progress.current?.id === step.id;
  };

  const toggle = (step: GuideStep) => {
    const now = isOpen(step);
    setOpened((s) => {
      const n = new Set(s);
      if (now) n.delete(step.id);
      else n.add(step.id);
      return n;
    });
    setClosed((s) => {
      const n = new Set(s);
      if (now) n.add(step.id);
      else n.delete(step.id);
      return n;
    });
  };

  /** Opens a step and brings it into view (from a result card's "Go to step N"). */
  const goToStep = (id: string) => {
    setOpened((s) => new Set(s).add(id));
    setClosed((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setTimeout(() => document.getElementById(`step-${id}`)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }), 60);
  };

  /** Keys saved or a file sent: the step ticks itself, and stays open so its result can be seen. */
  function stayOpen(id: string, next: Parameters<typeof put>[0]) {
    setOpened((s) => new Set(s).add(id));
    put(next);
  }

  /** Marks a step done or not; false when the server refused (the page reloads what it has). */
  async function tick(step: GuideStep, done: boolean) {
    if (!setup) return false;
    setBusyStep(step.id);
    // Optimistic: the step folds and the next one opens straight away.
    put({ ...setup, stepsDone: done ? [...setup.stepsDone, step.id] : setup.stepsDone.filter((s) => s !== step.id) });
    setOpened((s) => {
      const n = new Set(s);
      n.delete(step.id);
      return n;
    });
    try {
      put(await api().setSetupStep(platform, step.id, done));
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      void reload();
      return false;
    } finally {
      setBusyStep(null);
    }
  }

  /** Sends the owner to the platform at once; false when that could not start (the error toast says why). */
  async function connect() {
    if (!setup?.keys.saved) {
      toast.info(`Paste your ${guide.name} keys first (step ${stepNumber(guide, "key-paste")}).`);
      return false;
    }
    startConnecting();
    try {
      const { authorizeUrl } = await api().connectAccount(platform);
      // Only the platform's own https page (or the mock's pretend page) is ever opened.
      if (!/^https:\/\//.test(authorizeUrl) && !authorizeUrl.startsWith("/mock-oauth/")) throw new Error("bad authorize url");
      location.assign(authorizeUrl);
      openedPlatform();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      stopConnecting();
      return false;
    }
  }

  function disconnect() {
    setLeaving(true);
    toast.undo(`Disconnecting ${guide.name}…`, {
      onUndo: () => {
        setLeaving(false);
        disconnectAct.rewind();
      },
      onCommit: () => {
        api()
          .disconnectAccount(platform)
          .then(() => reload())
          .catch((e) => toast.error(`${friendlyMessage(e)} ${guide.name} is still connected.`))
          .finally(() => setLeaving(false));
      },
    });
  }

  async function pickReview(state: ReviewState) {
    setReview(state);
    try {
      put(await api().setReviewState(state));
    } catch (e) {
      toast.error(friendlyMessage(e));
    }
  }

  const youtubePrivacy: YoutubePrivacy = me?.settings.youtubePrivacy ?? "public";
  const gate = (key: string) => setup?.gates.find((g) => g.key === key);
  const reviewValue: ReviewState =
    review ?? (gate("app_review")?.state === "ok" ? "live" : gate("app_review")?.state === "waiting" ? "in_review" : "draft");

  /** What only some steps hold: the paste boxes, the upload box, Connect, and the pickers. */
  function extras(step: GuideStep, primary: boolean) {
    if (!setup) return null;
    const out = [];
    if (step.paste)
      out.push(<KeyForm key="keys" platform={platform} setup={setup} primary={primary} onSaved={(s) => stayOpen(step.id, s)} />);
    if (step.upload) out.push(<VerificationUpload key="upload" setup={setup} onChange={(s) => stayOpen(step.id, s)} reload={reload} />);
    if (step.auto === "connected")
      out.push(
        <div className="gstep__connect" key="connect" data-help="setup-connect">
          <Button
            variant={primary ? "primary" : "action"}
            size="lg"
            icon="link"
            act="connect"
            loading={connecting}
            disabled={!setup.keys.saved}
            onClick={() => connect()}
          >
            {`Connect ${guide.name}`}
          </Button>
          {!setup.keys.saved ? (
            <p className="gstep__note">Paste your keys first (step {stepNumber(guide, "key-paste")}). Then this button works.</p>
          ) : setup.account.status === "connected" ? (
            <p className="gstep__note is-ok">
              <Icon name="checkCircle" size={18} />
              Connected as {setup.account.handle ?? setup.account.name ?? guide.name}.
            </p>
          ) : null}
        </div>,
      );
    if (step.gate) {
      const g = gate(step.gate);
      if (g)
        out.push(
          <p className={`gate-line is-${g.state}`} key="gate" role="status">
            <Icon name={g.state === "ok" ? "checkCircle" : g.state === "action" ? "alert" : "info"} size={18} />
            <span>
              <Rich text={gateLine(g, { reviewState: reviewValue, youtubePrivacy, platform })} />
            </span>
          </p>,
        );
    }
    if (step.extra === "youtube-privacy")
      out.push(
        <div className="gstep__picker" id="youtube-privacy" data-help="youtube-privacy" key="privacy" tabIndex={-1}>
          <span className="gstep__picker-label" id="youtube-privacy-name">
            Who can see your YouTube clips
          </span>
          <Segmented<YoutubePrivacy>
            label="Who can see your YouTube clips"
            value={youtubePrivacy}
            options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YOUTUBE_PRIVACY_LABEL[v] }))}
            onChange={(v) => void saveSettings({ youtubePrivacy: v })}
          />
        </div>,
      );
    if (step.extra === "tiktok-review")
      out.push(
        <div className="gstep__picker" key="review">
          <span className="gstep__picker-label">What does TikTok say?</span>
          <Segmented<ReviewState>
            label="What TikTok says about your app"
            value={reviewValue}
            options={[
              { value: "draft", label: "Draft" },
              { value: "in_review", label: "In review" },
              { value: "live", label: "Live" },
              { value: "not_approved", label: "Not approved" },
            ]}
            onChange={(v) => void pickReview(v)}
          />
        </div>,
      );
    if (step.extra === "x-cost")
      out.push(
        <p className="callout callout--info" id="x-cost" data-help="x-cost" key="x-cost" tabIndex={-1}>
          <Icon name="info" size={18} />
          <span>{xLeaf} Posting costs about $1.50 for 100 clips.</span>
        </p>,
      );
    return out.length ? <div className="gstep__extras">{out}</div> : null;
  }

  if (error && !data) return <ErrorPanel message={error} onRetry={() => void reload()} />;

  const name = setup?.account.handle ?? setup?.account.name;
  const copy = resultCopy(platform);

  return (
    <div className="setup-page">
      <header className="setup-head glass" data-help="setup-progress">
        <span className={`setup-head__mark is-${platform}`}>
          <PlatformMark platform={platform} size={34} />
        </span>
        <div className="setup-head__text">
          <h1 className="setup-head__title">Set up {guide.name}</h1>
          <p className="setup-head__meta">{timeLine(guide)}</p>
          <p className="setup-head__checked">
            <Icon name="checkCircle" size={16} />
            {/* The date never splits across two lines ("16 / Nov 2026"). */}
            <span>
              Steps checked on <span className="nowrap">{checkedOnText(guide)}</span>
            </span>
          </p>
        </div>
        <ProgressRing
          value={progress.fraction}
          size={76}
          label={`${guide.name}: ${progress.ready ? "ready" : `${progress.done} of ${progress.total} steps done`}`}
        >
          {/* A percentage, so it never clashes with the step numbers (optional steps do not count). */}
          {progress.ready ? <Icon name="check" size={26} /> : `${Math.round(progress.fraction * 100)}%`}
        </ProgressRing>
      </header>

      {result ? (
        result === "connected" ? (
          <section className="result-card result-card--ok glass" role="status">
            {setup?.account.avatarUrl ? <img className="result-card__avatar" src={setup.account.avatarUrl} alt="" /> : <Icon name="checkCircle" size={34} />}
            <div className="result-card__text">
              <h2 className="result-card__title">
                Connected as <strong className="user-text">{name ?? guide.name}</strong>
              </h2>
              <p>{copy.connected} Clip Factory can post there now.</p>
            </div>
          </section>
        ) : result === "choose" && choosing ? null : (
          <section className="result-card glass" role="alert">
            <Icon name="info" size={28} />
            <div className="result-card__text">
              <h2 className="result-card__title">Not connected yet</h2>
              <p>{copy[result]}</p>
              {resultStep(platform, result) ? (
                <Button size="sm" icon="chevronRight" onClick={() => goToStep(resultStep(platform, result)!)}>
                  {`Go to step ${stepNumber(guide, resultStep(platform, result)!)}`}
                </Button>
              ) : null}
            </div>
          </section>
        )
      ) : null}

      {choosing && setup ? (
        <ChooseAccount
          platform={platform}
          name={guide.name}
          choices={setup.account.choices ?? []}
          onChosen={(next, c) => {
            put(next);
            burst(undefined, 140);
            // This runs inside the owner's tap on an account, so the success sound can play straight away.
            sounds.play("success");
            toast.success(`Connected as ${c.name}.`);
            setResult("connected");
            celebrated.current = true;
          }}
        />
      ) : null}

      {!setup ? (
        <>
          <Skeleton className="setup-skel" />
          <Skeleton className="setup-skel" />
        </>
      ) : (
        guide.parts.map((part) => (
          <section className="setup-part" key={part.id} aria-labelledby={`part-${part.id}`}>
            <h2 className="setup-part__title" id={`part-${part.id}`}>
              {part.title}
            </h2>
            {part.id === "public" && guide.publicNote ? <p className="setup-part__note">{guide.publicNote}</p> : null}
            <ol className="guide-steps">
              {part.steps.map((step) => {
                const primary = mainStep === step.id;
                return (
                  <StepCard
                    key={step.id}
                    step={step}
                    number={stepNumber(guide, step.id)}
                    done={stepDone(step, setup)}
                    open={isOpen(step)}
                    current={progress.current?.id === step.id}
                    primary={primary}
                    copyValue={(v) => resolveValue(v, platform, values, callbackBase)}
                    onToggle={() => toggle(step)}
                    onDone={(d) => tick(step, d)}
                    busy={busyStep === step.id}
                  >
                    {extras(step, primary)}
                  </StepCard>
                );
              })}
            </ol>
          </section>
        ))
      )}

      {setup && (setup.account.status === "connected" || reconnect) ? (
        <section className="done-panel glass" aria-labelledby="done-title">
          <h2 className="done-panel__title" id="done-title">
            When it&apos;s done
          </h2>
          <div className="done-panel__account">
            {setup.account.avatarUrl ? <img className="done-panel__avatar" src={setup.account.avatarUrl} alt="" /> : <PlatformMark platform={platform} size={30} />}
            <div className="done-panel__who">
              <span className="done-panel__name user-text" title={name ?? guide.name}>{name ?? guide.name}</span>
              <span className={`done-panel__state${reconnect ? " is-bad" : ""}`}>
                {leaving ? "Disconnecting…" : reconnect ? `${guide.name} logged Clip Factory out. Press Connect again.` : setup.ready ? "Ready. Clip Factory posts here by itself." : "Connected."}
              </span>
            </div>
          </div>
          {setup.account.reason === "expires_soon" && setup.account.reconnectBy ? (
            <p className="callout callout--info">
              <Icon name="info" size={18} />
              <span>Press Connect again before {new Date(setup.account.reconnectBy).toLocaleDateString()} to keep posting.</span>
            </p>
          ) : null}
          {platform === "youtube" && setup.stepsDone.includes("public-privacy") ? (
            <div className="gstep__picker">
              <span className="gstep__picker-label">Who can see your YouTube clips</span>
              <Segmented<YoutubePrivacy>
                label="Who can see your YouTube clips (When it's done)"
                value={youtubePrivacy}
                options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YOUTUBE_PRIVACY_LABEL[v] }))}
                onChange={(v) => void saveSettings({ youtubePrivacy: v })}
              />
            </div>
          ) : null}
          {platform === "x" ? (
            <p className="callout callout--info">
              <Icon name="info" size={18} />
              <span>{xLeaf} Clip Factory never puts links in X posts (a link costs $0.20).</span>
            </p>
          ) : null}
          {backMain && back ? (
            <div className="done-panel__actions">
              <LinkButton href={back.href} variant="primary" size="lg" icon="chevronLeft" data-help-clear="" data-setup="back">
                {backLabel(back)}
              </LinkButton>
            </div>
          ) : null}
          <div className="done-panel__actions">
            <Button variant={reconnect ? "primary" : "glass"} icon="link" act="connect" loading={connecting} disabled={leaving} onClick={() => connect()}>
              Connect again
            </Button>
            <CheckIt platform={platform} check={setup.keys.check} onChecked={put} />
            <Button variant="ghost" icon="logout" act={disconnectAct} disabled={leaving} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          {/* §40.1 item 4: how this platform pays him, with the way back here. */}
          <div className="done-panel__actions">
            <LinkButton href={`/settings/posting/getpaid/${platform}?back=/settings/posting/setup/${platform}`} variant="glass" icon="coin" iconAfter="chevronRight" data-setup="getpaid">
              Get paid
            </LinkButton>
          </div>
        </section>
      ) : null}
    </div>
  );
}
