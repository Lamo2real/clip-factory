// "See your Whop payouts here" (docs/CONTRACTS.md §40.6), the optional card on Content Rewards' Get paid page. Behind
// the API's WHOP_CONNECT switch: while it is off (`connections.whop` is null) the card only says "Coming soon". The
// owner makes his own Whop app once (a public client, no secret), pastes its key here, then taps Connect Whop. Clip
// Factory only reads his payouts: it never asks to move money. Every button is glass unless the page has no next step
// and Whop isn't connected (§40.1 item 2).
import { useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { PayConn } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button } from "../../components/ui.tsx";
import { putGetPaid, reloadGetPaid, WHOP_KEY, WHOP_KEY_BAD } from "../../lib/getPaid.ts";
import { useAction } from "../../lib/motion.ts";
import { Hints, Lines, OpenButton } from "../campaigns/bits.tsx";
import { CopyChip, readClipboard } from "../settings/setup/bits.tsx";

export const WHOP_DEVELOPER = "https://whop.com/dashboard/developer";
export const WHOP_SOON = "Coming soon: your Whop payouts here.";
const SCOPES = "Tick **user:balance:read**, **payout:withdrawal:read**, **payout:destination:read** and **identity:read**.";

/** Starts Connect Whop: the authorize page in this tab (only Whop's https page, or the mock's own page). */
export async function startWhop(onError: (m: string) => void): Promise<boolean> {
  try {
    const { authorizeUrl } = await api().connectWhop();
    if (!/^https:\/\//.test(authorizeUrl) && !authorizeUrl.startsWith("/settings/posting/getpaid/")) throw new Error("bad authorize url");
    location.assign(authorizeUrl);
    return true;
  } catch (e) {
    onError(friendlyMessage(e));
    return false;
  }
}

export function WhopCard({ conn, main, result }: { conn: PayConn | null; main: boolean; result: string | null }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "connect" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [change, setChange] = useState(false);
  const stopAct = useAction("disconnect");

  if (!conn)
    return (
      <section className="gp-whop glass" id="whop" data-help="getpaid-whop" aria-labelledby="gp-whop-title" tabIndex={-1}>
        <h2 className="gp-section__title" id="gp-whop-title">
          See your Whop payouts here
        </h2>
        <p className="gp-whop__soon">{WHOP_SOON}</p>
      </section>
    );

  const keySaved = !!conn.keyHint;
  const connected = conn.status === "connected";
  const reconnect = conn.status === "needs_reconnect";

  async function save() {
    const v = key.trim();
    if (!WHOP_KEY.test(v)) {
      setBad(WHOP_KEY_BAD);
      return false;
    }
    setBad(null);
    setBusy("save");
    try {
      putGetPaid(await api().saveWhopKey(v));
      setKey("");
      setChange(false);
      return true;
    } catch (e) {
      setBad(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function paste() {
    const text = await readClipboard();
    if (text) setKey(text.trim());
    return !!text;
  }

  async function connect() {
    setBusy("connect");
    const ok = await startWhop((m) => toast.error(m));
    if (!ok) setBusy(null);
    return ok;
  }

  function stop() {
    setStopping(true);
    toast.undo("Stopping Whop reading…", {
      onUndo: () => {
        setStopping(false);
        stopAct.rewind();
      },
      onCommit: () => {
        api()
          .stopWhop()
          .then(() => reloadGetPaid())
          .catch((e) => toast.error(friendlyMessage(e)))
          .finally(() => setStopping(false));
      },
    });
  }

  const showKeyStep = !keySaved || change || conn.reason === "keys_changed";
  return (
    <section className="gp-whop glass" id="whop" data-help="getpaid-whop" aria-labelledby="gp-whop-title" tabIndex={-1}>
      <h2 className="gp-section__title" id="gp-whop-title">
        See your Whop payouts here
      </h2>
      <p className="gp-whop__lede">Optional. Then Clip Factory sees what Whop sent to your bank.</p>
      {result ? (
        <p className="gp-result" role="status">
          <Icon name={result.startsWith("Clip Factory can see") ? "checkCircle" : "info"} size={18} />
          <span>{result}</span>
        </p>
      ) : null}
      {connected ? (
        <p className="gstep__note is-ok" data-whop="on">
          <Icon name="checkCircle" size={18} />
          <span>Clip Factory can see your Whop payouts{conn.accountName ? ` (${conn.accountName})` : ""}.</span>
        </p>
      ) : reconnect ? (
        <p className="gstep__note" data-whop="reconnect">
          <Icon name="alert" size={18} />
          <span>Sign in to Whop again to see your payouts.</span>
        </p>
      ) : null}

      {showKeyStep ? (
        <div className="gp-whop__key" data-step="whop-key">
          <h3 className="gp-whop__step">
            <Icon name="key" size={20} />
            <span>Make your Whop key</span>
          </h3>
          <div className="gstep__actions">
            <OpenButton label="Open Whop's developer page" href={WHOP_DEVELOPER} size="md" />
          </div>
          <Lines lines={["Tap **Create app**. Name it:"]} />
          <div className="gstep__copies">
            <CopyChip label="App name" value="Clip Factory" quiet />
          </div>
          <Lines lines={["Find **OAuth**. Paste this in **Redirect URIs**:"]} />
          <div className="gstep__copies">
            <CopyChip label="Redirect URI" value={conn.redirectUri ?? null} quiet />
          </div>
          <Lines lines={[SCOPES, "Tap **Save**. Copy the **Client ID**. It starts with app_.", "Whop may show this a little differently. Look for the same words."]} />
          <form
            className="gp-whop__form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field__label" htmlFor="whop-key">
              Whop key
            </label>
            <div className="gp-whop__row">
              <input
                id="whop-key"
                className="input"
                name="whop-key"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                placeholder="app_…"
                value={key}
                aria-invalid={bad ? true : undefined}
                aria-describedby={bad ? "whop-key-bad" : undefined}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button variant="glass" size="md" icon="paste" onClick={paste}>
                Paste
              </Button>
            </div>
            {bad ? (
              <p className="field__status is-bad" id="whop-key-bad" role="alert">
                {bad}
              </p>
            ) : null}
            <Button type="submit" variant="glass" size="lg" icon="check" act="tick" loading={busy === "save"}>
              Save key
            </Button>
          </form>
          <Hints list={[{ see: "that Whop asks for a company first", do: "Make one. Any name is fine. It's free." }]} />
        </div>
      ) : (
        <p className="gstep__note is-ok" data-step="whop-key" data-done="">
          <Icon name="check" size={18} />
          <span>
            Your Whop key is saved: <code className="user-text">{conn.keyHint}</code>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setChange(true)}>
            Change key
          </Button>
        </p>
      )}

      <div className="gstep__actions">
        {!connected ? (
          <Button
            variant={main && keySaved ? "primary" : "glass"}
            size="lg"
            icon="link"
            act="connect"
            loading={busy === "connect"}
            disabled={!keySaved}
            onClick={connect}
            data-help-clear={main && keySaved ? "" : undefined}
            data-gp="connect-whop"
          >
            Connect Whop
          </Button>
        ) : (
          <Button variant="glass" size="md" icon="logout" act={stopAct} disabled={stopping} onClick={stop}>
            Stop reading Whop
          </Button>
        )}
      </div>
      {!keySaved && !connected ? <p className="gstep__note">Save your Whop key first. Then Connect Whop works.</p> : null}
    </section>
  );
}
