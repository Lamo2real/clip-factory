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
import { Segmented, Skeleton, Toggle } from "../../components/ui.tsx";
import { presetOf, X_REPLIES_LABEL, YOUTUBE_CATEGORIES, YT_WHO } from "../../lib/preset.ts";
import { PRIVACY_LABEL } from "../../lib/tiktokChoices.ts";
import { macOn } from "../../lib/tiktokMac.ts";
import { tiktokAudited } from "../../lib/tiktokYourself.ts";
import { useSetup } from "./setup/useSetup.ts";
import { Apple, Panel } from "./parts.tsx";

const TIKTOK_ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

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
          Whether a clip earns money is up to each app (like YouTube&apos;s Partner Program or TikTok&apos;s Creator Rewards), not these switches.
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
            <span>Made for kids: No. My settings never mark a clip as made for kids.</span>
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
          <p className="field__hint">
            {macPosts
              ? "Commercial content is off. Your Mac posts TikTok with these. Paid partnerships can't go through your Mac yet: untick TikTok for that clip, then post it in the TikTok app with its label, not with Post with my Mac or Send these to my Mac."
              : "Commercial content is off. For a paid partnership, tick Branded content in the TikTok row of that clip. TikTok wants your own tap on each clip, so tap Use my settings there."}
          </p>
        </div>
      </Apple>
      <Apple id="my-settings-instagram" wide>
        <Toggle label="Also show it in my feed" checked={preset.instagram.shareToFeed} onChange={(v) => save("instagram", { shareToFeed: v })} />
      </Apple>
      <Apple id="my-settings-facebook" wide>
        <p className="field__hint">Reels on your Facebook Page are public: everyone can see them.</p>
      </Apple>
      <Apple id="my-settings-x" wide>
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
          {xReady ? null : <p className="field__hint">X is not set up yet. This is used once it is.</p>}
        </div>
      </Apple>
    </Panel>
  );
}
