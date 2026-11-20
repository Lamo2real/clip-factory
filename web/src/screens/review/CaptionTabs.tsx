import { useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { Captions } from "../../api/types.ts";
import { Glide } from "../../components/Glide.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { useAction } from "../../lib/motion.ts";

type Tab = "youtube" | "instagram" | "facebook" | "tiktok" | "x";

const TABS: { key: Tab; label: string }[] = PLATFORM_ORDER.map((key) => ({ key, label: PLATFORM_LABEL[key] }));

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

/** A caption is longer than its platform allows. With `chosen`, only the chosen places count (§33.2). */
export function captionsTooLong(c: Captions, chosen?: readonly Tab[]): boolean {
  return (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).some((k) => c[k].length > LIMITS[k] && (!chosen || chosen.includes(TAB_OF[k])));
}

/** Which tab holds each caption (YouTube has two: title and description). */
const TAB_OF: Record<keyof typeof LIMITS, Tab> = {
  youtubeTitle: "youtube",
  youtubeDescription: "youtube",
  instagram: "instagram",
  facebook: "facebook",
  tiktok: "tiktok",
  x: "x",
};

/** The tabs with a caption longer than its platform allows, in tab order (only the chosen ones, when given). */
export function tabsTooLong(c: Captions, chosen?: readonly Tab[]): Tab[] {
  const over = new Set((Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter((k) => c[k].length > LIMITS[k]).map((k) => TAB_OF[k]));
  return TABS.map((t) => t.key).filter((k) => over.has(k) && (!chosen || chosen.includes(k)));
}

/** The platform's name for a tab ("X", "YouTube"). */
export function tabLabel(tab: Tab): string {
  return TABS.find((t) => t.key === tab)!.label;
}

export interface CaptionTabsHandle {
  /** Opens the first tab whose caption is too long, scrolls it into view and focuses it. Returns its name, or null. */
  showTooLong(): string | null;
}

/**
 * Editable captions per platform as ARIA tabs (arrow keys move between them). With `platforms`, only those places get
 * a tab (the places picked for Upload, §33.2); a place turned off keeps its caption for when it comes back.
 */
export function CaptionTabs({
  captions,
  onChange,
  readOnly = false,
  handle,
  platforms,
}: {
  captions: Captions;
  onChange: (patch: Partial<Captions>) => void;
  readOnly?: boolean;
  /** Lets Review open the too-long tab when Upload is refused. */
  handle?: Ref<CaptionTabsHandle>;
  platforms?: readonly Tab[];
}) {
  const id = useId();
  const tabs = platforms ? TABS.filter((t) => platforms.includes(t.key)) : TABS;
  const [picked, setTab] = useState<Tab>("youtube");
  // The tab being edited went away (its place was turned off): the first place left takes over.
  const tab: Tab = tabs.some((t) => t.key === picked) ? picked : (tabs[0]?.key ?? picked);
  // The newly chosen tab's name bumps (§20.11 (a) `toggle`), by tap or by arrow key.
  const bump = useAction("toggle");
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({
    youtube: null,
    instagram: null,
    facebook: null,
    tiktok: null,
    x: null,
  });
  function choose(key: Tab) {
    setTab(key);
    if (key !== tab) bump.play();
    // The strip can be wider than the card: bring the chosen tab into view.
    refs.current[key]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  const over = tabsTooLong(captions, platforms);

  useImperativeHandle(handle, () => ({
    showTooLong() {
      const first = tabsTooLong(captions, platforms)[0];
      if (!first) return null;
      choose(first);
      refs.current[first]?.focus();
      return tabLabel(first);
    },
  }));

  function onKey(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.key === tab);
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const key = tabs[next]!.key;
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

  if (!tabs.length) return null;
  return (
    <div className="captions">
      <div className="tabs" role="tablist" aria-label="Caption per platform" onKeyDown={onKey}>
        <Glide active=".tab.is-on" />
        {tabs.map((t) => {
          const tooLong = over.includes(t.key);
          return (
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
              aria-label={tooLong ? `${t.label}, too long` : t.label}
              title={tooLong ? `${t.label}: too long` : t.label}
              tabIndex={tab === t.key ? 0 : -1}
              className={`tab${tab === t.key ? " is-on" : ""}${tooLong ? " is-over" : ""}`}
              data-act="toggle"
              onClick={() => choose(t.key)}
            >
              <PlatformMark platform={t.key} size={18} />
              {/* The name shows on the open tab only; X's mark already reads "X", so its name is for screen readers
                  only (no "X X", §33.2). aria-label always carries the name. */}
              {tab === t.key && t.key !== "x" ? (
                <span className={`tab__label act act--toggle act--text is-${bump.phase}`} aria-hidden="true">
                  <span className="act__item" key={bump.shot}>
                    {t.label}
                  </span>
                </span>
              ) : null}
              {tooLong ? <span className="tab__over" aria-hidden="true" /> : null}
            </button>
          );
        })}
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
