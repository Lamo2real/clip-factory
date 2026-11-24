// Settings › Clip making › Streamers I follow (docs/CONTRACTS.md §24.5): follow YouTube, Twitch and Kick streamers by
// link or by name, only after "Yes, they said I can"; see who is live; Remove with Undo; the "Clips by itself"
// choices (used once that part ships); and the Twitch and Kick keys a grown-up pastes once.
import { useEffect, useId, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type {
  Follow,
  FollowCreator,
  FollowKeyPlatform,
  FollowKeySlot,
  FollowLive,
  FollowPlatform,
  FollowsView,
  LiveEvent,
} from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, Pill, Segmented, Skeleton, Stepper, Toggle } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { count, relative } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { sounds } from "../../lib/sounds.ts";
import { CopyChip, copyText } from "./setup/bits.tsx";
import { Apple, Panel } from "./parts.tsx";

export const FOLLOW_LABEL: Record<FollowPlatform, string> = { youtube: "YouTube", twitch: "Twitch", kick: "Kick" };
const KEY_LABEL: Record<FollowKeyPlatform, string> = { twitch: "Twitch", kick: "Kick", "youtube-read": "YouTube" };
const FOLLOW_PLATFORMS: readonly FollowPlatform[] = ["youtube", "twitch", "kick"];
/** How long Undo stays after Remove. */
export const REMOVE_UNDO_MS = 5000;
/** How long Remove keys must be held. */
export const HOLD_MS = 1600;
export const SHORTEST_CHOICES = [10, 30, 60, 120] as const;

/** "1.2K watching", "42 watching". */
export function watchingLine(viewers: number | undefined): string | null {
  if (viewers === undefined || viewers === null || !Number.isFinite(viewers)) return null;
  return `${count(viewers)} watching`;
}

/** The one label for missing Twitch or Kick keys, on rows, found cards and the key slots alike. */
export const NEEDS_GROWN_UP = "Needs a grown-up";

/** The badge on a streamer: LIVE (with viewers), Offline, or nothing yet (keys missing, YouTube without a read key). */
export function liveBadge(f: { live?: FollowLive; resolved: boolean; platform: FollowPlatform }): { text: string; tone: "vermilion" | "neutral" | "warn"; live: boolean } | null {
  if (!f.resolved && f.platform !== "youtube") return { text: NEEDS_GROWN_UP, tone: "warn", live: false };
  if (f.live?.isLive) {
    const watching = watchingLine(f.live.viewers);
    return { text: watching ? `LIVE · ${watching}` : "LIVE", tone: "vermilion", live: true };
  }
  if (f.live) return { text: "Offline", tone: "neutral", live: false };
  return null;
}

/** "Stream ended 3 hours ago." */
export function lastLine(f: Follow, now = Date.now()): string | null {
  if (!f.last) return null;
  return `${f.last.text} ${relative(f.last.at, now)}.`;
}

/** Live first, then by name. */
export function sortFollows(list: readonly Follow[]): Follow[] {
  return [...list].sort((a, b) => Number(!!b.live?.isLive) - Number(!!a.live?.isLive) || a.name.localeCompare(b.name));
}

/** Two letters for a streamer without a picture. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) {
    const w = words[0]!;
    const caps = w.match(/\p{Lu}/gu);
    return (caps && caps.length >= 2 ? caps[0]! + caps[1]! : w.slice(0, 2)).toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** The live event for a follow, applied to the list (upsert keeps the order, delete removes it). */
export function applyFollowEvent(list: Follow[], e: LiveEvent): Follow[] {
  if (e.type !== "follow" || e.partial) return list;
  if (e.op === "delete") return list.filter((f) => f.followId !== e.id);
  const i = list.findIndex((f) => f.followId === e.id);
  if (i < 0) return [...list, e.item];
  const next = [...list];
  next[i] = { ...next[i]!, ...e.item };
  return next;
}

/** A round picture, or the streamer's initials on a green disc. */
export function Avatar({ name, url, live = false, size = 48 }: { name: string; url: string; live?: boolean; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`avatar${live ? " is-live" : ""}`} style={{ inlineSize: size, blockSize: size }} aria-hidden="true">
      {url && !broken ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span className="avatar__initials">{initials(name)}</span>}
    </span>
  );
}

export function FollowBranch() {
  const { data, error, reload, setData } = useLoad(() => api().listFollows());
  useLiveEvents(
    (e) => {
      if (e.type === "follow") setData((d) => (d ? { ...d, follows: applyFollowEvent(d.follows, e) } : d));
    },
    () => void reload(),
  );
  const replace = (next: Follow) => setData((d) => (d ? { ...d, follows: applyFollowEvent(d.follows, { type: "follow", op: "upsert", id: next.followId, item: next }) } : d));
  const used = new Set(data?.follows.map((f) => f.platform) ?? []);
  return (
    <>
      <Panel>
        <Apple id="follow-streamer" wide>
          <AddStreamer
            onAdded={(f) => {
              replace(f);
              void reload();
            }}
          />
        </Apple>
      </Panel>
      <Panel>
        <Apple id="streamers-followed" wide aside={data ? <span className="apple__count">{data.follows.length}</span> : undefined}>
          {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
          {!data && !error ? <Skeleton className="line-skel" /> : null}
          {data && data.follows.length === 0 ? <p className="muted follow__empty">Nobody yet. Find a streamer above and tap Follow.</p> : null}
          {data && data.follows.length ? (
            <ul className="follow__list" aria-label="Streamers you follow">
              {sortFollows(data.follows).map((f) => (
                <li key={f.followId}>
                  <FollowRow
                    follow={f}
                    keysMissing={!f.resolved && f.platform !== "youtube" && !data.keys.find((k) => k.platform === f.platform)?.saved}
                    onHide={(hidden) => setData((d) => (d ? { ...d, follows: hidden ? d.follows.filter((x) => x.followId !== f.followId) : applyFollowEvent(d.follows, { type: "follow", op: "upsert", id: f.followId, item: f }) } : d))}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </Apple>
      </Panel>
      <Panel>
        <Apple id="clips-by-itself" wide>
          <AutoChoices />
        </Apple>
      </Panel>
      <Panel>
        <Apple id="streamer-keys" wide>
          {data ? <KeySlots view={data} used={used} onView={(v) => setData(() => v)} /> : <Skeleton className="line-skel" />}
        </Apple>
      </Panel>
    </>
  );
}

// ---------- Follow a streamer ----------

type Step =
  | { kind: "typing" }
  | { kind: "which"; name: string }
  | { kind: "found"; creator: FollowCreator };

function AddStreamer({ onAdded }: { onAdded: (f: Follow) => void }) {
  const id = useId();
  const toast = useToast();
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>({ kind: "typing" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [yes, setYes] = useState(false);
  const [asking, setAsking] = useState(false);
  const followButton = useRef<HTMLButtonElement>(null);

  async function find(platform?: FollowPlatform): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      const out = await api().lookupFollow(platform && step.kind === "which" ? step.name : text, platform);
      setYes(false);
      setStep(out.needsPlatform ? { kind: "which", name: out.name } : { kind: "found", creator: out.creator });
      return true;
    } catch (e) {
      setProblem(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) {
      setProblem("Paste a link or type a name.");
      return;
    }
    void find();
  }

  function reset() {
    setText("");
    setStep({ kind: "typing" });
    setYes(false);
    setProblem(null);
  }

  async function follow(): Promise<boolean> {
    if (step.kind !== "found" || !yes) return false;
    try {
      const f = await api().follow(step.creator.platform, step.creator.platformId);
      sounds.play("tap", followButton.current);
      burst(centerOf(followButton.current), 90);
      toast.success(`You follow ${f.name} now!`);
      onAdded(f);
      reset();
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  }

  return (
    <div className="follow-add">
      <form className="follow-add__form" onSubmit={submit}>
        <label className="field__label" htmlFor={`${id}-q`}>
          Link or name
        </label>
        <div className="follow-add__row">
          <input
            id={`${id}-q`}
            className="input follow-add__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="twitch.tv/name or a name"
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-status`}
            onChange={(e) => {
              setText(e.target.value);
              if (step.kind !== "typing") setStep({ kind: "typing" });
              setProblem(null);
            }}
          />
          <Button type="submit" variant="action" icon="search" loading={busy && step.kind === "typing"}>
            Find
          </Button>
        </div>
        <p className={`field__status${problem ? " is-bad" : ""}`} id={`${id}-status`} aria-live="polite">
          {problem ? (
            <>
              <Icon name="alert" size={18} />
              <span>{problem}</span>
            </>
          ) : null}
        </p>
      </form>

      {step.kind === "which" ? (
        <div className="follow-which" role="group" aria-labelledby={`${id}-which`}>
          <p className="follow-which__q" id={`${id}-which`}>
            Where does <span className="user-text">{step.name}</span> stream?
          </p>
          <div className="follow-which__buttons">
            {FOLLOW_PLATFORMS.map((p) => (
              <button key={p} type="button" className={`follow-which__btn is-${p}`} data-platform={p} disabled={busy} onClick={() => void find(p)}>
                <PlatformMark platform={p} size={30} />
                <span>{FOLLOW_LABEL[p]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {step.kind === "found" ? (
        <article className="follow-card" aria-label={`${step.creator.name} on ${FOLLOW_LABEL[step.creator.platform]}`}>
          <div className="follow-card__who">
            <Avatar name={step.creator.name} url={step.creator.avatarUrl} live={!!step.creator.live?.isLive} size={56} />
            <div className="follow-card__text">
              <p className="follow-card__name user-text">{step.creator.name}</p>
              <p className="follow-card__site">
                <PlatformMark platform={step.creator.platform} size={18} />
                <span>{FOLLOW_LABEL[step.creator.platform]}</span>
                <LiveBadge follow={step.creator} />
              </p>
            </div>
          </div>
          {step.creator.needsKeys ? (
            <p className="follow-card__note">
              <Icon name="key" size={18} />
              <span>You can follow now. Ask a grown-up to finish {FOLLOW_LABEL[step.creator.platform]} setup to see when they are live.</span>
            </p>
          ) : null}
          <div className="follow-ask">
            <p className="follow-ask__q" id={`${id}-ask`}>
              Did <span className="user-text">{step.creator.name}</span> say you can make clips of their videos?
            </p>
            {step.creator.platform === "youtube" ? <p className="follow-ask__more">YouTube does not allow downloading videos without permission.</p> : null}
            <div className="follow-ask__buttons">
              <button type="button" className={`follow-yes${yes ? " is-on" : ""}`} aria-pressed={yes} aria-describedby={`${id}-ask`} onClick={() => setYes((v) => !v)}>
                <span className="follow-yes__box" aria-hidden="true">
                  {yes ? <Icon name="check" size={18} /> : null}
                </span>
                <span>Yes, they said I can</span>
              </button>
              <Button variant="ghost" size="sm" icon="comment" onClick={() => setAsking(true)}>
                How do I ask?
              </Button>
            </div>
          </div>
          <div className="follow-card__actions">
            <Button ref={followButton} variant="primary" icon="plus" act="add" disabled={!yes} onClick={() => follow()}>
              Follow
            </Button>
            <Button variant="ghost" icon="x" onClick={reset}>
              Cancel
            </Button>
          </div>
          {!yes ? <p className="follow-card__hint">Tap “Yes, they said I can” first.</p> : null}
        </article>
      ) : null}
      {asking && step.kind === "found" ? <AskSheet name={step.creator.name} onClose={() => setAsking(false)} /> : null}
    </div>
  );
}

/** The message to send a streamer. Plain words a child can copy. */
export function askMessage(name: string): string {
  return `Hi ${name}! I love your streams. Can I make short clips of your videos and post them? I will say they are from you. Thank you!`;
}

function AskSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const toast = useToast();
  const message = askMessage(name);
  return (
    <Sheet
      title="How do I ask?"
      onClose={onClose}
      actions={
        <>
          <Button
            variant="action"
            icon="copy"
            act="copy"
            onClick={async () => {
              const ok = await copyText(message);
              if (ok) toast.success("Copied. Paste it in a message to them.");
              return ok;
            }}
          >
            Copy message
          </Button>
          <Button icon="x" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <ol className="follow-steps">
        <li>Ask a grown-up to help you.</li>
        <li>Send this message to the streamer, in their chat or by email.</li>
        <li>Wait for them to say yes.</li>
      </ol>
      <blockquote className="follow-message user-text">{message}</blockquote>
    </Sheet>
  );
}

function LiveBadge({ follow }: { follow: { live?: FollowLive; resolved: boolean; platform: FollowPlatform } }) {
  const badge = liveBadge(follow);
  if (!badge) return null;
  return (
    <span className={`follow-live${badge.live ? " is-live" : ""}`}>
      <Pill tone={badge.tone} icon={badge.text === NEEDS_GROWN_UP ? "key" : undefined}>
        {badge.text}
      </Pill>
    </span>
  );
}

// ---------- Who you follow ----------

function FollowRow({ follow, keysMissing, onHide }: { follow: Follow; keysMissing: boolean; onHide: (hidden: boolean) => void }) {
  const toast = useToast();
  const last = lastLine(follow);

  function remove() {
    onHide(true);
    toast.undo(`Stopped following ${follow.name}.`, {
      ms: REMOVE_UNDO_MS,
      onUndo: () => onHide(false),
      onCommit: () => {
        api()
          .unfollow(follow.platform, follow.platformId)
          .catch((e: unknown) => {
            onHide(false);
            toast.error(friendlyMessage(e));
          });
      },
    });
  }

  return (
    <article className={`follow-row${follow.live?.isLive ? " is-live" : ""}`} data-follow={follow.followId}>
      <div className="follow-row__who">
        <Avatar name={follow.name} url={follow.avatarUrl} live={!!follow.live?.isLive} />
        <div className="follow-row__text">
          <a className="follow-row__name user-text" href={follow.url} target="_blank" rel="noopener noreferrer">
            {follow.name}
          </a>
          <p className="follow-row__site">
            <PlatformMark platform={follow.platform} size={18} title={FOLLOW_LABEL[follow.platform]} />
            <span>{FOLLOW_LABEL[follow.platform]}</span>
            <LiveBadge follow={follow} />
          </p>
          {follow.live?.isLive && follow.live.title ? <p className="follow-row__title user-text clamp-1">{follow.live.title}</p> : null}
          {keysMissing ? <p className="follow-row__line">Ask a grown-up to finish {FOLLOW_LABEL[follow.platform]} setup.</p> : last ? <p className="follow-row__line">{last}</p> : null}
        </div>
      </div>
      <div className="follow-row__actions">
        {/* Part 1 makes nothing by itself: no bright switch that promises clips, just a calm "coming soon". */}
        <span className="follow-row__soon">
          <Pill tone="bone" icon="clock">
            Clips by itself: coming soon
          </Pill>
        </span>
        <Button size="sm" variant="ghost" icon="trash" onClick={remove} aria-label={`Remove ${follow.name}`}>
          Remove
        </Button>
      </div>
    </article>
  );
}

// ---------- Clips by itself ----------

function AutoChoices() {
  const { me, saveSettings } = useSession();
  const s = me?.settings;
  const [lastLimit, setLastLimit] = useState(3);
  if (!s) return <Skeleton className="line-skel" />;
  const daily = s.followDailyMax ?? 0;
  const limited = daily > 0;
  const shortest = s.followMinMinutes ?? 30;
  const options = SHORTEST_CHOICES.includes(shortest as (typeof SHORTEST_CHOICES)[number]) ? [...SHORTEST_CHOICES] : [...SHORTEST_CHOICES, shortest].sort((a, b) => a - b);
  const label = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : `${m} min`);
  return (
    <div className="follow-auto">
      <p className="follow-auto__soon">
        <Pill tone="bone" icon="clock">
          Coming soon
        </Pill>
        <span>Your picks are saved until then.</span>
      </p>
      <Toggle label="Stop all automatic clips" description="Nothing is made by itself while this is on." checked={!!s.followPaused} onChange={(on) => void saveSettings({ followPaused: on })} />
      <Toggle
        label="Limit how many a day"
        description={limited ? "It stops after this many videos a day." : "No limit."}
        checked={limited}
        onChange={(on) => {
          if (!on) setLastLimit(daily || lastLimit);
          void saveSettings({ followDailyMax: on ? lastLimit : 0 });
        }}
      />
      {limited ? (
        <div className="stepper-pair__item follow-auto__limit">
          <Stepper label="Most videos a day" value={daily} min={1} max={20} onChange={(n) => void saveSettings({ followDailyMax: n })} />
          <span className="stepper-pair__label">a day</span>
        </div>
      ) : null}
      <div className="follow-auto__shortest">
        <span className="field__label" id="follow-shortest">
          Shortest video
        </span>
        <Segmented
          label="Shortest video"
          value={String(shortest)}
          options={options.map((m) => ({ value: String(m), label: label(m) }))}
          onChange={(v) => void saveSettings({ followMinMinutes: Number(v) })}
        />
      </div>
      <p className="follow-auto__note muted">Only the first {s.maxSourceHours} hours of a stream are used. These clips always wait in Review for you to check.</p>
    </div>
  );
}

// ---------- Twitch and Kick keys ----------

function KeySlots({ view, used, onView }: { view: FollowsView; used: Set<FollowPlatform>; onView: (v: FollowsView) => void }) {
  const slots = view.keys.filter((k) => k.platform === "youtube-read" || used.has(k.platform as FollowPlatform) || k.saved);
  const nothing = !slots.some((k) => k.platform !== "youtube-read");
  return (
    <div className="follow-keys">
      {nothing ? <p className="muted">Nothing to do yet. Twitch and Kick show up here once you follow someone there.</p> : null}
      {slots.map((slot) => (
        <KeySlot key={slot.platform} slot={slot} kickWebhookUrl={view.kickWebhookUrl} onView={onView} />
      ))}
    </div>
  );
}

const STEPS: Record<FollowKeyPlatform, string[]> = {
  twitch: [
    "Turn on two-step login on your Twitch account.",
    "Open dev.twitch.tv/console and tap Register Your Application.",
    "Type any name, add the address https://localhost as the OAuth Redirect URL, pick a category, then tap Create.",
    "Tap Manage. Copy the Client ID, then tap New Secret and copy the Client Secret.",
    "Paste both below and tap Save keys.",
  ],
  kick: [
    "Turn on two-step login on your Kick account.",
    "Open kick.com/settings/developer and create an app.",
    "Turn on Enable webhooks and paste the webhook address below.",
    "Copy the Client ID and the Client Secret.",
    "Paste both below and tap Save keys.",
  ],
  "youtube-read": [
    "Make a new project in Google Cloud. Do not use the one you post with.",
    "Turn on YouTube Data API v3 in that project.",
    "Create an API key and limit it to YouTube Data API v3.",
    "Paste it below and tap Save key.",
  ],
};

function KeySlot({ slot, kickWebhookUrl, onView }: { slot: FollowKeySlot; kickWebhookUrl: string; onView: (v: FollowsView) => void }) {
  const toast = useToast();
  const id = useId();
  const label = KEY_LABEL[slot.platform];
  const optional = slot.optional;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const names = slot.platform === "youtube-read" ? ["apiKey"] : ["clientId", "clientSecret"];
  const fieldLabel: Record<string, string> = { clientId: "Client ID", clientSecret: "Client Secret", apiKey: "API key" };
  const title = optional ? "YouTube read key (you can skip this)" : `${label} keys`;

  async function save(): Promise<boolean> {
    try {
      const body = slot.platform === "youtube-read" ? { apiKey: values.apiKey ?? "" } : { clientId: values.clientId ?? "", clientSecret: values.clientSecret ?? "" };
      const next = await api().saveFollowKeys(slot.platform, body);
      setValues({});
      setOpen(false);
      onView(next);
      toast.success(`${label} ${optional ? "key" : "keys"} saved.`);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  }

  async function check(): Promise<boolean> {
    setChecking(true);
    try {
      const out = await api().checkFollowKeys(slot.platform);
      const { check: result, ...view } = out;
      onView(view);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      return result.ok;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    setRemoving(false);
    try {
      await api().deleteFollowKeys(slot.platform);
      onView(await api().listFollows());
      toast.success(`${label} ${optional ? "key" : "keys"} removed.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    }
  }

  return (
    <section className={`follow-key${slot.saved ? " is-saved" : ""}`} data-keys={slot.platform} aria-labelledby={`${id}-t`}>
      <div className="follow-key__head">
        {slot.platform === "youtube-read" ? <PlatformMark platform="youtube" size={22} /> : <PlatformMark platform={slot.platform} size={22} />}
        <h3 className="follow-key__title" id={`${id}-t`}>
          {title}
        </h3>
        {slot.saved ? (
          <Pill tone="success" icon="check">
            Saved
          </Pill>
        ) : optional ? null : (
          <Pill tone="warn" icon="key">
            {NEEDS_GROWN_UP}
          </Pill>
        )}
      </div>
      {slot.saved ? (
        <>
          <p className="follow-key__hints">
            {Object.entries(slot.hints ?? {}).map(([k, v]) => (
              <span key={k}>
                {fieldLabel[k] ?? k}: <code>{v}</code>
              </span>
            ))}
          </p>
          {slot.check ? <p className={`follow-key__check${slot.check.ok ? " is-ok" : " is-bad"}`}>{slot.check.message}</p> : null}
          <div className="follow-key__actions">
            <Button size="sm" variant="action" icon="checkCircle" loading={checking} onClick={() => check()}>
              Check it
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoving(true)}>
              Remove {optional ? "key" : "keys"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="follow-key__ask">{optional ? "Shows when YouTube streamers are live. New videos show without it." : `Ask a grown-up to finish ${label} setup. It takes about 5 minutes, once.`}</p>
          <Button size="sm" variant={optional ? "glass" : "action"} icon={open ? "chevronDown" : "key"} aria-expanded={open} aria-controls={`${id}-form`} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide the steps" : optional ? "Add a YouTube key" : "I am the grown-up"}
          </Button>
          {open ? (
            <div className="follow-key__form" id={`${id}-form`}>
              <ol className="follow-steps">
                {STEPS[slot.platform].map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {slot.platform === "kick" ? <CopyChip label="Webhook address" value={kickWebhookUrl || null} /> : null}
              {names.map((name) => (
                <div className="field" key={name}>
                  <label className="field__label" htmlFor={`${id}-${name}`}>
                    {fieldLabel[name]}
                  </label>
                  <input
                    id={`${id}-${name}`}
                    className="input"
                    type={name === "clientId" ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={values[name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                  />
                </div>
              ))}
              <Button variant="action" icon="check" act="save" disabled={names.some((n) => !(values[n] ?? "").trim())} onClick={() => save()}>
                {optional ? "Save key" : "Save keys"}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {removing ? (
        <Sheet
          title={`Remove the ${label} ${optional ? "key" : "keys"}?`}
          onClose={() => setRemoving(false)}
          actions={
            <>
              <Button icon="x" onClick={() => setRemoving(false)}>
                Keep them
              </Button>
              <HoldButton label={`Hold to remove`} onDone={() => void remove()} />
            </>
          }
        >
          <p>{optional ? "Live badges for YouTube stop until a new key is pasted." : `Live badges for ${label} stop until a grown-up pastes them again.`}</p>
        </Sheet>
      ) : null}
    </section>
  );
}

/** A button that only acts after being held down (pointer, Space or Enter) for HOLD_MS. Letting go early does nothing. */
export function HoldButton({ label, onDone, ms = HOLD_MS }: { label: string; onDone: () => void; ms?: number }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = () => {
    if (timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onDone();
    }, ms);
  };
  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  const keyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      start();
    }
  };
  const keyUp = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") stop();
  };
  return (
    <button
      type="button"
      className={`btn btn--danger btn--md hold-btn${holding ? " is-holding" : ""}`}
      style={{ ["--hold-ms" as string]: `${ms}ms` }}
      aria-describedby="hold-help"
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onBlur={stop}
    >
      <span className="hold-btn__fill" aria-hidden="true" />
      <Icon name="trash" size={20} />
      <span className="btn__label">{label}</span>
      <span className="sr-only" id="hold-help">
        Press and hold until the bar is full.
      </span>
    </button>
  );
}
