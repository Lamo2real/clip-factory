// Clips Funded › References: "paste a link" (docs/CONTRACTS.md §45.40.3). One box takes the link to one
// TikTok, YouTube, Instagram, Facebook, X, Google Drive or Dropbox video (api/refLinks.ts: the same list as the API's
// and the agent's); Add sends it (POST …/references/link) and Clips Funded's own runtime gets the video. The button at
// the box's end is Paste while it is empty (when the browser can read the clipboard), Add once it holds a video link,
// and none otherwise: the line under the box says why. A link pasted anywhere on the page, or dropped on it, fills the
// box (usePagePaste here, the page drop in RefList); nothing is ever added by itself.
import "../../styles/ref-link.css";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { PlatformMark } from "../../../components/PlatformMark.tsx";
import { filesFrom } from "../../../features/help/pictures.ts";
import { extractLink } from "../../../lib/links.ts";
import { isEditableTarget } from "../../../lib/dropGuard.ts";
import { OWN_DROP_SELECTOR } from "../../../lib/useFileDrop.ts";
import { storiesApi } from "../../api/client.ts";
import { REF_LINK_REFUSED, refLink, SITE_NAME, type RefSite } from "../../api/refLinks.ts";
import type { ReferenceVideo } from "../../api/types.ts";
import { cx } from "../../glass/index.ts";
import { useAppActive } from "../../pane.tsx";
import { Icon, sentence } from "../kit.tsx";

/** What the box holds: nothing, one video's link (cleaned, with its site), or something else (the line says why). */
export type LinkLook = { kind: "empty" } | { kind: "ok"; url: string; site: RefSite } | { kind: "bad"; line: string };

/** The browser would not let the page read the clipboard: paste by hand. */
export const PASTE_HELP = "Press and hold in the box, then choose Paste.";

/** The box's text as the API will see it: share text cleaned to its link, then checked against the sites (the
 * line for each refusal is the API's own sentence, REF_LINK_REFUSED; each names the fix). */
export function lookOf(text: string): LinkLook {
  const r = refLink(extractLink(text));
  if (r.ok) return { kind: "ok", url: r.url, site: r.site };
  if (r.why === "empty") return { kind: "empty" };
  return { kind: "bad", line: REF_LINK_REFUSED[r.why] };
}

/** The line a box's text gives ("TikTok video found.", or why not), or null while it is empty. */
export function lineOf(look: LinkLook): string | null {
  return look.kind === "ok" ? `${SITE_NAME[look.site]} video found.` : look.kind === "bad" ? look.line : null;
}

/** True when pasted text holds a link worth putting in the box: any http(s) link (the line then says whether it can
 * come in), or a bare link to one of the sites ("youtu.be/…"). */
export function holdsLink(text: string): boolean {
  const t = extractLink(text);
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  const r = refLink(t);
  return r.ok || r.why === "not_one_video";
}

export interface RefLink {
  text: string;
  look: LinkLook;
  /** The line under the box: a note (the Paste help, the API's refusal, a file's refusal) wins until the box changes. */
  line: string | null;
  adding: boolean;
  /** The box element (the page's paste counts a paste in it as its own). */
  box: RefObject<HTMLDivElement | null>;
  /** Typing in the box. */
  setText(text: string): void;
  /** A link from a paste or a drop elsewhere on the page: the box takes it and focus moves to Add. */
  fill(text: string): void;
  /** A line of its own under the box (cleared by the next change of the box). */
  say(line: string | null): void;
  add(): Promise<void>;
  paste(): Promise<void>;
}

/** The link box's state, kept by the page that shows it (RefList), so the page's paste and drop can fill it. */
export function useRefLink(ws: string, onAdded: (ref: ReferenceVideo) => void): RefLink {
  const [text, setTextNow] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [focusAsk, setFocusAsk] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const added = useRef(onAdded);
  added.current = onAdded;
  const look = lookOf(text);

  // After a fill: Add when the box holds a video link, else the box itself (its line says why).
  useEffect(() => {
    if (!focusAsk) return;
    const el = box.current;
    (el?.querySelector<HTMLElement>(".st-ref-link__add") ?? el?.querySelector<HTMLElement>("input"))?.focus();
  }, [focusAsk]);

  const setText = (t: string) => {
    setTextNow(t);
    setNote(null);
  };
  const fill = (t: string) => {
    setText(extractLink(t));
    setFocusAsk((n) => n + 1);
  };

  return {
    text,
    look,
    line: note ?? lineOf(look),
    adding,
    box,
    setText,
    fill,
    say: setNote,
    async add() {
      if (adding || look.kind !== "ok") return;
      setAdding(true);
      setNote(null);
      const hadFocus = !!box.current?.contains(document.activeElement);
      try {
        const made = await storiesApi().createReferenceFromLink(ws, { url: look.url });
        setTextNow("");
        added.current(made.reference);
        if (hadFocus) box.current?.querySelector<HTMLElement>("input")?.focus();
      } catch (e) {
        setNote(sentence(e, "That link did not go in. Try again."));
      } finally {
        setAdding(false);
      }
    },
    async paste() {
      let got: string;
      try {
        got = await navigator.clipboard.readText();
      } catch {
        return setNote(PASTE_HELP);
      }
      if (!got.trim()) return setNote(REF_LINK_REFUSED.not_a_link);
      fill(got);
    },
  };
}

const canReadClipboard = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

/** The box: the site's mark, the field, and its one button. */
export function RefLinkBox({ link }: { link: RefLink }) {
  const id = useId();
  const { look } = link;
  const button: ReactNode =
    look.kind === "ok" ? (
      <button type="button" className="st-chat-btn st-chat-btn--main st-ref-link__btn st-ref-link__add" aria-disabled={link.adding || undefined} onClick={() => void link.add()}>
        <Icon name="plus" size={20} />
        {link.adding ? "Adding…" : "Add"}
      </button>
    ) : look.kind === "empty" && canReadClipboard() ? (
      <button type="button" className="st-chat-btn st-chat-btn--quiet st-ref-link__btn st-ref-link__paste" onClick={() => void link.paste()}>
        Paste
      </button>
    ) : null;
  return (
    <div className={cx("st-ref-link", look.kind === "ok" && "has-site", button && "has-btn")} ref={link.box}>
      <span className="st-ref-link__mark" aria-hidden="true">
        {look.kind === "ok" ? <SiteMark site={look.site} /> : <LinkMark />}
      </span>
      <label className="sr-only" htmlFor={id}>
        Video link
      </label>
      <input
        id={id}
        className="st-ref-link__input"
        type="url"
        inputMode="url"
        enterKeyHint="go"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Paste a video link"
        maxLength={4096}
        value={link.text}
        onChange={(e) => link.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void link.add();
        }}
      />
      {button}
    </div>
  );
}

/** The site's own mark (the five platforms share Clip Factory's single-colour marks; Drive and Dropbox are drawn here). */
function SiteMark({ site }: { site: RefSite }) {
  if (site === "drive")
    return (
      <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8.6 3.5h6.8l6.4 11-3.4 6H5.6l-3.4-6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8.6 3.5l6.4 11h6.8M15.4 3.5 9 14.5l-3.4 6M2.2 14.5H15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  if (site === "dropbox")
    return (
      <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7 3.5 2 6.75 7 10l5-3.25zM17 3.5l-5 3.25L17 10l5-3.25zM2 13.25 7 16.5l5-3.25L7 10zM17 10l-5 3.25 5 3.25 5-3.25zM7 17.75l5 3.25 5-3.25-5-3.25z" fill="currentColor" />
      </svg>
    );
  return <PlatformMark platform={site} size={22} />;
}

function LinkMark() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.2 1.2M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.2-1.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A paste anywhere on the page (§45.40.3): video files start uploads (through `checkFile`, the same check as the
 * picker), text with a link fills the box (never added by itself). On only while this app is on screen and `enabled`;
 * never a paste into another field, into Ask (OWN_DROP_SELECTOR), or while a dialog is open. preventDefault only when
 * the paste was taken.
 */
export function usePagePaste(opts: {
  enabled: boolean;
  box: RefObject<HTMLElement | null>;
  checkFile: (f: File) => string | null;
  maxFiles: number;
  onFiles: (files: File[]) => void;
  onLink: (text: string) => void;
  onRefused: (line: string) => void;
}): void {
  const active = useAppActive();
  const latest = useRef(opts);
  latest.current = opts;
  const on = opts.enabled && active;
  useEffect(() => {
    if (!on) return;
    const onPaste = (e: ClipboardEvent) => {
      const o = latest.current;
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(OWN_DROP_SELECTOR)) return;
      const inBox = !!target && !!o.box.current?.contains(target);
      if (!inBox && isEditableTarget(target)) return;
      const data = e.clipboardData;
      const files = filesFrom(data);
      if (files.length) {
        const good = files.filter((f) => !o.checkFile(f)).slice(0, o.maxFiles);
        if (good.length) {
          e.preventDefault();
          o.onFiles(good);
          return;
        }
      }
      let text: string;
      try {
        text = data?.getData("text/plain") ?? "";
      } catch {
        text = "";
      }
      if (text.trim() && holdsLink(text)) {
        e.preventDefault();
        o.onLink(text);
        return;
      }
      // A file that is no video (a screenshot), with no link beside it: say why, take nothing.
      if (files.length && !inBox) o.onRefused(o.checkFile(files[0]!) ?? REF_LINK_REFUSED.not_a_link);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [on]);
}
