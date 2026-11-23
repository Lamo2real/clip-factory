// The review player (docs/CONTRACTS.md §45.16.6): the finished MP4 when there is one, else the engine's live preview
// of the whole story (in mock mode that is the "final video"), always 9:16. It sits in a hero glass bezel
// (styles/GLASS-CONTRACT.md: --st-bezel-pad round the picture, whose radius is the bezel's less that pad).
import type { Story, StoryScript } from "../api/types.ts";
import { StoryPreview } from "../preview/StoryPreview.tsx";

export function Player({ story, script, width }: { story: Story; script: StoryScript | null; width: number }) {
  const height = Math.round((width * 16) / 9);
  return (
    <div className="st-s-player st-glass st-glass--hero st-lens" style={{ width: `calc(${width}px + 2 * var(--st-bezel-pad))` }}>
      {story.videoUrl ? (
        <video
          className="st-s-player__video"
          src={story.videoUrl}
          poster={story.coverUrl}
          controls
          playsInline
          preload="metadata"
          width={width}
          height={height}
          aria-label={`Video: ${story.title}`}
        />
      ) : script ? (
        <StoryPreview script={script} width={width} playing label={`Video: ${story.title}, drawn live`} />
      ) : (
        <div className="st-s-player__empty" style={{ width, height }}>
          <span>The video isn&apos;t ready yet.</span>
        </div>
      )}
      <p className="st-s-player__note">{story.videoUrl ? "The finished video" : script ? "Drawn live by Clips Funded" : ""}</p>
    </div>
  );
}
