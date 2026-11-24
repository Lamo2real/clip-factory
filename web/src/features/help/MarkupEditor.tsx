// The picture markup editor (docs/CONTRACTS.md §28.8): draw red marks on a picture before it goes to Ask (pen, box,
// arrow), undo, redo, clear, then Save: the marked picture replaces the tray picture and the original never leaves the
// device. Mouse, trackpad, touch and pencil draw with one pointer; two fingers zoom and pan; a finger pans while a
// pencil is in use. Fully usable from the keyboard (arrow keys move a crosshair, Enter starts and ends a mark).
// Modal on every screen: full-screen on phones with Save and Undo at the bottom right, a glass dialog elsewhere.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { Glide } from "../../components/Glide.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { useMedia } from "../../lib/hooks.ts";
import { getPrefs, prefersReducedMotion } from "../../lib/prefs.ts";
import { sounds } from "../../lib/sounds.ts";
import {
  addPoint,
  addStroke,
  clearMarks,
  drawMarks,
  emptyMarks,
  flatten,
  inkWidth,
  marksText,
  moveCursor,
  pointerRole,
  redoMarks,
  toPicture,
  TOOL_HELP,
  undoMarks,
  zoomAt,
  type Marks,
  type Point,
  type Stroke,
  type Tool,
  type View,
} from "./markup.ts";

export interface MarkupSource {
  /** The picture to draw on (the original when it was marked before). */
  url: string;
  blob: Blob;
  width: number;
  height: number;
  /** Marks from an earlier Save, editable again until the question is sent. */
  strokes?: Stroke[];
  label: string;
}

export interface MarkupResult {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  strokes: Stroke[];
}

const TOOLS: { id: Tool; name: string; icon: IconName; key: string }[] = [
  { id: "pen", name: "Pen", icon: "pen", key: "p" },
  { id: "box", name: "Box", icon: "box", key: "b" },
  { id: "arrow", name: "Arrow", icon: "arrow", key: "a" },
];

const THROW_AWAY = "Throw away your marks?";

export function MarkupEditor({ source, onSave, onCancel }: { source: MarkupSource; onSave: (r: MarkupResult) => void; onCancel: () => void }) {
  const titleId = useId();
  const helpId = useId();
  const phone = useMedia("(max-width: 767px)");
  const desktop = useMedia("(min-width: 1024px)");
  const [tool, setTool] = useState<Tool>("pen");
  const [marks, setMarks] = useState<Marks>(() => emptyMarks(source.strokes ?? []));
  const [live, setLive] = useState<Stroke | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [keyDrawing, setKeyDrawing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [news, setNews] = useState(TOOL_HELP.pen);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const self = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const pinch = useRef<{ dist: number; mid: Point; view: View } | null>(null);
  const penSeen = useRef(false);
  const drawingPointer = useRef<number | null>(null);
  const reduced = prefersReducedMotion() || getPrefs().reduceMotion;

  // The picture.
  useEffect(() => {
    const img = new Image();
    img.decoding = "async";
    img.src = source.url;
    let alive = true;
    void img.decode().then(
      () => alive && setImage(img),
      () => alive && setImage(img),
    );
    return () => {
      alive = false;
    };
  }, [source.url]);

  // The stage's size (the picture is fitted inside it).
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Modal: everything else on the page is inert while the editor is open; focus starts on the tools.
  useEffect(() => {
    const root = self.current;
    if (!root) return;
    const changed = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.contains(root) && !el.hasAttribute("inert") && !el.matches("script, style"));
    for (const el of changed) el.setAttribute("inert", "");
    root.querySelector<HTMLElement>(".mk-tool.is-on")?.focus({ preventScroll: true });
    return () => {
      for (const el of changed) el.removeAttribute("inert");
    };
  }, []);

  // The page under the editor rests while it is open (ask.css, html.mk-open): no blur and no endless loop of its own,
  // so a frame of drawing blurs only the dialog. A layout effect, so the page has its glass back in the frame the
  // editor goes.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("mk-open");
    return () => html.classList.remove("mk-open");
  }, []);

  const fit = box.w && box.h ? Math.min(box.w / source.width, box.h / source.height) : 1;
  const drawW = source.width * fit;
  const drawH = source.height * fit;
  const offX = (box.w - drawW) / 2;
  const offY = (box.h - drawH) / 2;
  const width = inkWidth(source.width, source.height);

  // Draws the picture, the marks, the mark being drawn and the keyboard crosshair.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !box.w) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.save();
    ctx.translate(offX + view.x, offY + view.y);
    ctx.scale(view.zoom * fit, view.zoom * fit);
    if (image) ctx.drawImage(image, 0, 0, source.width, source.height);
    drawMarks(ctx, live ? [...marks.strokes, live] : marks.strokes);
    if (cursor) {
      const r = 14 / (view.zoom * fit);
      ctx.lineWidth = 2 / (view.zoom * fit);
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.moveTo(cursor.x - r, cursor.y);
      ctx.lineTo(cursor.x + r, cursor.y);
      ctx.moveTo(cursor.x, cursor.y - r);
      ctx.lineTo(cursor.x, cursor.y + r);
      ctx.stroke();
      ctx.lineWidth = 1 / (view.zoom * fit);
      ctx.strokeStyle = "#111111";
      ctx.stroke();
    }
    ctx.restore();
  }, [image, marks, live, view, cursor, box, fit, offX, offY, source.width, source.height]);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pic = (p: Point): Point => {
    const q = toPicture({ x: p.x - offX, y: p.y - offY }, view, fit);
    return { x: Math.min(source.width, Math.max(0, q.x)), y: Math.min(source.height, Math.max(0, q.y)) };
  };

  const commit = useCallback((s: Stroke | null) => {
    setLive(null);
    if (!s) return;
    if (s.tool !== "pen" && Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) < 3) return;
    setMarks((m) => {
      const next = addStroke(m, s);
      setNews(marksText(next.strokes.length));
      return next;
    });
  }, []);

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer was already released (a very fast tap): the stroke still starts */
    }
    setCursor(null);
    if (e.pointerType === "pen") penSeen.current = true;
    const p = local(e);
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType });
    const touches = Array.from(pointers.current.values()).filter((x) => x.type === "touch").length;
    const role = pointerRole(e.pointerType, touches, penSeen.current);
    if (role === "pinch") {
      // A second finger: no stroke, zoom and pan instead.
      setLive(null);
      drawingPointer.current = null;
      const [a, b] = Array.from(pointers.current.values()).filter((x) => x.type === "touch");
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
      return;
    }
    if (role === "pan") return;
    drawingPointer.current = e.pointerId;
    const at = pic(p);
    const w = inkWidth(source.width, source.height, e.pointerType, e.pressure);
    setLive(tool === "pen" ? { tool: "pen", points: [at], width: w } : { tool, from: at, to: at, width: w });
  }

  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType });
    if (pinch.current) {
      const [a, b] = Array.from(pointers.current.values()).filter((x) => x.type === "touch");
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const start = pinch.current;
      const z = zoomAt(start.view, dist / Math.max(1, start.dist), { x: start.mid.x - offX, y: start.mid.y - offY });
      setView({ ...z, x: z.x + (mid.x - start.mid.x), y: z.y + (mid.y - start.mid.y) });
      return;
    }
    if (drawingPointer.current !== e.pointerId) {
      if (e.pointerType === "touch" && penSeen.current) setView((v) => ({ ...v, x: v.x + (p.x - prev.x), y: v.y + (p.y - prev.y) }));
      return;
    }
    const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const pts = (events.length ? events : [e.nativeEvent]).map((ev) => pic(local(ev)));
    setLive((s) => {
      if (!s) return s;
      if (s.tool === "pen") {
        let points = s.points;
        for (const q of pts) points = addPoint(points, q);
        return points === s.points ? s : { ...s, points };
      }
      return { ...s, to: pts[pts.length - 1]! };
    });
  }

  function up(e: ReactPointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (Array.from(pointers.current.values()).filter((x) => x.type === "touch").length < 2) pinch.current = null;
      return;
    }
    if (drawingPointer.current === e.pointerId) {
      drawingPointer.current = null;
      setLive((s) => {
        commit(s);
        return null;
      });
    }
  }

  // A wheel or trackpad pinch (ctrl+wheel in Chromium) zooms the picture, never the page: the listener is native
  // and not passive so preventDefault works (React's onWheel is passive). Safari's gesture events are stopped too.
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  wheel.current = (e: WheelEvent) => {
    const p = local(e);
    setView((v) => zoomAt(v, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), { x: p.x - offX, y: p.y - offY }));
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel.current(e);
    };
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stopGesture);
    el.addEventListener("gesturechange", stopGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stopGesture);
      el.removeEventListener("gesturechange", stopGesture);
    };
  }, []);

  // The keyboard: arrow keys move the crosshair, Enter starts and ends a mark.
  function canvasKeys(e: ReactKeyboardEvent<HTMLCanvasElement>) {
    const at = cursor ?? { x: source.width / 2, y: source.height / 2 };
    const moved = moveCursor(at, e.key, e.shiftKey, source.width, source.height);
    if (moved) {
      e.preventDefault();
      setCursor(moved);
      if (keyDrawing)
        setLive((s) => (!s ? s : s.tool === "pen" ? { ...s, points: addPoint(s.points, moved) } : { ...s, to: moved }));
      return;
    }
    if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!cursor) setCursor(at);
      if (!keyDrawing) {
        setKeyDrawing(true);
        setLive(tool === "pen" ? { tool: "pen", points: [at], width } : { tool, from: at, to: at, width });
        setNews(tool === "pen" ? "Drawing. Move with the arrow keys, Enter to finish." : "Move to the other corner with the arrow keys, Enter to finish.");
      } else {
        setKeyDrawing(false);
        commit(live);
      }
    }
  }

  function pickTool(t: Tool) {
    setTool(t);
    setNews(TOOL_HELP[t]);
  }

  const undo = () => setMarks((m) => undoMarks(m));
  const redo = () => setMarks((m) => redoMarks(m));
  const clear = () => {
    setMarks((m) => clearMarks(m));
    setNews("Marks cleared. Undo brings them back.");
  };

  function cancel() {
    if (marks.strokes.length && marks.undo.length && !confirm) {
      setConfirm(true);
      return;
    }
    onCancel();
  }

  async function save() {
    if (saving || !image) return;
    setSaving(true);
    try {
      const blob = await flatten(image, source.width, source.height, marks.strokes);
      if (!blob) {
        sounds.play("deny");
        setNews("That picture is too big to save. Try fewer marks.");
        return;
      }
      onSave({ blob, url: URL.createObjectURL(blob), width: source.width, height: source.height, strokes: marks.strokes });
    } finally {
      setSaving(false);
    }
  }

  function keys(e: ReactKeyboardEvent<HTMLDivElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (confirm) return setConfirm(false);
      return cancel();
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      return void save();
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) pickTool(t.id);
    // Tab stays inside the editor.
    if (e.key === "Tab" && self.current) {
      const all = Array.from(self.current.querySelectorAll<HTMLElement>('button:not([disabled]), canvas, [tabindex="0"]'));
      const first = all[0];
      const last = all[all.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
    }
  }

  // Escape also works when focus left the editor (a button that just went away): never a dead key.
  const escape = useRef<() => void>(() => undefined);
  escape.current = () => (confirm ? setConfirm(false) : cancel());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || self.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      escape.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Long-press on Undo (phones): Redo.
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longDone = useRef(false);

  // A real radio group: one Tab stop (the chosen tool), arrow keys move and choose (WAI-ARIA radio pattern).
  function toolKeys(e: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? TOOLS.length - 1 : step ? (index + step + TOOLS.length) % TOOLS.length : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    pickTool(TOOLS[to]!.id);
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".mk-tool");
    buttons?.[to]?.focus();
  }

  const toolbar = (
    <div className="mk-tools" role="radiogroup" aria-label="Marking tool">
      <Glide active=".mk-tool.is-on" className="mk-tools__glide" />
      {TOOLS.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={tool === t.id}
          tabIndex={tool === t.id ? 0 : -1}
          className={`mk-tool${tool === t.id ? " is-on" : ""}`}
          aria-keyshortcuts={t.key.toUpperCase()}
          onClick={(e) => {
            pickTool(t.id);
            // The chosen tool becomes the group's one Tab stop: keep focus on it (WebKit never focuses a clicked
            // button, and the old one just left the Tab order), so focus never falls out of the dialog.
            e.currentTarget.focus({ preventScroll: true });
          }}
          onKeyDown={(e) => toolKeys(e, i)}
        >
          <Icon name={t.icon} size={22} />
          <span className="mk-tool__name">{t.name}</span>
        </button>
      ))}
    </div>
  );

  // The editor sits in a portal inside the panel's React tree: paste and drops here must not reach the panel and add
  // files to the tray hidden behind it. Dropping on the editor does nothing (and never opens the file).
  const swallow = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const swallowDrag = (e: ReactDragEvent) => {
    swallow(e);
    e.dataTransfer.dropEffect = "none";
  };

  const canUndo = marks.undo.length > 0;
  const canRedo = marks.redo.length > 0;
  const body = (
    <div className={`mk${phone ? " is-phone" : desktop ? " is-desktop" : " is-tablet"}${reduced ? " is-reduced" : ""}`}>
      <div
        ref={self}
        className="mk__dialog glass glass--strong"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={helpId}
        onKeyDown={keys}
        onPaste={swallow}
        onDragEnter={swallow}
        onDragOver={swallowDrag}
        onDrop={swallow}
      >
        <header className="mk__head">
          <h2 className="mk__title" id={titleId}>
            Mark {source.label}
          </h2>
          <p className="mk__hint" id={helpId}>
            Draw red on what you mean.
          </p>
        </header>
        {/* Tab order: tools, picture, Undo, Clear, Cancel, Save. The grid puts the tools and the actions in the bottom
            bar and the picture above them. */}
        {toolbar}
        <div className="mk__stage" ref={stage}>
          <canvas
            ref={canvas}
            className="mk__canvas"
            tabIndex={0}
            role="application"
            aria-roledescription="drawing area"
            aria-label={`${source.label} with ${marks.strokes.length} ${marks.strokes.length === 1 ? "mark" : "marks"}. Arrow keys move the crosshair, Enter starts and ends a mark.`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={() => setView({ zoom: 1, x: 0, y: 0 })}
            onKeyDown={canvasKeys}
            onFocus={(e) => {
              if (e.currentTarget.matches(":focus-visible") && !cursor) setCursor({ x: source.width / 2, y: source.height / 2 });
            }}
            onBlur={() => {
              if (keyDrawing) {
                setKeyDrawing(false);
                commit(live);
              }
            }}
          />
        </div>
        {confirm ? (
          <div className="mk__confirm" role="alertdialog" aria-label={THROW_AWAY}>
            <p>{THROW_AWAY}</p>
            <div className="mk__confirm-row">
              <Button
                size="sm"
                variant="glass"
                icon="pen"
                autoFocus
                onClick={() => {
                  setConfirm(false);
                  requestAnimationFrame(() => canvas.current?.focus({ preventScroll: true }));
                }}
              >
                Keep marking
              </Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={onCancel}>
                Throw away
              </Button>
            </div>
          </div>
        ) : null}
        <div className="mk__actions">
          <button
            type="button"
            className="mk-btn"
            aria-label={phone ? "Undo (hold for Redo)" : "Undo"}
            aria-keyshortcuts="Meta+Z Control+Z"
            aria-disabled={!canUndo || undefined}
            onPointerDown={() => {
              if (!phone) return;
              longDone.current = false;
              press.current = setTimeout(() => {
                longDone.current = true;
                redo();
              }, 550);
            }}
            onPointerUp={() => clearTimeout(press.current)}
            onPointerLeave={() => clearTimeout(press.current)}
            onPointerCancel={() => clearTimeout(press.current)}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (longDone.current) return void (longDone.current = false);
              if (canUndo) undo();
            }}
          >
            <Icon name="undo" size={22} />
            <span className="mk-btn__word">Undo</span>
          </button>
          {!phone ? (
            <button type="button" className="mk-btn" aria-label="Redo" aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z" aria-disabled={!canRedo || undefined} onClick={() => canRedo && redo()}>
              <Icon name="redo" size={22} />
              <span className="mk-btn__word">Redo</span>
            </button>
          ) : null}
          <button type="button" className="mk-btn" aria-disabled={!marks.strokes.length || undefined} onClick={() => marks.strokes.length && clear()}>
            <Icon name="trash" size={22} />
            <span className="mk-btn__word">Clear</span>
          </button>
          {/* Phones: the × at the top right. Tablets: the × in the bar, so Redo fits and Undo stays in the right half. */}
          {!desktop ? (
            <button type="button" className="icon-btn mk__close" aria-label="Cancel" onClick={cancel}>
              <Icon name="x" />
            </button>
          ) : (
            <Button size="md" variant="glass" icon="x" className="mk__cancel" onClick={cancel}>
              Cancel
            </Button>
          )}
          <Button size={phone ? "lg" : "md"} variant="primary" icon="check" className="mk__save" loading={saving} onClick={() => void save()} aria-keyshortcuts="Meta+Enter Control+Enter">
            Save
          </Button>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {news}
        </span>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
