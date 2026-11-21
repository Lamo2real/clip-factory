// Review › one clip › where it goes (docs/CONTRACTS.md §33): the "Upload to" chips (only places that are set up, any
// number on). There are no other choices here: each place uses its own saved setup.
import { useId } from "react";
import type { Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, ActGlyph } from "../../components/ui.tsx";
import { CR_SETTINGS } from "../../setup/contentrewards.ts";
import { GreenButton, OpenButton } from "../campaigns/bits.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { useAction } from "../../lib/motion.ts";

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
export function UploadToChips({
  ready,
  chosen,
  onToggle,
  campaign,
}: {
  ready: readonly Platform[];
  chosen: readonly Platform[];
  onToggle: (p: Platform) => void;
  /**
   * A campaign clip (§38.5): only the places it pays for (`ready` is already limited to them), its lines, and the
   * places Content Rewards refused as not linked, with "I linked it".
   */
  campaign?: { lines: string[]; unlinked: Platform[]; onRelinked: (p: Platform) => unknown };
}) {
  const id = useId();
  const line = campaign ? null : notReadyLine(ready);
  const firstMissing = PLATFORM_ORDER.find((p) => !ready.includes(p));
  if (!ready.length && campaign)
    return (
      <div className="upload-to upload-to--none" data-help="upload-to">
        <p className="callout">
          <Icon name="alert" size={18} />
          <span>None of the places this campaign pays for is set up yet. Set one up, then tap Upload.</span>
        </p>
        <CampaignLines campaign={campaign} />
      </div>
    );
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
      {campaign ? <CampaignLines campaign={campaign} /> : null}
    </div>
  );
}

/** "Only places this campaign pays for.", the TikTok line, and "Link YouTube inside Content Rewards first." */
function CampaignLines({ campaign }: { campaign: NonNullable<Parameters<typeof UploadToChips>[0]["campaign"]> }) {
  return (
    <div className="cr-places">
      {campaign.lines.map((l) => (
        <p key={l} className="upload-to__hint small">
          {l}
        </p>
      ))}
      {campaign.unlinked.map((p) => (
        <div key={p} className="cr-places__unlinked">
          <p className="small">Link {PLATFORM_LABEL[p]} inside Content Rewards first.</p>
          <div className="cr-line__actions">
            <OpenButton label="Open Content Rewards settings" href={CR_SETTINGS} size="sm" />
            <GreenButton size="sm" onClick={() => campaign.onRelinked(p)}>
              I linked it
            </GreenButton>
          </div>
          <p className="small">Then tap I linked it. The next clip will go.</p>
        </div>
      ))}
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
