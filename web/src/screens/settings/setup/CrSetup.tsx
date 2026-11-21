// Settings › Posting › Set up posting › Content Rewards (docs/CONTRACTS.md §38.3): three numbered steps, the
// unnumbered "Content Rewards said no?" card when it applies, then "When it's done". A step Clip Factory can see
// ticks itself; one it can't see yet shows "I did this" (green). One vermilion button on the screen at a time.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { CrConnection, Platform } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { ProgressRing } from "../../../components/ProgressRing.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { A, Button, ErrorPanel, LinkButton, Skeleton } from "../../../components/ui.tsx";
import { useAction } from "../../../lib/motion.ts";
import {
  CAMPAIGNS_PATH,
  CHECK_TEXT,
  COMING_SOON,
  CR_MONEY_PATH,
  crSetupCount,
  safeMailto,
  crStepsDone,
  dayDate,
  patchCr,
  reloadCr,
  shortDay,
  signedIn,
  signInSoon,
  useCr,
} from "../../../lib/contentRewards.ts";
import { isTouchDevice } from "../../../lib/crConnect.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../../lib/format.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { navigate } from "../../../lib/router.ts";
import { CR_GUIDE, CR_PILOT, CR_PILOT_AFTER, CR_SETUP_STEPS, pilotMailto } from "../../../setup/contentrewards.ts";
import type { CrStep } from "../../../setup/types.ts";
import { BrandText, CrStepCard, GreenButton, Lines, Note } from "../../campaigns/bits.tsx";
import { CopyChip } from "./bits.tsx";
import { CrConnectControls, CrResultCard, useCrConnect } from "./CrConnect.tsx";
import { useSetup } from "./useSetup.ts";

/** The coin mark Content Rewards' card wears. */
export function CrMark({ size = 30 }: { size?: number }) {
  return (
    <span className="setup-head__mark cr-mark" aria-hidden="true">
      <Icon name="coin" size={size} />
    </span>
  );
}

/** "Clip Factory posts to: YouTube @faze · Instagram @faze …" from GET /v1/setup (connected places, never TikTok). */
export function postsToLine(platforms: { platform: Platform; account: { status: string; handle?: string; name?: string } }[]): string | null {
  const shown = PLATFORM_ORDER.filter((p) => p !== "tiktok")
    .map((p) => platforms.find((x) => x.platform === p))
    .filter((x): x is NonNullable<typeof x> => !!x && x.account.status === "connected")
    .map((x) => `${PLATFORM_LABEL[x.platform]} ${x.account.handle ?? x.account.name ?? ""}`.trim());
  return shown.length ? `Clip Factory posts to: ${shown.join(" · ")}.` : null;
}

/**
 * Where an Ask button for a Content Rewards step opens (`/settings/posting/setup/contentrewards#step-{id}`, api
 * ask/tools.py): the join steps live on Campaigns and the money steps on Money, so those go there instead.
 */
export function crStepHome(hash: string): string | null {
  const id = /^#step-([a-z0-9-]+)$/.exec(hash)?.[1];
  const part = id ? CR_GUIDE.parts.find((p) => p.steps.some((st) => st.id === id))?.id : undefined;
  if (part === "join") return `${CAMPAIGNS_PATH}#step-${id}`;
  if (part === "move" || part === "bank") return CR_MONEY_PATH;
  return null;
}

/** "Connect" status and reason: an old result card or Check it answer goes when it changes. */
const statusKey = (c: CrConnection | null) => (c ? `${c.status}:${c.reason ?? ""}:${c.canSubmit ? 1 : 0}` : "");

export function CrSetup() {
  const cr = useCr();
  const conn = cr.state === "ok" ? cr.data.connection : cr.state === "error" ? (cr.data?.connection ?? null) : null;
  const campaigns = cr.state === "ok" ? cr.data.campaigns : [];
  const setup = useSetup();
  const toast = useToast();
  const run = useCrConnect();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ text: string; key: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const disconnectAct = useAction("disconnect");
  const phone = isTouchDevice();
  const scrolled = useRef(false);

  const done = crStepsDone(conn);
  const count = crSetupCount(conn);
  const refusedLink = conn ? PLATFORM_ORDER.find((p) => conn.crLinked[p] === false) : undefined;
  const current = CR_SETUP_STEPS.find((s) => !done[s.id as keyof typeof done])?.id ?? null;
  const on = signedIn(conn);
  // "Content Rewards said no?": open when Connect said the account can't connect apps, or the sign-in is read only.
  const pilotApplies = !!conn && !conn.canSubmit && (conn.lastResult === "not_allowed" || conn.status === "read_only" || !!conn.pilotSentAt);
  const pilotDone = !!conn?.canSubmit;
  const pilotSent = !!conn?.pilotSentAt;
  // While that card waits for its email, "Open email" is the screen's one vermilion; after "I sent it", Connect is.
  const pilotMain = pilotApplies && !pilotSent && !pilotDone;
  const soon = signInSoon(conn);
  const reconnect = conn?.status === "needs_reconnect";
  const bridge = run.place === "bridge";
  const key = statusKey(conn);

  // An Ask button for a join or money step lands where that step is.
  useEffect(() => {
    const to = crStepHome(location.hash);
    if (to) navigate(to, { replace: true });
  }, []);

  // The last Connect's card stays until Connect's status changes (then it would say the opposite of the page).
  const resultAt = useRef<{ result: string; key: string } | null>(null);
  useEffect(() => {
    if (!run.result) {
      resultAt.current = null;
      return;
    }
    if (resultAt.current?.result !== run.result) resultAt.current = { result: run.result, key };
    else if (resultAt.current.key !== key) run.clear();
  }, [run, key]);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (run.result) resultRef.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [run.result]);

  // The first step not done is open and scrolled into view (once).
  useEffect(() => {
    if (!conn || scrolled.current || !current || count === 0) return;
    scrolled.current = true;
    const t = setTimeout(() => document.getElementById(`step-${current}`)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }), 160);
    return () => clearTimeout(t);
  }, [conn, current, count]);

  const isOpen = (id: string) => (closed.has(id) ? false : opened.has(id) || current === id);
  const toggle = (id: string) => {
    const now = isOpen(id);
    setOpened((s) => {
      const n = new Set(s);
      if (now) n.delete(id);
      else n.add(id);
      return n;
    });
    setClosed((s) => {
      const n = new Set(s);
      if (now) n.add(id);
      else n.delete(id);
      return n;
    });
  };

  async function tick(step: CrStep, d: boolean) {
    if (!conn) return false;
    setBusy(step.id);
    patchCr((o) => ({ ...o, connection: { ...o.connection, stepsDone: d ? [...new Set([...o.connection.stepsDone, step.id])] : o.connection.stepsDone.filter((x) => x !== step.id) } }));
    setOpened((s) => {
      const n = new Set(s);
      n.delete(step.id);
      return n;
    });
    try {
      const next = await api().crPatchConnection({ step: step.id, done: d });
      patchCr((o) => ({ ...o, connection: next }));
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      void reloadCr();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saidPilot(sent: boolean) {
    try {
      const next = await api().crPatchConnection({ said: sent ? "pilot_sent" : null });
      patchCr((o) => ({ ...o, connection: next }));
      if (sent)
        toast.undo("Saved: you sent the email.", {
          onUndo: () => void saidPilot(false),
          onCommit: () => undefined,
        });
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  }

  async function checkIt() {
    try {
      const out = await api().crCheck();
      setCheck({ text: out.check.message || CHECK_TEXT[out.check.code], key: statusKey(out.connection) });
      patchCr((o) => ({ ...o, connection: out.connection }));
      return out.check.ok;
    } catch (e) {
      setCheck({ text: friendlyMessage(e), key });
      return false;
    }
  }

  function disconnect() {
    setLeaving(true);
    toast.undo("Disconnecting Content Rewards…", {
      onUndo: () => {
        setLeaving(false);
        disconnectAct.rewind();
      },
      onCommit: () => {
        api()
          .crDisconnect()
          .then(() => {
            setDisconnected(true);
            return reloadCr();
          })
          .catch((e) => toast.error(`${friendlyMessage(e)} Content Rewards is still connected.`))
          .finally(() => setLeaving(false));
      },
    });
  }

  if (cr.state === "missing")
    return (
      <div className="setup-page">
        <Note>Content Rewards isn't in this version of Clip Factory yet.</Note>
      </div>
    );

  const header = (
    <header className="setup-head glass" data-help="cr-setup-card">
      <CrMark size={34} />
      <div className="setup-head__text">
        <h1 className="setup-head__title">Content Rewards</h1>
        <p className="setup-head__meta">Get paid by brands for your clips.</p>
        <p className="setup-head__meta">About 10 minutes · Free</p>
        <p className="setup-head__checked">
          <Icon name="checkCircle" size={16} />
          <span>
            Steps checked on <span className="nowrap">21 Nov 2026</span>
          </span>
        </p>
      </div>
      <ProgressRing value={count / 3} size={76} label={`Content Rewards: ${count === 3 ? "ready" : `${count} of 3 steps done`}`}>
        {count === 3 ? <Icon name="check" size={26} /> : `${count}/3`}
      </ProgressRing>
    </header>
  );

  if (cr.state === "soon")
    return (
      <div className="setup-page">
        {header}
        <Note>{COMING_SOON}</Note>
      </div>
    );
  if (cr.state === "error" && !conn) return <ErrorPanel message={cr.error} onRetry={() => void cr.reload()} />;
  if (!conn)
    return (
      <div className="setup-page">
        {header}
        <Skeleton className="setup-skel" />
        <Skeleton className="setup-skel" />
      </div>
    );

  // The one vermilion button, in one order: signed out → the panel's Connect again (Mac app); the sign-in-again week
  // (Mac app) → the calm card's Connect again; the pilot email; the first step not done; and only when every step is
  // done, Add a campaign. Signed out elsewhere: none (the panel says to sign in again on the Mac).
  const soonMain = !reconnect && soon && !!conn.signInBy && bridge;
  const main: string | null = reconnect
    ? bridge
      ? "reconnect"
      : null
    : soonMain
      ? "soon"
      : pilotMain
        ? "pilot"
        : (current ?? (!campaigns.length ? "add" : null));
  const postsTo = setup.data ? postsToLine(setup.data.platforms) : null;
  const shownCheck = check && check.key === key ? check.text : null;

  return (
    <div className="setup-page cr-setup">
      {header}

      <section className="setup-part" aria-labelledby="cr-part-setup">
        <h2 className="setup-part__title" id="cr-part-setup">
          Set it up once
        </h2>
        <ol className="guide-steps">
          {CR_SETUP_STEPS.map((step, i) => {
            const isConnect = step.id === "connect";
            const isDone = done[step.id as keyof typeof done];
            const primary = main === step.id;
            // Step 3 stays open while its last result shows (the card sits right above its button).
            const open = isOpen(step.id) || (step.id === "ready-socials" && !!refusedLink && !isDone) || (isConnect && (!!run.result || run.waiting));
            return (
              <CrStepCard
                key={step.id}
                // Step 3's own lines and "If you see" hints are the Mac app's: elsewhere its words say where to do it.
                step={isConnect && !bridge ? { ...step, ifYouSee: [] } : step}
                number={i + 1}
                done={isDone}
                open={open}
                current={current === step.id}
                primary={primary && !isConnect}
                onToggle={() => toggle(step.id)}
                onDone={(d) => tick(step, d)}
                busy={busy === step.id}
                say={isConnect ? [] : undefined}
              >
                {step.id === "ready-socials" ? (
                  <div className="gstep__extras">
                    {refusedLink ? (
                      <Note icon="alert" tone="bad" role="alert">
                        Content Rewards doesn&apos;t know your {PLATFORM_LABEL[refusedLink]} account. Connect it here, then tap I did this.
                      </Note>
                    ) : null}
                    {postsTo ? <p className="gstep__note">{postsTo}</p> : null}
                  </div>
                ) : null}
                {isConnect ? (
                  <div className="gstep__extras">
                    {bridge ? <Lines lines={step.say} /> : null}
                    {run.result ? (
                      <div ref={resultRef}>
                        <CrResultCard result={run.result} onClose={run.clear} />
                      </div>
                    ) : null}
                    {reconnect && bridge ? (
                      // Signed out: the one Connect is the panel's Connect again (never two Connect buttons).
                      <Note icon="alert" tone="bad">
                        Content Rewards signed you out. Tap Connect again below.
                      </Note>
                    ) : on && bridge ? null : (
                      // Signed in, in the Mac app: Connect again lives in the panel below (one Connect on the page).
                      <CrConnectControls run={run} primary={primary} />
                    )}
                    {on ? (
                      <p className="gstep__note is-ok">
                        <Icon name="checkCircle" size={18} />
                        Signed in to Content Rewards.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </CrStepCard>
            );
          })}
        </ol>
      </section>

      {pilotDone ? null : (
        <PilotCard
          conn={conn}
          applies={pilotApplies}
          main={main === "pilot"}
          onSaid={() => saidPilot(true)}
          open={isOpen(CR_PILOT.id) || (pilotApplies && !closed.has(CR_PILOT.id))}
          onToggle={() => toggle(CR_PILOT.id)}
        />
      )}

      {on || reconnect ? (
        <section className="done-panel glass" aria-labelledby="cr-done-title" data-help="cr-ready">
          <h2 className="done-panel__title" id="cr-done-title">
            {reconnect ? "Sign in again" : "You're connected"}
          </h2>
          <div className="done-panel__account">
            <CrMark size={26} />
            <div className="done-panel__who">
              <span className={`done-panel__name${reconnect ? " is-bad" : ""}`}>
                {reconnect
                  ? "Content Rewards signed you out."
                  : conn.connectedAt
                    ? `Signed in to Content Rewards since ${shortDay(conn.connectedAt)}.`
                    : "Signed in to Content Rewards."}
              </span>
              <span className={`done-panel__state${reconnect ? " is-bad" : ""}`}>
                {leaving
                  ? "Disconnecting…"
                  : reconnect
                    ? bridge
                      ? "Tap Connect again."
                      : "Sign in again in the Clip Factory app on your Mac."
                    : conn.status === "connected" && conn.canSubmit
                      ? "Clip Factory sends your campaign clips for you."
                      : "Clip Factory can see your campaigns and money. It can't send clips yet, so I remind you after each post."}
              </span>
            </div>
          </div>
          {!reconnect && soon && conn.signInBy ? (
            <div className="cr-calm glass" role="status">
              <Icon name="clock" size={20} />
              <p>{phone ? `Sign in again on your Mac by ${dayDate(conn.signInBy)}.` : `Sign in to Content Rewards again by ${dayDate(conn.signInBy)}. It takes one minute.`}</p>
              {bridge ? <CrConnectControls run={run} primary={main === "soon"} label="Connect again" /> : null}
            </div>
          ) : null}
          {shownCheck ? (
            <p className="gstep__note" role="status">
              <Icon name="info" size={18} />
              {shownCheck}
            </p>
          ) : null}
          <div className="done-panel__actions">
            <Button variant="glass" icon="checkCircle" act="tick" onClick={checkIt}>
              Check it
            </Button>
            {!soonMain && bridge ? <CrConnectControls run={run} primary={main === "reconnect"} label="Connect again" /> : null}
            <Button variant="ghost" icon="logout" act={disconnectAct} disabled={leaving} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          {main === "add" ? (
            <div className="done-panel__actions">
              <LinkButton href={CAMPAIGNS_PATH} variant="primary" size="lg" icon="plus" data-help-clear="">
                Add a campaign
              </LinkButton>
            </div>
          ) : null}
        </section>
      ) : disconnected ? (
        <Note>
          To remove Clip Factory on Content Rewards too: Settings, <strong>Connected apps</strong>, <strong>Disconnect</strong>.
        </Note>
      ) : null}

      <div className="cr-below">
        <A href={CAMPAIGNS_PATH} className="btn btn--glass btn--md">
          <Icon name="layers" size={20} />
          <span className="btn__label">Your campaigns</span>
        </A>
        <A href={CR_MONEY_PATH} className="btn btn--glass btn--md">
          <Icon name="coin" size={20} />
          <span className="btn__label">Get paid</span>
        </A>
      </div>
    </div>
  );
}

/** "Content Rewards said no?" (§38.3): the pilot email, under Show more, and "I sent it". */
function PilotCard({ conn, applies, main, onSaid, open, onToggle }: { conn: CrConnection; applies: boolean; main: boolean; onSaid: () => unknown; open: boolean; onToggle: () => void }) {
  const [more, setMore] = useState(false);
  const done = conn.canSubmit;
  const sent = !!conn.pilotSentAt;
  const email = conn.pilotEmail;
  return (
    <ol className="guide-steps cr-pilot" data-help="cr-pilot-email">
      <CrStepCard step={CR_PILOT} number={null} done={done} open={open && !done} current={applies && !done} primary={false} onToggle={onToggle}>
        <div className="gstep__extras">
          <div className="gstep__actions">
            <a className={`btn btn--${main ? "primary" : "glass"} btn--lg`} href={safeMailto(email.mailto, pilotMailto())} data-help-clear={main ? "" : undefined}>
              <Icon name="fileText" size={20} />
              <span className="btn__label">Open email</span>
            </a>
          </div>
          <div className="cr-email">
            <p className="gstep__note">An email asking Content Rewards to let Clip Factory send your clips.</p>
            <button type="button" className="text-link" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? "Show less" : "Show more"}
            </button>
            {more ? (
              <div className="cr-email__body">
                <p>
                  To: <span className="user-text">{email.to}</span>
                </p>
                <p>
                  Subject: <BrandText text={email.subject} />
                </p>
                <CopyChip label="Email to Content Rewards" value={email.body} quiet />
              </div>
            ) : null}
          </div>
          {sent ? (
            <Lines lines={CR_PILOT_AFTER} />
          ) : (
            <GreenButton size="lg" onClick={onSaid}>
              I sent it
            </GreenButton>
          )}
          {sent ? (
            <div className="gstep__actions">
              <a className="btn btn--glass btn--md" href="https://contentrewards.com/login" target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={20} />
                <span className="btn__label">Open Content Rewards</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
          ) : null}
        </div>
      </CrStepCard>
    </ol>
  );
}
