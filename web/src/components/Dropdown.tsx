// The app's own dropdown (never the OS list): a soft-fill button that opens a glass list of choices. Used where a
// platform's rules ask for a dropdown (TikTok's "Who can see it", §17.8) (and wherever a long pick-one list needs one). `value` "" shows the
// placeholder: nothing is picked until the owner picks.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon.tsx";

export interface DropdownOption {
  value: string;
  label: string;
  /** One plain line under the name. */
  line?: string;
  /** Shown greyed: it cannot be picked (the line says why). */
  disabled?: boolean;
}

export function Dropdown({
  label,
  labelledBy,
  value,
  options,
  placeholder,
  onChange,
  disabled = false,
  describedBy,
}: {
  /** Read by screen readers when there is no visible label to point at. */
  label?: string;
  /** The id of the visible label. */
  labelledBy?: string;
  value: string;
  options: DropdownOption[];
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  // The list opens above the button when there is no room for it below (the phone's tab bar, the screen's end).
  const [up, setUp] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const picked = options.find((o) => o.value === value);

  // A tap anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);

  // An opened list is all in sight: below the button when it fits above the phone's tab bar (or the screen's end),
  // else above it when it fits there, else the page scrolls it into view (html's scroll-padding keeps it clear of the
  // tab bar, base.css).
  useLayoutEffect(() => {
    if (!open) {
      setUp(false);
      return;
    }
    const el = list.current;
    const btn = button.current;
    if (!el || !btn) return;
    const box = btn.getBoundingClientRect();
    const height = el.getBoundingClientRect().height;
    // The phone's tab bar of the app on screen (fixed, so read by its box: the hidden app's bar and a wide screen's have
    // none). Each app's bottom tab bar carries data-bottom-bar, so this shared component names neither app's classes
    // (and Clips Funded's stay out of Clip Factory's main bundle, CONTRACTS §45.17).
    const bar = Array.from(document.querySelectorAll<HTMLElement>("[data-bottom-bar]"))
      .map((b) => b.getBoundingClientRect())
      .find((r) => r.height > 0);
    const barTop = bar ? bar.top : window.innerHeight;
    const bottom = Math.min(window.innerHeight, barTop) - 8;
    const top = 8;
    if (box.bottom + 6 + height <= bottom) return;
    if (box.top - 6 - height >= top) setUp(true);
    else el.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  // The choice the arrow keys move to stays in sight (a long list on a short screen). Not on opening: the list itself
  // was just put in sight.
  const moved = useRef(false);
  useEffect(() => {
    if (open && moved.current) document.getElementById(`${id}-opt-${at}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, at, id]);

  function show() {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === value && !o.disabled);
    setAt(i >= 0 ? i : Math.max(0, options.findIndex((o) => !o.disabled)));
    moved.current = false;
    setOpen(true);
  }

  /** The next choice that can be picked from `from`, going `step` (1 down, -1 up); `from` itself when there is none. */
  function next(from: number, step: number) {
    for (let i = from + step; i >= 0 && i < options.length; i += step) if (!options[i]!.disabled) return i;
    return from;
  }

  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    button.current?.focus();
  }

  function onButtonKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  }

  function onListKey(e: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) moved.current = true;
    if (e.key === "ArrowDown") setAt((i) => next(i, 1));
    else if (e.key === "ArrowUp") setAt((i) => next(i, -1));
    else if (e.key === "Home") setAt((i) => (next(-1, 1) < 0 ? i : next(-1, 1)));
    else if (e.key === "End") setAt((i) => (next(options.length, -1) >= options.length ? i : next(options.length, -1)));
    else if (e.key === "Enter" || e.key === " ") pick(at);
    else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") {
      // The list unmounts: put focus back on the button first, so Tab moves on from it and never falls to the page.
      setOpen(false);
      button.current?.focus();
      return;
    } else return;
    e.preventDefault();
  }

  return (
    <div className={`dropdown${open ? " is-open" : ""}`} ref={root}>
      <button
        ref={button}
        type="button"
        id={`${id}-button`}
        className={`dropdown__button${picked ? " is-picked" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}-button` : undefined}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        data-help-dodge=""
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onButtonKey}
      >
        <span className={`dropdown__value${picked ? "" : " is-empty"}`}>{picked ? picked.label : placeholder}</span>
        <Icon name="chevronDown" size={18} className="icon dropdown__chev" />
      </button>
      {open ? (
        <ul
          ref={list}
          id={`${id}-list`}
          className="dropdown__list"
          style={up ? { top: "auto", bottom: "calc(100% + 6px)" } : undefined}
          data-up={up || undefined}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : label}
          aria-activedescendant={`${id}-opt-${at}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`dropdown__opt${i === at ? " is-at" : ""}${o.value === value ? " is-on" : ""}${o.disabled ? " is-disabled" : ""}`}
              onPointerEnter={() => !o.disabled && setAt(i)}
              onClick={() => pick(i)}
            >
              <span className="dropdown__text">
                <span className="dropdown__name">{o.label}</span>
                {o.line ? <span className="dropdown__line">{o.line}</span> : null}
              </span>
              {o.value === value ? <Icon name="check" size={18} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
