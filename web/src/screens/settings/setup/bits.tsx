// Small pieces the setup steps share: words with the platform's own button names in bold, Copy chips, and the
// clipboard helpers (which work without clipboard permission through a select-and-copy fallback).
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../../components/Icon.tsx";

/** "Press **Create**." with the platform's button names in bold, exactly as on the platform. */
export function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>));
}

/** Copies text. Tries the Clipboard API, then a hidden select-all + copy, which needs no permission. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.inset = "0 auto auto 0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Reads what the owner copied, or null when the browser does not allow it (they then paste by hand). */
export async function readClipboard(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** A label and a value in mono, with one big Copy button. Shows a sage "Copied!" for a moment. */
export function CopyChip({ label, value }: { label: string; value: string | null }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const valueRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    if (value === null) return;
    const ok = await copyText(value);
    if (!ok && valueRef.current) {
      // Last resort: select the words so the owner can copy them by hand.
      const range = document.createRange();
      range.selectNodeContents(valueRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2400);
  }

  return (
    <div className={`copy-chip${state === "copied" ? " is-copied" : ""}`}>
      <span className="copy-chip__text">
        <span className="copy-chip__label">{label}</span>
        <code className="copy-chip__value" ref={valueRef}>
          {value ?? "Loading…"}
        </code>
      </span>
      <button
        type="button"
        className="copy-chip__btn"
        onClick={() => void copy()}
        aria-disabled={value === null || undefined}
        aria-label={state === "copied" ? `${label} copied` : `Copy ${label}`}
      >
        <Icon name={state === "copied" ? "check" : "copy"} size={18} />
        <span aria-live="polite">{state === "copied" ? "Copied!" : state === "failed" ? "Selected: copy it" : "Copy"}</span>
      </button>
    </div>
  );
}
