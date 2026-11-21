// The storyboard as a filmstrip (docs/CONTRACTS.md §45.16.5): one card per scene with the engine's live preview of
// that scene (it plays while the card is picked or under the mouse), the finished still once the scenes are drawn, the
// scene's title, its on-screen words and its length. Review adds a Remake this scene button to each card.
import { useState, type ReactNode } from "react";
import type { Story, StoryScript } from "../api/types.ts";
import { StoryPreview } from "../preview/StoryPreview.tsx";
import { seconds } from "./words.ts";

/** The words that show during one scene: its own scene words and every caption that starts inside it. */
export function sceneWords(script: StoryScript | null, sceneId: string): string[] {
  if (!script) return [];
  let start = 0;
  for (const sc of script.scenes) {
    const end = start + sc.durationSec;
    if (sc.sceneId === sceneId) {
      const cues = script.captions.filter((c) => c.at >= start - 0.01 && c.at < end).map((c) => c.text);
      return [...(sc.caption ? [sc.caption] : []), ...cues];
    }
    start = end;
  }
  return [];
}

export function Filmstrip({
  script,
  scenes,
  actions,
  width = 132,
  label = "Storyboard",
}: {
  script: StoryScript | null;
  scenes: Story["scenes"];
  /** Buttons under each scene (Review: Remake this scene). */
  actions?: (sceneId: string) => ReactNode;
  width?: number;
  label?: string;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  if (!scenes.length) return null;
  return (
    <ol className="st-s-film" aria-label={label}>
      {scenes.map((sc, i) => {
        const live = playing === sc.sceneId || hover === sc.sceneId;
        const words = sceneWords(script, sc.sceneId);
        const inScript = !!script?.scenes.some((x) => x.sceneId === sc.sceneId);
        return (
          <li key={sc.sceneId} className={`st-s-film__card${live ? " is-live" : ""}`} onPointerEnter={() => setHover(sc.sceneId)} onPointerLeave={() => setHover(null)}>
            <button
              type="button"
              className="st-s-film__frame"
              aria-pressed={playing === sc.sceneId}
              aria-label={`${playing === sc.sceneId ? "Stop" : "Play"} scene ${i + 1}: ${sc.title}`}
              onClick={() => setPlaying((p) => (p === sc.sceneId ? null : sc.sceneId))}
            >
              {script && inScript ? (
                <StoryPreview script={script} sceneId={sc.sceneId} width={width} playing={live} label={`Scene ${i + 1}, ${sc.title}, drawn live`} />
              ) : (
                <span className="st-s-film__blank" style={{ width, height: (width * 16) / 9 }} aria-hidden="true" />
              )}
              <span className="st-s-film__play" aria-hidden="true">
                {playing === sc.sceneId ? "❚❚" : "▶"}
              </span>
            </button>
            <span className="st-s-film__text">
              <span className="st-s-film__num">Scene {i + 1}</span>
              <span className="st-s-film__title">{sc.title}</span>
              <span className="st-s-film__len">{seconds(sc.durationSec)}</span>
              {words.length ? (
                <span className="st-s-film__words">
                  {words.map((w, k) => (
                    <span key={k} className="st-film__word">
                      “{w}”
                    </span>
                  ))}
                </span>
              ) : (
                <span className="st-s-film__words is-none">No words on screen</span>
              )}
            </span>
            {sc.stillUrl ? (
              <span className="st-s-film__still">
                <img src={sc.stillUrl} alt={`Finished picture of scene ${i + 1}`} width={44} height={78} loading="lazy" />
                <span>Finished picture</span>
              </span>
            ) : (
              <span className="st-s-film__still is-waiting">Picture not drawn yet</span>
            )}
            {actions ? <span className="st-s-film__actions">{actions(sc.sceneId)}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
