// Settings › Posting › My settings (docs/CONTRACTS.md §36): the owner's own choices for each place, put on a clip by
// "Use my settings" on Review. One section per platform, X included. Saved on the server, so every device has them.
// My settings never mark a clip as made for kids, and TikTok's Commercial content is picked per clip only. While his
// Mac posts TikTok, every Review card but a campaign clip starts on these, TikTok too, with no tap, and his Mac posts
// TikTok with them (§47.9); a paid partnership can't go through the Mac yet (he posts that clip in the TikTok app
// himself). While it is off, TikTok's API rule still wants his own tap on each clip.
import type { PostPreset, XReplies, YoutubePrivacy } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Pill, Segmented, Skeleton, Toggle } from "../../components/ui.tsx";
import { presetOf, X_REPLIES_LABEL, YOUTUBE_CATEGORIES, YT_WHO } from "../../lib/preset.ts";
import { PRIVACY_LABEL } from "../../lib/tiktokChoices.ts";
import { macOn } from "../../lib/tiktokMac.ts";
import { tiktokAudited } from "../../lib/tiktokYourself.ts";
import { useSetup } from "./setup/useSetup.ts";
import { Apple, Panel } from "./parts.tsx";

const TIKTOK_ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

/** TikTok's line under its switches: one short line, and the paid-partnership how-to in its fold. */
export const COMMERCIAL_OFF = "Commercial content: off.";
export const OWN_TAP = "TikTok wants your own tap, so tap Use my settings on each clip.";
export const MAC_COMMERCIAL = "Commercial content: off. Your Mac posts TikTok with these.";
export const PAID_STEPS = ["Tick Branded content in that clip's TikTok row."];
export const MAC_PAID_STEPS = [
  "Your Mac can't post those yet.",
  "Untick TikTok on that clip.",
  "Post it in the TikTok app, with its label.",
  "Don't use Post with my Mac or Send these to my Mac for it.",
];

export function MySettingsBranch() {
  const { me, saveSettings } = useSession();
  const setup = useSetup();
  const xReady = !!setup.data?.platforms.find((p) => p.platform === "x")?.ready;
  if (!me)
    return (
      <Panel>
        <Skeleton className="line-skel" />
      </Panel>
    );
  const preset = presetOf(me.settings.postPreset);
  const save = <K extends keyof PostPreset>(platform: K, patch: Partial<PostPreset[K]>) =>
    void saveSettings({ postPreset: { ...preset, [platform]: { ...preset[platform], ...patch } } });
  const yt = preset.youtube;
  const tt = preset.tiktok;
  // §47.9: while his Mac posts TikTok (and TikTok has not approved the app), Review starts every ticked place on
  // these, TikTok included, as Review decides it.
  const macPosts = macOn(me.settings) && !tiktokAudited(setup.data?.platforms);
  return (
    <Panel>
      <p className="callout preset-page__note">
        <Icon name="sparkle" size={18} />
        <span>
          {macPosts ? (
            <>Every clip on Review starts on these, TikTok too, except campaign clips.</>
          ) : (
            <>
              Tap <strong>Use my settings</strong> on a clip to put these on.
            </>
          )}{" "}
          Each app decides if a clip earns money. These switches don&apos;t.
        </span>
      </p>
      <Apple id="my-settings-youtube" wide>
        <div className="preset-page__controls">
          <span className="field__label">Who can see it</span>
          <Segmented<YoutubePrivacy>
            label="Who can see it on YouTube"
            value={me.settings.youtubePrivacy ?? "public"}
            options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YT_WHO[v] }))}
            onChange={(v) => void saveSettings({ youtubePrivacy: v })}
          />
          <span className="field__label" id="my-yt-cat">
            Category
          </span>
          <Dropdown
            labelledBy="my-yt-cat"
            value={yt.category}
            placeholder="Pick a category"
            options={YOUTUBE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
            onChange={(v) => save("youtube", { category: v })}
          />
          <Toggle label="Tell my subscribers" checked={yt.notifySubscribers} onChange={(v) => save("youtube", { notifySubscribers: v })} />
          <Toggle label="Let other sites show it" checked={yt.embeddable} onChange={(v) => save("youtube", { embeddable: v })} />
          <p className="place-row__fixed">
            <Icon name="lock" size={16} />
            <span>Made for kids: always No.</span>
          </p>
        </div>
      </Apple>
      <Apple id="my-settings-tiktok" wide>
        <div className="preset-page__controls">
          <span className="field__label" id="my-tt-privacy">
            Who can see it
          </span>
          <Dropdown
            labelledBy="my-tt-privacy"
            value={tt.privacy}
            placeholder="Pick who can see it"
            options={TIKTOK_ORDER.map((v) => ({ value: v, label: PRIVACY_LABEL[v]! }))}
            onChange={(v) => save("tiktok", { privacy: v })}
          />
          <Toggle label="Comments" checked={tt.comments} onChange={(v) => save("tiktok", { comments: v })} />
          <Toggle label="Duet" checked={tt.duet} onChange={(v) => save("tiktok", { duet: v })} />
          <Toggle label="Stitch" checked={tt.stitch} onChange={(v) => save("tiktok", { stitch: v })} />
          <p className="field__hint">{macPosts ? MAC_COMMERCIAL : `${COMMERCIAL_OFF} ${OWN_TAP}`}</p>
          {/* Only for a paid partnership: the how-to waits in one fold. */}
          <details className="cr-fold" data-my="paid">
            <summary className="cr-fold__q">
              <Icon name="info" size={18} />
              <span>Paid partnership?</span>
              <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
            </summary>
            <div className="cr-fold__body">
              <ul className="gstep__say">
                {(macPosts ? MAC_PAID_STEPS : PAID_STEPS).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      </Apple>
      <Apple id="my-settings-instagram" wide>
        <Toggle label="Also show it in my feed" checked={preset.instagram.shareToFeed} onChange={(v) => save("instagram", { shareToFeed: v })} />
      </Apple>
      {/* Its leaf says it all: Reels on a Page are public, nothing to pick. */}
      <Apple id="my-settings-facebook" wide />
      <Apple id="my-settings-x" wide aside={xReady ? null : <Pill tone="neutral">Not set up yet</Pill>}>
        <div className="preset-page__controls">
          <span className="field__label" id="my-x-replies">
            Who can reply
          </span>
          <Dropdown
            labelledBy="my-x-replies"
            value={preset.x.replies}
            placeholder="Pick who can reply"
            options={(Object.keys(X_REPLIES_LABEL) as XReplies[]).map((v) => ({ value: v, label: X_REPLIES_LABEL[v] }))}
            onChange={(v) => save("x", { replies: v as XReplies })}
          />
        </div>
      </Apple>
    </Panel>
  );
}
