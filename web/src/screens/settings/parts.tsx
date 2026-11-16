// The small pieces every branch page is built from: a glass panel of apples, each apple with its leaf under it.
import type { ReactNode } from "react";
import { findApple } from "../../lib/settingsTree.ts";

/** A glass panel holding one or more apples, separated by hairlines. */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`apple-panel glass ${className}`}>{children}</div>;
}

/**
 * One setting ("apple") with its help line ("leaf"). The name and leaf come from the settings tree, so search,
 * the folder panel and the page always use the same words. `wide` puts the control under the words instead of
 * beside them (lists, pickers, cards).
 */
export function Apple({
  id,
  children,
  wide = false,
  title,
  aside,
}: {
  id: string;
  children?: ReactNode;
  wide?: boolean;
  /** A heading to show instead of the apple's name (the name then sits beside it as a tag). */
  title?: ReactNode;
  /** Something small beside the heading (a count, a version). */
  aside?: ReactNode;
}) {
  const found = findApple(id);
  if (!found) throw new Error(`Unknown setting ${id}`);
  const { apple } = found;
  return (
    <section className={`apple${wide ? " apple--wide" : ""}`} id={id} aria-labelledby={`${id}-name`} aria-describedby={`${id}-leaf`} tabIndex={-1}>
      <div className="apple__text">
        <div className="apple__head">
          <h2 className="apple__name" id={`${id}-name`}>
            {title ?? apple.name}
          </h2>
          {title ? <span className="apple__tag">{apple.name}</span> : null}
          {aside}
        </div>
        <p className="apple__leaf" id={`${id}-leaf`}>
          {apple.leaf}
        </p>
      </div>
      {children ? <div className="apple__control">{children}</div> : null}
    </section>
  );
}

/** An on/off switch named by its apple (its heading and leaf), so "Sounds" reads as one control with its help. */
export function AppleSwitch({
  apple,
  checked,
  onChange,
}: {
  apple: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-labelledby={`${apple}-name`}
      aria-describedby={`${apple}-leaf`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}
