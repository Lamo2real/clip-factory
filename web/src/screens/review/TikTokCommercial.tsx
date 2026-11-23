// TikTok's Commercial content choices and its "By posting, you agree" line (TikTok's Content Sharing Guidelines,
// CONTRACTS §17.8), the same in the TikTok row on the Review card and on the Post to TikTok sheet. Branded content
// (a paid partnership) can only be seen by Everyone or Friends: while Only me or Followers is picked it is greyed.
import { useId } from "react";
import { brandedBlocked, tiktokLabel } from "../../lib/tiktokChoices.ts";

export function TikTokCommercial({
  privacy,
  hint = true,
  yourBrand,
  branded,
  onYourBrand,
  onBranded,
}: {
  privacy: string;
  /**
   * The line under the choices ("Your video will be labeled as …", or "Pick Your brand, Branded content, or both.").
   * Off while the owner's Mac posts TikTok (§47.9): nothing would add the label, and the row's alert says what to do.
   */
  hint?: boolean;
  yourBrand: boolean;
  branded: boolean;
  onYourBrand: (on: boolean) => void;
  onBranded: (on: boolean) => void;
}) {
  const id = useId();
  const label = tiktokLabel({ commercial: true, yourBrand, branded });
  const blocked = brandedBlocked(privacy);
  return (
    <div className="tt-sheet__brand" role="group" aria-label="Commercial content">
      <label className={`check-chip${yourBrand ? " is-on" : ""}`}>
        <input type="checkbox" checked={yourBrand} onChange={(e) => onYourBrand(e.target.checked)} />
        <span>Your brand</span>
        <span className="tt-sheet__tag">Promotional content</span>
      </label>
      <label className={`check-chip${branded ? " is-on" : ""}`}>
        {/* Greyed while the privacy picked cannot go with it; once ticked it can always be unticked. */}
        <input
          type="checkbox"
          checked={branded}
          disabled={!!blocked && !branded}
          aria-describedby={blocked ? `${id}-blocked` : undefined}
          onChange={(e) => onBranded(e.target.checked)}
        />
        <span>Branded content</span>
        <span className="tt-sheet__tag">Paid partnership</span>
      </label>
      {!hint ? null : label ? (
        <p className="field__hint">Your video will be labeled as &apos;{label}&apos;.</p>
      ) : (
        <p className="field__hint">Pick Your brand, Branded content, or both.</p>
      )}
      {blocked ? (
        <p className="field__hint" id={`${id}-blocked`}>
          {blocked}
        </p>
      ) : null}
    </div>
  );
}

/** "By posting, you agree to TikTok's …": the Branded Content Policy joins the Music Usage Confirmation for branded content. */
export function TikTokLegal({ className, branded }: { className: string; branded: boolean }) {
  const music = (
    <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">
      Music Usage Confirmation
    </a>
  );
  return (
    <p className={className}>
      By posting, you agree to TikTok&apos;s{" "}
      {branded ? (
        <>
          <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">
            Branded Content Policy
          </a>{" "}
          and {music}
        </>
      ) : (
        music
      )}
      .
    </p>
  );
}
