// A round glass icon button (back, menu, notifications, avatar, play). The icon is decorative; `label` names it.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";

export interface RoundGlassButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** what it does, for screen readers and the hover title ("Back", "Menu") */
  label: string;
  /** the icon */
  children: ReactNode;
  /** glass (default) · cream (solid, for the one that matters) · accent (orange, e.g. play) */
  tone?: "glass" | "cream" | "accent";
  size?: "md" | "lg";
  /** shown as on (cream) */
  active?: boolean;
  /** a small orange dot at the top right (something new) */
  dot?: boolean;
}

export function RoundGlassButton({ label, children, tone = "glass", size = "md", active = false, dot = false, className, type, title, ...rest }: RoundGlassButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      className={cx("st-round-btn", tone !== "glass" && `st-round-btn--${tone}`, size === "lg" && "st-round-btn--lg", active && "is-on", className)}
      {...rest}
    >
      <span aria-hidden="true">{children}</span>
      {dot ? <span className="st-round-btn__dot" aria-hidden="true" /> : null}
    </button>
  );
}
