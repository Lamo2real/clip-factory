// The "Post to TikTok" sheet (docs/CONTRACTS.md §17.8, TikTok's Content Sharing Guidelines): opens on Keep when
// TikTok is connected. Who can see it has no default; Comments, Duet and Stitch start off; Commercial content needs
// Your brand or Branded content (branded cannot be "Only me"); Keep stays off until a privacy is picked.
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, TikTokCreator, TikTokPostOptions } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button, Toggle } from "../../components/ui.tsx";

export const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/** The options the sheet may offer: TikTok's list, without "Only me" when the post is branded content. */
export function privacyChoices(options: string[], branded: boolean): string[] {
  return options.filter((o) => !(branded && o === "SELF_ONLY"));
}

/** Keep can be pressed: a privacy is picked, and Commercial content (when on) says whose. */
export function sheetReady(o: { privacy: string; commercial: boolean; yourBrand: boolean; branded: boolean }): boolean {
  if (!o.privacy) return false;
  if (o.commercial && !o.yourBrand && !o.branded) return false;
  if (o.branded && o.privacy === "SELF_ONLY") return false;
  return true;
}

export function TikTokSheet({
  clip,
  caption,
  onCaption,
  onKeep,
  onClose,
  busy,
  action = "Keep",
}: {
  clip: Clip;
  caption: string;
  /** Absent: the caption cannot change any more (Try again on a kept clip), so the box is read-only. */
  onCaption?: (text: string) => void;
  onKeep: (options: TikTokPostOptions) => void;
  onClose: () => void;
  busy: boolean;
  /** The big button's word: Keep, or Try again on a failed clip. */
  action?: "Keep" | "Try again";
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [creator, setCreator] = useState<TikTokCreator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState("");
  const [comments, setComments] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);

  // Fetched every time the sheet opens: TikTok's rules say the creator's current options must be shown.
  useEffect(() => {
    let alive = true;
    api()
      .tiktokCreatorInfo()
      .then((c) => alive && setCreator(c))
      .catch((e) => alive && setError(friendlyMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    dialog.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const options = creator ? privacyChoices(creator.privacyOptions, branded && commercial) : [];
  const ready = sheetReady({ privacy, commercial, yourBrand: commercial && yourBrand, branded: commercial && branded });
  const tooLong = !!creator && clip.durationSec > creator.maxDurationSec;

  function setBrandedOn(on: boolean) {
    setBranded(on);
    if (on && privacy === "SELF_ONLY") setPrivacy("");
  }

  return (
    <div className="tt-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tt-sheet glass" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialog}>
        <header className="tt-sheet__head">
          <h2 className="tt-sheet__title" id={`${id}-title`}>
            Post to TikTok
          </h2>
          <button type="button" className="tt-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </header>
        {error ? (
          <p className="callout callout--bad" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
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
              <label className="field__label" htmlFor={`${id}-privacy`}>
                Who can see it
              </label>
              <select id={`${id}-privacy`} className="input tt-sheet__select" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
                <option value="" disabled>
                  Pick who can see it
                </option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {PRIVACY_LABEL[o] ?? o}
                  </option>
                ))}
              </select>
              {creator.privacyOptions.length === 1 && creator.privacyOptions[0] === "SELF_ONLY" ? (
                <p className="field__hint">TikTok only allows Only me until it checks the app.</p>
              ) : null}
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
              <p className="callout callout--bad">
                <Icon name="alert" size={18} />
                <span>This clip is longer than TikTok allows for you. It cannot go to TikTok.</span>
              </p>
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
            icon={action === "Keep" ? "check" : "retry"}
            loading={busy}
            disabled={!ready || !creator || tooLong}
            onClick={() =>
              onKeep({
                privacyLevel: privacy,
                disableComment: !comments || creator!.commentDisabled,
                disableDuet: !duet || creator!.duetDisabled,
                disableStitch: !stitch || creator!.stitchDisabled,
                brandContent: commercial && branded,
                brandOrganic: commercial && yourBrand,
              })
            }
          >
            {action}
          </Button>
        </footer>
        {!ready && creator ? (
          <p className="tt-sheet__why">{privacy ? `Pick Your brand or Branded content to turn on ${action}.` : `Pick who can see it to turn on ${action}.`}</p>
        ) : null}
      </div>
    </div>
  );
}
