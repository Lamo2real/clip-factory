// The app's own dropdown (never the OS list): a soft-fill button that opens a glass list of choices. Used where a
// platform's rules ask for a dropdown (TikTok's "Who can see it", §17.8) and in More details. `value` "" shows the
// placeholder: nothing is picked until the owner picks.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon.tsx";

export interface DropdownOption {
  value: string;
  label: string;
  /** One plain line under the name. */
  line?: string;
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

  function show() {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === value);
    setAt(i >= 0 ? i : 0);
    setOpen(true);
  }

  function pick(i: number) {
    const o = options[i];
    if (!o) return;
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
    const last = options.length - 1;
    if (e.key === "ArrowDown") setAt((i) => Math.min(last, i + 1));
    else if (e.key === "ArrowUp") setAt((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setAt(0);
    else if (e.key === "End") setAt(last);
    else if (e.key === "Enter" || e.key === " ") pick(at);
    else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
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
              className={`dropdown__opt${i === at ? " is-at" : ""}${o.value === value ? " is-on" : ""}`}
              onPointerEnter={() => setAt(i)}
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
