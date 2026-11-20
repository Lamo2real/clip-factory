// Settings › Posting › My settings (docs/CONTRACTS.md §33.4): the owner's preferred choices for each place, used by
// "Use my settings" on Review. Filled in with each platform's best practice for reach; never "made for kids".
import type { PostPreset, XReplies, YoutubePrivacy } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Segmented, Skeleton, Toggle } from "../../components/ui.tsx";
import { presetOf, TIKTOK_PRIVACY_LABEL, X_REPLIES_LABEL, YOUTUBE_CATEGORIES, YOUTUBE_PRIVACY_LABEL } from "../../lib/preset.ts";
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
  return (
    <Panel className="my-settings">
      <p className="callout my-settings__note">
        <Icon name="sparkle" size={18} />
        <span>
          Tap <strong>Use my settings</strong> on a clip to put these in. Whether a clip earns money is up to each app (like YouTube&apos;s Partner
          Program or TikTok&apos;s Creator Rewards), not these switches.
        </span>
      </p>
      <Apple id="my-settings-youtube" wide>
        <div className="my-settings__controls">
          <span className="field__label">Who can see it</span>
          <Segmented<YoutubePrivacy>
            label="Who can see it on YouTube"
            value={yt.privacy}
            options={(["public", "unlisted", "private"] as const).map((v) => ({ value: v, label: YOUTUBE_PRIVACY_LABEL[v] }))}
            onChange={(v) => save("youtube", { privacy: v })}
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
          <Toggle
            label="Made with AI to look real"
            description="Only turn on if it is true of your clips."
            checked={yt.syntheticMedia}
            onChange={(v) => save("youtube", { syntheticMedia: v })}
          />
          <p className="more-details__fixed">
            <Icon name="lock" size={16} />
            <span>Made for kids: No, always. Clip Factory never marks a clip as made for kids.</span>
          </p>
          <p className="field__hint">Tip: swearing in the first seconds or in the title can limit ads on YouTube.</p>
        </div>
      </Apple>
      <Apple id="my-settings-tiktok" wide>
        <div className="my-settings__controls">
          <span className="field__label" id="my-tt-privacy">
            Who can see it
          </span>
          <Dropdown
            labelledBy="my-tt-privacy"
            value={tt.privacy}
            placeholder="Pick who can see it"
            options={TIKTOK_ORDER.map((v) => ({ value: v, label: TIKTOK_PRIVACY_LABEL[v]! }))}
            onChange={(v) => save("tiktok", { privacy: v })}
          />
          <Toggle label="Comments" checked={tt.comments} onChange={(v) => save("tiktok", { comments: v })} />
          <Toggle label="Duet" checked={tt.duet} onChange={(v) => save("tiktok", { duet: v })} />
          <Toggle label="Stitch" checked={tt.stitch} onChange={(v) => save("tiktok", { stitch: v })} />
          <Toggle
            label="Commercial content"
            description="Off. When a clip is a paid partnership, turn it on for that clip on the TikTok sheet."
            checked={tt.commercial}
            onChange={(v) => save("tiktok", { commercial: v })}
          />
          <p className="field__hint">TikTok wants you to see its choices on each clip, so they show on the TikTok sheet every time. Use my settings fills them in.</p>
        </div>
      </Apple>
      <Apple id="my-settings-instagram" wide>
        <Toggle label="Also show it in my main feed" checked={preset.instagram.shareToFeed} onChange={(v) => save("instagram", { shareToFeed: v })} />
      </Apple>
      <Apple id="my-settings-facebook" wide>
        <p className="field__hint">Reels on your Facebook Page are always public.</p>
      </Apple>
      <Apple id="my-settings-x" wide>
        <div className="my-settings__controls">
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
