// The "Post to TikTok" sheet (docs/CONTRACTS.md §17.8, §36.5, TikTok's Content Sharing Guidelines). On the Review
// card TikTok's choices live in its own row (§36), so this sheet only opens where there is no row: Upload while nothing
// is set up yet but TikTok is connected, and Try again on a clip whose TikTok post needs a new privacy pick. Who can
// see it is the app's own dropdown with no default, Everyone first; Comments, Duet and Stitch start off and stay
// visible; Commercial content needs Your brand or Branded content (branded is only Everyone or Friends).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, TikTokCreator, TikTokPostOptions } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { Button, Toggle } from "../../components/ui.tsx";
import { TikTokCommercial, TikTokLegal } from "./TikTokCommercial.tsx";
import { TikTokPrivacy } from "./TikTokPrivacy.tsx";
import { useAction, type ActionHandle } from "../../lib/motion.ts";
import { brandedBlocked, NO_TIKTOK_CHOICES, PICK_WHOSE, sheetReady, tiktokOptions, tooLongForTikTok, type TikTokChoices } from "../../lib/tiktokChoices.ts";

export { onlyPrivateAllowed, PRIVACY_LABEL, privacyChoices, sheetReady, tooLongForTikTok } from "../../lib/tiktokChoices.ts";

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
  /** The big button's word: Upload, Try again on a clip that did not go up, or Post now for a place set up since. */
  action?: "Upload" | "Try again" | "Post now";
  /**
   * The big button's motion (§20.11 (a)): Upload posts to TikTok, so the plane flies; Try again turns. Pass a handle
   * to shake it when posting fails (the owner's own error path); without one the sheet uses its own.
   */
  act?: ActionHandle;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const ownAct = useAction(action === "Try again" ? "retry" : "send");
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
  const setBranded = (v: boolean) => set({ branded: v });

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

  const ready = sheetReady({ privacy, commercial, yourBrand: commercial && yourBrand, branded: commercial && branded });
  const tooLong = !!creator && tooLongForTikTok(clip.durationSec, creator.maxDurationSec);
  // Commercial content is on but says nothing about whose: TikTok's own words, as the hover text and the line under it.
  const noWhose = commercial && !yourBrand && !branded;
  const why = !privacy
    ? `Pick who can see it to turn on ${action}.`
    : noWhose
      ? `${PICK_WHOSE} Pick Your brand or Branded content to turn on ${action}.`
      : (brandedBlocked(privacy) ?? "");

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
              <span>{error} Tap Ask TikTok again.</span>
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
            <TikTokPrivacy creator={creator} value={privacy} branded={branded && commercial} onChange={setPrivacy} />
            <div className="tt-sheet__switches">
              <Toggle label="Comments" checked={comments && !creator.commentDisabled} disabled={creator.commentDisabled} onChange={setComments} description={creator.commentDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Duet" checked={duet && !creator.duetDisabled} disabled={creator.duetDisabled} onChange={setDuet} description={creator.duetDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Stitch" checked={stitch && !creator.stitchDisabled} disabled={creator.stitchDisabled} onChange={setStitch} description={creator.stitchDisabled ? "Turned off in your TikTok settings." : undefined} />
              <Toggle label="Commercial content" description="Turn on if this clip promotes a brand, a product or yourself." checked={commercial} onChange={setCommercial} />
              {commercial ? <TikTokCommercial privacy={privacy} yourBrand={yourBrand} branded={branded} onYourBrand={setYourBrand} onBranded={setBranded} /> : null}
            </div>
            <TikTokLegal className="tt-sheet__legal" branded={commercial && branded} />
            {tooLong ? (
              <div className="tt-sheet__stuck">
                <p className="callout callout--bad" role="alert">
                  <Icon name="alert" size={18} />
                  <span>Too long for TikTok. To post it elsewhere, turn TikTok off above and tap Upload.</span>
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
            icon={action === "Try again" ? "retry" : "upload"}
            act={act ?? ownAct}
            loading={busy}
            disabled={!ready || !creator || tooLong}
            title={creator && noWhose ? PICK_WHOSE : undefined}
            onClick={() => onUpload(tiktokOptions(choices, creator!))}
          >
            {action}
          </Button>
        </footer>
        {!ready && creator && !tooLong ? (
          <p className="tt-sheet__why">{why}</p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
