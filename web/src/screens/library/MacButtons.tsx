// The TikTok row's one button (docs/CONTRACTS.md §47.4) on Library cards, the clip page and Review's Uploaded just
// now. Until TikTok approves the app the owner's Mac is the only way to TikTok (ADR-86), so there is no sheet: Try
// again on a stopped Mac post and Post with my Mac on a clip that isn't on TikTok yet (both go to the Mac at once,
// `now`), Turn on while the Mac can't post, Open Your Mac posts TikTok while it is quiet, Open the stopped clip while it
// needs him, Start my Mac again while it is paused, the inline Add link (with Find it for me) on a post made without
// its link, and It's on TikTok (with a quieter Try again once the Mac stopped looking, which asks first) when it is not
// sure it posted: the Mac pressed Post but couldn't tell, or its post is stuck.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Post, PostMac } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, LinkButton } from "../../components/ui.tsx";
import { useAction } from "../../lib/motion.ts";
import {
  MAC_AGAIN_CONFIRM,
  MAC_FIND_BUTTON,
  MAC_LINK_EMPTY,
  MAC_NO_LINK_BUTTON,
  MAC_NO_LINK_CONFIRM,
  MAC_NO_LINK_SAVED,
  MAC_NO_LINK_YES,
  MAC_ON_TIKTOK_BUTTON,
  MAC_OPEN_BUTTON,
  MAC_OPEN_STOPPED_BUTTON,
  MAC_RESUME_BUTTON,
  MAC_RESUMED_TOAST,
  macOn,
  type TikTokRow,
  type TikTokRowContext,
} from "../../lib/tiktokMac.ts";
import { looksLikeTikTokLink } from "../../lib/tiktokYourself.ts";
import { readClipboard } from "../settings/setup/bits.tsx";
import { macChanged, useTikTokMac } from "../settings/TikTokMacBranch.tsx";

type Kept = (clip: Clip, posts: Post[]) => void;
type Size = "sm" | "md";

/** A clock for the rows' "since" and "goes at about" times, ticking only while a row reads the Mac (a page full of rows). */
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
 * What every TikTok row reads (§47.4): the two switches (the session's settings), and the Mac's check-in and queue
 * while `needsMac` (GET /v1/tiktok/mac, which also says the Mac's own backlog time and hold). Nothing reads GET
 * /v1/autopost: the Mac paces its backlog itself and says when (D4).
 */
export function useTikTokRowContext({ audited, needsMac }: { audited: boolean; needsMac: boolean }): TikTokRowContext {
  const { me } = useSession();
  const mac = useTikTokMac(needsMac);
  const now = useClock(needsMac);
  return {
    audited,
    ...(me ? { macOn: macOn(me.settings), autoPostOn: me.settings.autoPost?.on === true } : {}),
    ...(mac.status ? { helper: mac.status.helper, queue: mac.status.queue } : {}),
    now,
  };
}

/** Try again on a stopped Mac post: back to the Mac at once. After the Mac pressed Post it also says it's not on TikTok. */
export function MacTryAgain({ clip, mac, onKept, size = "sm" }: { clip: Pick<Clip, "clipId">; mac: Pick<PostMac, "pressedAt">; onKept: Kept; size?: Size }) {
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
      <Button size={size} variant="glass" icon="retry" act={act} loading={busy} onClick={() => void press()} aria-label="Try again, TikTok">
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
 * paused) it reads Open Your Mac posts TikTok, on a line of its own under the row's words (it is long). `label`: the
 * words for a Turn on that stands away from TikTok's row (the clip page's actions), so it says what it turns on.
 */
export function TurnOnMac({ href, size = "sm", open = false, label = "Turn on" }: { href: string; size?: Size; open?: boolean; label?: string }) {
  return (
    <span className={open ? "post__retry post__retry--wide" : "post__retry"}>
      <LinkButton href={href} size={size} variant="glass" icon="monitor" iconAfter="chevronRight">
        {open ? MAC_OPEN_BUTTON : label}
      </LinkButton>
    </span>
  );
}

/** Open the stopped clip (D5): the clip the Mac stopped on while it needs him, on a line of its own under the words. */
export function OpenStoppedClip({ href, size = "sm", wide = true }: { href: string; size?: Size; wide?: boolean }) {
  const link = (
    <LinkButton href={href} size={size} variant="glass" icon="monitor" iconAfter="chevronRight">
      {MAC_OPEN_STOPPED_BUTTON}
    </LinkButton>
  );
  return wide ? <span className="post__retry post__retry--wide">{link}</span> : link;
}

/**
 * Start my Mac again (D5): the paused Mac goes on at its next tick (POST /v1/tiktok/mac/request resume). Every open
 * view reads the Mac again at once (macChanged), so its rows and Settings say "starting again" within a second.
 */
export function MacStartAgain({ size = "sm" }: { size?: Size }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("send");
  async function press() {
    setBusy(true);
    try {
      await api().tiktokMacRequest("resume");
      toast.success(MAC_RESUMED_TOAST, { group: "tiktok-mac" });
      macChanged();
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
      macChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size={size} variant="glass" icon="monitor" act={act} loading={busy} onClick={() => void press()}>
      {MAC_RESUME_BUTTON}
    </Button>
  );
}

const NOT_A_LINK = "That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.";

/**
 * Add link, in the row itself (no dialog): the box with Find it for me next to it, Paste and Save the link (POST
 * /v1/clips/{id}/tiktok/posted, §42.2). Find it for me lets Clip Factory look for the post on his TikTok, from `since`
 * (when it was posted; absent, the API looks back an hour); not found, it says so and saves nothing (D3). With
 * `noLink` (a post the Mac is not working on before Post) a quiet "It's on TikTok, no link" saves it without its
 * link, after its own question.
 */
export function AddTikTokLink({
  clip,
  since,
  onKept,
  focus = false,
  noLink = false,
  id: formId,
}: {
  clip: Pick<Clip, "clipId">;
  since?: string;
  onKept: Kept;
  /** Opened by a tap (It's on TikTok): the box takes the focus. */
  focus?: boolean;
  /** "It's on TikTok, no link" is offered (TikTokRow.noLink). */
  noLink?: boolean;
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
  const [asking, setAsking] = useState(false);
  const done = useAction("check");
  const paste = useAction("paste");
  const find = useAction("check");
  const [finding, setFinding] = useState(false);

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
    // An empty box sends nothing: Find it for me is the way to look for it.
    if (!typed) {
      done.fail({ sound: false });
      setProblem(MAC_LINK_EMPTY);
      return;
    }
    if (!looksLikeTikTokLink(typed)) {
      done.fail();
      setProblem(NOT_A_LINK);
      return;
    }
    await mark(typed, done, setBusy);
  }

  /** Find it for me: no link, Clip Factory looks for the post on his TikTok (whatever the box holds). */
  async function findIt() {
    await mark("", find, setFinding);
  }

  async function mark(typed: string, act: typeof done, setLoading: (on: boolean) => void) {
    setLoading(true);
    setProblem("");
    try {
      const out = await api().markTikTokPosted(clip.clipId, typed || undefined, since);
      onKept(out.clip, out.posts);
      const linked = !!out.posts.find((p) => p.platform === "tiktok")?.url;
      // The note wins: a link from another account is kept, but its views are not read.
      if (out.note || !linked) toast.info(out.note ?? "Clip Factory could not find it yet. Paste its link instead.");
      else toast.success(typed ? "Link saved! Clip Factory will count its views." : "Found it on your TikTok! Clip Factory will count its views.");
    } catch (err) {
      // Not found (or TikTok not connected): the server's words, in the row; nothing was saved.
      act.fail({ sound: false });
      setProblem(friendlyMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (asking) return <NoLinkConfirm clip={clip} since={since} onKept={onKept} id={formId} onClose={() => setAsking(false)} />;

  return (
    <form className="post-link" id={formId} onSubmit={(e) => void save(e)} aria-label="Add the TikTok link">
      {/* The box and Find it for me on one line, side by side: no link needed to find it. */}
      <span className="post-link__box">
        <label className="sr-only" htmlFor={`${id}-link`}>
          TikTok link
        </label>
        <input
          ref={box}
          id={`${id}-link`}
          className="input post-link__input"
          inputMode="url"
          autoComplete="off"
          placeholder="Paste the link"
          value={link}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => setLink(e.target.value)}
        />
        <Button size="sm" variant="glass" icon="search" act={find} loading={finding} disabled={busy} onClick={() => void findIt()}>
          {MAC_FIND_BUTTON}
        </Button>
      </span>
      <Button size="sm" variant="glass" icon="paste" act={paste} onClick={() => void pasteLink()} aria-label="Paste the TikTok link">
        Paste
      </Button>
      <Button type="submit" size="sm" variant="glass" icon="check" act={done} loading={busy} disabled={finding}>
        Save the link
      </Button>
      {noLink ? (
        <Button size="sm" variant="ghost" className="post__again" disabled={busy || finding} onClick={() => setAsking(true)}>
          {MAC_NO_LINK_BUTTON}
        </Button>
      ) : null}
      {problem ? (
        <p className="post-link__problem" id={`${id}-problem`} role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/** "Save it as on TikTok without its link? …": Yes saves it with no link (`noLink`), Not now goes back to the box. */
function NoLinkConfirm({ clip, since, onKept, id: groupId, onClose }: { clip: Pick<Clip, "clipId">; since?: string; onKept: Kept; id?: string; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("check");
  const yes = useRef<HTMLButtonElement>(null);
  const id = useId();
  // The tapped button is gone: the focus goes to the question's Yes, so a keyboard keeps its place.
  useEffect(() => yes.current?.focus(), []);
  async function save() {
    setBusy(true);
    try {
      const out = await api().markTikTokPosted(clip.clipId, undefined, since, true);
      onKept(out.clip, out.posts);
      toast.success(MAC_NO_LINK_SAVED, { group: "tiktok-mac" });
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
      onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="post__confirm" id={groupId} role="group" aria-labelledby={`${id}-ask`}>
      <p className="post__confirm-text" id={`${id}-ask`}>
        {MAC_NO_LINK_CONFIRM}
      </p>
      <span className="post__confirm-buttons">
        <Button ref={yes} size="sm" variant="glass" icon="check" act={act} loading={busy} onClick={() => void save()}>
          {MAC_NO_LINK_YES}
        </Button>
        <Button size="sm" variant="ghost" className="post__again" disabled={busy} onClick={onClose}>
          Not now
        </Button>
      </span>
    </div>
  );
}

/**
 * Not sure it posted (§47.3): the Mac pressed Post but couldn't tell, or its post is stuck. It may be on TikTok, so he
 * looks there first. It's on TikTok opens the Add link in the row (its link, or Find it for me, from `since`; with
 * `noLink` also "It's on TikTok, no link"). Try again, the second and quieter choice, shows only with `again` (the
 * Mac stopped looking for it, D2); it asks first ("Post it again? Only if it's not on your TikTok."), then says it is
 * not there and sends it to the Mac again at once.
 */
export function MacOnTikTok({
  clip,
  since,
  again = false,
  noLink = false,
  onKept,
  size = "sm",
}: {
  clip: Pick<Clip, "clipId">;
  since?: string;
  again?: boolean;
  noLink?: boolean;
  onKept: Kept;
  size?: Size;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const formId = useId();
  if (asking && again) return <MacAgainConfirm clip={clip} onKept={onKept} size={size} onClose={() => setAsking(false)} />;
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
        {again ? (
          <Button
            size={size}
            variant="ghost"
            icon="retry"
            className="post__again"
            aria-label="Try again, TikTok"
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
          >
            Try again
          </Button>
        ) : null}
      </span>
      {open ? <AddTikTokLink clip={clip} since={since} onKept={onKept} focus noLink={noLink} id={formId} /> : null}
    </>
  );
}

/** Try again after It's on TikTok: "Post it again? Only if it's not on your TikTok." Yes says it isn't there (`notOnTikTok`). */
function MacAgainConfirm({ clip, onKept, size, onClose }: { clip: Pick<Clip, "clipId">; onKept: Kept; size: Size; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("retry");
  const yes = useRef<HTMLButtonElement>(null);
  const id = useId();
  // The tapped Try again is gone: the focus goes to the question's Yes, so a keyboard keeps its place.
  useEffect(() => yes.current?.focus(), []);
  async function again() {
    setBusy(true);
    try {
      const out = await api().retryMac(clip.clipId, true, true);
      onKept(out.clip, out.posts);
      toast.success("Sent to your Mac again.", { group: "tiktok-mac" });
      onClose();
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="post__confirm" role="group" aria-labelledby={`${id}-ask`}>
      <p className="post__confirm-text" id={`${id}-ask`}>
        {MAC_AGAIN_CONFIRM}
      </p>
      <span className="post__confirm-buttons">
        <Button ref={yes} size={size} variant="glass" icon="retry" act={act} loading={busy} onClick={() => void again()}>
          Yes, post it again
        </Button>
        <Button size={size} variant="ghost" className="post__again" disabled={busy} onClick={onClose}>
          Not now
        </Button>
      </span>
    </div>
  );
}

/**
 * The row's one button, from tiktokRow: Try again, Post with my Mac, Turn on, Open Your Mac posts TikTok, Open the
 * stopped clip, Start my Mac again, Add link, or It's on TikTok (with Try again once `row.again`); none for the rest.
 * `mac`: the Mac post's own fields, for Try again.
 */
export function TikTokRowAction({
  clip,
  row,
  mac,
  onKept,
  size = "sm",
  turnOnLabel,
}: {
  clip: Pick<Clip, "clipId">;
  row: TikTokRow | null;
  mac?: Pick<PostMac, "pressedAt">;
  onKept: Kept;
  size?: Size;
  /** Turn on's words where the button stands away from TikTok's row (the clip page): "Turn on TikTok on my Mac". */
  turnOnLabel?: string;
}) {
  if (!row?.button) return null;
  switch (row.button) {
    case "try_again":
      return <MacTryAgain clip={clip} mac={mac ?? {}} onKept={onKept} size={size} />;
    case "on_tiktok":
      return <MacOnTikTok clip={clip} since={row.since ?? mac?.pressedAt} again={!!row.again} noLink={!!row.noLink} onKept={onKept} size={size} />;
    case "post_with_mac":
      return <PostWithMyMac clip={clip} onKept={onKept} size={size} />;
    case "turn_on":
      return row.href ? <TurnOnMac href={row.href} size={size} label={turnOnLabel} /> : null;
    case "open_mac":
      return row.href ? <TurnOnMac href={row.href} size={size} open /> : null;
    case "open_stopped":
      return row.href ? <OpenStoppedClip href={row.href} size={size} /> : null;
    case "resume":
      return (
        <span className="post__retry post__retry--wide">
          <MacStartAgain size={size} />
        </span>
      );
    case "add_link":
      return <AddTikTokLink clip={clip} since={row.since} onKept={onKept} />;
  }
}
