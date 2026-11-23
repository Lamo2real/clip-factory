// The one small solid cream card among the glass cards (for example "Next video"), with a slot for an orange toggle.
// Espresso words on cream; orange words only in --st-on-cream-orange.
import { useId, type ReactNode } from "react";
import { cx } from "./cx.ts";

export interface CreamCardProps {
  title: ReactNode;
  /** a short line above the title (caps) */
  eyebrow?: ReactNode;
  children?: ReactNode;
  /** the toggle's slot, top right: a <GlassToggle> */
  toggle?: ReactNode;
  /** under the body: a link or a button */
  footer?: ReactNode;
  as?: "section" | "article" | "div";
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

export function CreamCard({ title, eyebrow, children, toggle, footer, as: Tag = "section", headingLevel = 3, className }: CreamCardProps) {
  const id = useId();
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <Tag className={cx("st-cream", "st-cream-card", className)} aria-labelledby={`${id}-t`}>
      <div className="st-cream-card__head">
        <div>
          {eyebrow ? <p className="st-cream-card__eyebrow st-caps">{eyebrow}</p> : null}
          <H className="st-cream-card__title" id={`${id}-t`}>
            {title}
          </H>
        </div>
        {toggle ? <div className="st-cream-card__toggle">{toggle}</div> : null}
      </div>
      {children ? <div className="st-cream-card__body">{children}</div> : null}
      {footer ? <div className="st-cream-card__foot">{footer}</div> : null}
    </Tag>
  );
}
