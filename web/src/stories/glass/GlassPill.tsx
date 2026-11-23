// A pill chip: the chosen one solid cream with espresso words, the others glass. A button by default; `as="span"`
// for a pill that only shows a state. For a pick-one bar, give each pill role="radio" and aria-checked.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";

export interface GlassPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** the chosen one: solid cream */
  active?: boolean;
  size?: "md" | "sm";
  /** an icon before the words (decorative) */
  icon?: ReactNode;
  as?: "button" | "span";
  children: ReactNode;
}

export function GlassPill({ active = false, size = "md", icon, as = "button", className, children, type, ...rest }: GlassPillProps) {
  const cls = cx("st-pill", size === "sm" && "st-pill--small", active && "is-on", className);
  const inner = (
    <>
      {icon ? (
        <span className="st-pill__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </>
  );
  if (as === "span") return <span className={cls}>{inner}</span>;
  return (
    <button type={type ?? "button"} className={cls} {...rest}>
      {inner}
    </button>
  );
}
