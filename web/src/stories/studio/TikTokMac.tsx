// My Mac posts TikTok, in Clips Funded › Social accounts › TikTok (docs/CONTRACTS.md §47.10). The switch is the
// workspace's own (StoriesConfig.tiktokMac, saved with PATCH …/workspaces/{ws}); while it is on, Post it hands TikTok
// to the owner's Mac helper, which posts it for everyone with TikTok's AI label, only to this workspace's TikTok
// account. The card says what the Mac is doing (GET …/tiktok/mac, read every minute while it is on) and has Log in on
// my Mac: the Mac opens a TikTok window there, and the owner logs in with the TikTok app's code. No password is ever
// asked for here.
import { useEffect, useId, useRef, useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { clockWords } from "../../lib/tiktokMac.ts";
import { storiesApi } from "../api/client.ts";
import type { SocialAccount, WsMacHelper, WsMacStatus } from "../api/types.ts";
import { GlassToggle } from "../glass/index.ts";
import { useAppActive } from "../pane.tsx";
import { storiesHref } from "../routes.ts";
import { useWorkspaceConfig } from "../settings/data.ts";
import { StButton, StIcon, StLinkButton } from "../ui.tsx";
import { loginReason, macHelperNew, macNotSeen } from "./macRow.ts";
import * as W from "./macWords.ts";

/** The card's id: the rows' Turn on and Set it up go here (/stories/connections/tiktok#tiktok-mac). */
export const MAC_CARD_ID = "tiktok-mac";

/**
 * GET …/tiktok/mac while `on`, read again every `every` ms while Clips Funded is on screen; null while off. The rows
 * and the card share it (one cache name).
 */
export function useMacStatus(ws: string, on: boolean, every = 60_000) {
  const status = useLoad<WsMacStatus | null>(() => (on ? storiesApi().macStatus(ws) : Promise.resolve(null)), `${ws}:${on ? "on" : "off"}`, "st-mac-status");
  const active = useAppActive();
  usePoll(() => status.reload(), on && active, every);
  return status;
}

type CardState = {
  line: string;
  tone: "sky" | "sun" | "coral";
  steps?: string[];
  /** §47.11: one quiet line under it (the Mac carries on by itself once it's logged in). */
  note?: string;
  button?: "login" | "login_quiet" | "open_stopped" | "resume";
};

/** What the card says while the switch is on (§47.10.6), from the Mac's last check-in. */
export function cardState(helper: WsMacHelper | null, handle: string, now: number = Date.now()): CardState {
  if (!macHelperNew(helper)) return { line: W.MAC_NOT_SET_UP, tone: "sun", steps: W.macSteps(handle, 1) };
  if (macNotSeen(helper, now)) return { line: W.notSeenWords(clockWords(helper.seenAt, now)), tone: "sun" };
  if (helper.loginRequest) return { line: W.MAC_ASKED, tone: "sky" };
  if (helper.state === "needs_you")
    return {
      line: W.needsYouWords(helper.reason),
      tone: "coral",
      ...(helper.needsYouCode === "login" ? { note: W.loginBackWords(handle) } : {}),
      button: loginReason(helper.reason) ? "login" : helper.needsYouStoryId ? "open_stopped" : undefined,
    };
  if (helper.state === "paused") return helper.resumeRequest ? { line: W.MAC_CARD_STARTING, tone: "sky" } : { line: W.MAC_CARD_PAUSED, tone: "sun", button: "resume" };
  if (!helper.setUp) return { line: W.notLoggedInWords(handle), tone: "sun", steps: W.macSteps(handle, 2), button: "login" };
  return { line: W.checkedInWords(clockWords(helper.seenAt, now), helper.handle ?? handle), tone: "sky", button: "login_quiet" };
}

export function TikTokMac({ ws, account }: { ws: string; account: SocialAccount }) {
  const id = useId();
  const toast = useToast();
  const box = useRef<HTMLElement | null>(null);
  const { config, save } = useWorkspaceConfig(ws);
  const on = config.tiktokMac?.on === true;
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // While a login or a start waits, the card looks again every 10 seconds until the Mac did it.
  const status = useMacStatus(ws, on, waiting ? 10_000 : 60_000);
  const helper = status.data?.helper ?? null;
  const handle = status.data?.account?.handle || account.handle || "your Clips Funded TikTok";
  const asked = !!helper?.loginRequest || !!helper?.resumeRequest;
  if (waiting !== asked) setWaiting(asked);

  // The rows' Turn on and Set it up land here.
  useEffect(() => {
    if (typeof location !== "undefined" && location.hash === `#${MAC_CARD_ID}`) box.current?.scrollIntoView?.({ block: "center" });
  }, []);

  /** Log in on my Mac, or Start my Mac again: the Mac does it on its next tick. */
  async function ask(what: "login" | "resume") {
    if (asking) return;
    setAsking(true);
    try {
      const r = what === "login" ? await storiesApi().macLogin(ws) : await storiesApi().macResume(ws);
      status.setData((d) => (d ? { ...d, helper: r.helper } : d));
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setAsking(false);
    }
  }

  // Nothing to turn on until Clips Funded's TikTok is connected (Post it needs it, and so does the Mac); a switch that
  // is on always shows, so it can be turned off.
  if (!on && account.connectionStatus !== "connected") return null;
  const state = on && status.data ? cardState(helper, handle) : null;
  return (
    <section className="st-conn__mac" id={MAC_CARD_ID} ref={box} aria-labelledby={`${id}-t`}>
      <div className="st-note st-note--sky st-note--wide">
        <StIcon name="screen" size={18} />
        <span style={{ flex: "1 1 auto" }}>
          <strong id={`${id}-t`}>{W.MAC_TITLE}</strong>
          <br />
          {on ? W.MAC_CARD_ON : W.MAC_CARD_OFF}
        </span>
        <GlassToggle label={W.MAC_TITLE} checked={on} onChange={(v) => save({ tiktokMac: { on: v } })} />
      </div>
      {on ? (
        <>
          {status.error && !status.data ? (
            <p className="st-note st-note--coral" role="alert">
              <StIcon name="alert" size={18} />
              {status.error}
            </p>
          ) : state ? (
            <div className={`st-note st-note--${state.tone}`} role="status">
              <StIcon name={state.tone === "coral" ? "alert" : "bulb"} size={18} />
              <span>
                {state.line}
                {state.note ? (
                  <>
                    <br />
                    <small data-mac="login-back">
                      {state.note}
                    </small>
                  </>
                ) : null}
                {state.steps ? (
                  <ol className="st-conn__mac-steps" style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
                    {state.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                ) : null}
              </span>
            </div>
          ) : null}
          {state?.button ? (
            <div className="st-conn__actions">
              {state.button === "open_stopped" && helper?.needsYouStoryId ? (
                <StLinkButton href={storiesHref({ name: "review_story", storyId: helper.needsYouStoryId })} main>
                  {W.MAC_OPEN_STOPPED}
                </StLinkButton>
              ) : state.button === "resume" ? (
                <StButton main aria-disabled={asking || undefined} onClick={() => void ask("resume")}>
                  {asking ? "Asking your Mac…" : W.MAC_RESUME}
                </StButton>
              ) : (
                <StButton main={state.button === "login"} quiet={state.button === "login_quiet"} aria-disabled={asking || undefined} onClick={() => void ask("login")}>
                  {asking ? "Asking your Mac…" : W.MAC_LOGIN_BUTTON}
                </StButton>
              )}
            </div>
          ) : null}
          <p className="st-conn__since">{W.MAC_STOP_LINE}</p>
        </>
      ) : null}
    </section>
  );
}
