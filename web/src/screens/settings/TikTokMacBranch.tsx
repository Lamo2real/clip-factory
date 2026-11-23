// Settings › Posting › Your Mac posts TikTok (docs/CONTRACTS.md §47.4): the switch and its line, when the Mac last
// checked in and how many clips wait for it (with Start my Mac again while it is paused, Open the stopped clip while it
// needs him, and Let them go while it holds older auto-posting clips), Send these to my Mac (the backlog: every clip
// that isn't on TikTok yet, campaign clips never), the TikTok login kept on the Mac with Change and Forget (§47.8), and
// how to stop it. GET /v1/tiktok/mac on open, on focus, every 60 s while open, after a post changes (its live news) and
// after the owner asked the Mac something (macChanged). Until TikTok approves the app the Mac is the only way to TikTok
// (ADR-86); the words are in lib/tiktokMac.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, MacHelper, MacLoginAction, Post, TikTokMacStatus } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, Skeleton } from "../../components/ui.tsx";
import { timeWords } from "../../lib/autopost.ts";
import { usePoll } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { useAction } from "../../lib/motion.ts";
import {
  canSendToMac,
  helperLine,
  holdLine,
  loginLine,
  loginRequestLine,
  MAC_LET_GO_BUTTON,
  MAC_LET_GO_PENDING,
  MAC_LET_GO_TOAST,
  MAC_LOGIN_FORGET_CONFIRM,
  MAC_RESUME_PENDING,
  MAC_OFF_LINE,
  MAC_ON_LINE,
  MAC_SEND_CONFIRM,
  MAC_SENT_WAITS,
  MAC_STOP_LINE,
  macHelperBeats,
  macOn,
  sendableLine,
  sendLots,
  sentLine,
  whenLine,
} from "../../lib/tiktokMac.ts";
import { MacStartAgain, OpenStoppedClip } from "../library/MacButtons.tsx";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";
import "../../styles/autopost.css";

export const MAC_STATUS_EVERY_MS = 60_000;

/** The owner asked the Mac something (Start my Mac again, Let them go): every open view reads GET /v1/tiktok/mac again. */
export const MAC_CHANGED_EVENT = "cf:tiktok-mac";
export function macChanged(): void {
  window.dispatchEvent(new Event(MAC_CHANGED_EVENT));
}

export interface TikTokMacData {
  /** null until read, and on an api from before §47 (404). */
  status: TikTokMacStatus | null;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * GET /v1/tiktok/mac while `active`: at once, on focus, every 60 s, and soon after a post changes. The TikTok rows of
 * the Library, the clip page and Review read the Mac's last check-in from it (MacButtons.tsx); this page also its queue.
 */
export function useTikTokMac(active: boolean): TikTokMacData {
  const [status, setStatus] = useState<TikTokMacStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api().tiktokMacStatus();
      if (mine === seq.current) {
        setStatus(next);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(friendlyMessage(e));
      throw e;
    }
  }, []);
  const reload = useCallback(() => load().catch(() => undefined), [load]);
  useEffect(() => {
    if (!active) return;
    void reload();
    window.addEventListener("focus", reload);
    window.addEventListener(MAC_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener(MAC_CHANGED_EVENT, reload);
    };
  }, [active, reload]);
  usePoll(load, active, MAC_STATUS_EVERY_MS);
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(soon.current), []);
  useLiveEvents(
    (e) => {
      if (!active || e.type !== "post") return;
      clearTimeout(soon.current);
      soon.current = setTimeout(() => void reload(), 800);
    },
    () => {
      if (active) void reload();
    },
  );
  return { status: active ? status : null, error, reload };
}

/** The clips Send these to my Mac takes (canSendToMac: kept, not on TikTok yet, never a campaign clip), oldest first. */
async function sendable(): Promise<string[]> {
  const [clips, posts] = await Promise.all([api().listClips({ status: "all" }), api().listPosts()]);
  const by = new Map<string, Post[]>();
  for (const p of posts) by.set(p.clipId, [...(by.get(p.clipId) ?? []), p]);
  return clips
    .filter((c) => canSendToMac(c, by.get(c.clipId) ?? []))
    .sort((a: Clip, b: Clip) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt))
    .map((c) => c.clipId);
}

/**
 * Send these to my Mac (§47.2): one tap shows the confirm line, Yes sends them (25 at a time, without `now`, so they
 * wait as the backlog), Not now closes it. `clipIds`: the clips to send (oldest first). `waits`: the Mac never checked
 * in, so the confirm line and the toast say they wait for it (MAC_SENT_WAITS).
 */
export function SendToMac({ clipIds, onSent, waits = false }: { clipIds: readonly string[]; onSent: () => void; waits?: boolean }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = useAction("send");
  if (!clipIds.length && !asking) return null;

  async function send() {
    setBusy(true);
    try {
      let sent = 0;
      let why = "";
      for (const lot of sendLots(clipIds)) {
        const results = await api().sendToMac(lot);
        sent += results.filter((r) => r.sent).length;
        why ||= results.find((r) => !r.sent)?.reason ?? "";
      }
      setAsking(false);
      if (sent) toast.success(sentLine(sent, waits));
      else {
        act.fail({ sound: false });
        toast.error(why || "Nothing could go to your Mac.");
      }
      onSent();
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return asking ? (
    <div className="mac-send" role="group" aria-label="Send these to my Mac">
      <p className="mac-send__confirm">{MAC_SEND_CONFIRM}</p>
      {waits ? <p className="mac-send__confirm">{MAC_SENT_WAITS}</p> : null}
      <div className="mac-send__buttons">
        <Button variant="primary" icon="monitor" act={act} loading={busy} onClick={() => void send()}>
          Yes, send them
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
          Not now
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="glass" icon="monitor" onClick={() => setAsking(true)}>
      Send these to my Mac
    </Button>
  );
}

/**
 * The Mac never checked in: how to set it up (mac/tiktok-helper/README.md, "Setup"), right under that line, so this
 * page always says what to do next. The helper's own steps, typed in Terminal on the Mac.
 */
export const MAC_SETUP_STEPS: readonly { type: string; then?: string }[] = [
  { type: "./install.sh --no-start" },
  { type: 'node "$HOME/Library/Application Support/Clip Factory TikTok/app/src/cli.js" setup', then: "Log in to TikTok and to Clip Factory in the window that opens." },
  { type: "./install.sh" },
];

function MacSetUp() {
  return (
    <div className="autopost__where" data-mac="setup">
      <p className="autopost__line">To set it up, open Terminal on your Mac in Clip Factory&apos;s mac/tiktok-helper folder and type:</p>
      <ol className="autopost__where">
        {MAC_SETUP_STEPS.map((step, i) => (
          <li key={step.type}>
            {i + 1}. <code className="user-text">{step.type}</code>
            {step.then ? <span className="small"> {step.then}</span> : null}
          </li>
        ))}
      </ol>
      <p className="small">Your Mac checks in within a minute, and this page says so.</p>
    </div>
  );
}

/** §47.8: Change TikTok login / Forget TikTok login. The Mac does it the next time it checks in. */
function MacLogin({ helper, onAsked }: { helper: MacHelper; onAsked: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<MacLoginAction | null>(null);
  const [asking, setAsking] = useState(false);
  const line = loginLine(helper);
  const next = loginRequestLine(helper);

  async function ask(action: MacLoginAction) {
    setBusy(action);
    try {
      await api().tiktokMacLogin(action);
      toast.success(action === "change" ? "Your Mac asks for it in a minute." : "Your Mac forgets it in a minute.", { group: "tiktok-mac" });
      setAsking(false);
      onAsked();
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="autopost__where">
      {line ? <p className="autopost__line" data-mac="login">{line}</p> : null}
      {next ? (
        <p className="autopost__line" role="status">
          {next}
        </p>
      ) : null}
      {asking ? (
        <div className="mac-send" role="group" aria-label="Forget TikTok login">
          <p className="mac-send__confirm">{MAC_LOGIN_FORGET_CONFIRM}</p>
          <div className="mac-send__buttons">
            <Button variant="primary" loading={busy === "forget"} onClick={() => void ask("forget")}>
              Yes, forget it
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setAsking(false)}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <div className="mac-send__buttons">
          <Button variant="glass" icon="monitor" loading={busy === "change"} disabled={busy !== null} onClick={() => void ask("change")}>
            Change TikTok login
          </Button>
          {helper.login !== "none" ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => setAsking(true)}>
              Forget TikTok login
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Under the Mac's status line (D5): Start my Mac again while it is paused, Open the stopped clip while it needs him,
 * and its hold on older auto-posting clips with Let them go. Once asked, the line says the Mac does it at its next tick.
 */
function MacAsks({ helper }: { helper: MacHelper }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("send");
  async function letGo() {
    setBusy(true);
    try {
      await api().tiktokMacRequest("let_go");
      toast.success(MAC_LET_GO_TOAST, { group: "tiktok-mac" });
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
      macChanged();
    }
  }
  // An older helper never reads Start my Mac again (macHelperBeats): then only its status line says it is paused.
  const paused = helper.state === "paused" && macHelperBeats(helper);
  const stoppedOn = helper.state === "needs_you" ? helper.needsYouClipId : undefined;
  const hold = helper.holdBefore;
  if (!paused && !stoppedOn && !hold) return null;
  return (
    <>
      {paused ? (
        helper.resumeRequest ? (
          <p className="autopost__line" role="status" data-mac="resume">
            {MAC_RESUME_PENDING}
          </p>
        ) : (
          <div className="mac-send__buttons" data-mac="resume">
            <MacStartAgain size="md" />
          </div>
        )
      ) : null}
      {stoppedOn ? (
        <div className="mac-send__buttons" data-mac="stopped">
          <OpenStoppedClip href={`/clips/${stoppedOn}`} size="md" wide={false} />
        </div>
      ) : null}
      {hold ? (
        <>
          <p className="autopost__line" data-mac="hold">
            {holdLine(timeWords(hold))}
          </p>
          {helper.letGoRequest ? (
            <p className="autopost__line" role="status">
              {MAC_LET_GO_PENDING}
            </p>
          ) : (
            <div className="mac-send__buttons">
              <Button variant="glass" icon="monitor" act={act} loading={busy} onClick={() => void letGo()}>
                {MAC_LET_GO_BUTTON}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

export function TikTokMacBranch() {
  const { me, saveSettings, refresh } = useSession();
  const toast = useToast();
  const on = macOn(me?.settings);
  const { status, error, reload } = useTikTokMac(true);
  // When the Mac posts: with auto-posting (its next run), and at once on Upload.
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const autoOn = me?.settings?.autoPost?.on === true;
  useEffect(() => {
    if (!on || !autoOn) return;
    let live = true;
    api()
      .autoPostStatus()
      .then((a) => {
        if (live) setNextRunAt(a.nextRunAt);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [on, autoOn, status]);
  const [ids, setIds] = useState<string[] | null>(null);
  const readSendable = useCallback(() => {
    sendable()
      .then(setIds)
      .catch(() => setIds([]));
  }, []);
  useEffect(() => {
    if (on) readSendable();
  }, [on, readSendable]);
  // Changed on another device: back here, the settings are read again too, so the switch shows what is saved.
  useEffect(() => {
    const again = () => void refresh().catch(() => undefined);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  if (!me)
    return (
      <Panel>
        <Skeleton className="line-skel" />
      </Panel>
    );

  async function turn(next: boolean) {
    const saved = await saveSettings({ tiktokMac: { on: next } });
    if (!saved) return;
    toast.success("Saved.", { group: "tiktok-mac" });
    void reload();
  }

  const waiting = status?.queue.filter((j) => j.state === "waiting").length ?? 0;
  return (
    <>
      <Panel>
        <Apple id="tiktok-mac-on">
          <AppleSwitch apple="tiktok-mac-on" checked={on} onChange={(next) => void turn(next)} />
        </Apple>
        <p className="apple-panel__note autopost__state" role="status">
          {on ? MAC_ON_LINE : MAC_OFF_LINE}
        </p>
        {/* The one quiet line: on the glass, under the switch it is about. */}
        <p className="apple-panel__note mac-stop">{MAC_STOP_LINE}</p>
      </Panel>

      <Panel>
        <Apple id="tiktok-mac-status" wide>
          {status ? (
            <div className="autopost__where">
              <p className="autopost__line" data-mac="helper">
                {helperLine(status.helper)}
              </p>
              {status.helper ? <MacAsks helper={status.helper} /> : <MacSetUp />}
              {on ? (
                <p className="autopost__line" data-mac="when">
                  {whenLine(autoOn, nextRunAt, waiting)}
                </p>
              ) : null}
            </div>
          ) : error ? (
            <ErrorPanel message={error} onRetry={() => void reload()} />
          ) : (
            <Skeleton className="line-skel" />
          )}
        </Apple>
      </Panel>

      {status?.helper ? (
        <Panel>
          <Apple id="tiktok-mac-login" wide>
            <MacLogin helper={status.helper} onAsked={() => void reload()} />
          </Apple>
        </Panel>
      ) : null}

      {on ? (
        <Panel>
          <Apple id="tiktok-mac-send" wide>
            {ids === null ? (
              <Skeleton className="line-skel" />
            ) : (
              <div className="autopost__where">
                <p className="autopost__line">{sendableLine(ids.length, waiting)}</p>
                <SendToMac
                  clipIds={ids}
                  waits={!!status && !status.helper}
                  onSent={() => {
                    readSendable();
                    void reload();
                  }}
                />
              </div>
            )}
          </Apple>
        </Panel>
      ) : null}

    </>
  );
}
