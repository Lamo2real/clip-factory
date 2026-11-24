// Settings › Posting › Auto-posting (docs/CONTRACTS.md §46.2): the oldest clips in Review go up by themselves, every
// few hours, through Upload's own code. Top to bottom: the switch and its line, how often with the result line, where
// they go (TikTok: his Mac, or Turn on while Your Mac posts TikTok is off, §47), Next up, what waits for him, what did
// not work, the recent runs, and a closed Test it first. TikTok has no list of its own here (ADR-86): each clip's
// TikTok row in Library says what his Mac is doing. Every control saves the moment it changes (like My settings,
// §36.2). GET /v1/autopost on open, on focus, every 60 s while open and after every change, and every 3 s for 30 s
// after a test run.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { AutoPostPatch, AutoPostStatus, Clip } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, LinkButton, Segmented, Skeleton, Toggle } from "../../components/ui.tsx";
import {
  autoPostOf,
  canTryPlaceAgain,
  dayWarnings,
  EVERY_HOURS,
  hoursWords,
  leftOutLine,
  NEXT_ALL_WAITING,
  NEXT_EMPTY,
  PER_RUN,
  placesLine,
  resultLine,
  runLines,
  switchLine,
  timeWords,
} from "../../lib/autopost.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { usePoll } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { postError } from "../../lib/tiktokYourself.ts";
import { settingsPath } from "../../lib/settingsTree.ts";
import { onClipBack, throwAwayWithUndo, useThrownAway } from "../../lib/throwAways.ts";
import { UploadAgain } from "../library/Library.tsx";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";
import { MAC_WHERE_LINE, macOn } from "../../lib/tiktokMac.ts";
import "../../styles/autopost.css";

/** How often the page reads the status while open, and after a test run (every 3 s for 30 s). */
export const STATUS_EVERY_MS = 60_000;
export const BURST_EVERY_MS = 3_000;
export const BURST_FOR_MS = 30_000;

/** The Private test run's line: who can see it on each place, and that the clip leaves Review. */
export const PRIVATE_LINE = "Posts the next clip so only you see it: YouTube Only me, Facebook a draft, Instagram not published. It leaves Review.";

export interface AutoPostData {
  status: AutoPostStatus | null;
  error: string | null;
  reload: () => Promise<void>;
  /** A test run just started: read every 3 s for 30 s, so the run shows in Recent. */
  burst: () => void;
}

/**
 * GET /v1/autopost while `active`: at once, on focus, every 60 s, and soon after a clip or post changes (its live
 * news, §14.2). Review (its card line) and this page share it.
 */
export function useAutoPost(active: boolean): AutoPostData {
  const [status, setStatus] = useState<AutoPostStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api().autoPostStatus();
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
  usePoll(load, active, STATUS_EVERY_MS);

  const [burstAt, setBurstAt] = useState(0);
  usePoll(load, active && burstAt > 0, BURST_EVERY_MS);
  useEffect(() => {
    if (!burstAt) return;
    const t = setTimeout(() => setBurstAt(0), BURST_FOR_MS);
    return () => clearTimeout(t);
  }, [burstAt]);

  // A clip thrown away, uploaded or posted somewhere else: read again after a short pause (a burst of news is one read).
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(soon.current), []);
  const later = useCallback(() => {
    clearTimeout(soon.current);
    soon.current = setTimeout(() => void reload(), 800);
  }, [reload]);
  useLiveEvents(
    (e) => {
      if (active && (e.type === "clip" || e.type === "post")) later();
    },
    () => {
      if (active) later();
    },
  );

  const burst = useCallback(() => setBurstAt(Date.now()), []);
  return { status: active ? status : null, error, reload, burst };
}

/** A clip whose places are still going up: its Try again waits until they are done. */
const stillPosting = (c: Clip) => c.status === "confirmed" || c.status === "publishing";

/**
 * The clips Didn't work's Try again needs, read once each; one still posting its places is read again with each new
 * status (`version`), so its Try again shows once they are done.
 */
function useClips(ids: readonly string[], version: unknown) {
  const [clips, setClips] = useState<ReadonlyMap<string, Clip>>(() => new Map());
  const key = ids.join(",");
  useEffect(() => {
    const missing = ids.filter((id) => {
      const c = clips.get(id);
      return !c || stillPosting(c);
    });
    if (!missing.length) return;
    let gone = false;
    void Promise.all(missing.map((id) => api().getClip(id).catch(() => null))).then((found) => {
      if (gone) return;
      setClips((m) => {
        const next = new Map(m);
        for (const c of found) if (c) next.set(c.clipId, c);
        return next;
      });
    });
    return () => {
      gone = true;
    };
    // Only when the list or the status changes; a clip read once that is done is kept (its actions refresh it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  const put = useCallback((c: Clip) => setClips((m) => new Map(m).set(c.clipId, c)), []);
  return { clips, put };
}

export function AutoPostBranch() {
  const { me, refresh, saveSettings } = useSession();
  const toast = useToast();
  const { status, error, reload, burst } = useAutoPost(true);
  const thrown = useThrownAway();
  // Only Didn't work needs its clips. `status.tiktokYourself` stays in the API but the page no longer lists it (ADR-86).
  const actions = useClips(status?.failed.map((f) => f.clipId) ?? [], status);
  const [running, setRunning] = useState<"practice" | "private" | null>(null);

  // Thrown away from Next up: the focus goes to the next row's Throw away (or, after the last one, to Next up itself);
  // Undo brings it back.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(target)?.focus();
  });
  // Undo shows the row again at once (from the status already here); the status is read again only once its hold is let
  // go, or the answer would still leave the clip out (a held clip is skipped silently, §46.13).
  useEffect(() => onClipBack((_, released) => void released.then(reload)), [reload]);
  // Changed on another device: back on this one, the settings are read again too, so the switch shows what is saved.
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

  const a = autoPostOf(me.settings.autoPost);
  // The screen shows the whole setting at once; the server gets only the key that changed (it merges each one, §46.3),
  // so a copy read before a change on another device never sends "on" back. The saves go out in the order of the taps.
  const save = async (patch: AutoPostPatch) => {
    const saved = await saveSettings((now) => ({ autoPost: { ...autoPostOf(now.autoPost), ...patch } }), { send: { autoPost: patch }, inOrder: true });
    if (!saved) return;
    toast.success("Saved.", { group: "autopost" });
    void reload();
  };

  /** One test run now (§46.8); a refusal (one a minute) shakes the button and says why. */
  async function runNow(kind: "practice" | "private"): Promise<boolean> {
    setRunning(kind);
    try {
      await api().autoPostRun(kind);
      burst();
      await reload();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setRunning(null);
    }
  }

  const warnings = dayWarnings(a.perRun, a.everyHours);
  const macIsOn = macOn(me.settings);
  const nextUp = status?.nextUp.filter((c) => !thrown.has(c.clipId)) ?? [];
  const loading = !status && !error ? <Skeleton className="line-skel" /> : null;

  function throwAway(item: AutoPostStatus["nextUp"][number]) {
    const at = nextUp.findIndex((c) => c.clipId === item.clipId);
    const after = nextUp[at + 1] ?? nextUp[at - 1];
    if (document.activeElement?.closest(`[data-clip="${item.clipId}"]`)) focusNext.current = after ? `auto-throw-${after.clipId}` : "auto-post-next";
    // The clip itself is only named here: the decline sends its id (the Review card's own Undo, §20.7).
    throwAwayWithUndo({ clipId: item.clipId, jobId: item.jobId, hook: item.hook } as Clip, toast, () => void reload());
  }

  return (
    <>
      <Panel>
        <Apple id="auto-post-on">
          <AppleSwitch apple="auto-post-on" checked={a.on} onChange={(on) => void save({ on })} />
        </Apple>
        <p className="apple-panel__note autopost__state" role="status">
          {switchLine(a, status?.nextRunAt)}
        </p>
      </Panel>

      <Panel className="autopost__above">
        <Apple id="auto-post-every" wide>
          <div className="autopost__controls">
            <span className="field__label" id="auto-every-label">
              Post every
            </span>
            <Dropdown
              labelledBy="auto-every-label"
              value={String(a.everyHours)}
              placeholder="Pick how many hours"
              options={EVERY_HOURS.map((h) => ({ value: String(h), label: hoursWords(h) }))}
              onChange={(v) => void save({ everyHours: Number(v) })}
            />
            <span className="field__label">Clips each time</span>
            <Segmented
              label="Clips each time"
              value={String(a.perRun)}
              options={PER_RUN.map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(v) => void save({ perRun: Number(v) })}
            />
          </div>
          <p className="autopost__result" data-help="auto-post-result">
            {resultLine(a.perRun, a.everyHours)}
          </p>
          {warnings.length ? (
            <p className="field__status is-bad autopost__warn" role="status">
              <Icon name="alert" size={18} />
              <span>{warnings.join(" ")}</span>
            </p>
          ) : null}
        </Apple>
      </Panel>

      <Panel>
        <Apple id="auto-post-where" wide>
          {status ? (
            <div className="autopost__where">
              <p className="autopost__line">{placesLine(status.places)}</p>
              {/* §47.2: while his Mac posts TikTok, each clip's TikTok goes to the Mac. */}
              {status.macPlaces?.includes("tiktok") ? (
                <p className="autopost__left-row" data-mac="where">
                  <PlatformMark platform="tiktok" size={18} title={PLATFORM_LABEL.tiktok} />
                  <span className="autopost__left-text">{MAC_WHERE_LINE}</span>
                </p>
              ) : null}
              {status.leftOut.length ? (
                <ul className="autopost__left">
                  {status.leftOut.map((l) => (
                    <li key={l.platform} className="autopost__left-row">
                      <PlatformMark platform={l.platform} size={18} title={PLATFORM_LABEL[l.platform]} />
                      <span className="autopost__left-text">{leftOutLine(l.platform, l.reason, macIsOn)}</span>
                      {l.reason === "not_set_up" ? (
                        <LinkButton href={settingsPath("posting", "setup") + `/${l.platform}`} size="sm" iconAfter="chevronRight">
                          Set up {PLATFORM_LABEL[l.platform]}
                        </LinkButton>
                      ) : l.reason === "tiktok_yourself" && !macIsOn ? (
                        // TikTok goes only through his Mac (ADR-86): Your Mac posts TikTok is off, so one way to turn it on.
                        <LinkButton href={settingsPath("posting", "tiktok-mac")} size="sm" iconAfter="chevronRight">
                          Turn on
                        </LinkButton>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : error ? (
            <ErrorPanel message={error} onRetry={() => void reload()} />
          ) : (
            loading
          )}
        </Apple>
      </Panel>

      <Panel>
        <Apple id="auto-post-next" wide title={a.on ? undefined : "Would go first"}>
          {status ? (
            nextUp.length ? (
              <ol className="autopost__list" aria-labelledby="auto-post-next-name">
                {nextUp.map((c) => (
                  <li key={c.clipId} className="autopost__row" data-clip={c.clipId}>
                    <Cover url={c.coverUrl} />
                    <span className="autopost__text">
                      <span className="autopost__hook clamp-2 user-text">{c.hook}</span>
                      {a.on && c.runAt ? <span className="autopost__when">{timeWords(c.runAt)}</span> : null}
                    </span>
                    <Button
                      id={`auto-throw-${c.clipId}`}
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      act="throw"
                      aria-label={`Throw away, ${c.hook}`}
                      onClick={() => throwAway(c)}
                    >
                      Throw away
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="autopost__line muted">{status.waiting.length ? NEXT_ALL_WAITING : NEXT_EMPTY}</p>
            )
          ) : (
            loading
          )}
        </Apple>

        {/* Always on the page (§46.2 hides only item 6 when empty): with nothing waiting, its leaf alone. */}
        <Apple id="auto-post-waiting" wide>
          {status ? (
            status.waiting.length ? (
              <ul className="autopost__list">
                {status.waiting.map((c) => (
                  <li key={c.clipId} className="autopost__row">
                    <Cover url={c.coverUrl} />
                    <span className="autopost__text">
                      <span className="autopost__hook clamp-2 user-text">{c.hook}</span>
                      <span className="autopost__why">{c.reason}</span>
                    </span>
                    <LinkButton href={`/review#clip-${c.clipId}`} size="sm" iconAfter="chevronRight" aria-label={`Open in Review, ${c.hook}`}>
                      Open in Review
                    </LinkButton>
                  </li>
                ))}
              </ul>
            ) : null
          ) : (
            loading
          )}
        </Apple>
      </Panel>

      {status?.failed.length ? (
        <Panel>
          <Apple id="auto-post-failed" wide>
            <ul className="autopost__list">
              {status.failed.map((f) => {
                const clip = actions.clips.get(f.clipId);
                return (
                  <li key={f.postId} className="autopost__row is-failed">
                    <span className="autopost__mark" title={PLATFORM_LABEL[f.platform]}>
                      <PlatformMark platform={f.platform} size={18} />
                    </span>
                    <span className="autopost__text">
                      <span className="autopost__name">{PLATFORM_LABEL[f.platform]}</span>
                      <span className="autopost__hook clamp-2 user-text">{f.hook}</span>
                      <span className="autopost__why">{postError(f.error)}</span>
                    </span>
                    {/* The Library's own Try again for this place, once the clip's other places are done (§33). */}
                    {!clip ? (
                      <Skeleton className="autopost__wait" />
                    ) : canTryPlaceAgain(clip, { platform: f.platform, status: "failed", error: f.error }) ? (
                      <UploadAgain
                        clip={clip}
                        posts={[]}
                        platform={f.platform}
                        onKept={(c) => {
                          actions.put(c);
                          void reload();
                        }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Apple>
        </Panel>
      ) : null}

      {/* Always on the page (§46.2 hides only item 6 when empty): before the first run, its leaf alone. */}
      <Panel>
        <Apple id="auto-post-recent" wide>
          {status ? (
            status.runs.length ? (
              <ul className="autopost__list">
                {status.runs.flatMap((run) =>
                  runLines(run).map((line) => (
                    <li key={line.key} className="autopost__run">
                      <span className="autopost__run-text user-text">{line.text}</span>
                      {line.opens.length ? (
                        <span className="autopost__opens">
                          {line.opens.map((o) => (
                            <LinkButton
                              key={o.platform}
                              href={o.url}
                              size="sm"
                              iconAfter="external"
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open the ${PLATFORM_LABEL[o.platform]} post`}
                            >
                              {/* Which place each Open goes to, at a glance (the name is said by its label). */}
                              <PlatformMark platform={o.platform} size={16} />
                              Open
                            </LinkButton>
                          ))}
                        </span>
                      ) : null}
                    </li>
                  )),
                )}
              </ul>
            ) : null
          ) : (
            loading
          )}
        </Apple>
      </Panel>

      {/* Found with "Find a setting": the branch page opens it and focuses its summary (the part Tab reaches). */}
      <details className="apple-panel glass autopost__test" id="auto-post-test" data-help="auto-post-test">
        <summary className="cr-fold__q" data-help="auto-post-test-open">
          <Icon name="sliders" size={18} />
          <span>Test it first</span>
          <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
        </summary>
        <div className="cr-fold__body">
          <Toggle
            label="Practice"
            description="Sends nothing. The clips stay in Review."
            checked={a.practice}
            onChange={(practice) => void save({ practice })}
          />
          <div className="autopost__runs">
            <Button variant="glass" icon="play" act="play" loading={running === "practice"} disabled={!!running} onClick={() => runNow("practice")}>
              Practice run now
            </Button>
            <div className="autopost__run-now">
              <Button
                variant="glass"
                icon="lock"
                act="send"
                loading={running === "private"}
                disabled={!!running}
                aria-describedby="auto-private-line"
                onClick={() => runNow("private")}
              >
                Private test run
              </Button>
              <p className="field__hint" id="auto-private-line">
                {PRIVATE_LINE}
              </p>
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

/** A clip's cover (9:16), or a quiet tile when it has none. */
function Cover({ url }: { url?: string }) {
  return <span className="autopost__cover">{url ? <img src={url} alt="" loading="lazy" /> : <Icon name="film" size={18} />}</span>;
}
