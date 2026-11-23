// Drag and drop for every upload (docs/CONTRACTS.md §45.40.1, §12.5): the one hook each new drop zone uses, in Clip
// Factory and in Clips Funded alike. A zone is one element ("element": spread `bind` on it) or the whole window while
// its app is on screen ("page"). It says what a drag over it would do (`over`, drawn by components/DropOverlay.tsx),
// takes the files its check lets through and a dropped link, and refuses anything else with one short line.
//
// The highlight is counted (dragenter up, dragleave down, cleared at 0) so moving over a zone's children never makes
// it flicker; a drop, the drag ending or the pointer leaving the window clears it too. There is no idle timer: WebKit
// sends no dragover while the pointer is held still. Text dragged into a text box always lands there.
//
// Page zones never take what an element zone or Ask already took (`defaultPrevented`, or a target inside
// OWN_DROP_SELECTOR), and are off while a dialog is open or their app is hidden. Their listeners are on `document`, so
// React's own handlers (on #root) run first, and the window guard (lib/dropGuard.ts) after them.
import { useEffect, useMemo, useRef, useState, type DOMAttributes, type DragEvent as ReactDragEvent } from "react";
import { useAppActive } from "../app/shell.ts";
import { filesFrom } from "../features/help/pictures.ts";
import { isEditableTarget } from "./dropGuard.ts";
import { dragKind, dragMayHoldText, linkFrom } from "./drops.ts";

export type DropScope = "element" | "page";
export type DropOver = "file" | "link" | "either" | "busy" | null;

export interface FileDropOptions {
  /** "element": spread `bind` on the zone. "page": the whole window, while this app is on screen. */
  scope: DropScope;
  /** Files this zone takes. Return null to take the file, or the short refusal line. Leave it out and no files are taken. */
  checkFile?: (file: File) => string | null;
  /** The most files one drop gives (default 1). Extra files are refused with `tooMany`. */
  maxFiles?: number;
  tooMany?: string;
  /** Take a dropped link: a uri-list, or plain text that is one http(s) link. */
  links?: boolean;
  onFiles?: (files: File[]) => void;
  onLink?: (url: string) => void;
  /** Default true. When false the zone is off: no highlight, nothing taken, and the window guard refuses the drop. */
  enabled?: boolean;
  /** While set, a drag shows this line and the drop is refused with it. */
  busy?: string | null;
  /** The line for a dropped file when the zone takes no files, or for a drop that held nothing usable. */
  wrongThing?: string; // default "That can't go here."
}

export interface FileDrop {
  over: DropOver;
  /** The last refusal line. Cleared after 4 s or on the next dragenter. */
  refused: string | null;
  /** Goes up by one on every refusal. Used as the key that restarts the shake. */
  refusals: number;
  /** Spread on the zone element (scope "element"). For "page" these are no-ops. */
  bind: Pick<DOMAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
}

/** Page zones never handle events whose target is inside these. They have their own drops. */
export const OWN_DROP_SELECTOR = ".help-launcher, #help-panel, .mk, [data-own-drop]";

export const WRONG_THING = "That can't go here.";
/** How long the last refusal line stays (the status line a screen reader hears). */
export const REFUSED_MS = 4000;

const DRAG_TYPES = ["dragenter", "dragover", "dragleave", "drop"] as const;

/** What a drag means to a zone where the pointer is now: its highlight, "pass" (text into a box: let it through),
 * or undefined (not this zone's drag at all). */
type Verdict = Exclude<DropOver, null> | "pass" | undefined;

function verdict(data: DataTransfer | null, target: EventTarget | null, o: FileDropOptions): Verdict {
  const files = Array.from(data?.types ?? []).includes("Files");
  const kind = dragKind(data);
  const linky = kind === "link" || kind === "either" || dragMayHoldText(data);
  const takesFiles = !!o.checkFile && files;
  const takesLink = !!o.links && linky;
  if (!takesFiles && !takesLink) return undefined;
  if (!files && isEditableTarget(target)) return "pass";
  if (o.busy) return "busy";
  if (takesFiles) return takesLink && kind === "either" ? "either" : "file";
  return "link";
}

function inOwnDrop(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !!el?.closest(OWN_DROP_SELECTOR);
}

const modalOpen = () => typeof document !== "undefined" && !!document.querySelector('[aria-modal="true"]');

/** The parts of a drag event the hook reads, from a DOM event (page) or a React one (element). */
interface DragLike {
  type: string;
  dataTransfer: DataTransfer | null;
  target: EventTarget | null;
  relatedTarget: EventTarget | null;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  preventDefault(): void;
  zone?: Element | null;
}

const NO_BIND: FileDrop["bind"] = {};

export function useFileDrop(opts: FileDropOptions): FileDrop {
  const latest = useRef(opts);
  latest.current = opts;
  const [over, setOver] = useState<DropOver>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const { scope } = opts;
  const active = useAppActive();
  const on = opts.enabled !== false && (scope === "element" || active);

  // One set of handlers for the hook's whole life: they read the options of the last render.
  const core = useMemo(() => {
    let depth = 0;
    let shown: DropOver = null;
    let zone: Element | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    // Targets whose dragenter was skipped (another zone or Ask took it): their dragleave is skipped too, so the count
    // stays in step.
    let skipped = new WeakSet<EventTarget>();

    const show = (o: DropOver) => {
      if (o === shown) return;
      shown = o;
      setOver(o);
    };
    const end = () => {
      depth = 0;
      show(null);
    };
    const refuse = (line: string) => {
      setRefused(line);
      setRefusals((n) => n + 1);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setRefused(null), REFUSED_MS);
    };
    const unrefuse = () => {
      clearTimeout(clearTimer);
      setRefused(null);
    };

    /** What a drop gives the zone: the files that pass, else a link, else the refusal. */
    const take = (data: DataTransfer | null, o: FileDropOptions) => {
      if (o.busy) return refuse(o.busy);
      const wrong = o.wrongThing ?? WRONG_THING;
      const files = filesFrom(data);
      if (o.checkFile && files.length) {
        const good = files.filter((f) => o.checkFile!(f) === null);
        if (good.length) {
          const max = Math.max(1, o.maxFiles ?? 1);
          o.onFiles?.(good.slice(0, max));
          if (good.length > max && o.tooMany) refuse(o.tooMany);
          return;
        }
      }
      // A thumbnail dragged off a video page carries its picture and the page's link: the link is what was meant.
      const url = o.links ? linkFrom(data) : null;
      if (url) return o.onLink?.(url);
      if (o.checkFile && files.length) return refuse(o.checkFile(files[0]!) ?? wrong);
      refuse(wrong);
    };

    const handle = (e: DragLike, page: boolean) => {
      const o = latest.current;
      const t = e.target;
      if (e.type === "dragleave" && t && skipped.has(t)) {
        skipped.delete(t);
        return;
      }
      if (e.defaultPrevented || (page && (inOwnDrop(t) || modalOpen()))) {
        if (e.type === "dragenter" && t) skipped.add(t);
        show(null);
        return;
      }
      const v = verdict(e.dataTransfer, t, o);
      if (v === undefined) return;
      if (e.zone) zone = e.zone;
      switch (e.type) {
        case "dragenter":
          depth++;
          if (v === "pass") return show(null);
          unrefuse();
          e.preventDefault();
          return show(v);
        case "dragover":
          // The window lost track (it cleared on a leave it took for the last one): the pointer is on the zone again.
          if (depth === 0) depth = 1;
          if (v === "pass") return show(null);
          show(v);
          // Without this the drop would be refused (the window guard) or the file opened instead of taken.
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = v === "busy" ? "none" : "copy";
          return;
        case "dragleave":
          depth = Math.max(0, depth - 1);
          if (depth === 0) show(null);
          return;
        case "drop":
          end();
          if (v === "pass") return;
          e.preventDefault();
          return take(e.dataTransfer, o);
      }
    };

    /** A drop anywhere, the drag ending, the drag going into another part of the page (element zones), or leaving
     * the window (Escape fires a dragleave too) clears the highlight, even when the zone itself never heard about it. */
    const windowListeners = (page: boolean) => {
      const done = () => end();
      const entered = (e: DragEvent) => {
        if (!page && zone && !zone.contains(e.target as Node)) end();
      };
      const left = (e: DragEvent) => {
        const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight;
        if (!e.relatedTarget && outside) end();
      };
      window.addEventListener("drop", done);
      window.addEventListener("dragend", done);
      window.addEventListener("dragenter", entered);
      window.addEventListener("dragleave", left);
      return () => {
        window.removeEventListener("drop", done);
        window.removeEventListener("dragend", done);
        window.removeEventListener("dragenter", entered);
        window.removeEventListener("dragleave", left);
      };
    };

    const fromReact = (e: ReactDragEvent<HTMLElement>): DragLike => ({
      type: e.type,
      dataTransfer: e.dataTransfer,
      target: e.target,
      relatedTarget: e.relatedTarget,
      clientX: e.clientX,
      clientY: e.clientY,
      defaultPrevented: e.isDefaultPrevented() || e.nativeEvent.defaultPrevented,
      preventDefault: () => e.preventDefault(),
      zone: e.currentTarget,
    });

    const reset = () => {
      end();
      skipped = new WeakSet();
    };
    const stop = () => clearTimeout(clearTimer);

    return { handle, windowListeners, fromReact, reset, stop };
  }, []);

  // Element zones: the window listeners that clear the highlight.
  useEffect(() => {
    if (scope !== "element" || !on) return;
    const off = core.windowListeners(false);
    return () => {
      off();
      core.reset();
    };
  }, [core, scope, on]);

  // Page zones: the document's drag events, while the zone is on and its app is on screen.
  useEffect(() => {
    if (scope !== "page" || !on) return;
    const listen = (e: DragEvent) => core.handle(e, true);
    for (const type of DRAG_TYPES) document.addEventListener(type, listen);
    const off = core.windowListeners(true);
    return () => {
      for (const type of DRAG_TYPES) document.removeEventListener(type, listen);
      off();
      core.reset();
    };
  }, [core, scope, on]);

  useEffect(() => () => core.stop(), [core]);

  const bind = useMemo<FileDrop["bind"]>(() => {
    if (scope === "page") return NO_BIND;
    const react = (e: ReactDragEvent<HTMLElement>) => {
      if (latest.current.enabled === false) return;
      core.handle(core.fromReact(e), false);
    };
    return { onDragEnter: react, onDragOver: react, onDragLeave: react, onDrop: react };
  }, [core, scope]);

  return { over: on ? over : null, refused, refusals, bind };
}
