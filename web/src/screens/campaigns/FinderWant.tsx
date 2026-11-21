// What you want (docs/CONTRACTS.md §41.1): the owner's requirements for the campaign finder, set once. Open the first
// time and after "Change"; else one summary line. Every change saves at once (the page debounces the PATCH); a glass
// "Done" folds it. Never started, its vermilion "Find campaigns for me" sends the first PATCH (or, with no place set
// up, "Set up YouTube"). Pick-one rows are <Glide> bars (Segmented); many-choice rows are toggle chips.
import { useId, type ReactNode } from "react";
import type { Finder, FinderLanguage, FinderWant, Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, Button, LinkButton, Segmented, Toggle } from "../../components/ui.tsx";
import { TIKTOK_NOT_YET } from "../../lib/contentRewards.ts";
import {
  ACCESS_CHOICES,
  LANGUAGE_CHOICES,
  LEFT_CHOICES,
  NO_PLACE_LINE,
  PAY_CHOICES,
  pickedPlaces,
  setupPlaceHref,
  toggleIn,
  togglePlace,
  wantPlaces,
  wantSummary,
} from "../../lib/finder.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";

export const SKIP_LINE = "I skip campaigns Clip Factory can't make clips for, like ones that need their own sound or picture on the video.";
export const NEWS_OFF = "Content Rewards news is off in Settings.";

function Row({ label, line, children, id }: { label: string; line?: string; children: ReactNode; id: string }) {
  return (
    <div className="finder-want__row" role="group" aria-labelledby={`${id}-label`}>
      <p className="finder-want__label" id={`${id}-label`}>
        {label}
        {line ? <span className="finder-want__line">{line}</span> : null}
      </p>
      {children}
    </div>
  );
}

function Chip({ on, disabled, describedBy, onToggle, children }: { on: boolean; disabled?: boolean; describedBy?: string; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`check-chip upload-chip finder-chip${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!disabled) onToggle();
      }}
    >
      {children}
      <span className={`upload-chip__check${on ? " is-on" : ""}`} aria-hidden="true">
        {on ? <Icon name="check" size={16} /> : null}
      </span>
    </button>
  );
}

export function FinderWant({
  finder,
  want,
  ready,
  open,
  fresh,
  noPlace,
  setUpFirst,
  main,
  pinned,
  newsOff,
  starting,
  onChange,
  onOpen,
  onDone,
  onStart,
  onKeepOne,
  hideChange = false,
}: {
  finder: Finder;
  /** The want as it shows now (the store's copy with the changes not saved yet over it). */
  want: FinderWant;
  /** The places a chip can be on for (set up, TikTok once its audit passed). */
  ready: Platform[];
  open: boolean;
  /** Never started: the changes wait for "Find campaigns for me". */
  fresh: boolean;
  noPlace: boolean;
  /** The place the no-place vermilion sets up. */
  setUpFirst: Platform;
  /** This card holds the screen's vermilion. */
  main: boolean;
  pinned: boolean;
  newsOff: boolean;
  starting: boolean;
  onChange: (patch: Partial<FinderWant>) => void;
  onOpen: () => void;
  onDone: () => void;
  onStart: () => unknown;
  onKeepOne: () => void;
  /** The state box above already shows "Change what you want" (no match): the folded card's Change would be a twin. */
  hideChange?: boolean;
}) {
  const id = useId();
  const picked = pickedPlaces(want, ready);
  const notSetUp = PLATFORM_ORDER.filter((p) => p !== "tiktok" && !ready.includes(p));
  const tiktokWaits = finder.tiktokWaits;
  // No place but TikTok is ready: "Set up a place" (there is no other one yet).
  const noneReady = !ready.some((p) => p !== "tiktok");

  if (!open)
    return (
      <section className="finder-want finder-want--folded glass" id="want" data-help="cr-finder-want" aria-labelledby={`${id}-title`}>
        <div className="finder-want__fold">
          <h2 className="cr-section__title" id={`${id}-title`}>
            What you want
          </h2>
          <p className="finder-want__summary">{wantSummary(want, finder.resolvedPlaces, finder.categories)}</p>
        </div>
        {hideChange ? null : (
          <Button variant="glass" icon="sliders" onClick={onOpen}>
            Change
          </Button>
        )}
      </section>
    );

  const mainEl = fresh ? (
    noPlace ? (
      <LinkButton href={setupPlaceHref(setUpFirst)} variant={main ? "primary" : "glass"} size="lg" icon="link" data-help-clear={main ? "" : undefined}>
        Set up {PLATFORM_LABEL[setUpFirst]}
      </LinkButton>
    ) : (
      <Button variant={main ? "primary" : "glass"} size="lg" icon="search" loading={starting} data-help-clear={main ? "" : undefined} onClick={onStart}>
        Find campaigns for me
      </Button>
    )
  ) : null;

  const toggle = (p: Platform) => {
    const kept = togglePlace(picked, p, ready);
    if (!kept) return onKeepOne();
    onChange({ places: wantPlaces(kept, ready) });
  };

  return (
    <section className={`finder-want glass${pinned && mainEl ? " has-pin" : ""}`} id="want" data-help="cr-finder-want" aria-labelledby={`${id}-title`}>
      <h2 className="cr-section__title" id={`${id}-title`}>
        What you want
      </h2>
      {fresh && noPlace ? (
        <p className="finder-want__noplace">
          <Icon name="info" size={20} />
          <span>{NO_PLACE_LINE}</span>
        </p>
      ) : null}

      <Row label="Pays at least" line="for every 1,000 views" id={`${id}-pay`}>
        <Segmented
          label="Pays at least"
          value={String(want.minPer1kCents)}
          options={PAY_CHOICES.map((c) => ({ value: String(c.value), label: c.label }))}
          onChange={(v) => onChange({ minPer1kCents: Number(v) as FinderWant["minPer1kCents"] })}
        />
      </Row>

      <Row label="Where you post" line={want.places === null ? "The places you set up." : undefined} id={`${id}-places`}>
        <ul className="finder-chips" aria-label="Where you post">
          {PLATFORM_ORDER.map((p) => {
            const waits = p === "tiktok" && tiktokWaits;
            const off = waits || !ready.includes(p);
            return (
              <li key={p} className="finder-chip-wrap">
                <Chip on={!off && picked.includes(p)} disabled={off} describedBy={off && !waits && !noPlace ? `${id}-first` : undefined} onToggle={() => toggle(p)}>
                  <PlatformMark platform={p} size={18} />
                  <span className={p === "x" ? "sr-only" : undefined}>{PLATFORM_LABEL[p]}</span>
                </Chip>
              </li>
            );
          })}
        </ul>
        {/* Once under the row (the no-place line above already says it when nothing is set up). */}
        {notSetUp.length && !noPlace ? (
          <p className="finder-want__note" id={`${id}-first`}>
            Set it up first.
          </p>
        ) : null}
        {tiktokWaits ? <p className="finder-want__note">{TIKTOK_NOT_YET}</p> : null}
        {notSetUp.length ? (
          // A place's own setup page reads `?back=`, so "Back to Find campaigns" shows there (§41.6 change 7).
          <A href={setupPlaceHref(notSetUp[0]!)} className="text-link finder-want__more">
            {noneReady ? "Set up a place" : "Set up another place"}
          </A>
        ) : null}
      </Row>

      <Row label="Money left" id={`${id}-left`}>
        <Segmented
          label="Money left"
          value={String(want.minLeftPct)}
          options={LEFT_CHOICES.map((c) => ({ value: String(c.value), label: c.label }))}
          onChange={(v) => onChange({ minLeftPct: Number(v) as FinderWant["minLeftPct"] })}
        />
      </Row>

      <Row label="Who can join" id={`${id}-access`}>
        <Segmented label="Who can join" value={want.access} options={ACCESS_CHOICES} onChange={(v) => onChange({ access: v })} />
      </Row>

      <Row label="What it's about" id={`${id}-topic`}>
        <ul className="finder-chips" aria-label="What it's about">
          <li className="finder-chip-wrap">
            <Chip on={!want.categories.length} onToggle={() => onChange({ categories: [] })}>
              <span>Anything</span>
            </Chip>
          </li>
          {finder.categories.slice(0, 12).map((c) => (
            <li key={c.id} className="finder-chip-wrap">
              <Chip on={want.categories.includes(c.id)} onToggle={() => onChange({ categories: toggleIn(want.categories, c.id).slice(0, 12) })}>
                <span className="user-text">{c.name.slice(0, 40)}</span>
              </Chip>
            </li>
          ))}
        </ul>
      </Row>

      <Row label="Language" id={`${id}-lang`}>
        <ul className="finder-chips" aria-label="Language">
          <li className="finder-chip-wrap">
            <Chip on={!want.languages.length} onToggle={() => onChange({ languages: [] })}>
              <span>Any</span>
            </Chip>
          </li>
          {LANGUAGE_CHOICES.map((l) => (
            <li key={l.value} className="finder-chip-wrap">
              <Chip on={want.languages.includes(l.value)} onToggle={() => onChange({ languages: toggleIn<FinderLanguage>(want.languages, l.value) })}>
                <span>{l.label}</span>
              </Chip>
            </li>
          ))}
        </ul>
      </Row>

      <div className="finder-want__switches">
        <Toggle label="Other kinds of pay" description="Also show campaigns that pay per post or share a prize." checked={want.otherPay} onChange={(v) => onChange({ otherPay: v })} />
        <Toggle label="Tell me about new ones" description="At most once a day." checked={want.tellMe} onChange={(v) => onChange({ tellMe: v })} />
        {newsOff && want.tellMe ? <p className="finder-want__note">{NEWS_OFF}</p> : null}
      </div>

      <p className="finder-want__skip">
        <Icon name="info" size={18} />
        <span>{SKIP_LINE}</span>
      </p>

      {mainEl ? (
        <div className={pinned ? "finder-want__main cr-pin" : "finder-want__main"}>{mainEl}</div>
      ) : (
        <div className="finder-want__main">
          <Button variant="glass" icon="check" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </section>
  );
}
