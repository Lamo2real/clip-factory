// A character drawn live by the engine (docs/CONTRACTS.md §45.8): the Characters page and every cast picker.
// Owned by builder D (engine); screens only pass props.
import { useEffect, useRef } from "react";
import { previewCharacter } from "../engine/engine.ts";
import type { ActionId, CharacterLook, Expression, MovementStyle } from "../engine/types.ts";
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
}

export function CharacterPreview({ look, movementStyle, expression = "neutral", action = "idle", size, playing = true, label }: CharacterPreviewProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const still = !playing || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawPrims(ctx, previewCharacter(look, movementStyle, expression, action, still ? 0 : (now - start) / 1000, canvas.width), 1);
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [look, movementStyle, expression, action, size, playing]);
  return <canvas ref={ref} className="st-character-preview" style={{ width: size, height: size }} role="img" aria-label={label} />;
}
