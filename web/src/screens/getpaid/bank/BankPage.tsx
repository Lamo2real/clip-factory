// The bank page (docs/CONTRACTS.md §40.5.2), /settings/posting/getpaid/bank. Top to bottom: the header (the card mark,
// "Your bank", the ring, "About 25 minutes · Free", the day the steps were checked); the status block (the pill, the
// line, the next step's words, and Reconnect when a link needs it); the connect card (what came back from BankID);
// the step cards; Your banks; Is this from an app?; Reached your bank; What Clip Factory keeps; When it's done.
//
// The page's only vermilion is `next` (§40.5.9): while setting up, the next step's main action (its Open, or Clip
// Factory's own button), pinned bottom right on phones from the moment the page opens; once every step is done,
// "Reconnect Swedbank" in the status block when a link needs it. Otherwise none. The green answers stay green.
// Once he tapped a step's Open (Enable Banking's page is open in another tab), opening it again is not the next tap:
// the Open turns glass and the step's green answer ("I'm in", "I did this", "I linked them") is its main tap, pinned
// bottom right on phones in the Open's place. While Clip Factory can't read a bank, or the bank wants him to do
// something first, "Check now" (glass) sits in the status block beside the line that names it; when questions wait,
// the status block says how many, with a glass "Answer them".
import "../../../styles/getpaid.css";
import "../../../styles/bank.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, friendlyMessage } from "../../../api/index.ts";
import type { BankAnswer, BankAppCode, BankResult, BankRow, BankStepId, BankTickId } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button, Empty, ErrorPanel, LinkButton, Skeleton } from "../../../components/ui.tsx";
import {
  BANK_CHECKED,
  BANK_GUIDE,
  BANK_PATH,
  BANK_TIME,
  CHECKING_FIRST,
  NO_APP_ID,
  OPEN_APPS,
  bankStep,
  findAppId,
  isBankResult,
  numberedBankSteps,
  resultSentence,
  tryAgainAt,
  type BankError,
  type BankStep,
} from "../../../getpaid/bank.ts";
import { GETPAID_PATH } from "../../../getpaid/index.ts";
import { backLabel, backLink, parseBack, type BackLink } from "../../../lib/backLink.ts";
import { clearConnectSent, connectSent, markConnectSent, putBank, reloadBank, sendFirstRead, useBank, useHeld } from "../../../lib/bank.ts";
import { BANK_TEXT } from "../../../lib/getPaid.ts";
import { burst } from "../../../lib/confetti.ts";
import { usePinMain } from "../../../lib/contentRewards.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { useHash } from "../../../lib/router.ts";
import { sounds } from "../../../lib/sounds.ts";
import { OpenButton } from "../../campaigns/bits.tsx";
import { Rich } from "../../settings/setup/bits.tsx";
import { BankAsks } from "./BankAsks.tsx";
import { BankKeyBox, KeyMain } from "./BankKeyBox.tsx";
import { BankLinks, BankPill, BankRing } from "./BankLinks.tsx";
import { ANSWER_THEM, BankKeeps, ReachedSection } from "./BankMoney.tsx";
import { BankPicker, type PickedBank } from "./BankPicker.tsx";
import { BankSteps, StepAnswer, hasAnswer } from "./BankSteps.tsx";

/** A `?result=` read on arrival is shown from `lastConnect` only when it is this fresh (§40.5.2 Connect, step 5). */
const FRESH_MS = 15 * 60_000;
const HOUR = 3_600_000;

/** Reads `?result=` once and takes it out of the address (a reload does not say it again). Unknown reads as an error. */
export function takeBankResult(): BankResult | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  if (!q.has("result")) return null;
  const code = q.get("result") ?? "";
  q.delete("result");
  const rest = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return isBankResult(code) ? code : "bank_error";
}

/** `?back=`, kept for this tab while Enable Banking's and the bank's pages run, so the way back survives `?result=`. */
function takeBack(): BackLink | null {
  if (typeof location === "undefined") return null;
  const key = "cf-getpaid-back:bank";
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

export function BankPage() {
  const [back] = useState(() => takeBack());
  const [arrived] = useState(() => takeBankResult());
  const load = useBank();
  const view = load.state === "ok" || load.state === "error" ? load.view : null;
  const toast = useToast();
  const hold = useHeld();
  const pinOn = usePinMain();
  const hash = useHash();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState<"save" | "check" | "pem" | null>(null);
  const [paste, setPaste] = useState("");
  /** The check answered in this visit (Save, Check again): its words and its code go together (§40.5.4). */
  const [check, setCheck] = useState<{ code: BankAppCode; text: string } | null>(null);
  /** The steps whose Open he tapped in this visit: their green answer is the next tap now, not the Open again. */
  const [tappedOpen, setTappedOpen] = useState<Set<BankStepId>>(new Set());
  const [linkCheck, setLinkCheck] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  /** Enable Banking's page was opened (location.assign ran): only from then may coming back stop the wait. */
  const [away, setAway] = useState(false);
  const [checking, setChecking] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [card, setCard] = useState<{ result: BankResult; text: string } | null>(null);
  const shownCard = useRef(false);
  const scrolled = useRef<string | null>(null);

  // ---------- What came back from BankID (§40.5.2 Connect, step 5) ----------
  function celebrate(result: BankResult) {
    if (result === "bank_connected") {
      if (!prefersReducedMotion()) burst(undefined, 120);
      sounds.play("success");
    } else sounds.play("deny");
  }
  // With `?result=`: lastConnect's sentence when it is the same and fresh, else the result's own words.
  useEffect(() => {
    if (!arrived || !view || shownCard.current) return;
    shownCard.current = true;
    const lc = view.lastConnect;
    const fresh = lc && lc.result === arrived && Date.now() - Date.parse(lc.at) < FRESH_MS;
    setCard({ result: arrived, text: fresh ? lc.text : resultSentence(arrived) });
    celebrate(arrived);
    if (arrived === "bank_connected") sendFirstRead(fresh ? `lc:${lc.at}` : "arrived");
  }, [arrived, view]);
  // With no query (the Mac app, or another browser): once lastConnect is newer than the connect this page sent.
  useEffect(() => {
    const sent = connectSent();
    const lc = view?.lastConnect;
    if (arrived || !sent || !lc || Date.parse(lc.at) <= Date.parse(sent)) return;
    clearConnectSent();
    setConnecting(null);
    setCard({ result: lc.result, text: lc.text });
    celebrate(lc.result);
    if (lc.result === "bank_connected") sendFirstRead(`lc:${lc.at}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.lastConnect?.at, arrived]);
  // The Mac app opens Enable Banking in the system browser and this page waits (§17.1 useConnecting): the spinner
  // stops when he comes back to the window, or when the browser brings this page back with Back.
  // Armed only once Enable Banking's page was opened: a blur and focus while POST /connect is still on its way never
  // stops the wait early (the buttons stay off, so one tap starts one authorisation).
  useEffect(() => {
    if (!connecting || !away) return;
    const stop = () => {
      setConnecting(null);
      setAway(false);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) stop();
    };
    window.addEventListener("pageshow", onShow);
    const t = setTimeout(() => window.addEventListener("focus", stop), 400);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", stop);
      window.removeEventListener("pageshow", onShow);
    };
  }, [connecting, away]);
  // A new link still waiting for its first read, within the hour after BankID: the first read is asked for once.
  useEffect(() => {
    const lc = view?.lastConnect;
    if (!lc || lc.result !== "bank_connected" || Date.now() - Date.parse(lc.at) > HOUR) return;
    if (view.links.some((l) => l.status === "checking")) sendFirstRead(`lc:${lc.at}`);
  }, [view]);

  // ---------- The steps ----------
  const stateOf = (id: BankStepId) => view?.steps.find((s) => s.id === id);
  const current = view ? (numberedBankSteps().find((s) => !stateOf(s.id)?.done)?.id ?? null) : null;
  const next = view?.next ?? null;
  const nextStep = next?.stepId ? bankStep(next.stepId) : null;
  const hasMain = !!nextStep && (nextStep.action !== undefined || (!!nextStep.open && !nextStep.mail));
  // He opened Enable Banking for the next step already: its green answer is the next tap, never the Open again.
  const nextAnswer = nextStep && !nextStep.action && tappedOpen.has(nextStep.id) && hasAnswer(nextStep) ? nextStep : null;
  const vermilion = !!next && next.vermilion && !nextAnswer;
  const pinned = pinOn && ((vermilion && (next.stepId === null || hasMain)) || !!nextAnswer);
  const anchor = hash?.startsWith("step-") || hash === "bank-asks" ? hash : null;

  useEffect(() => {
    if (!view) return;
    const to = anchor ?? (card ? "bank-connect-card" : current ? `step-${current}` : null);
    if (!to || scrolled.current === to) return;
    const t = setTimeout(() => {
      scrolled.current = to;
      document.getElementById(to)?.scrollIntoView?.({ block: anchor || card ? "center" : "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, 160);
    return () => clearTimeout(t);
  }, [view, anchor, current, card]);

  const isOpen = (id: BankStepId) => {
    if (closed.has(id)) return false;
    const ask = id === "bank-ask" && view?.status === "not_started" && !stateOf("bank-ask")?.done;
    // Step 5 stays open while its "Now delete the .pem file" line waits for I deleted it.
    const pem = id === "bank-appid" && !!view?.key.pemReminder;
    return opened.has(id) || id === current || `step-${id}` === anchor || ask || pem;
  };
  /** Step 5 stays open after Save and Check again, so the check's sentence is seen (§40.5.4). */
  const keepOpen = (id: BankStepId) =>
    setOpened((s) => {
      const n = new Set(s);
      n.add(id);
      return n;
    });
  const toggle = (id: BankStepId) => {
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

  if (load.state === "off" || (load.state === "error" && !view))
    return (
      <div className="setup-page gp-page bank-page" data-bank="off">
        {load.state === "error" ? <ErrorPanel message={load.error} onRetry={() => void load.reload()} /> : null}
        <Empty icon="card" title="Your bank" heading="h1" action={<LinkButton href={GETPAID_PATH} icon="chevronLeft">Back to Get paid</LinkButton>}>
          {BANK_TEXT}
        </Empty>
      </div>
    );

  // ---------- His taps ----------
  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    try {
      return await fn();
    } catch (e) {
      toast.error(friendlyMessage(e));
      void reloadBank();
      return null;
    } finally {
      setBusy(null);
    }
  }
  async function tick(id: BankStepId, done: boolean) {
    fold(id);
    const v = await run(id, () => api().bankStep(id as BankTickId, done));
    if (v) putBank(v);
    setTimeout(() => document.querySelector<HTMLElement>(`#step-${id} > .gstep__head`)?.focus({ preventScroll: true }), 0);
    return !!v;
  }
  async function makeKey() {
    const v = await run("bank-key", () => api().bankMakeKey());
    if (v) putBank(v);
    return !!v;
  }
  function openedStep(id: BankStepId) {
    setTappedOpen((s) => (s.has(id) ? s : new Set(s).add(id)));
  }
  async function saveAppId() {
    const found = findAppId(paste);
    if (!found) {
      toast.error(NO_APP_ID.replace(/\*\*/g, ""));
      return false;
    }
    setKeyBusy("save");
    try {
      const out = await api().bankSaveApp({ appId: found });
      keepOpen("bank-appid");
      putBank(out.view);
      setCheck(out.check);
      setPaste("");
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setKeyBusy(null);
    }
  }
  async function checkApp(which: "check" | "linked") {
    if (which === "check") setKeyBusy("check");
    else setBusy("bank-link");
    try {
      const out = await api().bankCheckApp();
      keepOpen(which === "check" ? "bank-appid" : "bank-link");
      putBank(out.view);
      if (which === "check") setCheck(out.check);
      else setLinkCheck(out.check.text);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setKeyBusy(null);
      setBusy(null);
    }
  }
  async function sendPem(pem: string, fileName?: string) {
    const appId = findAppId(paste);
    setKeyBusy("pem");
    try {
      const out = await api().bankSaveApp({ pem, ...(fileName ? { fileName } : {}), ...(appId ? { appId } : {}) });
      keepOpen("bank-appid");
      putBank(out.view);
      setCheck(out.check);
      setPaste("");
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setKeyBusy(null);
    }
  }
  async function pemDeleted() {
    const v = await run("pem", () => api().bankStep("pem-deleted", true));
    if (v) putBank(v);
  }
  /** Connect (or reconnect): Enable Banking's page in this tab; in the Mac app the system browser, and this page waits. */
  async function connect(body: PickedBank | { linkId: string }) {
    const key = "linkId" in body ? body.linkId : "new";
    setConnecting(key);
    try {
      const { authorizeUrl } = await api().bankConnect("linkId" in body ? { linkId: body.linkId } : { bank: body.bank });
      if (!/^https:\/\//.test(authorizeUrl) && !authorizeUrl.startsWith("/mock-bank")) throw new Error("bad authorize url");
      markConnectSent();
      setPicker(false);
      location.assign(authorizeUrl);
      setAway(true);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      setConnecting(null);
      setAway(false);
      return false;
    }
  }
  async function checkNow() {
    setChecking(true);
    try {
      putBank(await api().bankCheckNow());
      toast.info("Checking your bank. This page changes in a moment.");
      return true;
    } catch (e) {
      const err = e as BankError;
      if (err.bankCode === "rate_limited" || err.status === 429) toast.info(`${friendlyMessage(e)} ${tryAgainAt(err.retryAt)}`.trim());
      else toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }
  function forget() {
    setForgetting(true);
    const held = hold(() => {
      api()
        .bankForget()
        .then(() => reloadBank())
        .catch((e) => toast.error(friendlyMessage(e)))
        .finally(() => setForgetting(false));
    });
    toast.undo("Forgetting your bank…", {
      signal: held.signal,
      onUndo: () => {
        held.drop();
        setForgetting(false);
      },
      onCommit: held.send,
    });
  }
  async function notThis(row: BankRow) {
    const v = await run(row.depositId, () => api().bankAnswer(row.depositId, { answer: "not_this" } as BankAnswer));
    if (v) {
      putBank(v);
      toast.info("Moved to Is this from an app?");
    }
  }

  // ---------- The header ----------
  const header = (
    <header className="setup-head glass gp-head bank-head" data-help="getpaid-bank">
      <span className="setup-card__mark gp-mark bank-mark" aria-hidden="true">
        <Icon name="card" size={34} />
      </span>
      <div className="setup-head__text">
        <h1 className="setup-head__title">Your bank</h1>
        {/* How long it takes and what it costs matter only before it is set up. */}
        {view && view.ring.done === view.ring.total ? null : <p className="setup-head__meta">{BANK_TIME}</p>}
        <p className="setup-head__checked">
          <Icon name="checkCircle" size={16} />
          <span>
            Steps checked on <span className="nowrap">{BANK_CHECKED}</span>
          </span>
        </p>
      </div>
      {view ? <BankRing view={view} size={76} /> : null}
    </header>
  );
  if (!view)
    return (
      <div className="setup-page gp-page bank-page">
        {header}
        <Skeleton className="setup-skel" />
        <Skeleton className="setup-skel" />
      </div>
    );

  // ---------- The main actions ----------
  const appIdSaved = !!view.key.appIdHint;
  const crOn = "contentrewards" in view.places;
  const reconnectLink = next && !next.stepId && next.linkId ? view.links.find((l) => l.linkId === next.linkId) : null;
  function mainButton(step: BankStep, primary: boolean): ReactNode {
    const st = stateOf(step.id);
    switch (step.action) {
      case "make_bank_key":
        return st?.done ? null : (
          <Button variant={primary ? "primary" : "glass"} size="lg" icon="key" loading={busy === "bank-key"} onClick={makeKey} data-help-clear={primary ? "" : undefined} data-bank="make-key">
            Make my bank key
          </Button>
        );
      case "connect_bank":
        return st?.done ? null : (
          <Button variant={primary ? "primary" : "glass"} size="lg" icon="card" act="connect" loading={connecting === "new"} onClick={() => setPicker(true)} data-help-clear={primary ? "" : undefined} data-bank="connect">
            Connect your bank
          </Button>
        );
      case "save_app_id":
        return <KeyMain saved={appIdSaved} primary={primary} busy={keyBusy === "pem" ? null : keyBusy} onSave={saveAppId} onCheck={() => checkApp("check")} />;
      default:
        return step.open && !step.mail ? <OpenButton label={step.open.label} href={step.open.url} primary={primary} size="lg" onOpen={() => openedStep(step.id)} /> : null;
    }
  }
  const mainOf = (step: BankStep): ReactNode => {
    const isNext = next?.stepId === step.id && vermilion;
    if (isNext && pinned) return null;
    if (step.action === "save_app_id") return null;
    return mainButton(step, isNext);
  };
  const reconnectButton = (primary: boolean) =>
    reconnectLink ? (
      <Button
        variant={primary ? "primary" : "glass"}
        size="lg"
        icon="retry"
        act="connect"
        loading={connecting === reconnectLink.linkId}
        disabled={!!connecting && connecting !== reconnectLink.linkId}
        onClick={() => connect({ linkId: reconnectLink.linkId })}
        data-help-clear={primary ? "" : undefined}
        data-bank="reconnect"
      >
        {next!.label}
      </Button>
    ) : null;

  const lineHasNext = !!next?.text && view.line.includes(next.text.trim());
  const anyLink = view.links.length > 0;
  // The status line says "Tap Check now": the button sits right there (glass), not five screens down.
  const checkHere = anyLink && (view.status === "cant_read" || view.status === "look_in_bank");
  const checkNowButton = (
    <Button variant="glass" icon="retry" act="retry" loading={checking} onClick={checkNow} data-bank="check-now">
      Check now
    </Button>
  );
  const needYou = view.reached.needYou && view.asks.length ? view.reached.needYou : null;
  const toAsks = () => {
    const el = document.getElementById("bank-asks");
    el?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  };
  const answerButton = (step: BankStep) => <StepAnswer step={step} busy={busy} onTick={tick} onLinked={() => checkApp("linked")} pinned />;
  const appIdDone = !!stateOf("bank-appid")?.done;
  const keyStep = next?.stepId === "bank-appid";
  const checkingFirst = card?.result === "bank_connected" && view.links.some((l) => l.status === "checking");

  return (
    <div className={`setup-page gp-page bank-page${pinned ? " has-pin" : ""}`} data-bank-status={view.status}>
      {header}

      <section className="gp-status glass" data-help="bank-status" aria-labelledby="bank-status-title" data-status={view.status}>
        <h2 className="sr-only" id="bank-status-title">
          Can Clip Factory see your bank?
        </h2>
        <BankPill status={view.status} tone={view.tone} pill={view.pill} />
        <p className="gp-status__line">
          <Rich text={view.line} />
        </p>
        {next?.stepId && next.text && !lineHasNext ? <p className="gp-status__next">{next.text}</p> : null}
        {(next && !next.stepId && reconnectLink && !pinned) || checkHere ? (
          <div className="gstep__actions bank-status__actions">
            {next && !next.stepId && reconnectLink && !pinned ? reconnectButton(next.vermilion) : null}
            {checkHere ? checkNowButton : null}
          </div>
        ) : null}
        {needYou ? (
          <div className="bank-status__need" data-bank="need-you">
            <p className="gp-status__small">{needYou}</p>
            <Button variant="glass" size="sm" iconAfter="chevronDown" onClick={toAsks}>
              {ANSWER_THEM}
            </Button>
          </div>
        ) : null}
      </section>

      {card ? (
        <section className={`bank-connect glass${card.result === "bank_connected" ? " is-ok" : ""}`} id="bank-connect-card" data-result={card.result} aria-live="polite">
          <p className="gp-result">
            <Icon name={card.result === "bank_connected" ? "checkCircle" : "info"} size={20} />
            <span>{card.text}</span>
          </p>
          {checkingFirst ? <p className="gp-status__small">{CHECKING_FIRST}</p> : null}
          {card.result === "bank_no_accounts" ? <OpenButton label={OPEN_APPS.label} href={OPEN_APPS.url} size="md" /> : null}
        </section>
      ) : null}

      <BankSteps
        view={view}
        isOpen={isOpen}
        onToggle={toggle}
        current={current}
        mainOf={mainOf}
        onTick={tick}
        onLinked={() => checkApp("linked")}
        busy={busy}
        linkCheck={linkCheck}
        answerPinned={pinned && nextAnswer ? nextAnswer.id : null}
        quietKey={appIdDone && appIdSaved && !paste.trim()}
        keyBox={
          <BankKeyBox
            view={view}
            paste={paste}
            onPaste={setPaste}
            primary={keyStep && vermilion && !pinned}
            pinned={keyStep && pinned}
            busy={keyBusy}
            onSave={saveAppId}
            onCheck={() => checkApp("check")}
            onPem={sendPem}
            onPemDeleted={pemDeleted}
            check={check ?? (view.key.check ? { code: view.key.check.code, text: view.key.check.text } : null)}
          />
        }
      />

      {anyLink ? <BankLinks view={view} onReconnect={(linkId) => void connect({ linkId })} connecting={connecting} mainLinkId={next && !next.stepId && next.vermilion ? (next.linkId ?? null) : null} /> : null}

      <BankAsks view={view} crOn={crOn} />

      <ReachedSection view={view} onNotThis={(row) => void notThis(row)} busy={busy} />

      <BankKeeps />

      {anyLink || back ? (
        <section className="done-panel glass gp-done" aria-labelledby="bank-done-title">
          <h2 className="done-panel__title" id="bank-done-title">
            When it&apos;s done
          </h2>
          <div className="done-panel__actions">
            {anyLink && !checkHere ? checkNowButton : null}
            {anyLink && view.canAddBank ? (
              <Button variant="glass" icon="plus" loading={connecting === "new"} disabled={!!connecting && connecting !== "new"} onClick={() => setPicker(true)}>
                Connect another bank
              </Button>
            ) : null}
            {anyLink ? (
              <Button variant="ghost" icon="trash" disabled={forgetting} onClick={forget}>
                Forget my bank
              </Button>
            ) : null}
            {back ? (
              <LinkButton href={back.href} variant="glass" icon="chevronLeft" data-gp="back">
                {backLabel(back)}
              </LinkButton>
            ) : null}
          </div>
        </section>
      ) : null}
      {!back ? (
        <div className="bank-back">
          <LinkButton href={GETPAID_PATH} variant="ghost" icon="chevronLeft">
            Back to Get paid
          </LinkButton>
        </div>
      ) : null}

      {pinned ? (
        <div className="gp-pin" data-gp="pin">
          {nextAnswer ? answerButton(nextAnswer) : next?.stepId ? mainButton(nextStep!, true) : reconnectButton(true)}
        </div>
      ) : null}

      {picker ? <BankPicker view={view} onClose={() => setPicker(false)} onPick={(b) => connect(b)} /> : null}
    </div>
  );
}

/** Where the Your bank page is, with the way back to `from` when it is one of the back shapes. */
export function bankHref(from?: string): string {
  const back = from ? parseBack(from) : null;
  return back ? `${BANK_PATH}?back=${back.href}` : BANK_PATH;
}

/** Every step the guide has (for the screen tests). */
export const BANK_STEP_IDS = BANK_GUIDE.steps.map((s) => s.id);
