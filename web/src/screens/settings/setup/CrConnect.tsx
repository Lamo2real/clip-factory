// Step 3 of the Content Rewards setup (docs/CONTRACTS.md §38.3, §38.15): Connect Content Rewards, with the words for
// where the page runs, the "Waiting for you in the browser…" card while the sign-in is open, and the result card
// after it. The run itself is lib/crConnect.ts; this file only draws it.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/index.ts";
import type { CrConnectResult, CrConnection } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button, LinkButton } from "../../../components/ui.tsx";
import { burst } from "../../../lib/confetti.ts";
import { CONNECT_RESULT_TEXT, patchCr, reloadCr } from "../../../lib/contentRewards.ts";
import { connectPlace, crBridge, PLACE_WORDS, runConnect, type ConnectPlace } from "../../../lib/crConnect.ts";
import { prefersReducedMotion } from "../../../lib/prefs.ts";
import { sounds } from "../../../lib/sounds.ts";
import { Lines } from "../../campaigns/bits.tsx";

export interface CrConnectRun {
  place: ConnectPlace;
  /** The sign-in is open in the browser. */
  waiting: boolean;
  /** The last Connect's result (shown once as a card). */
  result: CrConnectResult | null;
  /** The API refused before the browser opened: its sentence. */
  failure: string | null;
  start: () => Promise<boolean>;
  cancel: () => void;
  clear: () => void;
}

/** Runs Connect Content Rewards in the Mac app. Cancel, or leaving the page, closes the door (§38.15). */
export function useCrConnect(onConnection?: (c: CrConnection) => void): CrConnectRun {
  const [place, setPlace] = useState<ConnectPlace>(() => connectPlace());
  const [waiting, setWaiting] = useState(false);
  const [result, setResult] = useState<CrConnectResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const toast = useToast();
  const onConn = useRef(onConnection);
  onConn.current = onConnection;

  useEffect(() => () => abort.current?.abort(), []);

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
    setWaiting(true);
    const out = await runConnect({ api: api(), bridge, signal: ctl.signal });
    if (abort.current !== ctl) return false;
    abort.current = null;
    setWaiting(false);
    if (out.kind === "canceled") return false;
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
    if (out.connection) {
      const conn = out.connection;
      patchCr((d) => ({ ...d, connection: conn }));
      onConn.current?.(conn);
    }
    void reloadCr();
    if (out.result === "connected") {
      // Once, right here (the door brought the window to the front; the owner's tap started it).
      if (!prefersReducedMotion()) burst(undefined, 140);
      sounds.play("success");
      toast.success(CONNECT_RESULT_TEXT.connected);
      return true;
    }
    if (out.result !== "read_only") sounds.play("deny");
    return out.result === "read_only";
  }, [toast]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setWaiting(false);
    void crBridge()?.cancel().catch(() => undefined);
  }, []);

  return { place, waiting, result, failure, start, cancel, clear: () => setResult(null) };
}

/** Step 3's controls for where the page runs. `primary`: Connect (or Get the app) is the screen's vermilion. */
export function CrConnectControls({ run, primary, label = "Connect Content Rewards" }: { run: CrConnectRun; primary: boolean; label?: string }) {
  if (run.place === "bridge") {
    if (run.waiting)
      return (
        <div className="cr-waiting glass" role="status" data-help="cr-connect">
          <span className="spinner" aria-hidden="true" />
          <span className="cr-waiting__text">Waiting for you in the browser…</span>
          <Button variant="glass" size="md" icon="x" act="clear" onClick={run.cancel}>
            Cancel
          </Button>
        </div>
      );
    return (
      <div className="gstep__connect" data-help="cr-connect">
        <Button variant={primary ? "primary" : "glass"} size="lg" icon="link" act="connect" data-help-clear="" onClick={() => run.start()}>
          {label}
        </Button>
      </div>
    );
  }
  return (
    <div className="gstep__connect cr-place" data-help="cr-connect" data-place={run.place}>
      <Lines lines={PLACE_WORDS[run.place]} className="gstep__say cr-place__words" />
      {run.place === "browser" || run.place === "old_app_cant_update" ? (
        <LinkButton href="/get-app" variant={primary ? "primary" : "glass"} size="lg" icon="download" data-help-clear="">
          Get the app
        </LinkButton>
      ) : null}
    </div>
  );
}

/** The card after a Connect (§38.3): confetti already played for `connected`. */
export function CrResultCard({ result, onClose }: { result: CrConnectResult; onClose: () => void }) {
  const ok = result === "connected";
  return (
    <section className={`result-card${ok ? " result-card--ok" : ""} glass`} role={ok ? "status" : "alert"} data-result={result}>
      <Icon name={ok ? "checkCircle" : "info"} size={30} />
      <div className="result-card__text">
        <h2 className="result-card__title">{ok ? "Connected!" : result === "read_only" ? "Connected, almost" : "Not connected yet"}</h2>
        <p>{CONNECT_RESULT_TEXT[result]}</p>
        <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
