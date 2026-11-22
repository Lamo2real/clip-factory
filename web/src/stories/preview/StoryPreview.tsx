// A story script played live by the engine (docs/CONTRACTS.md §45.10): storyboard scenes, production and mock mode.
// Owned by builder D (engine); screens only pass props.
import { useEffect, useMemo, useRef } from "react";
import { drawFrame, frameCount, sceneFrames, textTrack } from "../engine/engine.ts";
import type { StoryScript } from "../engine/types.ts";
import { useAppActive } from "../pane.tsx";
import { storiesReduceMotion } from "../prefs.ts";
import { drawPrims, drawText } from "./draw.ts";

export interface StoryPreviewProps {
  script: StoryScript;
  /** only this scene (looping), else the whole story */
  sceneId?: string;
  /** CSS pixels wide; the height follows the script's shape (width × 16 / 9 for 9:16, the same for 1:1, width × 9 / 16
   * for 16:9; CONTRACTS §45.34) */
  width: number;
  playing?: boolean;
  loop?: boolean;
  onTime?: (seconds: number) => void;
  label: string;
}

/** The CSS height of a preview `width` pixels wide, in the script's own shape. */
export function previewHeight(script: Pick<StoryScript, "width" | "height">, width: number): number {
  const w = script.width > 0 ? script.width : 1080;
  const h = script.height > 0 ? script.height : 1920;
  return Math.round((width * h) / w);
}

export function StoryPreview({ script, sceneId, width, playing = true, loop = true, onTime, label }: StoryPreviewProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const height = previewHeight(script, width);
  // the latest callback, read on each frame: a new function from the parent must not restart the animation
  const onTimeRef = useRef(onTime);
  useEffect(() => {
    onTimeRef.current = onTime;
  }, [onTime]);
  const text = useMemo(() => textTrack(script), [script]);
  // Lamo Stories kept hidden behind Clip Factory: no painting at all (the last frame stays), again once it is back.
  const active = useAppActive();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !active) return;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    // Set only when it changes: setting a canvas's size clears it, and the picture would blink on coming back.
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    const scale = canvas.width / script.width;
    const [from, to] = sceneId ? sceneFrames(script, sceneId) : [0, frameCount(script)];
    const still = !playing || storiesReduceMotion();
    let raf = 0;
    let last = -1;
    const start = performance.now();
    const paint = (now: number) => {
      const span = Math.max(1, to - from);
      const elapsed = Math.floor(((now - start) / 1000) * script.fps);
      const f = still ? from + Math.floor(span / 2) : loop ? from + (elapsed % span) : Math.min(to - 1, from + elapsed);
      if (f !== last) {
        last = f;
        drawPrims(ctx, drawFrame(script, f), scale);
        drawText(ctx, text, f / script.fps, scale);
        onTimeRef.current?.(f / script.fps);
      }
      if (!still && (loop || from + elapsed < to)) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [script, sceneId, width, height, playing, loop, text, active]);
  return <canvas ref={ref} className="st-story-preview" style={{ width, height }} role="img" aria-label={label} />;
}
