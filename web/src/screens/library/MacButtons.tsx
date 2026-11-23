// The TikTok row's one button (docs/CONTRACTS.md §47.4) on Library cards, the clip page and Review's Uploaded just
// now. Until TikTok approves the app the owner's Mac is the only way to TikTok (ADR-85), so there is no sheet: Try
// again on a stopped Mac post and Post with my Mac on a clip that isn't on TikTok yet (both go to the Mac at once,
// `now`), Turn on while the Mac can't post (Open Your Mac posts TikTok while it needs him or is paused), the inline
// Add link on a post made without its link, and It's on TikTok (with Try again second) once the Mac pressed Post but
// couldn't tell if it posted.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Post, PostMac } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, LinkButton } from "../../components/ui.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { useAction } from "../../lib/motion.ts";
import { lastLiveRunAt, MAC_ON_TIKTOK_BUTTON, MAC_OPEN_BUTTON, macOn, type TikTokRow, type TikTokRowContext } from "../../lib/tiktokMac.ts";
import { looksLikeTikTokLink } from "../../lib/tiktokYourself.ts";
import { readClipboard } from "../settings/setup/bits.tsx";
import { useTikTokMac } from "../settings/TikTokMacBranch.tsx";

type Kept = (clip: Clip, posts: Post[]) => void;
type Size = "sm" | "md";

/** Auto-posting's next run and its last scheduled live run, read while a backlog clip waits (it goes ~30 min after one). */
export interface RunTimes {
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** GET /v1/autopost while `active`: at once, on focus and every 5 minutes. Null until read (or when it fails). */
export function useRunTimes(active: boolean): RunTimes | null {
  const [times, setTimes] = useState<RunTimes | null>(null);
  const load = useCallback(async () => {
    const a = await api().autoPostStatus();
    setTimes({ nextRunAt: a.nextRunAt, lastRunAt: lastLiveRunAt(a.runs) });
  }, []);
  const reload = useCallback(() => void load().catch(() => undefined), [load]);
  useEffect(() => {
    if (!active) return;
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [active, reload]);
  usePoll(load, active, 5 * 60_000);
  return active ? times : null;
}

/** A clock for the rows' "next at" and "since" times, ticking only while a row reads the Mac (a page full of rows). */
function useClock(active: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active, ms]);
  return now;
}

/**
 * What every TikTok row reads (§47.4): the two switches (the session's settings), the Mac's check-in while `needsMac`
 * (GET /v1/tiktok/mac), and auto-posting's runs while `needsRuns`. `runs`: a page that reads GET /v1/autopost anyway
 * (Review) passes its own, and this reads nothing more.
 */
export function useTikTokRowContext({
  audited,
  needsMac,
  needsRuns,
  runs,
}: {
  audited: boolean;
  needsMac: boolean;
  needsRuns: boolean;
  runs?: RunTimes | null;
}): TikTokRowContext {
  const { me } = useSession();
  const mac = useTikTokMac(needsMac);
  const own = useRunTimes(needsRuns && runs === undefined);
  const times = runs === undefined ? own : runs;
  const now = useClock(needsMac || needsRuns);
  return {
    audited,
    ...(me ? { macOn: macOn(me.settings), autoPostOn: me.settings.autoPost?.on === true } : {}),
    ...(mac.status ? { helper: mac.status.helper } : {}),
    nextRunAt: times?.nextRunAt ?? null,
    lastRunAt: times?.lastRunAt ?? null,
    now,
  };
}

/** Try again on a stopped Mac post: back to the Mac at once. After the Mac pressed Post it also says it's not on TikTok. */
export function MacTryAgain({
  clip,
  mac,
  onKept,
  size = "sm",
  variant = "glass",
}: {
  clip: Pick<Clip, "clipId">;
  mac: Pick<PostMac, "pressedAt">;
  onKept: Kept;
  size?: Size;
  /** "ghost" where it is the second choice (after It's on TikTok). */
  variant?: "glass" | "ghost";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("retry");
  async function press() {
    setBusy(true);
    try {
      const out = await api().retryMac(clip.clipId, !!mac.pressedAt, true);
      onKept(out.clip, out.posts);
      toast.success("Sent to your Mac again.", { group: "tiktok-mac" });
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="post__retry">
      <Button size={size} variant={variant} icon="retry" act={act} loading={busy} onClick={() => void press()} aria-label="Try again, TikTok">
        Try again
      </Button>
    </span>
  );
}

/** Post with my Mac: a clip that isn't on TikTok yet goes to the Mac at once, like an Upload tap (§47.2, `now`). */
export function PostWithMyMac({ clip, onKept, size = "sm" }: { clip: Pick<Clip, "clipId">; onKept: Kept; size?: Size }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("send");
  async function press() {
    setBusy(true);
    try {
      const [result] = await api().sendToMac([clip.clipId], true);
      if (!result?.sent) {
        act.fail({ sound: false });
        toast.error(result?.reason ?? "Your Mac couldn't take this clip.");
        return;
      }
      const [posts, fresh] = await Promise.all([api().listPosts(clip.clipId), api().getClip(clip.clipId)]);
      onKept(fresh, posts);
      toast.success("Sent to your Mac! It posts it in a minute.", { group: "tiktok-mac" });
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="post__retry">
      <Button size={size} variant="glass" icon="monitor" act={act} loading={busy} onClick={() => void press()}>
        Post with my Mac
      </Button>
    </span>
  );
}

/**
 * Turn on: to Settings › Posting › Your Mac posts TikTok, where the switch is. With `open` (the Mac needs him, or is
 * paused) it reads Open Your Mac posts TikTok, on a line of its own under the row's words (it is long).
 */
export function TurnOnMac({ href, size = "sm", open = false }: { href: string; size?: Size; open?: boolean }) {
  return (
    <span className={open ? "post__retry post__retry--wide" : "post__retry"}>
      <LinkButton href={href} size={size} variant="glass" icon="monitor" iconAfter="chevronRight">
        {open ? MAC_OPEN_BUTTON : "Turn on"}
      </LinkButton>
    </span>
  );
}

const NOT_A_LINK = "That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.";

/**
 * Add link, in the row itself (no dialog): the box, Paste and Save the link (POST /v1/clips/{id}/tiktok/posted, §42.2).
 * An empty box lets Clip Factory look for the post on his TikTok, from `since` (when it was posted; absent, the API
 * looks back an hour). A campaign clip he posted in the TikTok app is marked the same way.
 */
export function AddTikTokLink({
  clip,
  since,
  onKept,
  focus = false,
  id: formId,
}: {
  clip: Pick<Clip, "clipId">;
  since?: string;
  onKept: Kept;
  /** Opened by a tap (It's on TikTok): the box takes the focus. */
  focus?: boolean;
  id?: string;
}) {
  const id = useId();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const toast = useToast();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const done = useAction("check");
  const paste = useAction("paste");

  async function pasteLink() {
    const text = await readClipboard();
    if (text) {
      setLink(text.trim());
      setProblem("");
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const typed = link.trim();
    if (typed && !looksLikeTikTokLink(typed)) {
      done.fail();
      setProblem(NOT_A_LINK);
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const out = await api().markTikTokPosted(clip.clipId, typed || undefined, since);
      onKept(out.clip, out.posts);
      const linked = !!out.posts.find((p) => p.platform === "tiktok")?.url;
      // The note wins: a link from another account is kept, but its views are not read.
      if (out.note || !linked) toast.info(out.note ?? "Clip Factory could not find it yet. Paste its link instead.");
      else toast.success(typed ? "Link saved! Clip Factory will count its views." : "Found it on your TikTok! Clip Factory will count its views.");
    } catch (err) {
      done.fail({ sound: false });
      setProblem(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="post-link" id={formId} onSubmit={(e) => void save(e)} aria-label="Add the TikTok link">
      <label className="sr-only" htmlFor={`${id}-link`}>
        TikTok link
      </label>
      <input
        ref={box}
        id={`${id}-link`}
        className="input post-link__input"
        inputMode="url"
        autoComplete="off"
        placeholder="Paste the TikTok link"
        value={link}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => setLink(e.target.value)}
      />
      <Button size="sm" variant="glass" icon="paste" act={paste} onClick={() => void pasteLink()} aria-label="Paste the TikTok link">
        Paste
      </Button>
      <Button type="submit" size="sm" variant="glass" icon="check" act={done} loading={busy}>
        Save the link
      </Button>
      {problem ? (
        <p className="post-link__problem" id={`${id}-problem`} role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The Mac pressed Post but couldn't tell if it posted (§47.3): it may be on TikTok, so he looks there first. It's on
 * TikTok opens the Add link in the row (its link, or an empty box to let Clip Factory find it on his TikTok, from
 * `since`); Try again, the second choice, says it is not there and sends it to the Mac again at once.
 */
export function MacOnTikTok({
  clip,
  mac,
  since,
  onKept,
  size = "sm",
}: {
  clip: Pick<Clip, "clipId">;
  mac: Pick<PostMac, "pressedAt">;
  since?: string;
  onKept: Kept;
  size?: Size;
}) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  return (
    <>
      <span className="post__choices">
        <Button
          size={size}
          variant="glass"
          icon="check"
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          {MAC_ON_TIKTOK_BUTTON}
        </Button>
        <MacTryAgain clip={clip} mac={mac} onKept={onKept} size={size} variant="ghost" />
      </span>
      {open ? <AddTikTokLink clip={clip} since={since ?? mac.pressedAt} onKept={onKept} focus id={formId} /> : null}
    </>
  );
}

/**
 * The row's one button, from tiktokRow: Try again, Post with my Mac, Turn on, Open Your Mac posts TikTok, Add link,
 * or It's on TikTok with Try again (none for the rest). `mac`: the Mac post's own fields, for Try again.
 */
export function TikTokRowAction({
  clip,
  row,
  mac,
  onKept,
  size = "sm",
}: {
  clip: Pick<Clip, "clipId">;
  row: TikTokRow | null;
  mac?: Pick<PostMac, "pressedAt">;
  onKept: Kept;
  size?: Size;
}) {
  if (!row?.button) return null;
  switch (row.button) {
    case "try_again":
      return <MacTryAgain clip={clip} mac={mac ?? {}} onKept={onKept} size={size} />;
    case "on_tiktok":
      return <MacOnTikTok clip={clip} mac={mac ?? {}} since={row.since} onKept={onKept} size={size} />;
    case "post_with_mac":
      return <PostWithMyMac clip={clip} onKept={onKept} size={size} />;
    case "turn_on":
      return row.href ? <TurnOnMac href={row.href} size={size} /> : null;
    case "open_mac":
      return row.href ? <TurnOnMac href={row.href} size={size} open /> : null;
    case "add_link":
      return <AddTikTokLink clip={clip} since={row.since} onKept={onKept} />;
  }
}
