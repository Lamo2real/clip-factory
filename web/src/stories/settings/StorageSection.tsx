// Lamo Stories › Settings › Storage and production (docs/CONTRACTS.md §45.29): the space Lamo Stories' own files use
// (videos, scenes, sounds, reference videos, skills; from its ASSET# and REFVID# sizes, under its own ws/ folder, apart
// from Clip Factory's), the output format (MP4, H.264 and AAC, +faststart), captions burned into the picture or not,
// how many scenes are drawn at a time (1 to 3), how many old versions each video keeps (all, or the last 1 to 10), and
// how YouTube posts are filed and who sees them (§45.16.7).
import { useEffect } from "react";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { StorageSummary, StoriesConfig } from "../api/types.ts";
import { Btn, Empty, Failed, Loading, SavedMark, SetCard, SetPick, SetSwitch, sizeText, useSaved } from "./bits.tsx";
import { useWorkspaceConfig } from "./data.ts";

export const STORAGE_KINDS: { key: keyof StorageSummary["bytes"]; label: string; sw: string }[] = [
  { key: "videos", label: "Finished videos", sw: "st-stg-sw--sun" },
  { key: "scenes", label: "Scenes and storyboards", sw: "st-stg-sw--sky" },
  { key: "audio", label: "Sounds and music", sw: "st-stg-sw--mint" },
  { key: "references", label: "Reference videos", sw: "st-stg-sw--coral" },
  { key: "skills", label: "Skills", sw: "st-stg-sw--lilac" },
  { key: "other", label: "Character pictures and the rest", sw: "st-stg-sw--cream" },
];

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

export function StorageSection({ ws }: { ws: string }) {
  const { workspace, config: c, save, saved: savedCount, busy } = useWorkspaceConfig(ws);
  const storage = useLoad(() => storiesApi().storage(ws), ws, "st-settings-storage");
  const { saved, flash } = useSaved();
  useEffect(() => {
    if (savedCount) flash();
  }, [savedCount, flash]);

  if (!workspace.data) return workspace.error ? <Failed message={workspace.error} onRetry={() => void workspace.reload()} /> : <Loading label="Opening the storage settings…" />;
  const keep = c.production.keepVersions;
  const keepN = keep === "all" ? 3 : keep;

  return (
    <div className="st-stg-cards">
      <div className="st-stg-bar">
        <p className="st-stg-small">Lamo Stories keeps its files in its own folder, apart from Clip Factory's.</p>
        <SavedMark saved={saved} busy={busy} />
      </div>
      <SetCard title="Space used" icon="box" lede="Everything Lamo Stories has made and kept.">
        {storage.data ? <Used storage={storage.data} /> : storage.error ? <Failed message={storage.error} onRetry={() => void storage.reload()} /> : <Loading label="Adding it up…" />}
      </SetCard>

      <SetCard title="The finished file" icon="film" lede="Every platform takes this file as it is.">
        <dl className="st-stg-facts">
          <div>
            <dt>Format</dt>
            <dd>MP4: H.264 picture and AAC sound, made to start playing fast (+faststart)</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>1080 × 1920 at 30 fps</dd>
          </div>
        </dl>
        <SetSwitch
          label="Put the captions into the picture"
          description={c.production.burnCaptions ? "The words are part of the video, so they show everywhere." : "The words are left out of the picture."}
          checked={c.production.burnCaptions}
          onChange={(v) => save({ production: { ...c.production, burnCaptions: v } })}
        />
      </SetCard>

      <SetCard title="Making the scenes" icon="clock" lede="More at a time is quicker; fewer is gentler when lots is going on.">
        <SetPick<"1" | "2" | "3">
          label="Scenes drawn at a time"
          value={String(c.production.scenesAtOnce) as "1" | "2" | "3"}
          onChange={(v) => save({ production: { ...c.production, scenesAtOnce: Number(v) as 1 | 2 | 3 } })}
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
          onChange={(v) => save({ production: { ...c.production, keepVersions: v === "all" ? "all" : keepN } })}
          options={[
            { value: "all", label: "Keep them all" },
            { value: "some", label: "Keep only the last few" },
          ]}
        />
        {keep !== "all" ? (
          <div className="st-stg-stepper" role="group" aria-label="How many versions each video keeps">
            <Btn label="Keep one fewer" off={keep <= 1 ? "One is the fewest" : undefined} onClick={() => save({ production: { ...c.production, keepVersions: keep - 1 } })}>
              <span aria-hidden="true">−</span>
            </Btn>
            <span className="st-stg-stepper__value" aria-live="polite">
              The last <strong>{keep}</strong> {keep === 1 ? "version" : "versions"}
            </span>
            <Btn label="Keep one more" off={keep >= 10 ? "Ten is the most" : undefined} onClick={() => save({ production: { ...c.production, keepVersions: keep + 1 } })}>
              <span aria-hidden="true">+</span>
            </Btn>
          </div>
        ) : null}
        <p className="st-stg-small">{keep === "all" ? "Nothing is ever cleared away." : "When a new version is made, the files of older ones are deleted. The video's history stays."}</p>
      </SetCard>

      <SetCard title="YouTube posts" icon="film" lede="Lamo Stories' own YouTube choices, never made for kids. Clip Factory's YouTube settings are not used here.">
        <p className="st-stg-label">Which shelf on YouTube</p>
        <SetPick label="YouTube category" value={c.youtubeCategory} options={CATEGORIES} onChange={(v) => save({ youtubeCategory: v })} />
        <p className="st-stg-label">Who can see the videos</p>
        <SetPick label="Who can see the videos on YouTube" value={c.youtubePrivacy} options={PRIVACY} onChange={(v) => save({ youtubePrivacy: v })} />
      </SetCard>
    </div>
  );
}
