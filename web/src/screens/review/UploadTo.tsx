// Review › one clip › where it goes and how (docs/CONTRACTS.md §33): the "Upload to" chips (only places that are set
// up, any number on), "Use my settings" (the owner's preset in one tap) and More details (every choice, per place).
import { useId } from "react";
import type { ClipPostOptions, Platform, XReplies, YoutubePrivacy } from "../../api/types.ts";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, ActGlyph, Segmented, Toggle } from "../../components/ui.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { useAction } from "../../lib/motion.ts";
import { DEFAULT_PRESET, TIKTOK_PRIVACY_LABEL, X_REPLIES_LABEL, YOUTUBE_CATEGORIES, YOUTUBE_PRIVACY_LABEL, type TikTokChoices } from "../../lib/preset.ts";

/** "X", "X and TikTok", "X, TikTok and Facebook". */
export function nameList(list: readonly Platform[]): string {
  const names = PLATFORM_ORDER.filter((p) => list.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** The quiet line under the chips: which places are not set up yet (none when all five are). */
export function notReadyLine(ready: readonly Platform[]): string | null {
  const missing = PLATFORM_ORDER.filter((p) => !ready.includes(p));
  return missing.length ? `Set up ${nameList(missing)} to upload there too.` : null;
}

/**
 * One soft-fill toggle chip per place that is set up, in STATS_ORDER. Any number can be on (so not a Glide bar); a
 * chip that is on shows a check mark and has aria-pressed. Places not set up get no chip, only the quiet line below.
 */
export function UploadToChips({ ready, chosen, onToggle }: { ready: readonly Platform[]; chosen: readonly Platform[]; onToggle: (p: Platform) => void }) {
  const id = useId();
  const line = notReadyLine(ready);
  const firstMissing = PLATFORM_ORDER.find((p) => !ready.includes(p));
  if (!ready.length)
    return (
      <div className="upload-to upload-to--none">
        <p className="callout">
          <Icon name="alert" size={18} />
          <span>Nothing is set up yet. Upload saves it, and it goes up once you set up a place.</span>
        </p>
        <A href="/settings/posting/setup" className="text-link">
          Open Set up posting
        </A>
      </div>
    );
  return (
    <div className="upload-to" data-help="upload-to" data-help-dodge="">
      <span className="field__label" id={`${id}-label`}>
        Upload to
      </span>
      <div className="upload-to__chips" role="group" aria-labelledby={`${id}-label`}>
        {PLATFORM_ORDER.filter((p) => ready.includes(p)).map((p) => (
          <UploadChip key={p} platform={p} on={chosen.includes(p)} onToggle={() => onToggle(p)} />
        ))}
      </div>
      {line && firstMissing ? (
        <A href={`/settings/posting/setup/${firstMissing}`} className="text-link small upload-to__hint">
          {line}
        </A>
      ) : null}
    </div>
  );
}

function UploadChip({ platform, on, onToggle }: { platform: Platform; on: boolean; onToggle: () => void }) {
  const tick = useAction("tick");
  return (
    <button
      type="button"
      className={`check-chip upload-chip${on ? " is-on" : ""}`}
      aria-pressed={on}
      data-act="tick"
      onClick={() => {
        onToggle();
        if (!on) tick.play();
      }}
    >
      <ActGlyph act={tick}>
        <PlatformMark platform={platform} size={18} />
      </ActGlyph>
      {/* X's mark already reads "X": its name is for screen readers only (no "X X"). */}
      <span className={platform === "x" ? "sr-only" : undefined}>{PLATFORM_LABEL[platform]}</span>
      <span className={`upload-chip__check${on ? " is-on" : ""}`} aria-hidden="true">
        {on ? <Icon name="check" size={16} /> : null}
      </span>
    </button>
  );
}

/** One plain line about where the clip goes, right above Upload. */
export function goingToLine(chosen: readonly Platform[]): string {
  return chosen.length ? `Going to: ${PLATFORM_ORDER.filter((p) => chosen.includes(p)).map((p) => PLATFORM_LABEL[p]).join(" · ")}` : "Pick at least one place.";
}

/**
 * More details: every choice for each chosen place, filled in from My settings. TikTok's own choices stay on its
 * sheet, where TikTok wants them seen every time (§17.8); here they are only summed up.
 */
export function MoreDetails({
  chosen,
  options,
  onOptions,
  tiktok,
}: {
  chosen: readonly Platform[];
  options: ClipPostOptions;
  onOptions: (next: ClipPostOptions) => void;
  tiktok: TikTokChoices | undefined;
}) {
  const id = useId();
  const yt = options.youtube ?? DEFAULT_PRESET.youtube;
  const ig = options.instagram ?? DEFAULT_PRESET.instagram;
  const x = options.x ?? DEFAULT_PRESET.x;
  return (
    <details className="more-details" data-help="more-details">
      <summary className="more-details__summary">
        <span>More details</span>
        <Icon name="chevronRight" size={18} className="icon more-details__chev act-turn" />
      </summary>
      <div className="more-details__body">
        {chosen.includes("youtube") ? (
          <section className="more-details__place" aria-labelledby={`${id}-yt`}>
            <h3 className="more-details__name" id={`${id}-yt`}>
              <PlatformMark platform="youtube" size={18} /> YouTube
            </h3>
            <span className="field__label">Who can see it</span>
            <Segmented<YoutubePrivacy>
              label="Who can see it on YouTube"
              value={yt.privacy}
              options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YOUTUBE_PRIVACY_LABEL[v] }))}
              onChange={(v) => onOptions({ ...options, youtube: { ...yt, privacy: v } })}
            />
            <span className="field__label" id={`${id}-yt-cat`}>
              Category
            </span>
            <Dropdown
              labelledBy={`${id}-yt-cat`}
              value={yt.category}
              placeholder="Pick a category"
              options={YOUTUBE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
              onChange={(v) => onOptions({ ...options, youtube: { ...yt, category: v } })}
            />
            <Toggle label="Tell my subscribers" checked={yt.notifySubscribers} onChange={(v) => onOptions({ ...options, youtube: { ...yt, notifySubscribers: v } })} />
            <Toggle label="Let other sites show it" checked={yt.embeddable} onChange={(v) => onOptions({ ...options, youtube: { ...yt, embeddable: v } })} />
            <Toggle
              label="Made with AI to look real"
              description="Only turn on if it is true of this clip."
              checked={yt.syntheticMedia}
              onChange={(v) => onOptions({ ...options, youtube: { ...yt, syntheticMedia: v } })}
            />
            <p className="more-details__fixed">
              <Icon name="lock" size={16} />
              <span>Made for kids: No. Clip Factory never marks a clip as made for kids.</span>
            </p>
            <p className="field__hint">Tip: swearing in the first seconds or in the title can limit ads on YouTube.</p>
          </section>
        ) : null}
        {chosen.includes("tiktok") ? (
          <section className="more-details__place" aria-labelledby={`${id}-tt`}>
            <h3 className="more-details__name" id={`${id}-tt`}>
              <PlatformMark platform="tiktok" size={18} /> TikTok
            </h3>
            <p className="field__hint">
              {tiktok?.privacy
                ? `Ready: ${TIKTOK_PRIVACY_LABEL[tiktok.privacy] ?? tiktok.privacy}${tiktok.comments || tiktok.duet || tiktok.stitch ? ", comments and remixes on" : ""}. `
                : ""}
              TikTok&apos;s choices open on their own sheet when you tap Upload, so you see them every time. Paid partnership is there too.
            </p>
          </section>
        ) : null}
        {chosen.includes("instagram") ? (
          <section className="more-details__place" aria-labelledby={`${id}-ig`}>
            <h3 className="more-details__name" id={`${id}-ig`}>
              <PlatformMark platform="instagram" size={18} /> Instagram
            </h3>
            <Toggle label="Also show it in my main feed" checked={ig.shareToFeed} onChange={(v) => onOptions({ ...options, instagram: { shareToFeed: v } })} />
          </section>
        ) : null}
        {chosen.includes("facebook") ? (
          <section className="more-details__place" aria-labelledby={`${id}-fb`}>
            <h3 className="more-details__name" id={`${id}-fb`}>
              <PlatformMark platform="facebook" size={18} /> Facebook
            </h3>
            <p className="field__hint">Reels on your Page are public to everyone. Nothing to pick.</p>
          </section>
        ) : null}
        {chosen.includes("x") ? (
          <section className="more-details__place" aria-labelledby={`${id}-x`}>
            <h3 className="more-details__name" id={`${id}-x`}>
              <PlatformMark platform="x" size={18} />
              <span className="sr-only">X</span>
            </h3>
            <span className="field__label" id={`${id}-x-replies`}>
              Who can reply
            </span>
            <Dropdown
              labelledBy={`${id}-x-replies`}
              value={x.replies}
              placeholder="Pick who can reply"
              options={(Object.keys(X_REPLIES_LABEL) as XReplies[]).map((v) => ({ value: v, label: X_REPLIES_LABEL[v] }))}
              onChange={(v) => onOptions({ ...options, x: { replies: v as XReplies } })}
            />
          </section>
        ) : null}
        <p className="field__hint">Whether a clip earns money is up to each app (like YouTube&apos;s Partner Program), not these switches.</p>
      </div>
    </details>
  );
}
