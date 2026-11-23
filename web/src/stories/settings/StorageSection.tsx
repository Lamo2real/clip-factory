// Lamo Stories › Settings › Storage and production (docs/CONTRACTS.md §45.29, §45.34; request 2 §6F "Media storage.
// Reference-video storage. Output formats. Production settings. Rendering configuration. Asset retention." and §9):
// where Lamo Stories keeps its files (its own folder in Clip Factory's media storage, apart from Clip Factory's) and
// the space each kind uses (videos, scenes and storyboards, sounds, reference videos, skills; from its ASSET# and
// REFVID# sizes), the finished file (MP4, H.264 and AAC, +faststart, always; WebM and MOV besides it if the owner
// wants), captions burned into the picture or not (only the caption words are left out; the bubbles and the safety
// end card always stay), how many scenes are drawn at a time (1 to 3), how long reference videos, chat pictures and
// old versions are kept, Clean up now (applies those choices at once), how YouTube posts are filed (§45.16.7), and
// this device's own sounds and motion for Lamo Stories (cf.stories.prefs, apart from Clip Factory's).
import { useEffect, useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { SoundEngine } from "../../lib/sound.ts";
import { CLICK_SOUNDS, ERROR_SOUNDS } from "../../lib/soundCatalog.ts";
import { storiesApi } from "../api/client.ts";
import type { ExtraFormat, KeepChatPictures, KeepReferences, StorageSummary, StoriesConfig } from "../api/types.ts";
import { setStoriesDevicePref, storiesClickSound, storiesDeviceOwn, storiesErrorSound, storiesMotionSetting, storiesReduceMotion, storiesSoundOn, useStoriesDevicePrefs } from "../prefs.ts";
import { Btn, cheer, Empty, Failed, Loading, Note, SavedMark, SectionBar, SetCard, SetPick, SetSelect, SetSwitch, SIcon, sizeText, useSaved } from "./bits.tsx";
import { useWorkspaceConfig } from "./data.ts";
import { StTech } from "../ui.tsx";
import { sizeWords } from "./VideoSection.tsx";

export const STORAGE_KINDS: { key: keyof StorageSummary["bytes"]; label: string; sw: string }[] = [
  { key: "videos", label: "Finished videos", sw: "st-stg-sw--sun" },
  { key: "scenes", label: "Scenes and storyboards", sw: "st-stg-sw--sky" },
  { key: "audio", label: "Sounds and music", sw: "st-stg-sw--mint" },
  { key: "references", label: "Reference videos", sw: "st-stg-sw--coral" },
  { key: "skills", label: "Skills", sw: "st-stg-sw--lilac" },
  { key: "other", label: "Character pictures and the rest", sw: "st-stg-sw--cream" },
];

/** AWS Regions by their place's name, for the storage line. */
const PLACES: Record<string, string> = {
  "eu-north-1": "Europe (Stockholm)",
  "eu-west-1": "Europe (Ireland)",
  "eu-central-1": "Europe (Frankfurt)",
  "us-east-1": "US East (N. Virginia)",
};

export const LOCATION_WORDS = "Funded Clips' own folder in Clip Factory's media storage";

const CATEGORIES: { value: StoriesConfig["youtubeCategory"]; label: string }[] = [
  { value: "27", label: "Education" },
  { value: "1", label: "Film & Animation" },
  { value: "23", label: "Comedy" },
  { value: "24", label: "Entertainment" },
  { value: "2", label: "Autos & Vehicles" },
];

const PRIVACY: { value: StoriesConfig["youtubePrivacy"]; label: string; line: string }[] = [
  { value: "public", label: "Everyone", line: "Public" },
  { value: "unlisted", label: "Only with the link", line: "Unlisted" },
  { value: "private", label: "Only me", line: "Private" },
];

/** How long reference videos are kept (§45.34), in plain words. */
export const KEEP_REFERENCES: { value: KeepReferences; label: string; line: string }[] = [
  { value: "all", label: "Keep them all", line: "Nothing is cleared" },
  { value: "study_only", label: "Keep only the study", line: "The video goes once it is studied" },
  // By age a video that was never studied goes too, so only a study that exists stays (§45.35 D9).
  { value: "days_30", label: "30 days", line: "Then the video goes; its study stays if it was studied" },
  { value: "days_90", label: "90 days", line: "Then the video goes; its study stays if it was studied" },
];

/** How long pictures added in the chat are kept (§45.34). */
export const KEEP_CHAT_PICTURES: { value: KeepChatPictures; label: string; line: string }[] = [
  { value: "all", label: "Keep them all", line: "Nothing is cleared" },
  { value: "days_30", label: "30 days", line: "Then they go" },
  { value: "days_90", label: "90 days", line: "Then they go" },
];

/** The files made besides the MP4, in plain words (§45.34). */
export const EXTRA_FORMATS: { value: ExtraFormat; label: string; description: string }[] = [
  { value: "webm", label: "Also make a WebM file", description: "A small file that plays on web pages." },
  { value: "mov", label: "Also make a MOV file", description: "A big file for editing apps like Final Cut or Premiere." },
];

/** The burned-in captions switch's words (§45.34: only the caption words are left out). */
export function burnWords(on: boolean): string {
  return on
    ? "The words are part of the video, so they show everywhere."
    : "Only the caption words are left out of the picture. The speech bubbles and the safety end card always stay in.";
}

function Used({ storage }: { storage: StorageSummary }) {
  const total = STORAGE_KINDS.reduce((a, k) => a + storage.bytes[k.key], 0);
  if (!total) return <Empty title="Nothing stored yet" mood="sleepy">Videos, scenes and sounds show here once the first video is made.</Empty>;
  return (
    <>
      <p className="st-stg-total">
        {sizeText(total)}
        <span className="st-stg-total__note">{` in ${storage.files.toLocaleString("en-GB")} ${storage.files === 1 ? "file" : "files"}`}</span>
      </p>
      <div className="st-stg-meter" role="img" aria-label={`Storage used: ${STORAGE_KINDS.filter((k) => storage.bytes[k.key]).map((k) => `${k.label} ${sizeText(storage.bytes[k.key])}`).join(", ")}.`}>
        {STORAGE_KINDS.filter((k) => storage.bytes[k.key]).map((k) => (
          <span key={k.key} className={`st-stg-meter__part st-stg-sw ${k.sw}`} style={{ flexGrow: storage.bytes[k.key] }} />
        ))}
      </div>
      <ul className="st-stg-usage" aria-label="Storage by kind">
        {STORAGE_KINDS.map((k) => (
          <li key={k.key} className="st-stg-usage__row">
            <span className={`st-stg-sw ${k.sw}`} aria-hidden="true" />
            <span className="st-stg-usage__name">{k.label}</span>
            <span className="st-stg-usage__cost">{sizeText(storage.bytes[k.key])}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Where the files are: the place's name and the folder, from StorageSummary.location. */
function Where({ storage }: { storage: StorageSummary | null }) {
  const loc = storage?.location;
  return (
    <div className="st-stg-where">
      <span className="st-stg-active__word">Where</span>
      <span>
        {LOCATION_WORDS}
        {loc ? ` in ${PLACES[loc.region] ?? loc.region}.` : ", apart from Clip Factory's files."}
      </span>
      {/* The exact folder, one tap away (§45.35 D21, §45.36 E14). */}
      {loc ? (
        <StTech className="st-stg-tech st-stg-where__tech">
          <span>
            Folder <code className="st-stg-code">{loc.folder}</code> in {loc.region}
          </span>
        </StTech>
      ) : null}
    </div>
  );
}

/** Clean up now (POST …/storage/cleanup): applies the keep choices at once, after an "Are you sure?". */
function Cleanup({ ws, onDone }: { ws: string; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async (el: HTMLElement) => {
    setBusy(true);
    try {
      const { removed } = await storiesApi().storageCleanup(ws);
      setSure(false);
      const text = removed.files
        ? `Cleared ${removed.files.toLocaleString("en-GB")} ${removed.files === 1 ? "file" : "files"} (${sizeText(removed.bytes)}). The rest is kept.`
        : "Nothing to clear: every file is still one you keep.";
      setResult(text);
      if (removed.files) {
        cheer(el);
        toast.success(text);
      } else toast.info(text);
      await onDone();
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-stg-cleanup">
      {result ? (
        <Note tone="mint" role="status">
          {result}
        </Note>
      ) : null}
      {sure ? (
        <div className="st-stg-confirm" role="group" aria-label="Are you sure?">
          <p>
            <strong>Clear old files now?</strong> Files older than your choices above are deleted. Clip Factory's files are never touched.
          </p>
          <div className="st-stg-actions">
            <Btn main danger off={busy ? "Clearing…" : undefined} onClick={(e) => void run(e.currentTarget)}>
              {busy ? "Clearing…" : "Yes, clear them"}
            </Btn>
            <Btn quiet onClick={() => setSure(false)}>
              No, not now
            </Btn>
          </div>
        </div>
      ) : (
        <Btn
          onClick={() => {
            setResult(null);
            setSure(true);
          }}
        >
          Clean up now
        </Btn>
      )}
    </div>
  );
}

/** Plays a click or error sound by its number, for the pickers (its own engine: the usual click sound is kept out of the way). */
let preview: SoundEngine | null = null;
function hear(kind: "tap" | "deny", id: number, target: EventTarget | null): void {
  (preview ??= new SoundEngine(storiesSoundOn)).play(kind, target, id);
}

/**
 * Settings › Storage and production › Sounds and motion (§45.34, §45.38): this device's own choices for Lamo Stories,
 * read with the same readers Lamo Stories' sounds and motion use (stories/prefs.ts), so the card shows what really
 * applies. Unset, each is Lamo Stories' own usual choice; Clip Factory's settings never change them.
 */
function SoundsAndMotion() {
  useStoriesDevicePrefs();
  const mine = storiesDeviceOwn();
  const soundOn = storiesSoundOn();
  const click = storiesClickSound();
  const deny = storiesErrorSound();
  const calm = storiesMotionSetting();
  const systemCalm = !calm && storiesReduceMotion();
  const anySet = mine.sound !== undefined || mine.click !== undefined || mine.deny !== undefined || mine.motion !== undefined;
  const offWhy = soundOn ? undefined : "Turn Sounds on first";
  return (
    <SetCard title="Sounds and motion" icon="sound" id="sounds-and-motion" lede="For Funded Clips on this device. Clip Factory's sounds and motion stay as they are.">
      <SetSwitch
        label="Sounds"
        description="Click sounds on every button, and cheers when something works."
        checked={soundOn}
        onChange={(v) => setStoriesDevicePref("sound.enabled", v)}
      />
      <div className="st-stg-hear">
        <SetSelect
          label="Click sound"
          value={String(click)}
          off={offWhy}
          options={CLICK_SOUNDS.map((x) => ({ value: String(x.id), label: `${x.name}: ${x.feel.toLowerCase()}` }))}
          onChange={(v) => {
            const id = Number(v);
            setStoriesDevicePref("sound.click", id);
            hear("tap", id, null);
          }}
        />
        {/* It plays the picked sound itself (data-sound="off" keeps the usual click sound out of the way); with Sounds off it is switched off. */}
        <button
          type="button"
          className="st-btn st-stg-btn st-stg-btn--quiet"
          data-sound={soundOn ? "off" : undefined}
          aria-disabled={soundOn ? undefined : true}
          title={offWhy}
          onClick={(e) => {
            if (soundOn) hear("tap", click, e.currentTarget);
          }}
        >
          <SIcon name="sound" size={20} />
          Hear it
        </button>
      </div>
      <p className="st-stg-small">Funded Clips' own click sound.</p>
      <SetSelect
        label="Error sound"
        value={String(deny)}
        off={offWhy}
        options={ERROR_SOUNDS.map((x) => ({ value: String(x.id), label: `${x.name}: ${x.feel.toLowerCase()}` }))}
        onChange={(v) => {
          const id = Number(v);
          setStoriesDevicePref("sound.deny", id);
          hear("deny", id, null);
        }}
      />
      <SetSwitch
        label="Less motion"
        description="Fewer things slide, bounce and burst on the screen."
        checked={calm}
        onChange={(v) => setStoriesDevicePref("motion.reduce", v)}
      />
      {systemCalm ? <p className="st-stg-small">This device asks for less motion too, so Funded Clips keeps it calm anyway.</p> : null}
      {anySet ? (
        <Btn
          quiet
          onClick={() => {
            setStoriesDevicePref("sound.enabled", null);
            setStoriesDevicePref("sound.click", null);
            setStoriesDevicePref("sound.deny", null);
            setStoriesDevicePref("motion.reduce", null);
          }}
        >
          Use the usual settings again
        </Btn>
      ) : null}
    </SetCard>
  );
}

export function StorageSection({ ws }: { ws: string }) {
  const { workspace, config: c, save, saved: savedCount, busy } = useWorkspaceConfig(ws);
  const storage = useLoad(() => storiesApi().storage(ws), ws, "st-settings-storage");
  const { saved, flash } = useSaved();
  useEffect(() => {
    if (savedCount) flash();
  }, [savedCount, flash]);

  if (!workspace.data) return workspace.error ? <Failed message={workspace.error} onRetry={() => void workspace.reload()} /> : <Loading label="Opening the storage settings…" />;
  const prod = c.production;
  const keep = prod.keepVersions;
  const keepN = keep === "all" ? 3 : keep;
  const extra = prod.extraFormats ?? [];

  return (
    <div className="st-stg-cards">
      <SectionBar>
        <p className="st-stg-small">Funded Clips keeps its files in its own folder, apart from Clip Factory's.</p>
        <SavedMark saved={saved} busy={busy} />
      </SectionBar>
      <SetCard title="Space used" icon="box" lede="Everything Funded Clips has made and kept.">
        <Where storage={storage.data} />
        {storage.data ? <Used storage={storage.data} /> : storage.error ? <Failed message={storage.error} onRetry={() => void storage.reload()} /> : <Loading label="Adding it up…" />}
      </SetCard>

      <SetCard title="The finished file" icon="film" lede="Every video is an MP4, which every platform takes. You can have other files made too.">
        <dl className="st-stg-facts">
          <div>
            <dt>Format</dt>
            <dd>
              An MP4, which every platform and phone plays, made to start playing fast.
              <StTech className="st-stg-tech">
                <span>MP4: H.264 picture and AAC sound (+faststart).</span>
              </StTech>
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {sizeWords(c.video.resolution)} ({c.video.aspect}) at 30 fps
            </dd>
          </div>
        </dl>
        <SetSwitch
          label="Put the captions into the picture"
          description={burnWords(prod.burnCaptions)}
          checked={prod.burnCaptions}
          onChange={(v) => save({ production: { ...prod, burnCaptions: v } })}
        />
        <h4 className="st-stg-subhead">Other files, besides the MP4</h4>
        {EXTRA_FORMATS.map((f) => (
          <SetSwitch
            key={f.value}
            label={f.label}
            description={f.description}
            checked={extra.includes(f.value)}
            onChange={(v) => save({ production: { ...prod, extraFormats: (["webm", "mov"] as const).filter((x) => (x === f.value ? v : extra.includes(x))) } })}
          />
        ))}
        <StTech className="st-stg-tech">
          <span>WebM: VP9 picture and Opus sound. MOV: ProRes 422 Proxy picture and PCM sound.</span>
        </StTech>
      </SetCard>

      <SetCard title="Making the scenes" icon="clock" lede="More at a time is quicker; fewer is gentler when lots is going on.">
        <SetPick<"1" | "2" | "3">
          label="Scenes drawn at a time"
          value={String(prod.scenesAtOnce) as "1" | "2" | "3"}
          onChange={(v) => save({ production: { ...prod, scenesAtOnce: Number(v) as 1 | 2 | 3 } })}
          options={[
            { value: "1", label: "One at a time", line: "Slowest" },
            { value: "2", label: "Two at a time", line: "The usual" },
            { value: "3", label: "Three at a time", line: "Fastest" },
          ]}
        />
      </SetCard>

      <SetCard title="Old versions" icon="box" lede="Each remake makes a new version of a video. Old ones can be kept, or cleared away to save space.">
        <SetPick<"all" | "some">
          label="Keep old versions"
          value={keep === "all" ? "all" : "some"}
          onChange={(v) => save({ production: { ...prod, keepVersions: v === "all" ? "all" : keepN } })}
          options={[
            { value: "all", label: "Keep them all" },
            { value: "some", label: "Keep only the last few" },
          ]}
        />
        {keep !== "all" ? (
          <div className="st-stg-stepper" role="group" aria-label="How many versions each video keeps">
            {/* The white rounded-square steppers (.st-stepper__btn): never disabled, a tap at the end plays the deny sound. */}
            <button
              type="button"
              className="st-stepper__btn"
              aria-label="Keep one fewer"
              aria-disabled={keep <= 1 || undefined}
              title={keep <= 1 ? "One is the fewest" : undefined}
              onClick={() => {
                if (keep > 1) save({ production: { ...prod, keepVersions: keep - 1 } });
              }}
            >
              <span aria-hidden="true">−</span>
            </button>
            <span className="st-stg-stepper__value" aria-live="polite">
              The last <strong>{keep}</strong> {keep === 1 ? "version" : "versions"}
            </span>
            <button
              type="button"
              className="st-stepper__btn"
              aria-label="Keep one more"
              aria-disabled={keep >= 10 || undefined}
              title={keep >= 10 ? "Ten is the most" : undefined}
              onClick={() => {
                if (keep < 10) save({ production: { ...prod, keepVersions: keep + 1 } });
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        ) : null}
        <p className="st-stg-small">{keep === "all" ? "Nothing is ever cleared away." : "When a new version is made, the files of older ones are deleted. The video's history stays."}</p>
      </SetCard>

      <SetCard title="Keeping other files" icon="clock" id="keeping" lede="Reference videos and chat pictures can be cleared after a while to save space.">
        <p className="st-stg-label">Reference videos</p>
        <SetPick<KeepReferences> label="Keep reference videos" stack value={prod.keepReferences ?? "all"} options={KEEP_REFERENCES} onChange={(v) => save({ production: { ...prod, keepReferences: v } })} />
        {(prod.keepReferences ?? "all") === "study_only" ? <p className="st-stg-small">Funded Clips still learns from each study after its video is gone.</p> : null}
        <p className="st-stg-label">Pictures added in the chat</p>
        <SetPick<KeepChatPictures> label="Keep chat pictures" value={prod.keepChatPictures ?? "all"} options={KEEP_CHAT_PICTURES} onChange={(v) => save({ production: { ...prod, keepChatPictures: v } })} />
        <p className="st-stg-small">These choices and Old versions are applied after each video. Clean up now applies them at once.</p>
        <Cleanup ws={ws} onDone={() => storage.reload()} />
      </SetCard>

      <SetCard title="YouTube posts" icon="film" lede="Funded Clips' own YouTube choices, never made for kids. Clip Factory's YouTube settings are not used here.">
        <p className="st-stg-label">Which shelf on YouTube</p>
        <SetPick label="YouTube category" value={c.youtubeCategory} options={CATEGORIES} onChange={(v) => save({ youtubeCategory: v })} />
        <p className="st-stg-label">Who can see the videos</p>
        <SetPick label="Who can see the videos on YouTube" value={c.youtubePrivacy} options={PRIVACY} onChange={(v) => save({ youtubePrivacy: v })} />
      </SetCard>

      <SoundsAndMotion />
    </div>
  );
}
