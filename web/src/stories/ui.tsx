// A few Lamo Stories building blocks (docs/CONTRACTS.md §45.16.2), styled by web/src/styles/stories.css.
// SCAFFOLD (Phase 1): builder F owns this file and may add to it; builder G uses these and adds screen-level pieces
// in its own files. Click and deny sounds come from the app's global click handler (web/src/lib/sound.ts).
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function StButton({
  main = false,
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { main?: boolean }) {
  return <button type={type} className={`st-btn${main ? " st-btn--main" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
}

export function StCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`st-card${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function StChip({ children, tone }: { children: ReactNode; tone?: "sun" | "coral" | "mint" | "sky" }) {
  return <span className={`st-chip${tone ? ` st-chip--${tone}` : ""}`}>{children}</span>;
}
