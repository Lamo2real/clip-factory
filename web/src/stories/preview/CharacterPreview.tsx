// A character drawn live by the engine (docs/CONTRACTS.md §45.8): the Characters page and every cast picker.
// Owned by builder D (engine); screens only pass props.
import { useEffect, useRef } from "react";
import { previewCharacter } from "../engine/engine.ts";
import type { ActionId, ArtStyle, CharacterLook, Expression, MovementStyle } from "../engine/types.ts";
import { useAppActive } from "../pane.tsx";
import { storiesReduceMotion } from "../prefs.ts";
import { useArt } from "./art.tsx";
import { drawPrims } from "./draw.ts";

export interface CharacterPreviewProps {
  look: CharacterLook;
  movementStyle: MovementStyle;
  expression?: Expression;
  action?: ActionId;
  /** CSS pixels (square) */
  size: number;
  /** animate (default true; reduced motion shows one still frame) */
  playing?: boolean;
  label: string;
  /** the drawing style (§45.45); left out, the nearest ArtProvider's (Bright with none) */
  art?: ArtStyle;
}

export function CharacterPreview({ look, movementStyle, expression = "neutral", action = "idle", size, playing = true, label, art }: CharacterPreviewProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const shared = useArt();
  const style = art ?? shared;
  // Lamo Stories kept hidden behind Clip Factory: no painting at all (the last frame stays), again once it is back.
  const active = useAppActive();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !active) return;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    // Set only when it changes: setting a canvas's size clears it, and the picture would blink on coming back.
    if (canvas.width !== Math.round(size * dpr)) canvas.width = Math.round(size * dpr);
    if (canvas.height !== Math.round(size * dpr)) canvas.height = Math.round(size * dpr);
    const still = !playing || storiesReduceMotion();
    let raf = 0;
    let last = -1;
    const start = performance.now();
    const frame = (now: number) => {
      // 30 frames a second, like the videos: no need to redraw more often
      const t = still ? 0.9 : Math.floor(((now - start) / 1000) * 30) / 30;
      if (t !== last) {
        last = t;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawPrims(ctx, previewCharacter(look, movementStyle, expression, action, t, canvas.width, style), 1);
      }
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [look, movementStyle, expression, action, size, playing, active, style]);
  return <canvas ref={ref} className="st-character-preview" style={{ width: size, height: size }} role="img" aria-label={label} />;
}
