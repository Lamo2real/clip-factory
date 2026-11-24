// One place's Get paid page (docs/CONTRACTS.md §40.1 item 2), /settings/posting/getpaid/{place}. Top to bottom: the
// header (mark, name, ring, time and cost, the day the steps were checked); the status block (the pill, its line, what
// is missing or on hold, the reading chip, X's warning and the next step); Can you earn here? (the facts for his
// country); the step cards in time order; What Clip Factory can see; Sent to your bank; When it's done.
//
// The page's only vermilion is `next` (§40.2): when it names a step, that step card's main action (on phones pinned at
// the bottom right from the moment the page opens, and the status block says next.text as words); when its step id is
// null (a hold's fix or a reconnect), the status block holds it; when it is null or costs money, there is none.
import "../../styles/getpaid.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import { ApiError } from "../../api/errors.ts";
import type { CrStep } from "../../setup/types.ts";
import type { GetPaidCard, GetPaidNext, GetPaidPlace, Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { ProgressRing } from "../../components/ProgressRing.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Empty, ErrorPanel, LinkButton, Segmented, Skeleton } from "../../components/ui.tsx";
import { CR_GETPAID, drawnSteps, factGroups, factsFor, GETPAID_CHECKED, GETPAID_GUIDES, GETPAID_PATH, getPaidPath, getPaidTime, placeName, rulesLabel, stepNumber } from "../../getpaid/index.ts";
import type { GetPaidStep as Step } from "../../getpaid/types.ts";
import { backLabel, backLink, parseBack, type BackLink } from "../../lib/backLink.ts";
import { burst } from "../../lib/confetti.ts";
import { patchCr, reloadCr, useCr } from "../../lib/contentRewards.ts";
import { usePinMain } from "../../lib/contentRewards.ts";
import {
  onPhone,
  PAYMENTS_RESULTS,
  reloadGetPaid,
  scheduleGetPaid,
  takeGetPaidResult,
  tickGetPaid,
  useGetPaid,
  usePlace,
  whopSentence,
  WHOP_RESULTS,
  type PaymentsResult,
  type WhopResult,
} from "../../lib/getPaid.ts";
import { useAction } from "../../lib/motion.ts";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { useHash } from "../../lib/router.ts";
import { moneySteps } from "../money/CrMoneyPart.tsx";
import { CrStepCard, OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";
import { PlaceMark, ringLabel } from "./GetPaidList.tsx";
import { GetPaidStep, MainAction, whoSaid, type StepState } from "./GetPaidStep.tsx";
import { intoView, SentRows } from "./SentRows.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { startWhop, WhopCard } from "./WhopCard.tsx";

export const PICK_COUNTRY = "Pick your country to see its rules.";
/** The Finance question's id: the server's link to it (getpaid/status.py's FINANCE) ends in `#cr-finance`. */
export const CR_FINANCE = "cr-finance";
export const READING_GONE = "Clip Factory can't see YouTube payments anymore. Tap Allow payment reading again.";
export const SET_UP_YOUTUBE = `/settings/posting/setup/youtube?back=${GETPAID_PATH}/youtube`;

/** `?back=` (§39.1), kept for this tab while Google's or Whop's own page runs, so the way back survives `?result=`. */
function takeBack(place: GetPaidPlace): BackLink | null {
  if (typeof location === "undefined") return null;
  const key = `cf-getpaid-back:${place}`;
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

/** The step a next names, on this page (a platform guide's step, or one of §38.7's money steps). */
function nextStepOf(place: GetPaidPlace, next: GetPaidNext | null, crSteps: readonly CrStep[]): Step | CrStep | null {
  if (!next?.stepId) return null;
  if (place === "contentrewards") return crSteps.find((s) => s.id === next.stepId) ?? null;
  return GETPAID_GUIDES[place].steps.find((s) => s.id === next.stepId) ?? null;
}

export function GetPaidPage({ place }: { place: GetPaidPlace }) {
  const [back] = useState(() => takeBack(place));
  const [result, setResult] = useState<ReturnType<typeof takeGetPaidResult>>(null);
  const load = useGetPaid();
  const where = usePlace(place, load.version);
  const cr = useCr();
  const toast = useToast();
  const hash = useHash();
  const pin = usePinMain();
  const phone = useMemo(() => onPhone(), []);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const [needKeys, setNeedKeys] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopAct = useAction("disconnect");
  const scrolled = useRef<string | null>(null);
  const checkedOnArrival = useRef(false);

  const card: GetPaidCard | null = load.data?.places.find((p) => p.place === place) ?? where.card ?? null;
  const conn = cr.state === "ok" ? cr.data.connection : (cr.data?.connection ?? null);
  const finance = conn?.finance;
  const crSteps = useMemo(() => (place === "contentrewards" ? moneySteps(finance) : []), [place, finance]);
  const guide = place === "contentrewards" ? null : GETPAID_GUIDES[place];
  const next = card?.next ?? null;
  const target = nextStepOf(place, next, crSteps);
  const vermilion = !!next && next.vermilion !== false;
  // A phone step on a computer has no Open, so it has no main action to be the vermilion.
  const away = !!target && "phone" in target && !!target.phone && !phone;
  const stepMain = vermilion && !!target && !away;
  const pinned = stepMain && pin;
  const country = load.data?.country ?? null;
  const adsense = load.data?.connections.adsense ?? null;
  const whop = load.data?.connections.whop ?? null;

  // `?result=` is read once on arrival and taken out of the address, so a reload does not say it again.
  useEffect(() => {
    const code = takeGetPaidResult();
    if (code) setResult(code);
  }, []);

  // Back from Google or Whop: the sentence once, and (Allow payment reading) a Check now.
  const paymentsText = result && result in PAYMENTS_RESULTS ? PAYMENTS_RESULTS[result as PaymentsResult] : null;
  const whopText = result && result in WHOP_RESULTS ? whopSentence(result as WhopResult, whop?.accountName) : null;
  useEffect(() => {
    if (checkedOnArrival.current || !result) return;
    checkedOnArrival.current = true;
    if (result === "payments_allowed" || result === "whop_connected") {
      if (!prefersReducedMotion()) burst(undefined, 120);
      void api()
        .refreshMoney()
        .catch(() => undefined)
        .finally(() => void reloadGetPaid());
    }
  }, [result]);

  // The first step not done is open and brought into view (§40.1), so on a computer its main button is on screen.
  const steps = card?.steps ?? [];
  const stateOf = (id: string): StepState => {
    const s = steps.find((x) => x.id === id);
    return { done: !!s?.done, by: s?.by ?? null, auto: s?.auto };
  };
  // Content Rewards' ticks stay on CRCONN; the server's card also knows the autos (whop_linked ticks move-whop).
  const crDone = (id: string) => (conn?.stepsDone ?? []).includes(id) || !!card?.steps.find((x) => x.id === id)?.done;
  const numberedIds = guide ? drawnSteps(guide).filter((s) => s.role === "earn" || s.role === "payout").map((s) => s.id) : crSteps.filter((s) => s.repeat === "once").map((s) => s.id);
  const current = numberedIds.find((id) => (guide ? !stateOf(id).done : !crDone(id))) ?? null;
  const anchor = hash === "yt-reading" ? "step-yt-reading" : hash?.startsWith("step-") ? hash : hash === "whop" || hash === CR_FINANCE ? hash : null;
  useEffect(() => {
    if (!card) return;
    const to = anchor ?? (result && (result in WHOP_RESULTS) ? "whop" : result ? "step-yt-reading" : current ? `step-${current}` : null);
    if (!to || scrolled.current === to) return;
    // The current step moves only as far as it must (the status block stays on screen when there is room); a link or a
    // result goes to the middle, or to its start when it is taller than the screen (its head stays in sight).
    const t = setTimeout(() => {
      scrolled.current = to;
      const el = document.getElementById(to);
      if (!el) return;
      if (!anchor && !result) el.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      else intoView(el);
    }, 160);
    return () => clearTimeout(t);
  }, [card, anchor, current, result]);

  const isOpen = (id: string) => {
    if (closed.has(id)) return false;
    // The optional reading step stays open right after step 1 while it isn't done (it is never the current step).
    const reading = id === "yt-reading" && (!!paymentsText || needKeys || (stateOf("yt-join").done && !stateOf("yt-reading").done));
    return opened.has(id) || id === current || `step-${id}` === anchor || reading;
  };
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
  const fold = (id: string) =>
    setOpened((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });

  if (load.state === "missing" || where.state === "missing" || (load.state === "ok" && !load.data.places.some((p) => p.place === place)))
    return (
      <div className="page">
        <Empty icon="info" title={load.state === "missing" ? "Get paid is coming in the next update." : "This page does not exist"} heading="h1" action={<LinkButton href={GETPAID_PATH} icon="chevronLeft">Back to Get paid</LinkButton>}>
          {load.state === "missing" ? "Each app still pays you itself. Look in each app for its payout steps." : "The link may be old. Tap Back to Get paid."}
        </Empty>
      </div>
    );
  if (load.state === "error" && !card) return <ErrorPanel message={load.error} onRetry={() => void load.reload()} />;

  const name = placeName(place);

  /** The tapped answer goes away with its folded step: focus moves to that step's head, so a keyboard keeps its place. */
  function focusHead(id: string) {
    setTimeout(() => document.querySelector<HTMLElement>(`#step-${id} > .gstep__head`)?.focus({ preventScroll: true }), 0);
  }

  async function tick(id: string, done: boolean) {
    setBusy(id);
    fold(id);
    focusHead(id);
    try {
      return await tickGetPaid(id, done, (m) => toast.error(m));
    } finally {
      setBusy(null);
    }
  }

  async function tickCr(step: CrStep, done: boolean) {
    if (!conn) return false;
    setBusy(step.id);
    fold(step.id);
    focusHead(step.id);
    patchCr((o) => ({ ...o, connection: { ...o.connection, stepsDone: done ? [...new Set([...o.connection.stepsDone, step.id])] : o.connection.stepsDone.filter((x) => x !== step.id) } }));
    try {
      const connection = await api().crPatchConnection({ step: step.id, done });
      patchCr((o) => ({ ...o, connection }));
      // Content Rewards answers with its connection, not GetPaid: the status is read again.
      scheduleGetPaid(0);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      void reloadCr();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function setFinance(v: boolean | null) {
    setBusy("finance");
    try {
      const connection = await api().crPatchConnection({ finance: v });
      patchCr((o) => ({ ...o, connection }));
      scheduleGetPaid(0);
      // The answer (or the question again) takes the tapped control's place: the focus stays on the question.
      setTimeout(() => document.getElementById(CR_FINANCE)?.focus({ preventScroll: true }), 0);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** Allow payment reading (§40.6): Google's page in this tab; it comes back here by itself with `?result=`. */
  async function allowPayments() {
    setAllowing(true);
    setNeedKeys(false);
    try {
      const { authorizeUrl } = await api().connectAccount("youtube", "payments");
      if (!/^https:\/\//.test(authorizeUrl) && !authorizeUrl.startsWith(`${GETPAID_PATH}/`)) throw new Error("bad authorize url");
      location.assign(authorizeUrl);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNeedKeys(true);
      toast.error(friendlyMessage(e));
      setAllowing(false);
      return false;
    }
  }

  function stopReading() {
    setStopping(true);
    toast.undo("Stopping payment reading…", {
      onUndo: () => {
        setStopping(false);
        stopAct.rewind();
      },
      onCommit: () => {
        api()
          .stopPaymentReading()
          .then(() => reloadGetPaid())
          .catch((e) => toast.error(friendlyMessage(e)))
          .finally(() => setStopping(false));
      },
    });
  }

  async function checkNow() {
    setChecking(true);
    try {
      const out = await api().refreshMoney();
      toast.info(out.started ? `Checking ${name}. This page changes in a moment.` : "Checked a moment ago. Try again in a little while.");
      scheduleGetPaid(1500);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }

  /** The status block's own vermilion: a hold's fix, a reconnect, or "Answer: do you see Finance?" (step id null). */
  function nextButton(n: GetPaidNext) {
    const primary = n.vermilion !== false;
    if (n.label === "Allow payment reading")
      return (
        <Button variant={primary ? "primary" : "glass"} size="lg" icon="eye" act="connect" loading={allowing} onClick={allowPayments} data-help-clear={primary ? "" : undefined}>
          Allow payment reading
        </Button>
      );
    if (n.label === "Connect Whop")
      return (
        <Button variant={primary ? "primary" : "glass"} size="lg" icon="link" act="connect" onClick={() => startWhop((m) => toast.error(m))} data-help-clear={primary ? "" : undefined}>
          Connect Whop
        </Button>
      );
    if (n.external) return <OpenButton label={n.label} href={n.href} primary={primary} size="lg" />;
    // A place on this page (the server's "…/contentrewards#cr-finance"): scrolled to on every tap, with the address
    // (and its ?back=) left as it is. Going to the same address again would do nothing.
    const at = n.href.indexOf("#");
    if (at === 0 || (at > 0 && n.href.slice(0, at) === location.pathname))
      return (
        <Button
          variant={primary ? "primary" : "glass"}
          size="lg"
          icon="chevronDown"
          onClick={() => document.getElementById(n.href.slice(at + 1))?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" })}
          data-help-clear={primary ? "" : undefined}
        >
          {n.label}
        </Button>
      );
    return (
      <LinkButton href={n.href} variant={primary ? "primary" : "glass"} size="lg" iconAfter="chevronRight" data-help-clear={primary ? "" : undefined}>
        {n.label}
      </LinkButton>
    );
  }

  const header = (
    <header className="setup-head glass gp-head" data-help="getpaid-place">
      <PlaceMark place={place} size={34} />
      <div className="setup-head__text">
        <h1 className="setup-head__title">Get paid by {name}</h1>
        <p className="setup-head__meta">{getPaidTime(place)}</p>
        <p className="setup-head__checked">
          <Icon name="checkCircle" size={16} />
          <span>
            Steps checked on <span className="nowrap">{GETPAID_CHECKED}</span>
          </span>
        </p>
      </div>
      {card ? (
        <ProgressRing value={card.ring.total ? card.ring.done / card.ring.total : 0} size={76} label={ringLabel(card)}>
          {card.ring.total && card.ring.done === card.ring.total ? <Icon name="check" size={26} /> : `${card.ring.done}/${card.ring.total}`}
        </ProgressRing>
      ) : null}
    </header>
  );

  if (!card)
    return (
      <div className="setup-page gp-page">
        {header}
        <Skeleton className="setup-skel" />
        <Skeleton className="setup-skel" />
      </div>
    );

  // next.text is said once: not again under the line when the line already says it (it may end with a `when` line).
  const lineHasNext = !!next?.text && card.line.includes(next.text.trim());
  const facts = factsFor(guide ? guide.facts : CR_GETPAID.facts, country);
  const groups = factGroups(facts);
  // The one rule people act on first (to join, or when it pays): on the card; the rest, and the links, in the fold.
  const lead = groups[0]?.texts[0] ?? null;
  const restGroups = groups.map((g, i) => (i === 0 ? { ...g, texts: g.texts.slice(1) } : g));
  const readingGone = place === "youtube" && adsense?.status === "needs_reconnect";

  // ---------- the step cards ----------
  const platformSteps = guide
    ? drawnSteps(guide).map((step) => {
        const st = stateOf(step.id);
        const isNext = next?.stepId === step.id && vermilion;
        return (
          <GetPaidStep
            key={step.id}
            step={step}
            place={place as Platform}
            number={stepNumber(guide, step.id)}
            state={st}
            open={isOpen(step.id)}
            current={current === step.id}
            primary={isNext && !pinned}
            pinned={isNext && pinned}
            phone={phone}
            onToggle={() => toggle(step.id)}
            onDone={step.manual === false ? undefined : (d) => tick(step.id, d)}
            onAction={step.action === "allow_payment_reading" ? allowPayments : undefined}
            busy={busy === step.id}
            actionBusy={allowing}
          >
            {step.id === "yt-reading" ? (
              <>
                {paymentsText ? (
                  <p className={`gp-result${result === "payments_allowed" ? " is-ok" : ""}`} role="status" data-result={result ?? undefined}>
                    <Icon name={result === "payments_allowed" ? "checkCircle" : "info"} size={18} />
                    <span>
                      <Rich text={paymentsText} />
                    </span>
                  </p>
                ) : null}
                {needKeys ? (
                  <div className="gstep__actions">
                    <LinkButton href={SET_UP_YOUTUBE} variant="glass" size="md" iconAfter="chevronRight">
                      Set up YouTube
                    </LinkButton>
                  </div>
                ) : null}
              </>
            ) : null}
          </GetPaidStep>
        );
      })
    : null;
  const numbered = platformSteps?.filter((_, i) => guide && drawnSteps(guide)[i]!.role !== "each_time") ?? [];
  const eachTime = platformSteps?.filter((_, i) => guide && drawnSteps(guide)[i]!.role === "each_time") ?? [];

  const crOnce = crSteps.filter((s) => s.repeat === "once");
  const crEach = crSteps.filter((s) => s.repeat === "each_time");
  const crCard = (step: CrStep, number: number | null) => {
    const isNext = next?.stepId === step.id && vermilion;
    const done = step.repeat === "once" && crDone(step.id);
    const server = card?.steps.find((x) => x.id === step.id);
    return (
      <CrStepCard
        key={step.id}
        // Pinned on a phone, the step's Open lives at the bottom right (one Open, never two).
        step={isNext && pinned ? { ...step, open: undefined } : step}
        number={number}
        done={done}
        open={isOpen(step.id)}
        current={current === step.id}
        primary={isNext && !pinned}
        onToggle={() => toggle(step.id)}
        onDone={step.manual === false ? undefined : (d) => tickCr(step, d)}
        busy={busy === step.id}
        who={done ? whoSaid({ done, by: server?.done ? server.by : "you", auto: server?.auto }) : undefined}
      />
    );
  };

  // ---------- phones: the next step's main action, pinned at the bottom right from page open ----------
  const pinnedMain =
    pinned && target ? (
      <div className="gp-pin" data-gp="pin">
        {"role" in target ? <MainAction step={target} primary onAction={allowPayments} busy={allowing} /> : target.open ? <OpenButton label={target.open.label} href={target.open.url} primary size="lg" /> : null}
      </div>
    ) : null;

  return (
    <div className={`setup-page gp-page${pinned ? " has-pin" : ""}`} data-place={place}>
      {header}

      <section className="gp-status glass" data-help="getpaid-status" aria-labelledby="gp-status-title" data-status={card.status}>
        <h2 className="sr-only" id="gp-status-title">
          Can money reach you from {name}?
        </h2>
        <StatusPill card={card} />
        <p className="gp-status__line">
          <Rich text={card.line} />
        </p>
        {card.missing.map((m) => (
          <p key={m} className="gp-status__small">
            {m}
          </p>
        ))}
        {card.holds.length ? <Holds holds={card.holds} /> : null}
        {readingGone ? <p className="gp-status__small">{READING_GONE}</p> : null}
        {/* Off and a line above already says payments can't be seen: said once. */}
        {card.readingChip && !(!card.readingChip.endsWith("on") && card.missing.some((m) => /can't see .*(payments|payouts)/i.test(m))) ? (
          <p className="gp-chip" data-chip={card.readingChip.endsWith("on") ? "on" : "off"}>
            <Icon name="eye" size={16} />
            <span>{card.readingChip}</span>
          </p>
        ) : null}
        {card.warning ? (
          <p className="callout callout--info gp-warning">
            <Icon name="alert" size={18} />
            <span>{card.warning}</span>
          </p>
        ) : null}
        {next?.stepId && next.text && !lineHasNext ? <p className="gp-status__next">{next.text}</p> : null}
        {next && !next.stepId ? (
          <div className="gp-status__fix">
            {next.hint ? (
              <p className="gp-status__small">
                <Rich text={next.hint} />
              </p>
            ) : null}
            <div className="gstep__actions">
              {nextButton(next)}
            </div>
          </div>
        ) : null}
      </section>

      <section className="gp-facts glass" aria-labelledby="gp-facts-title">
        <h2 className="gp-section__title" id="gp-facts-title">
          Can you earn here?
        </h2>
        {country === null ? (
          <div className="gp-facts__country">
            <p>{PICK_COUNTRY}</p>
            <LinkButton href="/settings/posting/money#money-country" variant="glass" size="sm" icon="globe">
              Pick my country
            </LinkButton>
          </div>
        ) : null}
        {lead ? <p className="gp-facts__lead">{lead}</p> : null}
        {/* The other rules are long and needed only now and then: folded, one tap away. */}
        {groups.length ? (
          <details className="cr-fold gp-facts__fold">
            <summary className="cr-fold__q">
              <Icon name="info" size={18} />
              <span>See all the rules</span>
              <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
            </summary>
            <div className="cr-fold__body">
              {restGroups.map((g, i) => (
                <div key={g.source} className="gp-facts__group">
                  {g.texts.length ? (
                    <ul className="gp-facts__list">
                      {g.texts.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  ) : null}
                  <a className="btn btn--glass btn--sm cr-open" href={g.source} target="_blank" rel="noopener noreferrer">
                    <Icon name="external" size={18} />
                    <span className="btn__label">{rulesLabel(place, g.source)}</span>
                    <span className="sr-only">{` (page ${i + 1} of ${groups.length}, opens in a new tab)`}</span>
                  </a>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      {guide ? (
        <section className="setup-part" aria-labelledby="gp-steps-title">
          <h2 className="setup-part__title" id="gp-steps-title">
            Do these once
          </h2>
          <ol className="guide-steps">{numbered}</ol>
          {eachTime.length || guide.eachTime ? (
            <>
              <h2 className="setup-part__title" id="gp-each-title">
                Each time you get money
              </h2>
              {eachTime.length ? <ol className="guide-steps">{eachTime}</ol> : null}
              {guide.eachTime ? (
                <div className="gp-each glass">
                  <ul className="gstep__say">
                    {guide.eachTime.say.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  {guide.eachTime.open ? <OpenButton label={guide.eachTime.open.label} href={guide.eachTime.open.url} size="md" /> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : (
        <section className="setup-part" aria-labelledby="gp-steps-title">
          <h2 className="setup-part__title" id="gp-steps-title">
            Do these once
          </h2>
          <div className="gstep__picker gp-finance glass" id={CR_FINANCE} tabIndex={-1}>
            <span className="gstep__picker-label">
              <Rich text="Do you see **Finance** in the Content Rewards menu?" />
            </span>
            {finance === undefined ? (
              <Segmented<"yes" | "no" | "">
                label="Do you see Finance in the Content Rewards menu?"
                value=""
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]}
                onChange={(v) => void setFinance(v === "yes")}
              />
            ) : (
              <p className="gstep__note">
                <Icon name="checkCircle" size={18} />
                <span>{finance ? "Yes, I see Finance." : "No Finance in my menu."}</span>
                <Button variant="ghost" size="sm" onClick={() => setFinance(null)} loading={busy === "finance"}>
                  Change my answer
                </Button>
              </p>
            )}
          </div>
          {crOnce.length ? <ol className="guide-steps">{crOnce.map((s, i) => crCard(s, i + 1))}</ol> : null}
          {crEach.length ? (
            <>
              <h2 className="setup-part__title">Each time you get money</h2>
              <ol className="guide-steps">{crEach.map((s) => crCard(s, null))}</ol>
            </>
          ) : null}
          <WhopCard conn={whop} main={!next && whop?.status !== "connected"} result={whopText} />
        </section>
      )}

      <section className="gp-seen glass" aria-labelledby="gp-seen-title">
        <h2 className="gp-section__title" id="gp-seen-title">
          What Clip Factory can see
        </h2>
        <ul className="gp-seen__list">
          {card.seen.map((s) => (
            <li key={s}>
              <Rich text={s} />
            </li>
          ))}
        </ul>
      </section>

      <SentRows sent={card.sent} rows={where.payouts} unpaid={place === "youtube" ? card.unpaid : undefined} here={getPaidPath(place)} />

      <section className="done-panel glass gp-done" aria-labelledby="gp-done-title">
        <h2 className="done-panel__title" id="gp-done-title">
          When it&apos;s done
        </h2>
        <div className="done-panel__actions">
          {place === "youtube" || place === "contentrewards" ? (
            <Button variant="glass" icon="retry" act="retry" loading={checking} onClick={checkNow}>
              Check now
            </Button>
          ) : null}
          {/* Also while it needs a reconnect: the token is still kept until he stops it (§40.6). */}
          {place === "youtube" && (adsense?.status === "connected" || adsense?.status === "needs_reconnect") ? (
            <Button variant="glass" icon="logout" act={stopAct} disabled={stopping} onClick={stopReading}>
              Stop payment reading
            </Button>
          ) : null}
          {back ? (
            <LinkButton href={back.href} variant="glass" icon="chevronLeft" data-gp="back">
              {backLabel(back)}
            </LinkButton>
          ) : (
            <LinkButton href={GETPAID_PATH} variant="ghost" icon="chevronLeft">
              Back to Get paid
            </LinkButton>
          )}
        </div>
      </section>
      {pinnedMain}
    </div>
  );
}

/** Google's or Whop's own words about a hold: plain text, under Show more. */
function Holds({ holds }: { holds: string[] }) {
  const [more, setMore] = useState(false);
  return (
    <div className="gp-holds">
      <button type="button" className="text-link" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? "Show less" : "Show more"}
      </button>
      {more ? (
        <ul className="gp-holds__list">
          {holds.map((h) => (
            <li key={h} className="user-text">
              {h.slice(0, 300)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Where a place's page is, with the way back to `from` when it is one of the back shapes. */
export function getPaidHref(place: GetPaidPlace, from?: string): string {
  const base = getPaidPath(place);
  const back = from ? parseBack(from) : null;
  return back ? `${base}?back=${back.href}` : base;
}
