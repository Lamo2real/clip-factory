// The "Post to TikTok" sheet (docs/CONTRACTS.md §17.8, §33.5, TikTok's Content Sharing Guidelines): opens on Upload
// when TikTok is one of the chosen places. Who can see it is one tap on a bar of buttons (no dropdown) with no default,
// Everyone first; Comments, Duet and Stitch start off and stay visible; Commercial content needs Your brand or
// Branded content (branded cannot be "Only me"). Upload stays off until a privacy is picked.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, TikTokCreator, TikTokPostOptions } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { Button, Segmented, Toggle } from "../../components/ui.tsx";
import { useAction, type ActionHandle } from "../../lib/motion.ts";
import { NO_TIKTOK_CHOICES, tiktokOptions, type TikTokChoices } from "../../lib/tiktokChoices.ts";

export const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/** The order the buttons show: Everyone first, Only me last. Anything TikTok adds later goes at the end. */
const PRIVACY_ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

/**
 * The options the sheet may offer: TikTok's list (never more), Everyone first, without "Only me" when the post is
 * branded content.
 */
export function privacyChoices(options: string[], branded: boolean): string[] {
  const rank = (o: string) => (PRIVACY_ORDER.includes(o) ? PRIVACY_ORDER.indexOf(o) : PRIVACY_ORDER.length);
  return options.filter((o) => !(branded && o === "SELF_ONLY")).sort((a, b) => rank(a) - rank(b));
}

/** TikTok only lets this creator post as "Only me": the app is not approved (audited) by TikTok yet. */
export function onlyPrivateAllowed(options: string[]): boolean {
  return options.length === 1 && options[0] === "SELF_ONLY";
}

/** Upload can be pressed: a privacy is picked, and Commercial content (when on) says whose. */
export function sheetReady(o: { privacy: string; commercial: boolean; yourBrand: boolean; branded: boolean }): boolean {
  if (!o.privacy) return false;
  if (o.commercial && !o.yourBrand && !o.branded) return false;
  if (o.branded && o.privacy === "SELF_ONLY") return false;
  return true;
}

/**
 * Whether the clip is longer than TikTok lets this creator post. A limit of 0 (or none) means TikTok did not say,
 * so it does not block: the publisher checks the length again before it uploads (§17.8).
 */
export function tooLongForTikTok(durationSec: number, maxDurationSec: number | null | undefined): boolean {
  return !!maxDurationSec && maxDurationSec > 0 && durationSec > maxDurationSec;
}

export function TikTokSheet({
  clip,
  caption,
  onCaption,
  onUpload,
  onClose,
  busy,
  action = "Upload",
  act,
}: {
  clip: Clip;
  caption: string;
  /** Absent: the caption cannot change any more (Try again on an uploaded clip), so the box is read-only. */
  onCaption?: (text: string) => void;
  onUpload: (options: TikTokPostOptions) => void;
  onClose: () => void;
  busy: boolean;
  /** The big button's word: Upload, or Try again on a clip that did not go up. */
  action?: "Upload" | "Try again";
  /**
   * The big button's motion (§20.11 (a)): Upload posts to TikTok, so the plane flies; Try again turns. Pass a handle
   * to shake it when posting fails (the owner's own error path); without one the sheet uses its own.
   */
  act?: ActionHandle;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const ownAct = useAction(action === "Upload" ? "send" : "retry");
  const [creator, setCreator] = useState<TikTokCreator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<TikTokChoices>(NO_TIKTOK_CHOICES);
  const { privacy, comments, duet, stitch, commercial, yourBrand, branded } = choices;
  const set = (patch: Partial<TikTokChoices>) => setChoices((c) => ({ ...c, ...patch }));
  const setPrivacy = (v: string) => set({ privacy: v });
  const setComments = (v: boolean) => set({ comments: v });
  const setDuet = (v: boolean) => set({ duet: v });
  const setStitch = (v: boolean) => set({ stitch: v });
  const setCommercial = (v: boolean) => set({ commercial: v });
  const setYourBrand = (v: boolean) => set({ yourBrand: v });

  // Fetched every time the sheet opens: TikTok's rules say the creator's current options must be shown.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let alive = true;
    api()
      .tiktokCreatorInfo()
      .then((c) => alive && setCreator(c))
      .catch((e) => alive && setError(friendlyMessage(e)));
    return () => {
      alive = false;
    };
  }, [asked]);
  const askAgain = useCallback(() => {
    setError(null);
    setAsked((n) => n + 1);
  }, []);

  // The latest onClose: callers pass a new function on every render (each typed letter in the caption re-renders
  // the card), and the focus below must run once, or typing would lose the caret after one letter.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A real modal: focus moves in once on open and goes back to what opened it (the card's Upload) on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapTab(e, dialog.current);
  }

  const options = creator ? privacyChoices(creator.privacyOptions, branded && commercial) : [];
  const ready = sheetReady({ privacy, commercial, yourBrand: commercial && yourBrand, branded: commercial && branded });
  const tooLong = !!creator && tooLongForTikTok(clip.durationSec, creator.maxDurationSec);

  function setBrandedOn(on: boolean) {
    set(on && privacy === "SELF_ONLY" ? { branded: on, privacy: "" } : { branded: on });
  }

  // Drawn on document.body: inside the glass review card a fixed backdrop would cover only the card (§17.8).
  return createPortal(
    <div className="tt-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tt-sheet glass" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialog} onKeyDown={keys}>
        <header className="tt-sheet__head">
          <h2 className="tt-sheet__title" id={`${id}-title`}>
            Post to TikTok
          </h2>
          <button type="button" className="tt-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </header>
        {error ? (
          <div className="tt-sheet__stuck">
            <p className="callout callout--bad" role="alert">
              <Icon name="alert" size={18} />
              <span>{error} Tap Ask TikTok again. To upload it to your other places now, turn TikTok off above and tap Upload.</span>
            </p>
            <div className="tt-sheet__stuck-actions">
              <Button icon="retry" act="retry" onClick={askAgain}>
                Ask TikTok again
              </Button>
            </div>
          </div>
        ) : !creator ? (
          <p className="tt-sheet__loading" role="status">
            <span className="spinner" aria-hidden="true" /> Asking TikTok…
          </p>
        ) : (
          <div className="tt-sheet__body">
            <div className="tt-sheet__who">
              {creator.avatarUrl ? <img className="tt-sheet__avatar" src={creator.avatarUrl} alt="" /> : null}
              <span>
                Posting as <strong className="user-text">{creator.nickname}</strong>
              </span>
            </div>
            <div className="tt-sheet__preview">
              {clip.videoUrl ? (
                <video className="tt-sheet__video" src={clip.videoUrl} poster={clip.coverUrl} controls playsInline preload="none" aria-label={`Clip: ${clip.hook}`} />
              ) : clip.coverUrl ? (
                <img className="tt-sheet__video" src={clip.coverUrl} alt={`Cover for: ${clip.hook}`} />
              ) : null}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-caption`}>
                Caption
              </label>
              <textarea id={`${id}-caption`} className="input tt-sheet__caption" rows={3} value={caption} maxLength={2200} readOnly={!onCaption} onChange={(e) => onCaption?.(e.target.value)} />
            </div>
            <div className="field">
              <span className="field__label" id={`${id}-privacy`}>
                Who can see it
              </span>
              {options.length ? (
                <Segmented<string>
                  label="Who can see it"
                  value={privacy}
                  options={options.map((o) => ({ value: o, label: PRIVACY_LABEL[o] ?? o }))}
                  onChange={setPrivacy}
                />
              ) : (
                <p className="callout callout--bad" role="alert">
                  <Icon name="alert" size={18} />
                  <span>Branded content can&apos;t be Only me. Turn off Branded content.</span>
                </p>
              )}
              {onlyPrivateAllowed(creator.privacyOptions) ? <p className="field__hint">TikTok keeps posts private until it approves your app.</p> : null}
            </div>
            <div className="tt-sheet__switches">
              <Toggle label="Comments" checked={comments && !creator.commentDisabled} disabled={creator.commentDisabled} onChange={setComments} description={creator.commentDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Duet" checked={duet && !creator.duetDisabled} disabled={creator.duetDisabled} onChange={setDuet} description={creator.duetDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Stitch" checked={stitch && !creator.stitchDisabled} disabled={creator.stitchDisabled} onChange={setStitch} description={creator.stitchDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Commercial content" description="Turn on if this clip promotes a brand, a product or yourself." checked={commercial} onChange={setCommercial} />
              {commercial ? (
                <div className="tt-sheet__brand" role="group" aria-label="Commercial content">
                  <label className={`check-chip${yourBrand ? " is-on" : ""}`}>
                    <input type="checkbox" checked={yourBrand} onChange={(e) => setYourBrand(e.target.checked)} />
                    <span>Your brand</span>
                    <span className="tt-sheet__tag">Promotional content</span>
                  </label>
                  <label className={`check-chip${branded ? " is-on" : ""}`}>
                    <input type="checkbox" checked={branded} onChange={(e) => setBrandedOn(e.target.checked)} />
                    <span>Branded content</span>
                    <span className="tt-sheet__tag">Paid partnership</span>
                  </label>
                  {!yourBrand && !branded ? <p className="field__hint">Pick Your brand, Branded content, or both.</p> : null}
                </div>
              ) : null}
            </div>
            <p className="tt-sheet__legal">
              By posting, you agree to TikTok&apos;s{" "}
              <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">
                Music Usage Confirmation
              </a>
              {commercial && branded ? (
                <>
                  {" "}
                  and{" "}
                  <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">
                    Branded Content Policy
                  </a>
                </>
              ) : null}
              .
            </p>
            {tooLong ? (
              <div className="tt-sheet__stuck">
                <p className="callout callout--bad" role="alert">
                  <Icon name="alert" size={18} />
                  <span>
                    This clip is longer than TikTok allows for you, so it cannot go to TikTok. To upload it to your other places now, turn TikTok
                    off above and tap Upload.
                  </span>
                </p>
              </div>
            ) : null}
          </div>
        )}
        <footer className="tt-sheet__actions">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={action === "Upload" ? "upload" : "retry"}
            act={act ?? ownAct}
            loading={busy}
            disabled={!ready || !creator || tooLong}
            onClick={() => onUpload(tiktokOptions(choices, creator!))}
          >
            {action}
          </Button>
        </footer>
        {!ready && creator && !tooLong ? (
          <p className="tt-sheet__why">{privacy ? `Pick Your brand or Branded content to turn on ${action}.` : `Tap who can see it to turn on ${action}.`}</p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
