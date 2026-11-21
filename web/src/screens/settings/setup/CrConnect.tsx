// Step 3 of the Content Rewards setup (docs/CONTRACTS.md §38.3, §38.15): Connect Content Rewards, with the words for
// where the page runs, the "Waiting for you in the browser…" card while the sign-in is open, and the result card
// after it. The run itself is lib/crConnect.ts; this file only draws it.
//
// Content Rewards never sends the browser back when it refuses at sign-in ("This account can't connect apps"), so
// the page asks "What did Content Rewards say?": while it waits (once he comes back to the window), after Cancel and
// when the wait runs out. "It said my account can't connect apps" tells the API (`said: cant_connect`), which opens
// "Content Rewards said no?" on every device; an older API (400) still opens it here. Once Content Rewards answered
// (the door has its code), it never asks: "Connecting…" shows while the API finishes the sign-in.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "../../../api/index.ts";
import { ApiError, friendlyMessage } from "../../../api/errors.ts";
import type { CrConnectResult, CrConnection } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button, LinkButton } from "../../../components/ui.tsx";
import { burst } from "../../../lib/confetti.ts";
import { CONNECT_RESULT_TEXT, patchCr, reloadCr, signedIn } from "../../../lib/contentRewards.ts";
import { ASK_LATE_MS, ASK_MIN_MS, ASK_RETURN_MS, connectPlace, crBridge, PLACE_WORDS, runConnect, type ConnectPlace } from "../../../lib/crConnect.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { cheerOnNextTap } from "../../../lib/sound.ts";
import { sounds } from "../../../lib/sounds.ts";
import { CR_ASK } from "../../../setup/contentrewards.ts";
import { GreenButton, Lines, Note } from "../../campaigns/bits.tsx";

/** Why "What did Content Rewards say?" is on screen: it still waits, he tapped Cancel, or the wait ran out. */
export type CrAskWhy = "waiting" | "canceled" | "no_answer";
/** His answer to it. */
export type CrSaid = "cant_connect" | "allowed" | "other";

export interface CrConnectRun {
  place: ConnectPlace;
  /** The sign-in is open in the browser. */
  waiting: boolean;
  /** Content Rewards answered and the API finishes the sign-in ("Connecting…": no question, no Cancel). */
  finishing: boolean;
  /** "I tapped Allow" after the wait stopped: Check it runs ("Checking…"). */
  checking: boolean;
  /** The last Connect's result (shown once as a card). */
  result: CrConnectResult | null;
  /** The API refused before the browser opened: its sentence. */
  failure: string | null;
  /** "What did Content Rewards say?" is on screen, and why. */
  ask: CrAskWhy | null;
  /** His last answer, for its next line (a new Connect clears it). */
  said: CrSaid | null;
  /** He said Content Rewards refused: "Content Rewards said no?" opens here, even when an older API can't keep it. */
  saidCant: boolean;
  start: () => Promise<boolean>;
  cancel: () => void;
  clear: () => void;
  answer: (a: CrSaid) => Promise<void>;
}

/** Runs Connect Content Rewards in the Mac app. Cancel, or leaving the page, closes the door (§38.15). */
export function useCrConnect(onConnection?: (c: CrConnection) => void): CrConnectRun {
  const [place, setPlace] = useState<ConnectPlace>(() => connectPlace());
  const [waiting, setWaiting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CrConnectResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ask, setAsk] = useState<CrAskWhy | null>(null);
  const [said, setSaidState] = useState<CrSaid | null>(null);
  // The answer as it is now, for the end of a run (its closure holds the one from when it started).
  const saidNow = useRef<CrSaid | null>(null);
  const setSaid = useCallback((v: CrSaid | null) => {
    saidNow.current = v;
    setSaidState(v);
  }, []);
  const [saidCant, setSaidCant] = useState(false);
  // When the browser got the sign-in page (the question waits a little after that).
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const opened = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The last run, until it has ended (a stopped run closes the one door as it ends).
  const last = useRef<Promise<unknown> | null>(null);
  const toast = useToast();
  const onConn = useRef(onConnection);
  onConn.current = onConnection;

  useEffect(() => () => abort.current?.abort(), []);

  // While it waits: ask once he comes back to the window (a short wait first, as a good answer brings the window to
  // the front too and arrives within a second), or by itself after a while. Not again after "I tapped Allow", and never
  // once Content Rewards answered (the door brings the window to the front then, while the API still finishes).
  const quietAsk = waiting && !finishing && openedAt !== null && ask === null && said !== "allowed";
  useEffect(() => {
    if (!quietAsk || openedAt === null) return;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const late = setTimeout(() => setAsk("waiting"), Math.max(0, openedAt + ASK_LATE_MS - Date.now()));
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - openedAt < ASK_MIN_MS || soon) return;
      soon = setTimeout(() => setAsk("waiting"), ASK_RETURN_MS);
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      clearTimeout(late);
      clearTimeout(soon);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [quietAsk, openedAt]);

  /** Stops the wait without asking (an answer already said what happened). */
  const stopWaiting = useCallback(() => {
    if (!abort.current) return;
    abort.current.abort();
    abort.current = null;
    setWaiting(false);
    setFinishing(false);
    void crBridge()?.cancel().catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    const bridge = crBridge();
    if (!bridge) {
      setPlace(connectPlace());
      return false;
    }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setResult(null);
    setFailure(null);
    setAsk(null);
    setSaid(null);
    setOpenedAt(null);
    opened.current = null;
    setFinishing(false);
    setWaiting(true);
    // He tapped Connect again right after Cancel: the stopped run closes the door as it ends, so it must end first, or
    // it would close this run's door.
    await last.current?.catch(() => undefined);
    if (abort.current !== ctl) return false;
    const running = runConnect({
      api: api(),
      bridge,
      signal: ctl.signal,
      onOpened: () => {
        opened.current = Date.now();
        setOpenedAt(opened.current);
      },
      onAnswered: () => {
        if (abort.current !== ctl) return;
        setFinishing(true);
        setAsk(null);
      },
    });
    last.current = running;
    const out = await running;
    if (last.current === running) last.current = null;
    if (abort.current !== ctl) return false;
    abort.current = null;
    setWaiting(false);
    setFinishing(false);
    setAsk(null);
    if (out.kind === "canceled") return false;
    if (out.kind === "no_answer") {
      // Content Rewards never sent the browser back: it does that when it refuses at sign-in. He already said he
      // tapped Allow: never the same question again, only its plain line and Connect again.
      if (saidNow.current !== "allowed") setAsk("no_answer");
      return false;
    }
    if (out.kind === "unsupported") {
      // The Windows app: Connect works only in the Mac app, so the page says what a browser says.
      setPlace("browser");
      return false;
    }
    if (out.kind === "failed") {
      setFailure(out.message);
      toast.error(out.message);
      return false;
    }
    setResult(out.result);
    if (out.result === "connected" || out.result === "read_only") setSaidCant(false);
    if (out.connection) {
      const conn = out.connection;
      patchCr((d) => ({ ...d, connection: conn }));
      onConn.current?.(conn);
    }
    void reloadCr();
    if (out.result === "connected") {
      // Once, right here (the door brought the window to the front). The success sound answers his next tap (§20.8).
      if (!prefersReducedMotion()) burst(undefined, 140);
      cheerOnNextTap(sounds);
      toast.success(CONNECT_RESULT_TEXT.connected);
      return true;
    }
    return out.result === "read_only";
  }, [toast, setSaid]);

  // Cancel: he may be looking at Content Rewards' refusal, so the page asks what it said (only once the browser had
  // its page: before that there is nothing it could have said).
  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setWaiting(false);
    setFinishing(false);
    setAsk(opened.current !== null ? "canceled" : null);
    void crBridge()?.cancel().catch(() => undefined);
  }, []);

  const answer = useCallback(
    async (a: CrSaid) => {
      setAsk(null);
      if (a === "allowed") {
        // Still waiting: keep waiting (the answer is on its way).
        if (abort.current) {
          setSaid("allowed");
          return;
        }
        // Stopped: Check it. "Clip Factory didn't get it" only once the check says he still isn't connected.
        setChecking(true);
        try {
          const out = await api().crCheck();
          patchCr((d) => ({ ...d, connection: out.connection }));
          if (signedIn(out.connection)) {
            setSaid(null);
            onConn.current?.(out.connection);
          } else setSaid("allowed");
        } catch (e) {
          setSaid("allowed");
          toast.error(friendlyMessage(e));
        } finally {
          setChecking(false);
        }
        return;
      }
      stopWaiting();
      setSaid(a);
      if (a === "other") return;
      setSaidCant(true);
      // The API sets lastResult not_allowed and ticks step 1 (he has an account: Content Rewards signed him in).
      const local = (c: CrConnection): CrConnection => ({ ...c, lastResult: "not_allowed", stepsDone: [...new Set([...c.stepsDone, "ready-account"])] });
      try {
        const next = await api().crPatchConnection({ said: "cant_connect" });
        patchCr((d) => ({ ...d, connection: next }));
        onConn.current?.(next);
      } catch (e) {
        patchCr((d) => ({ ...d, connection: local(d.connection) }));
        if (!(e instanceof ApiError && e.status === 400)) {
          toast.error(friendlyMessage(e));
          return;
        }
        // An older API: step 1 ticks the old way; the card stays open here (saidCant).
        try {
          const next = await api().crPatchConnection({ step: "ready-account", done: true });
          patchCr((d) => ({ ...d, connection: local(next) }));
        } catch {
          /* the tick waits for the next visit */
        }
      }
    },
    [stopWaiting, toast, setSaid],
  );

  return { place, waiting, finishing, checking, result, failure, ask, said, saidCant, start, cancel, clear: () => setResult(null), answer };
}

/** "What did Content Rewards say?" with its three big answers (the Ask launcher never rests on them). After Cancel or
 * the time-out the Cancel button is gone, so focus moves to the question; while it waits, the waiting card's status
 * line says it instead (focus stays where it is). */
function CrAskCard({ run }: { run: CrConnectRun }) {
  const id = useId();
  const q = useRef<HTMLParagraphElement>(null);
  const moveFocus = run.ask !== "waiting";
  useEffect(() => {
    if (moveFocus) q.current?.focus({ preventScroll: true });
  }, [moveFocus]);
  return (
    <div className="cr-said" role="group" aria-labelledby={id} data-cr="ask">
      {run.ask === "no_answer" ? <p className="cr-said__lead">{CR_ASK.noAnswer}</p> : null}
      <p className="cr-said__q" id={id} ref={q} tabIndex={-1}>
        {CR_ASK.question}
      </p>
      <div className="cr-said__answers" data-help-clear="">
        <GreenButton size="lg" icon="alert" onClick={() => run.answer("cant_connect")}>
          {CR_ASK.cant}
        </GreenButton>
        <GreenButton size="lg" onClick={() => run.answer("allowed")}>
          {CR_ASK.allowed}
        </GreenButton>
        <Button variant="glass" size="lg" icon="question" onClick={() => run.answer("other")}>
          {CR_ASK.other}
        </Button>
      </div>
    </div>
  );
}

/** Step 3's controls for where the page runs. `primary`: Connect (or Get the app) is the screen's vermilion. */
export function CrConnectControls({
  run,
  primary,
  label = "Connect Content Rewards",
  words,
}: {
  run: CrConnectRun;
  primary: boolean;
  label?: string;
  /** Other words for where the page runs (a phone opened from a campaign: where that campaign is on the Mac). */
  words?: Partial<Record<Exclude<ConnectPlace, "bridge">, string[]>>;
}) {
  if (run.place === "bridge") {
    if (run.waiting)
      return (
        <div className="cr-waiting-wrap" data-help="cr-connect">
          <div className="cr-waiting glass" role="status">
            <span className="spinner" aria-hidden="true" />
            <span className="cr-waiting__text">{run.finishing ? CR_ASK.finishing : run.said === "allowed" ? CR_ASK.waiting : "Waiting for you in the browser…"}</span>
            {/* Content Rewards answered: the sign-in is being finished, so nothing to cancel (it takes a few seconds). */}
            {run.finishing ? null : (
              <Button variant="glass" size="md" icon="x" act="clear" onClick={run.cancel}>
                Cancel
              </Button>
            )}
            <span className="sr-only">{run.ask === "waiting" && !run.finishing ? ` ${CR_ASK.question}` : ""}</span>
          </div>
          {run.ask === "waiting" && !run.finishing ? <CrAskCard run={run} /> : null}
        </div>
      );
    // After Cancel or a wait with no answer: the question first, Connect again once he answered.
    if (run.ask) return <CrAskCard run={run} />;
    if (run.checking)
      return (
        <div className="cr-waiting glass" role="status" data-help="cr-connect">
          <span className="spinner" aria-hidden="true" />
          <span className="cr-waiting__text">{CR_ASK.checking}</span>
        </div>
      );
    const line = run.said === "other" ? CR_ASK.other_next : run.said === "allowed" ? CR_ASK.missed : null;
    return (
      <div className="gstep__connect" data-help="cr-connect">
        {line ? <Note role="status">{line}</Note> : null}
        <Button variant={primary ? "primary" : "glass"} size="lg" icon="link" act="connect" data-help-clear="" onClick={() => run.start()}>
          {label}
        </Button>
      </div>
    );
  }
  return (
    <div className="gstep__connect cr-place" data-help="cr-connect" data-place={run.place}>
      <Lines lines={words?.[run.place] ?? PLACE_WORDS[run.place]} className="gstep__say cr-place__words" />
      {run.place === "browser" || run.place === "old_app_cant_update" ? (
        <LinkButton href="/get-app" variant={primary ? "primary" : "glass"} size="lg" icon="download" data-help-clear="">
          Get the app
        </LinkButton>
      ) : null}
    </div>
  );
}

/** The card after a Connect (§38.3): confetti already played for `connected`. `next`: "Next: back to FaZe Clips."
 * when the page was opened with a way back (§39.1), with `action` (the way back) right under it, on screen at once. */
export function CrResultCard({ result, onClose, next, action }: { result: CrConnectResult; onClose: () => void; next?: string; action?: ReactNode }) {
  const ok = result === "connected";
  return (
    <section className={`result-card${ok ? " result-card--ok" : ""} glass`} role={ok ? "status" : "alert"} data-result={result}>
      <Icon name={ok ? "checkCircle" : "info"} size={30} />
      <div className="result-card__text">
        <h2 className="result-card__title">{ok ? "Connected!" : result === "read_only" ? "Connected, almost" : "Not connected yet"}</h2>
        <p>{CONNECT_RESULT_TEXT[result]}</p>
        {next ? <p className="result-card__next">{next}</p> : null}
        {action ? <div className="result-card__actions">{action}</div> : null}
        <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
