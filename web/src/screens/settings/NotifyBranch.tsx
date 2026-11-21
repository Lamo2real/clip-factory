// Settings › App & account › Notifications (docs/CONTRACTS.md §32.8): turn notifications on for this device, pick
// which ones come, and send a test. On iPhone they only work inside the app on the Home Screen, so a Safari tab
// shows the Home Screen steps instead of a button that could never work.
import { useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { NotifyChoices } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { GetAppPanel } from "../../components/GetApp.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Pill, Skeleton } from "../../components/ui.tsx";
import { currentOs } from "../../lib/device.ts";
import { badgeSupported } from "../../lib/badge.ts";
import { blockedHelp, deviceId, hideNotifyCard, notifyCardHidden, refreshPushState, syncPush, turnOff, turnOn, usePushState, type PushState } from "../../lib/push.ts";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";

export const NOTIFY_DEFAULTS: NotifyChoices = { ready: true, stopped: true, resumed: false, steps: false };

const STATE_PILL: Record<PushState, { text: string; tone: "success" | "neutral" }> = {
  on: { text: "On", tone: "success" },
  off: { text: "Off", tone: "neutral" },
  blocked: { text: "Off", tone: "neutral" },
  "needs-install": { text: "Not yet", tone: "neutral" },
  unsupported: { text: "Not here", tone: "neutral" },
};

export const NOT_READY_TEXT = "Notifications are not set up yet. They arrive with the next update.";
export const UNSUPPORTED_TEXT = "This browser can't show notifications. Try Safari, Chrome, Edge or Firefox.";
export const DESKTOP_TEXT = "The Mac and Windows app can't show notifications yet. Turn them on in Clip Factory on your phone, or in Safari or Chrome.";

function inDesktopApp(): boolean {
  return typeof window !== "undefined" && !!(window as Window & { __CF_DESKTOP__?: unknown }).__CF_DESKTOP__;
}

/** "Turn on" (vermilion: the one action here) and what happened, in plain words. Also used by the job page card. */
export function useTurnOn() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Not async on purpose: turnOn() asks for permission in this same tap (iPhone forgets the tap after an await).
  function start(): Promise<boolean> {
    setBusy(true);
    setNote(null);
    return turnOn()
      .then((result) => {
        if (result === "on") {
          toast.success("Notifications are on 🎉");
          return true;
        }
        if (result === "blocked") setNote(blockedHelp(currentOs()));
        else if (result === "dismissed") setNote("No problem. Tap Turn on when you want them.");
        else if (result === "not-ready") setNote(NOT_READY_TEXT);
        else setNote(UNSUPPORTED_TEXT);
        return false;
      })
      .catch((e: unknown) => {
        toast.error(friendlyMessage(e));
        return false;
      })
      .finally(() => setBusy(false));
  }
  return { busy, note, start };
}

export function NotifyBranch() {
  const { me, saveSettings } = useSession();
  const state = usePushState();
  const toast = useToast();
  const { busy, note, start } = useTurnOn();
  const [testing, setTesting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const choices = { ...NOTIFY_DEFAULTS, ...me?.settings.notify };
  const os = currentOs();

  function choose(key: keyof NotifyChoices, on: boolean) {
    // `contentRewards` goes back only when the API sent it (§38.19): an older API refuses keys it doesn't know.
    void saveSettings({ notify: { ...choices, [key]: on } });
  }

  async function stop() {
    setStopping(true);
    try {
      await turnOff();
      toast.info("Notifications are off on this device.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setStopping(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      await api().sendTestPush(deviceId());
      toast.success("Sent. Look for it in a few seconds.");
      return true;
    } catch (e) {
      if ((e as { status?: number })?.status === 404) {
        // The server has no working copy of this device: say it again, and show what is true.
        const fixed = await syncPush(true);
        await refreshPushState();
        toast.info(fixed ? "Fixed it. Tap Send a test again." : "Notifications are off here. Tap Turn on.");
        return false;
      }
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setTesting(false);
    }
  }

  const pill = state ? STATE_PILL[state] : null;
  return (
    <>
      <Panel>
        <Apple id="notify-device" wide aside={pill ? <Pill tone={pill.tone} icon={state === "on" ? "check" : "bell"}>{pill.text}</Pill> : null}>
          <div className="notify-device" data-state={state ?? "loading"}>
            {state === null ? <Skeleton className="line-skel" /> : null}
            {state === "needs-install" ? (
              <>
                <p className="notify-device__lead">
                  <Icon name="phone" size={20} />
                  <span>Add Clip Factory to your Home Screen first. Then open it from there and tap Turn on.</span>
                </p>
                <GetAppPanel title="Add it to your Home Screen" />
              </>
            ) : null}
            {state === "unsupported" ? <p className="notify-device__note">{inDesktopApp() ? DESKTOP_TEXT : UNSUPPORTED_TEXT}</p> : null}
            {state === "off" ? (
              <div className="notify-device__row">
                <Button variant="primary" size="lg" icon="bell" loading={busy} onClick={() => start()}>
                  Turn on
                </Button>
              </div>
            ) : null}
            {state === "on" ? (
              <>
                <p className="notify-device__on">
                  <Icon name="checkCircle" size={20} />
                  <span>This device gets them, even when Clip Factory is closed.</span>
                </p>
                <div className="notify-device__row">
                  <Button variant="glass" size="sm" icon="x" loading={stopping} onClick={() => void stop()}>
                    Turn off here
                  </Button>
                </div>
              </>
            ) : null}
            <p className="notify-device__note" role="status">
              {state === "blocked" ? (note ?? blockedHelp(os)) : note}
            </p>
          </div>
        </Apple>
      </Panel>
      <Panel>
        {(["ready", "stopped", "resumed", "steps"] as const).map((key) => (
          <Apple key={key} id={`notify-${key}`}>
            {me ? <AppleSwitch apple={`notify-${key}`} checked={choices[key]} onChange={(v) => choose(key, v)} /> : <Skeleton className="line-skel" />}
          </Apple>
        ))}
        {/* Content Rewards news (§38.11): only once the API knows the choice, so an older API never refuses it. */}
        {me && typeof me.settings.notify?.contentRewards === "boolean" ? (
          <Apple id="notify-contentrewards">
            <AppleSwitch apple="notify-contentrewards" checked={me.settings.notify.contentRewards} onChange={(v) => choose("contentRewards", v)} />
          </Apple>
        ) : null}
        <Apple id="notify-badge" aside={<Pill tone={badgeSupported() && state === "on" ? "success" : "neutral"}>{badgeSupported() ? (state === "on" ? "On" : "With notifications") : "Not here"}</Pill>} />
        <Apple id="notify-test">
          <Button variant="glass" icon="bell" loading={testing} disabled={state !== "on"} onClick={() => test()}>
            Send a test
          </Button>
        </Apple>
      </Panel>
      <Panel>
        <Apple id="notify-lock-screen" wide />
      </Panel>
    </>
  );
}

/**
 * "Get told when clips are ready" on a working job's page: once, until it is turned on or "Not now". Only where
 * notifications can be turned on right here (never in a Safari tab on iPhone: Settings shows the Home Screen steps).
 */
export function NotifyCard() {
  const state = usePushState();
  const { busy, note, start } = useTurnOn();
  const [hidden, setHidden] = useState(notifyCardHidden);
  if (hidden || (state !== "off" && !note)) return null;
  function later() {
    hideNotifyCard();
    setHidden(true);
  }
  return (
    <div className="notify-card">
      <p className="notify-card__text">
        <Icon name="bell" size={20} />
        <span>Get told when your clips are ready, even with the app closed.</span>
      </p>
      <div className="notify-card__row">
        {state === "off" ? (
          <Button variant="primary" icon="bell" loading={busy} onClick={() => start().then((on) => on && later())}>
            Turn on
          </Button>
        ) : null}
        <Button variant="ghost" onClick={later}>
          Not now
        </Button>
      </div>
      <p className="notify-device__note" role="status">
        {note}
      </p>
    </div>
  );
}
