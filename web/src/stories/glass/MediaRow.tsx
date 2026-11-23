// A media row: a thumbnail, the title and a line, a progress bar, and controls (the studio preview, the Library
// rows). Put it inside a glass surface (or give it className="st-glass").
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export interface MediaRowProps {
  /** a picture's address, or any element (a <video>, an icon) */
  thumb?: string | ReactNode;
  /** the picture's words (empty when the title says it all) */
  thumbAlt?: string;
  title: ReactNode;
  meta?: ReactNode;
  /** 0..1, or null/undefined for no bar */
  progress?: number | null;
  /** the bar's name ("Played", "Made") */
  progressLabel?: string;
  /** beside the bar ("1:24") */
  progressText?: ReactNode;
  /** round buttons, a pill */
  controls?: ReactNode;
  as?: "div" | "li" | "article";
  className?: string;
}

export function MediaRow({ thumb, thumbAlt = "", title, meta, progress, progressLabel = "Progress", progressText, controls, as: Tag = "div", className }: MediaRowProps) {
  const f = progress === null || progress === undefined || !Number.isFinite(progress) ? null : Math.min(1, Math.max(0, progress));
  return (
    <Tag className={cx("st-media", className)}>
      <span className="st-media__thumb">{typeof thumb === "string" ? <img src={thumb} alt={thumbAlt} loading="lazy" /> : thumb}</span>
      <span className="st-media__text">
        <span className="st-media__title">{title}</span>
        {meta ? <span className="st-media__meta">{meta}</span> : null}
      </span>
      {f !== null ? (
        <span className="st-media__bar">
          <span className="st-media__track" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
            <span className="st-media__fill" style={{ width: `${f * 100}%` }} />
          </span>
          {progressText ? <span className="st-media__time">{progressText}</span> : null}
        </span>
      ) : null}
      {controls ? <span className="st-media__controls">{controls}</span> : null}
    </Tag>
  );
}
