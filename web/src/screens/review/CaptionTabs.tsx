import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { Captions } from "../../api/types.ts";
import { Glide } from "../../components/Glide.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useAction } from "../../lib/motion.ts";

type Tab = "youtube" | "instagram" | "facebook" | "tiktok" | "x";

const TABS: { key: Tab; label: string }[] = [
  { key: "youtube", label: "YouTube" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "tiktok", label: "TikTok" },
  { key: "x", label: "X" },
];

// The platforms' own caption limits.
const LIMITS = { youtubeTitle: 100, youtubeDescription: 5000, instagram: 2200, facebook: 5000, tiktok: 2200, x: 280 } as const;

function Counter({ value, limit, id }: { value: string; limit: number; id: string }) {
  const over = value.length > limit;
  return (
    <span className={`counter${over ? " is-over" : ""}`} id={id}>
      {value.length} / {limit}
      {over ? " · too long" : ""}
    </span>
  );
}

export function captionsTooLong(c: Captions): boolean {
  return (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).some((k) => c[k].length > LIMITS[k]);
}

/** Editable captions per platform as ARIA tabs (arrow keys move between them). */
export function CaptionTabs({
  captions,
  onChange,
  readOnly = false,
}: {
  captions: Captions;
  onChange: (patch: Partial<Captions>) => void;
  readOnly?: boolean;
}) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("youtube");
  // The newly chosen tab's name bumps (§20.11 (a) `toggle`), by tap or by arrow key.
  const bump = useAction("toggle");
  function choose(key: Tab) {
    setTab(key);
    if (key !== tab) bump.play();
  }
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ youtube: null, instagram: null, facebook: null, tiktok: null, x: null });

  function onKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.key === tab);
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const key = TABS[next]!.key;
    choose(key);
    refs.current[key]?.focus();
  }

  const field = (key: keyof Captions, label: string, rows: number, single = false) => {
    const fid = `${id}-${key}`;
    return (
      <div className="field">
        <div className="field__row">
          <label className="field__label" htmlFor={fid}>
            {label}
          </label>
          <Counter value={captions[key]} limit={LIMITS[key]} id={`${fid}-c`} />
        </div>
        {single ? (
          <input
            id={fid}
            className="input"
            value={captions[key]}
            readOnly={readOnly}
            aria-describedby={`${fid}-c`}
            aria-invalid={captions[key].length > LIMITS[key] || undefined}
            onChange={(e) => onChange({ [key]: e.target.value })}
          />
        ) : (
          <textarea
            id={fid}
            className="input textarea"
            rows={rows}
            value={captions[key]}
            readOnly={readOnly}
            aria-describedby={`${fid}-c`}
            aria-invalid={captions[key].length > LIMITS[key] || undefined}
            onChange={(e) => onChange({ [key]: e.target.value })}
          />
        )}
      </div>
    );
  };

  return (
    <div className="captions">
      <div className="tabs" role="tablist" aria-label="Caption per platform" onKeyDown={onKey}>
        <Glide active=".tab.is-on" />
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`${id}-panel`}
            aria-label={t.label}
            title={t.label}
            tabIndex={tab === t.key ? 0 : -1}
            className={`tab${tab === t.key ? " is-on" : ""}`}
            data-act="toggle"
            onClick={() => choose(t.key)}
          >
            <PlatformMark platform={t.key} size={18} />
            {tab === t.key ? (
              <span className={`tab__label act act--toggle act--text is-${bump.phase}`}>
                <span className="act__item" key={bump.shot}>
                  {t.label}
                </span>
              </span>
            ) : (
              <span className="tab__label">{t.label}</span>
            )}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
        {tab === "youtube" ? (
          <>
            {field("youtubeTitle", "Title", 1, true)}
            {field("youtubeDescription", "Description", 4)}
          </>
        ) : (
          field(tab, `${TABS.find((t) => t.key === tab)!.label} caption`, tab === "x" ? 3 : 5)
        )}
      </div>
    </div>
  );
}
