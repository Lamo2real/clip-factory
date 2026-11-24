// Review › one clip › one row per place it goes to (docs/CONTRACTS.md §36). Each row starts closed and says what is
// inside ("YouTube · title, description and settings"); tapping it opens that place's own words (already written)
// and every option it has. There is no second place picker: the "Upload to" chips above decide where it goes, and
// these rows follow them.
import { useId, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import type { Captions, Platform, TikTokCreator, XReplies, YoutubePrivacy } from "../../api/types.ts";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Button, LinkButton, Segmented, Toggle } from "../../components/ui.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { CAMPAIGN_LOCKED, META_PAID_LINE, X_REPLIES_LABEL, YOUTUBE_CATEGORIES, YT_WHO, type CardOptions } from "../../lib/preset.ts";
import { campaignTikTokProblem, PRIVACY_LABEL, tooLongForTikTok, type TikTokChoices } from "../../lib/tiktokChoices.ts";
import { TikTokCommercial } from "./TikTokCommercial.tsx";
import { TikTokPrivacy } from "./TikTokPrivacy.tsx";

// The platforms' own caption limits.
const LIMITS = { youtubeTitle: 100, youtubeDescription: 5000, instagram: 2200, facebook: 5000, tiktok: 2200, x: 280 } as const;

/** Which place holds each caption (YouTube has two: title and description). */
const PLACE_OF: Record<keyof typeof LIMITS, Platform> = {
  youtubeTitle: "youtube",
  youtubeDescription: "youtube",
  instagram: "instagram",
  facebook: "facebook",
  tiktok: "tiktok",
  x: "x",
};

/** What a closed row says is inside it. */
export const ROW_WHAT: Record<Platform, string> = {
  youtube: "title, description and settings",
  tiktok: "caption and settings",
  instagram: "caption and settings",
  facebook: "caption and settings",
  x: "caption and settings",
};

/** A caption is longer than its platform allows. With `chosen`, only the chosen places count. */
export function captionsTooLong(c: Captions, chosen?: readonly Platform[]): boolean {
  return (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).some((k) => c[k].length > LIMITS[k] && (!chosen || chosen.includes(PLACE_OF[k])));
}

/** The places with a caption longer than the platform allows, in STATS_ORDER (only the chosen ones, when given). */
export function placesTooLong(c: Captions, chosen?: readonly Platform[]): Platform[] {
  const over = new Set((Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter((k) => c[k].length > LIMITS[k]).map((k) => PLACE_OF[k]));
  return PLATFORM_ORDER.filter((p) => over.has(p) && (!chosen || chosen.includes(p)));
}

/** A campaign clip's rows (§38.5): what is locked, and the caption items the publisher puts back. */
export interface CampaignRows {
  /** "#Ad" (or the brief's own) and every required tag. */
  required: string[];
}

/** The caption is missing #Ad or one of the campaign's tags (the publisher puts them back, §38.14). */
export function missingRequired(text: string, required: readonly string[]): boolean {
  const low = text.toLowerCase();
  return required.some((r) => !low.includes(r.toLowerCase()));
}

/** One short line under a closed row: what will be used, so nothing is hidden behind the tap (null: nothing to say). */
export function nowLine(p: Platform, o: CardOptions, tiktok: TikTokChoices, nickname?: string, campaign?: CampaignRows): string | null {
  if (campaign && p === "youtube") return "Who can see it: Everyone · Made for kids: No · Paid promotion";
  if (campaign && p === "x") return `Who can reply: ${X_REPLIES_LABEL[o.x.replies]} · Paid partnership: on`;
  switch (p) {
    case "youtube": {
      const cat = YOUTUBE_CATEGORIES.find((c) => c.id === o.youtube.category)?.label ?? "Gaming";
      return `Who can see it: ${YT_WHO[o.youtube.privacy]} · Made for kids: ${o.youtube.madeForKids ? "Yes" : "No"} · ${cat}`;
    }
    case "tiktok":
      return tiktokNowLine(tiktok, nickname);
    case "instagram":
      return o.instagram.shareToFeed ? "Reel · also in your feed" : "Reel · not in your feed";
    case "facebook":
      return "Reel on your Page · Everyone can see it";
    case "x":
      return `Who can reply: ${X_REPLIES_LABEL[o.x.replies]}`;
  }
}

/** One short line under a closed TikTok row: what will be used, so nothing is hidden behind the tap. */
export function tiktokNowLine(c: TikTokChoices, nickname?: string): string {
  // TikTok's rules: the account he is posting to is named before he posts.
  const who = nickname ? `Posting as ${nickname} · ` : "";
  if (!c.privacy) return `${who}Who can see it: not picked yet`;
  const onOff = (on: boolean) => (on ? "on" : "off");
  const paid = c.commercial && c.branded ? " · Paid partnership" : c.commercial && c.yourBrand ? " · Your brand" : "";
  return `${who}Who can see it: ${PRIVACY_LABEL[c.privacy] ?? c.privacy} · Comments ${onOff(c.comments)} · Duet ${onOff(c.duet)} · Stitch ${onOff(c.stitch)}${paid}`;
}

export interface PlaceRowsHandle {
  /** Opens the first row whose caption is too long, scrolls to its box and focuses it. Returns its name, or null. */
  showTooLong(): string | null;
  /** Opens a place's row and brings it into view. */
  open(p: Platform): void;
  /** Whether a place's row is open now. */
  isOpen(p: Platform): boolean;
}

export interface TikTokRow {
  /**
   * TikTok's answer about this creator (null: not asked yet, or still asking). While the Mac posts TikTok (§47), TikTok
   * Studio's choices (macCreator), with no name until TikTok's API answered.
   */
  creator: TikTokCreator | null;
  /** Asking TikTok did not work: a plain sentence. */
  error: string | null;
  asking: boolean;
  onAskAgain: () => void;
  choices: TikTokChoices;
  onChoices: (patch: Partial<TikTokChoices>) => void;
  durationSec: number;
  /** The TikTok row was opened: TikTok must be asked for this creator's current options. */
  onOpen: () => void;
  /**
   * The owner's Mac posts TikTok (§47.9): the row shows what the Mac posts it with (My settings, read-only, with a link
   * to change them) instead of TikTok's privacy and switches; only Commercial content is this clip's own.
   */
  mac?: {
    /** "Your Mac posts it with My settings: Everyone · Comments on · Duet on · Stitch on" (macPostsLine). */
    line: string;
    /** Settings › Posting › My settings. */
    settingsHref: string;
    /** Why Upload is held for TikTok: Commercial content is on (macTikTokHeld), else null. */
    held: string | null;
  };
}

export function PlaceRows({
  places,
  captions,
  onChange,
  handle,
  settings = true,
  options,
  onOptions,
  tiktok,
  campaign,
}: {
  places: readonly Platform[];
  captions: Captions;
  onChange: (patch: Partial<Captions>) => void;
  handle?: Ref<PlaceRowsHandle>;
  /** False while nothing is set up (or the check failed): the rows hold the words only, no options (§36.4). */
  settings?: boolean;
  /** This clip's choices for YouTube, Instagram and X (from My settings until changed here). */
  options: CardOptions;
  onOptions: <K extends keyof CardOptions>(platform: K, patch: Partial<CardOptions[K]>) => void;
  tiktok: TikTokRow;
  /** A campaign clip: YouTube's choices are locked, and the lines say what the campaign needs. */
  campaign?: CampaignRows;
}) {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<Platform>>(() => new Set());
  const shown = PLATFORM_ORDER.filter((p) => places.includes(p));
  const over = placesTooLong(captions, places);

  function openRow(p: Platform) {
    setOpen((o) => new Set(o).add(p));
    if (p === "tiktok" && settings) tiktok.onOpen();
  }

  useImperativeHandle(handle, () => ({
    showTooLong() {
      const first = placesTooLong(captions, places)[0];
      if (!first) return null;
      openRow(first);
      const key = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).find((k) => PLACE_OF[k] === first && captions[k].length > LIMITS[k]);
      // After the row has opened.
      requestAnimationFrame(() => {
        const box = document.getElementById(`${id}-${key}`);
        box?.scrollIntoView?.({ block: "center" });
        box?.focus({ preventScroll: true });
      });
      return PLATFORM_LABEL[first];
    },
    open(p) {
      openRow(p);
      requestAnimationFrame(() => document.getElementById(`${id}-row-${p}`)?.scrollIntoView?.({ block: "nearest" }));
    },
    isOpen: (p) => open.has(p),
  }));

  const field = (key: keyof Captions, label: string, rows: number, single = false) => {
    const fid = `${id}-${key}`;
    const tooLong = captions[key].length > LIMITS[key];
    return (
      <div className="field" key={key}>
        <div className="field__row">
          <label className="field__label" htmlFor={fid}>
            {label}
          </label>
          <span className={`counter${tooLong ? " is-over" : ""}`} id={`${fid}-c`}>
            {captions[key].length} / {LIMITS[key]}
            {tooLong ? " · too long" : ""}
          </span>
        </div>
        {campaign && missingRequired(captions[key], campaign.required) && key !== "youtubeTitle" ? (
          <p className="cr-caption-note small">I put #Ad and the campaign&apos;s tags back when it uploads.</p>
        ) : null}
        {single ? (
          <input
            id={fid}
            className="input"
            value={captions[key]}
            aria-describedby={`${fid}-c`}
            aria-invalid={tooLong || undefined}
            onChange={(e) => onChange({ [key]: e.target.value })}
          />
        ) : (
          <textarea
            id={fid}
            className="input textarea"
            rows={rows}
            value={captions[key]}
            aria-describedby={`${fid}-c`}
            aria-invalid={tooLong || undefined}
            onChange={(e) => onChange({ [key]: e.target.value })}
          />
        )}
      </div>
    );
  };

  if (!shown.length) return null;
  return (
    <div className="place-rows" data-help="captions" data-help-dodge="">
      {shown.map((p) => {
        const isOpen = open.has(p);
        const now = settings ? nowLine(p, options, tiktok.choices, isOpen ? undefined : tiktok.creator?.nickname, campaign) : null;
        return (
          <details
            key={p}
            id={`${id}-row-${p}`}
            className={`place-row${over.includes(p) ? " is-over" : ""}`}
            data-place={p}
            open={isOpen}
            onToggle={(e) => {
              const on = e.currentTarget.open;
              if (on === isOpen) return;
              if (on) openRow(p);
              else
                setOpen((o) => {
                  const next = new Set(o);
                  next.delete(p);
                  return next;
                });
            }}
          >
            <summary className="place-row__summary">
              <PlatformMark platform={p} size={20} />
              <span className="place-row__words">
                <span className="place-row__title">
                  {/* X's mark already reads "X": its name is for screen readers only (no "X X"). */}
                  <span className={p === "x" ? "sr-only" : "place-row__name"}>{PLATFORM_LABEL[p]}</span>
                  <span aria-hidden="true">{p === "x" ? "" : " · "}</span>
                  <span className="place-row__what">{settings ? ROW_WHAT[p] : p === "youtube" ? "title and description" : "caption"}</span>
                </span>
                {now ? <span className="place-row__now">{now}</span> : null}
                {over.includes(p) ? <span className="place-row__over">Too long. Make it shorter.</span> : null}
              </span>
              <Icon name="chevronRight" size={18} className="icon place-row__chev act-turn" />
            </summary>
            <div className="place-row__body">
              {!settings ? (
                p === "youtube" ? (
                  <>
                    {field("youtubeTitle", "Title", 1, true)}
                    {field("youtubeDescription", "Description", 4)}
                  </>
                ) : (
                  field(p, `${PLATFORM_LABEL[p]} caption`, p === "x" ? 3 : 5)
                )
              ) : p === "youtube" ? (
                <>
                  {field("youtubeTitle", "Title", 1, true)}
                  {field("youtubeDescription", "Description", 4)}
                  {campaign ? (
                    // The row's own line already says "Everyone · Made for kids: No · Paid promotion": one locked line.
                    <div className="cr-locked">
                      <p className="place-row__fixed">
                        <Icon name="lock" size={16} />
                        <span>{CAMPAIGN_LOCKED}</span>
                      </p>
                    </div>
                  ) : (
                    <div className="field">
                      <span className="field__label">Who can see it</span>
                      <Segmented<YoutubePrivacy>
                        label="Who can see it on YouTube"
                        value={options.youtube.privacy}
                        options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YT_WHO[v] }))}
                        onChange={(v) => onOptions("youtube", { privacy: v })}
                      />
                    </div>
                  )}
                  <div className="field">
                    <span className="field__label" id={`${id}-yt-cat`}>
                      Category
                    </span>
                    <Dropdown
                      labelledBy={`${id}-yt-cat`}
                      value={options.youtube.category}
                      placeholder="Pick a category"
                      options={YOUTUBE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
                      onChange={(v) => onOptions("youtube", { category: v })}
                    />
                  </div>
                  <div className="place-row__switches">
                    {campaign ? null : (
                      <Toggle
                        label="Made for kids"
                        description={options.youtube.madeForKids ? "Yes: YouTube turns off comments and some ads." : "Turn on only if it's made for kids."}
                        checked={options.youtube.madeForKids}
                        onChange={(v) => onOptions("youtube", { madeForKids: v })}
                      />
                    )}
                    <Toggle label="Tell my subscribers" checked={options.youtube.notifySubscribers} onChange={(v) => onOptions("youtube", { notifySubscribers: v })} />
                  </div>
                </>
              ) : p === "tiktok" ? (
                <TikTokFields row={tiktok} field={field("tiktok", "TikTok caption", 5)} campaign={!!campaign} />
              ) : p === "instagram" ? (
                <>
                  {field("instagram", "Instagram caption", 5)}
                  <div className="place-row__switches">
                    <Toggle label="Also show it in my feed" description="Goes up as a Reel." checked={options.instagram.shareToFeed} onChange={(v) => onOptions("instagram", { shareToFeed: v })} />
                  </div>
                  {campaign ? <p className="small">{META_PAID_LINE("Instagram")}</p> : null}
                </>
              ) : p === "facebook" ? (
                <>
                  {/* "Reel on your Page · Everyone can see it" is the row's own line, open or closed. */}
                  {field("facebook", "Facebook caption", 5)}
                  {campaign ? <p className="small">{META_PAID_LINE("Facebook")}</p> : null}
                </>
              ) : (
                <>
                  {field("x", "X caption", 3)}
                  <div className="field">
                    <span className="field__label" id={`${id}-x-replies`}>
                      Who can reply
                    </span>
                    <Dropdown
                      labelledBy={`${id}-x-replies`}
                      value={options.x.replies}
                      placeholder="Pick who can reply"
                      options={(Object.keys(X_REPLIES_LABEL) as XReplies[]).map((v) => ({ value: v, label: X_REPLIES_LABEL[v] }))}
                      onChange={(v) => onOptions("x", { replies: v as XReplies })}
                    />
                  </div>
                  {campaign ? (
                    <p className="place-row__fixed">
                      <Icon name="lock" size={16} />
                      <span>Paid partnership: on</span>
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** TikTok's own options (TikTok's Content Sharing Guidelines): all of them, always visible once the row is open. */
function TikTokFields({ row, field, campaign = false }: { row: TikTokRow; field: ReactNode; campaign?: boolean }) {
  const { creator, error, choices, onChoices } = row;
  if (error)
    return (
      <>
        {field}
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>{error} Tap Ask TikTok again, or untick TikTok above.</span>
        </p>
        <div>
          <Button icon="retry" act="retry" loading={row.asking} onClick={row.onAskAgain}>
            Ask TikTok again
          </Button>
        </div>
      </>
    );
  if (!creator)
    return (
      <>
        {field}
        <p className="place-row__loading" role="status">
          <span className="spinner" aria-hidden="true" /> Asking TikTok…
        </p>
      </>
    );
  const { privacy, comments, duet, stitch, commercial, yourBrand, branded } = choices;
  const tooLong = tooLongForTikTok(row.durationSec, creator.maxDurationSec);
  const { mac } = row;
  return (
    <>
      {/* TikTok's rules: the account is named before he posts. Only while the Mac posts TikTok can the name be unknown
          (TikTok's API has not answered, or could not): then the line is left out. */}
      {creator.nickname || !mac ? (
        <div className="tt-sheet__who">
          {creator.avatarUrl ? <img className="tt-sheet__avatar" src={creator.avatarUrl} alt="" /> : null}
          <span>
            Posting as <strong className="user-text">{creator.nickname}</strong>
          </span>
        </div>
      ) : null}
      {field}
      {mac ? (
        // What the Mac really posts it with (the server asks the Mac for My settings, §47.9): nothing to change here.
        <div className="tt-mac-uses">
          <p className="place-row__fixed">
            <Icon name="monitor" size={16} />
            <span>{mac.line}</span>
          </p>
          <LinkButton href={mac.settingsHref} size="sm" variant="glass" icon="sliders" iconAfter="chevronRight">
            Change My settings
          </LinkButton>
        </div>
      ) : (
        <TikTokPrivacy creator={creator} value={privacy} branded={branded && commercial} onChange={(v) => onChoices({ privacy: v })} />
      )}
      {campaign && campaignTikTokProblem(choices) ? (
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>{campaignTikTokProblem(choices)}</span>
        </p>
      ) : null}
      <div className="tt-sheet__switches">
        {mac ? null : (
          <>
            <Toggle label="Comments" checked={comments && !creator.commentDisabled} disabled={creator.commentDisabled} onChange={(v) => onChoices({ comments: v })} description={creator.commentDisabled ? "Turned off in your TikTok settings." : undefined} />
            <Toggle label="Duet" checked={duet && !creator.duetDisabled} disabled={creator.duetDisabled} onChange={(v) => onChoices({ duet: v })} description={creator.duetDisabled ? "Turned off in your TikTok settings." : undefined} />
            <Toggle label="Stitch" checked={stitch && !creator.stitchDisabled} disabled={creator.stitchDisabled} onChange={(v) => onChoices({ stitch: v })} description={creator.stitchDisabled ? "Turned off in your TikTok settings." : undefined} />
          </>
        )}
        <Toggle label="Commercial content" description="Turn on if this clip promotes a brand, a product or yourself." checked={commercial} onChange={(v) => onChoices({ commercial: v })} />
        {commercial ? (
          // The Mac can't add TikTok's label (no "will be labeled" line), and there is no privacy to pick on its row.
          <TikTokCommercial
            privacy={mac ? "" : privacy}
            hint={!mac}
            yourBrand={yourBrand}
            branded={branded}
            onYourBrand={(v) => onChoices({ yourBrand: v })}
            onBranded={(v) => onChoices({ branded: v })}
          />
        ) : null}
      </div>
      {mac?.held ? (
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>{mac.held}</span>
        </p>
      ) : null}
      {tooLong ? (
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>Too long for TikTok. Untick TikTok above to upload the rest.</span>
        </p>
      ) : null}
    </>
  );
}
