// Settings › Posting › Set up posting › Content Rewards (docs/CONTRACTS.md §38.3, §39.1): in time order, the shortcut
// "Already use Content Rewards …?" (while steps 1 and 2 are both not done), three numbered steps, the unnumbered
// "Content Rewards said no?" card when it applies, then "When it's done". A step Clip Factory can see ticks itself;
// one it can't see yet has its own green answer ("I have an account", "I added them") right under its Open button.
// With `?back=` the page leads back where the owner came from once he is signed in. One vermilion at a time.
import { useEffect, useId, useRef, useState } from "react";
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
  crLoginEmail,
  crSetupCount,
  crStepsDone,
  looksLikeEmail,
  pilotOpen,
  saveCrLoginEmail,
  dayDate,
  patchCr,
  placeList,
  reloadCr,
  shortDay,
  signedIn,
  signInSoon,
  useCr,
} from "../../../lib/contentRewards.ts";
import { backLabel, backLink, backNext } from "../../../lib/backLink.ts";
import { isTouchDevice } from "../../../lib/crConnect.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../../lib/format.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { navigate } from "../../../lib/router.ts";
import { CR_GUIDE, CR_LOGIN_ASK, CR_LOGIN_FIRST, CR_PILOT, CR_PILOT_AFTER, CR_SAID_CANT, CR_SETUP_STEPS, CR_SHORTCUT, CR_TIKTOK_WAITS } from "../../../setup/contentrewards.ts";
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

/** The places connected in Clip Factory, never TikTok ("YouTube and Instagram"), for the shortcut and step 2's lead. */
export function addedPlaces(platforms: { platform: Platform; account: { status: string } }[] | undefined): string {
  const list = PLATFORM_ORDER.filter((p) => p !== "tiktok" && platforms?.find((x) => x.platform === p)?.account.status === "connected");
  return placeList(list);
}

/** "Already use Content Rewards, with YouTube added there?" (§39.1 item 0). */
export function shortcutQuestion(places: string): string {
  return places ? CR_SHORTCUT.question.replace("{places}", places) : CR_SHORTCUT.none;
}

/** Step 2's lead: "Already added YouTube and Instagram there? Tap I added them." */
export function socialsLead(places: string): string {
  return `Already added ${places || "your accounts"} there? Tap I added them.`;
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

/** Scrolls just enough that `el` is all on screen, clear of the bars fixed at the bottom (the phone tab bar, the
 * update bar), its top first when it is taller than the room. */
function bringOnScreen(el: HTMLElement) {
  let floor = window.innerHeight;
  for (const bar of document.querySelectorAll<HTMLElement>(".tabbar, .update-bar")) {
    const r = bar.getBoundingClientRect();
    if (r.height > 0 && r.top > 0) floor = Math.min(floor, r.top);
  }
  const bottom = floor - 12;
  const top = 48;
  const r = el.getBoundingClientRect();
  let by = r.bottom > bottom ? r.bottom - bottom : 0;
  if (r.top - by < top) by = r.top - top;
  if (Math.abs(by) >= 1) window.scrollBy({ top: by, behavior: prefersReducedMotion() ? "auto" : "smooth" });
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
  // Where the owner came from (§39.1 `?back=`): once signed in, the way back is the page's next step.
  const [back] = useState(() => (typeof location === "undefined" ? null : backLink(location.search)));
  const backName = back?.campaignId ? (campaigns.find((c) => c.campaignId === back.campaignId)?.name ?? null) : null;
  const [shortcutBusy, setShortcutBusy] = useState(false);

  const done = crStepsDone(conn);
  const count = crSetupCount(conn);
  const refusedLink = conn ? PLATFORM_ORDER.find((p) => conn.crLinked[p] === false) : undefined;
  const current = CR_SETUP_STEPS.find((s) => !done[s.id as keyof typeof done])?.id ?? null;
  const on = signedIn(conn);
  // "Content Rewards said no?": open when Connect said the account can't connect apps (or he said Content Rewards
  // said so, as it never sends the browser back then), or the sign-in is read only.
  const saidCant = !!conn && (conn.lastResult === "not_allowed" || run.saidCant);
  const pilotApplies = !!conn && !conn.canSubmit && (saidCant || conn.status === "read_only" || !!conn.pilotSentAt);
  const pilotDone = !!conn?.canSubmit;
  const pilotSent = !!conn?.pilotSentAt;
  // While that card waits for its email, "Open email" is the screen's one vermilion; after "I sent it", Connect is.
  const pilotMain = pilotApplies && !pilotSent && !pilotDone;
  const soon = signInSoon(conn);
  const reconnect = conn?.status === "needs_reconnect";
  const bridge = run.place === "bridge";
  const key = statusKey(conn);
  const soonMain = !reconnect && soon && !!conn?.signInBy && bridge;
  // While the pilot email waits, that card is the next step: it is the one open and brought on screen (the first step
  // not done stays folded until the email went, so the one vermilion is on the first screen).
  const pilotFirst = !reconnect && !soonMain && pilotMain;
  const focusId = pilotFirst ? CR_PILOT.id : current;

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
  // "What did Content Rewards say?" comes all on screen, its three answers clear of the tab bar (also while it waits:
  // it shows under the waiting card, so nothing moves under his pointer). After "It said my account can't connect
  // apps", its card opens (even if he folded it earlier) and comes on screen, its first line first.
  useEffect(() => {
    if (!run.ask) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>("[data-cr='ask']");
      if (el) bringOnScreen(el);
    }, 60);
    return () => clearTimeout(t);
  }, [run.ask]);
  useEffect(() => {
    if (run.said !== "cant_connect") return;
    setClosed((s) => {
      if (!s.has(CR_PILOT.id)) return s;
      const n = new Set(s);
      n.delete(CR_PILOT.id);
      return n;
    });
    const t = setTimeout(() => document.getElementById(`step-${CR_PILOT.id}`)?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }), 60);
    return () => clearTimeout(t);
  }, [run.said]);

  // The next step (the first step not done, or the pilot card while its email waits) is open and scrolled into view
  // (once).
  useEffect(() => {
    if (!conn || scrolled.current || !focusId || count === 0) return;
    scrolled.current = true;
    const t = setTimeout(
      () => document.getElementById(`step-${focusId}`)?.scrollIntoView({ block: focusId === CR_PILOT.id ? "start" : "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }),
      160,
    );
    return () => clearTimeout(t);
  }, [conn, focusId, count]);

  // Phones: the open step's pinned Open and its answer come fully on screen, clear of the tab bar (once). A step low on
  // the first screen would otherwise leave them under the bar until he scrolls.
  const pinShown = useRef(false);
  useEffect(() => {
    if (!conn || pinShown.current || !focusId) return;
    const t = setTimeout(() => {
      pinShown.current = true;
      const pin = document.querySelector<HTMLElement>(`#step-${focusId} .cr-pin`);
      if (!pin) return;
      const bar = document.querySelector<HTMLElement>(".tabbar")?.getBoundingClientRect();
      const limit = (bar && bar.height > 0 ? bar.top : window.innerHeight) - 12;
      const r = pin.getBoundingClientRect();
      if (r.bottom > limit) window.scrollBy({ top: r.bottom - limit, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, 400);
    return () => clearTimeout(t);
  }, [conn, focusId]);

  const isOpen = (id: string) => (closed.has(id) ? false : opened.has(id) || focusId === id);
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
  const next: string | null = reconnect
    ? bridge
      ? "reconnect"
      : null
    : soonMain
      ? "soon"
      : pilotMain
        ? "pilot"
        : (current ?? (back && on ? "back" : !campaigns.length ? "add" : null));
  // While Connect waits for the browser (before the question shows too), or "What did Content Rewards say?" is on
  // screen, nothing is the vermilion: he is in the browser, or its three big answers are the step (§39.1). Once he
  // answered "Something else" (or Clip Factory missed his Allow), its line says to tap Connect again, so that Connect
  // is the vermilion wherever it is (step 3, the calm card, or the panel's Connect again).
  const connectAgain = bridge && !run.waiting && !run.checking && (run.said === "other" || run.said === "allowed");
  const main: string | null = run.ask || (bridge && run.waiting) ? null : connectAgain ? (soonMain ? "soon" : on || reconnect ? "reconnect" : "connect") : next;
  const postsTo = setup.data ? postsToLine(setup.data.platforms) : null;
  const places = addedPlaces(setup.data?.platforms);
  // The shortcut: only while steps 1 and 2 are both not done (someone already set up says so in one tap).
  const shortcut = !done["ready-account"] && !done["ready-socials"] && !on;
  async function yesShortcut() {
    setShortcutBusy(true);
    try {
      const a = CR_SETUP_STEPS.find((st) => st.id === "ready-account")!;
      const b = CR_SETUP_STEPS.find((st) => st.id === "ready-socials")!;
      if ((await tick(a, true)) && (await tick(b, true))) {
        // Step 3 opens next: its Connect comes on screen (a short Mac window put it just below the edge).
        setTimeout(() => {
          const to = document.querySelector<HTMLElement>("#step-connect .gstep__connect, #step-connect .cr-place, #step-connect");
          to?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        }, 60);
      }
    } finally {
      setShortcutBusy(false);
    }
    return true;
  }
  const socialsSay = (step: CrStep) => {
    const lines = step.say.filter((l) => l !== CR_TIKTOK_WAITS);
    const last = lines.pop();
    return [...lines, ...(postsTo ? [postsTo] : []), CR_TIKTOK_WAITS, ...(last ? [last] : [])];
  };
  // On a phone, step 3 is done on the Mac: with a way back, the page still leads back (the vermilion when step 3 is the
  // only step left, since a phone's step 3 has no button), and says where that campaign is on the Mac.
  const phoneBack = !!back && !on && !reconnect && run.place === "phone";
  const phoneBackMain = phoneBack && main === "connect";
  const phoneWords = back?.campaignId && backName ? { phone: [`Do this step on your Mac. Open ${backName} in Clip Factory there, then tap Connect Content Rewards.`] } : undefined;
  const shownCheck = check && check.key === key ? check.text : null;
  // The way back (§39.1): the vermilion once he is signed in (glass while the pilot email waits). Right after a
  // Connect it sits in the result card, right under "Next: back to FaZe Clips.", so it is on screen at once.
  const backInCard = !!back && !reconnect && (run.result === "connected" || run.result === "read_only");
  const backButton = back ? (
    <LinkButton
      href={back.href}
      variant={main === "back" || phoneBackMain ? "primary" : "glass"}
      size="lg"
      icon="chevronLeft"
      data-help-clear={main === "back" || phoneBackMain ? "" : undefined}
      data-cr="back"
    >
      {backLabel(back, backName)}
    </LinkButton>
  ) : null;

  return (
    <div className="setup-page cr-setup">
      {header}

      {shortcut ? (
        <section className="cr-shortcut glass" aria-label="Already set up?" data-cr="shortcut">
          <p>{shortcutQuestion(places)}</p>
          <GreenButton size="lg" onClick={yesShortcut} loading={shortcutBusy}>
            {CR_SHORTCUT.yes}
          </GreenButton>
        </section>
      ) : null}

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
            const open = isOpen(step.id) || (step.id === "ready-socials" && !!refusedLink && !isDone) || (isConnect && (!!run.result || run.waiting || !!run.ask || !!run.said));
            return (
              <CrStepCard
                key={step.id}
                // Step 3's own lines and "If you see" hints are the Mac app's: elsewhere its words say where to do it.
                step={isConnect && !bridge ? { ...step, ifYouSee: [] } : step}
                number={i + 1}
                done={isDone}
                open={open}
                current={focusId === step.id}
                primary={primary && !isConnect}
                onToggle={() => toggle(step.id)}
                onDone={(d) => tick(step, d)}
                busy={busy === step.id}
                say={isConnect ? [] : step.id === "ready-socials" ? socialsSay(step) : undefined}
                lead={step.id === "ready-socials" ? socialsLead(places) : undefined}
              >
                {step.id === "ready-socials" && refusedLink ? (
                  <div className="gstep__extras">
                    <Note icon="alert" tone="bad" role="alert">
                      Content Rewards doesn&apos;t know your {PLATFORM_LABEL[refusedLink]} account. Add it in Content Rewards, then tap I added them.
                    </Note>
                  </div>
                ) : null}
                {isConnect ? (
                  <div className="gstep__extras">
                    {bridge ? <Lines lines={step.say} /> : null}
                    {run.result ? (
                      <div ref={resultRef}>
                        <CrResultCard
                          result={run.result}
                          onClose={run.clear}
                          next={backInCard && back ? backNext(back, backName) : undefined}
                          action={backInCard ? backButton : undefined}
                        />
                      </div>
                    ) : null}
                    {reconnect && bridge ? (
                      // Signed out: the one Connect is the panel's Connect again (never two Connect buttons).
                      <Note icon="alert" tone="bad">
                        Content Rewards signed you out. Tap Connect again below.
                      </Note>
                    ) : on && bridge ? null : (
                      // Signed in, in the Mac app: Connect again lives in the panel below (one Connect on the page).
                      <CrConnectControls run={run} primary={primary} words={phoneWords} />
                    )}
                    {phoneBack ? backButton : null}
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
          // The result card says it already when Connect itself answered not_allowed.
          cant={saidCant && run.result !== "not_allowed"}
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
                      : "It can see your campaigns and money, but can't send clips yet. You get a reminder after each post."}
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
          {back && !reconnect ? (
            // §39.1: the way back is the next step once he is signed in; glass while the pilot email waits. Right
            // after Connect it sits in the result card instead (on screen at once), never twice.
            backInCard ? null : <div className="done-panel__actions">{backButton}</div>
          ) : main === "add" ? (
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
        <A href="/settings/posting/getpaid/contentrewards" className="btn btn--glass btn--md" data-cr="getpaid">
          <Icon name="coin" size={20} />
          <span className="btn__label">Get paid</span>
        </A>
      </div>
    </div>
  );
}

/**
 * "Content Rewards said no?" (§38.3): the pilot email, under Show more, and "I sent it". It asks once which email he
 * signs in to Content Rewards with (kept on this device only), as Mail would send from its own default account: a
 * Gmail address opens Gmail's compose page for that exact account; any other keeps the mailto and says to check the
 * From line. Until the box has his email, Open email opens nothing: it points at the box. Once sent, it never pushes
 * him to send it again: no email question, and Open email stays (glass), so he can send it again if Content Rewards
 * never answers.
 */
function PilotCard({
  conn,
  applies,
  main,
  cant,
  onSaid,
  open,
  onToggle,
}: {
  conn: CrConnection;
  applies: boolean;
  main: boolean;
  cant: boolean;
  onSaid: () => unknown;
  open: boolean;
  onToggle: () => void;
}) {
  const [more, setMore] = useState(false);
  const [saved, setSaved] = useState(() => crLoginEmail());
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(!saved);
  // He tapped Open email before typing his email: the box says so. Kept with whether it was sent then, so a tap from
  // before "I sent it" never brings the email question back after it.
  const [nudgedAt, setNudgedAt] = useState<"before" | "after" | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const boxId = useId();
  const done = conn.canSubmit;
  const sent = !!conn.pilotSentAt;
  const phase = sent ? "after" : "before";
  const nudge = nudgedAt === phase;
  const email = conn.pilotEmail;
  const from = looksLikeEmail(draft) ? draft.trim() : saved;
  const target = pilotOpen(from, email);
  // Once sent, only what comes next (CR_PILOT_AFTER). Before that, only its first line: the box and the bold
  // "Send it from …" say where from (the guide's "Check the From line" would say it a third time).
  const lines = sent ? [] : CR_PILOT.say.slice(0, 1);
  // Once sent, no email question: the box comes back only when he taps Open email with no email kept here, and folds
  // again once Open email opens it. Never the "Send it from" line or Change after sending.
  const askBox = !sent || nudge;
  const fromLine = !sent && !!from;
  const describedBy = [nudge && !from ? `${boxId}-first` : "", fromLine ? `${boxId}-from` : ""].filter(Boolean).join(" ") || undefined;
  const first = cant && !sent;
  // Open email is the vermilion only while the email waits; once sent it stays glass.
  const emailMain = main && !sent;
  // After sending, the box shows only once he tapped Open email: it comes on screen first, then takes the focus.
  useEffect(() => {
    if (nudge) box.current?.focus();
  }, [nudge]);
  // Saved as he leaves the box (the box stays put, so nothing moves under his pointer); it folds once he taps Open
  // email, and on his next visit it shows only the bold line with Change.
  const keep = () => {
    if (!looksLikeEmail(draft)) return;
    saveCrLoginEmail(draft);
    setSaved(draft.trim());
  };
  return (
    <ol className="guide-steps cr-pilot" data-help="cr-pilot-email">
      <CrStepCard
        step={CR_PILOT}
        number={null}
        done={done}
        open={open && !done}
        current={applies && !done}
        primary={false}
        onToggle={onToggle}
        // Content Rewards' no comes first, above the card's own lines.
        say={first ? [] : lines}
      >
        <div className="gstep__extras">
          {first ? (
            <>
              <Note role="status" icon="alert">
                {CR_SAID_CANT}
              </Note>
              <Lines lines={lines} />
            </>
          ) : null}
          {askBox || (from && !target.gmail) ? (
            <div className="cr-login" data-cr="login">
              {askBox && editing ? (
                <div className="field">
                  <label className="field__label" htmlFor={boxId}>
                    {CR_LOGIN_ASK}
                  </label>
                  <input
                    id={boxId}
                    className="input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    spellCheck={false}
                    value={draft}
                    ref={box}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={keep}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") keep();
                    }}
                    aria-describedby={describedBy}
                  />
                </div>
              ) : null}
              {nudge && !from ? (
                <p id={`${boxId}-first`} className="cr-login__first" role="alert">
                  <strong>{CR_LOGIN_FIRST}</strong>
                </p>
              ) : null}
              {fromLine ? (
                <div className="cr-login__from">
                  <p id={`${boxId}-from`}>
                    <strong>
                      Send it from <span className="user-text">{from}</span>.
                    </strong>
                  </p>
                  {editing ? null : (
                    <Button variant="glass" className="cr-login__change" onClick={() => setEditing(true)}>
                      Change
                    </Button>
                  )}
                </div>
              ) : null}
              {from && !target.gmail ? (
                <p>
                  <strong>
                    Check the From line says <span className="user-text">{from}</span>.
                  </strong>
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="gstep__actions">
            {from ? (
              <a
                className={`btn btn--${emailMain ? "primary" : "glass"} btn--lg`}
                href={target.href}
                data-help-clear={emailMain ? "" : undefined}
                data-cr="open-email"
                onClick={() => {
                  keep();
                  setEditing(false);
                  setNudgedAt(null);
                }}
                {...(target.gmail ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                <Icon name="fileText" size={20} />
                <span className="btn__label">Open email</span>
                {target.gmail ? <span className="sr-only"> (opens Gmail in a new tab)</span> : null}
              </a>
            ) : (
              // No email yet: Mail would pick its own default account, so the box comes first.
              <button
                type="button"
                className={`btn btn--${emailMain ? "primary" : "glass"} btn--lg`}
                data-help-clear={emailMain ? "" : undefined}
                data-cr="open-email"
                onClick={() => {
                  setNudgedAt(phase);
                  box.current?.focus();
                }}
              >
                <Icon name="fileText" size={20} />
                <span className="btn__label">Open email</span>
              </button>
            )}
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
