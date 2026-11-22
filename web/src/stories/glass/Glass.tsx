// A glass surface (glass.css .st-glass and its kinds), for screens that want the recipe as a component.
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";

export type GlassVariant = "card" | "hero" | "bar" | "float" | "tinted";

export interface GlassProps extends HTMLAttributes<HTMLElement> {
  /** card (default) · hero (brighter edge, may bend) · bar (something scrolls under) · float (sheets, toasts) · tinted */
  variant?: GlassVariant;
  /** tinted only: the tone's channels, "255 154 69" (any --st-*-rgb) */
  tone?: string;
  /** hero only: its rim may bend where the device allows (.st-lens) */
  lens?: boolean;
  as?: "div" | "section" | "article" | "aside" | "header" | "nav" | "li";
  children?: ReactNode;
}

export function Glass({ variant = "card", tone, lens = false, as: Tag = "div", className, style, children, ...rest }: GlassProps) {
  const toneStyle = tone ? ({ "--st-tone-rgb": tone } as Record<string, string>) : undefined;
  return (
    <Tag className={cx("st-glass", variant !== "card" && `st-glass--${variant}`, lens && "st-lens", className)} style={toneStyle ? { ...toneStyle, ...style } : style} {...rest}>
      {children}
    </Tag>
  );
}
