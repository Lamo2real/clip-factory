// Settings › Posting › Your Mac posts TikTok (docs/CONTRACTS.md §47.4): the switch and its line, when the Mac last
// checked in and how many clips wait for it, Send these to my Mac (the clips that show Post it yourself), and how to
// stop it. GET /v1/tiktok/mac on open, on focus, every 60 s while open and after a post changes (its live news).
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Post, TikTokMacStatus } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, Skeleton } from "../../components/ui.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { useAction } from "../../lib/motion.ts";
import {
  canSendToMac,
  helperLine,
  MAC_OFF_LINE,
  MAC_ON_LINE,
  MAC_SEND_CONFIRM,
  MAC_STOP_LINE,
  macOn,
  sendableLine,
  sendLots,
  sentLine,
  waitingLine,
} from "../../lib/tiktokMac.ts";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";
import "../../styles/autopost.css";

export const MAC_STATUS_EVERY_MS = 60_000;

export interface TikTokMacData {
  /** null until read, and on an api from before §47 (404). */
  status: TikTokMacStatus | null;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * GET /v1/tiktok/mac while `active`: at once, on focus, every 60 s, and soon after a post changes. The Library, the
 * clip page and Review read the Mac's last check-in from it; this page also its queue.
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
    return () => window.removeEventListener("focus", reload);
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

/** The clips Send these to my Mac takes (they show Post it yourself), oldest first. */
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
 * Send these to my Mac (§47.2): one tap shows the confirm line, Yes sends them (25 at a time), Not now closes it.
 * Shared with Auto-posting's "Post these on TikTok yourself". `clipIds`: the clips to send (oldest first).
 */
export function SendToMac({ clipIds, onSent }: { clipIds: readonly string[]; onSent: () => void }) {
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
      if (sent) toast.success(sentLine(sent));
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

export function TikTokMacBranch() {
  const { me, saveSettings, refresh } = useSession();
  const toast = useToast();
  const on = macOn(me?.settings);
  const { status, error, reload } = useTikTokMac(true);
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
              {on ? <p className="autopost__line">{waitingLine(waiting)}</p> : null}
            </div>
          ) : error ? (
            <ErrorPanel message={error} onRetry={() => void reload()} />
          ) : (
            <Skeleton className="line-skel" />
          )}
        </Apple>
      </Panel>

      {on ? (
        <Panel>
          <Apple id="tiktok-mac-send" wide>
            {ids === null ? (
              <Skeleton className="line-skel" />
            ) : (
              <div className="autopost__where">
                <p className="autopost__line">{sendableLine(ids.length)}</p>
                <SendToMac
                  clipIds={ids}
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
