// "Edit for campaign" (docs/CONTRACTS.md §53 C2, C3, C6 and §54 L1 to L3): a glass sheet over the Review card. The clip's
// cover is the 9:16 preview; up to four pictures and one line of words sit on it where the owner drags them (or taps a
// corner), and Make it sends the edit. A row of chips under the preview lists them: the chosen chip is the one the
// corners, Size, drag and When change. Only pictures and text, nothing else. One short warning line when the chosen one
// covers the captions or the facecam (the areas are the renderer's own, lib/overlayAreas.ts).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Logo, OverlayBody, OverlayTextSize } from "../../api/types.ts";
import { Glide } from "../../components/Glide.tsx";
import { DropOverlay } from "../../components/DropOverlay.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Segmented } from "../../components/ui.tsx";
import { useCr } from "../../lib/contentRewards.ts";
import { L, layerBoxes, layersOf, MAX_LAYERS, newLayerId, settle, timingOf, whenOf, type Layer, type Pos, type When } from "../../lib/crLayers.ts";
import {
  bodyProblem,
  LOGO_SIZE_DEFAULT,
  LOGO_SIZE_MAX,
  LOGO_SIZE_MIN,
  logoRefusal,
  pastedPictures,
  TEXT_MAX,
  W,
  withHashtags,
} from "../../lib/crOverlay.ts";
import {
  areasOf,
  CORNER_LABEL,
  CORNERS,
  cornerCentre,
  FRAME_W,
  keepInside,
  logoBox,
  overlapWarning,
  textBox,
  textPx,
  type Box,
  type Corner,
} from "../../lib/overlayAreas.ts";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import { LogoLibrary, useLogos } from "./LogoLibrary.tsx";

/** What is chosen (the chip): a picture's layerId, or the words. */
const TEXT = "text";

const TEXT_SIZES: { value: OverlayTextSize; label: string }[] = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
];
const round = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function CampaignEdit({ clip, onClose, onClip, onMade }: { clip: Clip; onClose: () => void; onClip: (c: Clip) => void; onMade: (c: Clip) => void }) {
  const id = useId();
  const toast = useToast();
  const dialog = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  const cr = useCr();
  const before = clip.overlay;

  // The pictures (layers, §54: a §53 edit with one logo reads as one layer), the words, and which chip is chosen.
  const [layers, setLayers] = useState<Layer[]>(() => layersOf(before, clip.durationSec));
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const [chosen, setChosen] = useState<string | null>(() => layersOf(before, clip.durationSec)[0]?.layerId ?? (before?.text ? TEXT : null));
  const [text, setText] = useState(before?.text?.text ?? "");
  const [textPos, setTextPos] = useState<Pos | null>(before?.text ? { x: before.text.x, y: before.text.y } : null);
  const [textSize, setTextSize] = useState<OverlayTextSize>(before?.text?.size ?? "m");
  const [textWhen, setTextWhen] = useState<When>(() => whenOf(before?.timing, clip.durationSec));
  const [campaignId, setCampaignId] = useState(clip.cr?.campaignId ?? "");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"make" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Another copy of this logo joins the clip as the chosen picture (L1). At the cap it adds nothing. */
  function addLayer(logoId: string) {
    const layerId = newLayerId();
    setLayers((ls) => (ls.length >= MAX_LAYERS ? ls : [...ls, { layerId, logoId, pos: null, size: LOGO_SIZE_DEFAULT, when: whenOf(undefined, clip.durationSec) }]));
    setChosen(layerId);
  }
  const lib = useLogos({ onAdded: (l) => addLayer(l.logoId) });
  const known = useMemo(() => new Map((lib.logos ?? []).map((l) => [l.logoId, l])), [lib.logos]);
  // A picture whose logo is no longer in the library (deleted since) is not drawn; the edit keeps the copy it already has.
  useEffect(() => {
    if (lib.logos === null) return;
    setLayers((ls) => (ls.every((l) => known.has(l.logoId)) ? ls : ls.filter((l) => known.has(l.logoId))));
  }, [lib.logos, known]);
  const shown = layers.filter((l) => known.has(l.logoId));
  const full = shown.length >= MAX_LAYERS;
  const hasText = text.trim().length > 0;
  // The chosen chip: a picture that is still there, else the words, else the first picture.
  const first = shown[0]?.layerId ?? (hasText ? TEXT : null);
  const pick = chosen === TEXT ? (hasText ? TEXT : first) : shown.some((l) => l.layerId === chosen) ? chosen : first;
  const pickedLayer = shown.find((l) => l.layerId === pick) ?? null;

  // ---------- The boxes, in fractions of the frame ----------
  const logoOf = (l: Layer): Logo => known.get(l.logoId)!;
  const lBoxes = layerBoxes(shown.map((l) => ({ pos: l.pos, size: l.size, width: logoOf(l).width, height: logoOf(l).height })));
  const tSized = textBox(0.5, 0.5, text.trim() || " ", textSize);
  // Until it is moved, the words start at the top left, under any picture that is there.
  const tBox: Box = textPos ? { ...tSized, ...keepInside(textPos.x, textPos.y, tSized.w, tSized.h) } : settle(tSized, "tl", lBoxes);
  const campaignClip = !!clip.campaignId;
  const warns = lBoxes.map((b) => overlapWarning(b, clip.layout, campaignClip));
  const textWarn = hasText ? overlapWarning(tBox, clip.layout, campaignClip) : null;
  // The one line is for the chosen one (L2); every covered one shows its own vermilion (the box in the preview, a dot on its chip).
  const warning = pick === TEXT ? textWarn : pickedLayer ? (warns[shown.indexOf(pickedLayer)] ?? null) : null;
  const areas = areasOf(clip.layout, campaignClip);

  /** The chosen layer's numbers change; the words' are their own state. */
  const patchLayer = (layerId: string, patch: Partial<Layer>) => setLayers((ls) => ls.map((l) => (l.layerId === layerId ? { ...l, ...patch } : l)));
  const setPos = (which: string, at: Pos) => (which === TEXT ? setTextPos(at) : patchLayer(which, { pos: at }));
  const boxOf = (which: string): Box | null => (which === TEXT ? tBox : (lBoxes[shown.findIndex((l) => l.layerId === which)] ?? null));

  // ---------- Dragging ----------
  const drag = useRef<{ which: string; px: number; py: number; at: Pos; box: Box } | null>(null);
  function down(which: string, e: ReactPointerEvent<HTMLElement>) {
    const box = boxOf(which);
    if (!box) return;
    setChosen(which);
    drag.current = { which, px: e.clientX, py: e.clientY, at: { x: box.x, y: box.y }, box };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No capture: the move still reads the pointer over the item.
    }
    e.preventDefault();
  }
  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    const rect = frame.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    const next = keepInside(d.at.x + (e.clientX - d.px) / rect.width, d.at.y + (e.clientY - d.py) / rect.height, d.box.w, d.box.h);
    setPos(d.which, { x: round(next.x), y: round(next.y) });
  }
  function up() {
    drag.current = null;
  }
  function key(which: string, e: ReactKeyboardEvent<HTMLElement>) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = moves[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const box = boxOf(which);
    if (!box) return;
    const next = keepInside(box.x + d[0], box.y + d[1], box.w, box.h);
    setPos(which, { x: round(next.x), y: round(next.y) });
  }
  function corner(which: string, c: Corner) {
    const box = boxOf(which);
    if (!box) return;
    const at = cornerCentre(c, box.w, box.h);
    setPos(which, { x: round(at.x), y: round(at.y) });
  }
  function resizeLayer(l: Layer, size: number) {
    const logo = logoOf(l);
    const b = logoBox(0.5, 0.5, size, logo.width, logo.height);
    const next = l.pos ? keepInside(l.pos.x, l.pos.y, b.w, b.h) : null;
    patchLayer(l.layerId, { size, ...(next ? { pos: { x: round(next.x), y: round(next.y) } } : {}) });
  }

  // ---------- The chips ----------
  function chooseNext(gone: string) {
    const rest = shown.filter((l) => l.layerId !== gone);
    const at = Math.max(0, shown.findIndex((l) => l.layerId === gone));
    const next = rest[Math.min(at, rest.length - 1)]?.layerId ?? (hasText ? TEXT : null);
    setChosen(next);
    // Keyboard: the button that held focus is gone, so focus goes to the chip that is chosen now.
    refocus.current = next;
  }
  function removeLayer(layerId: string) {
    chooseNext(layerId);
    setLayers((ls) => ls.filter((l) => l.layerId !== layerId));
  }
  function removeText() {
    setText("");
    setTextPos(null);
    setTextWhen(whenOf(undefined, clip.durationSec));
    const next = shown[0]?.layerId ?? null;
    setChosen(next);
    refocus.current = next;
  }
  useEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    refocus.current = null;
    chips.current?.querySelector<HTMLElement>(`[data-chip="${want}"] .cr-chip__pick`)?.focus({ preventScroll: true });
  });

  // ---------- When: the chosen one's time ----------
  const when: When = pick === TEXT ? textWhen : (pickedLayer?.when ?? whenOf(undefined, clip.durationSec));
  function setWhen(patch: Partial<When>) {
    if (pick === TEXT) setTextWhen((w) => ({ ...w, ...patch }));
    else if (pickedLayer) patchLayer(pickedLayer.layerId, { when: { ...pickedLayer.when, ...patch } });
  }
  const whenTiming = timingOf(when);

  // ---------- Dropping and pasting pictures anywhere on the sheet ----------
  const drop = useFileDrop({ scope: "element", checkFile: (f) => logoRefusal(f, 0), maxFiles: 20, tooMany: "Up to 20 pictures at a time.", onFiles: (files) => lib.add(files), wrongThing: "Use a PNG, JPG or WebP picture." });
  function paste(e: ReactClipboardEvent) {
    const files = pastedPictures(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    lib.add(files);
  }

  // ---------- A campaign pre-picks (C6) ----------
  const campaigns = cr.state === "ok" || cr.state === "error" ? (cr.data?.campaigns ?? []) : [];
  async function pickCampaign(next: string) {
    setCampaignId(next);
    setError(null);
    setPicking(true);
    try {
      // Stored on the clip at once; the logo and the hashtags below only fill in the editor (both stay editable).
      const saved = await api().setClipCr(clip.clipId, next ? { active: true, campaignId: next } : { active: true });
      onClip(saved);
      if (!next) return;
      const [logoRes, tagsRes] = await Promise.allSettled([api().logoFromCampaign(next), api().crCampaign(next)]);
      if (logoRes.status === "fulfilled") {
        lib.put(logoRes.value);
        // Its logo joins the clip as a picture, once (picking the campaign again does not pile on copies).
        if (!layersRef.current.some((l) => l.logoId === logoRes.value.logoId)) addLayer(logoRes.value.logoId);
      } else toast.info(friendlyMessage(logoRes.reason));
      if (tagsRes.status === "fulfilled") {
        const rules = tagsRes.value.rules;
        const tags = [...(rules?.requiredHashtags ?? [])];
        if (tags.length) setText((t) => withHashtags(t, tags));
      }
    } catch (e) {
      setCampaignId(clip.cr?.campaignId ?? "");
      toast.error(friendlyMessage(e));
    } finally {
      setPicking(false);
    }
  }

  // ---------- Make it, Reset ----------
  const textTiming = hasText ? timingOf(textWhen) : undefined;
  const body: OverlayBody = {
    // The pictures go as `logos` (and no `logo`: that is the old one-picture shape, only ever read).
    ...(shown.length
      ? {
          logos: shown.map((l, i) => {
            const t = timingOf(l.when);
            return { layerId: l.layerId, logoId: l.logoId, x: round(lBoxes[i]!.x), y: round(lBoxes[i]!.y), size: round(l.size), ...(t ? { timing: t } : {}) };
          }),
        }
      : {}),
    ...(hasText ? { text: { text: text.trim(), x: round(tBox.x), y: round(tBox.y), size: textSize } } : {}),
    ...(textTiming ? { timing: textTiming } : {}),
  };
  const problem = bodyProblem(body, clip.durationSec);
  // A picture whose logo is not read yet would be left out of the edit: wait for the library.
  const noPicture = lib.uploading.length > 0 || (layers.length > 0 && lib.logos === null && !lib.error);

  async function make() {
    if (problem || busy) return;
    setBusy("make");
    setError(null);
    try {
      onMade(await api().makeOverlay(clip.clipId, body));
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(null);
    }
  }
  async function reset() {
    if (busy) return;
    setBusy("reset");
    setError(null);
    try {
      onClip(await api().resetOverlay(clip.clipId));
      toast.success(W.removed);
      onClose();
    } catch (e) {
      setError(friendlyMessage(e));
      setBusy(null);
    }
  }

  // ---------- A real modal ----------
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  function keys(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapTab(e, dialog.current);
  }

  const warnId = `${id}-warn`;
  return createPortal(
    <div className="tt-sheet-backdrop cr-ed-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="tt-sheet glass cr-ed drop-host"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={keys}
        onPaste={paste}
        data-help="cr-editor"
        {...drop.bind}
      >
        <header className="tt-sheet__head">
          <h2 className="tt-sheet__title" id={`${id}-title`}>
            {W.edit}
          </h2>
          <button type="button" className="tt-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </header>

        <div className="cr-ed__grid">
          <div className="cr-ed__side">
            <div className="cr-ed__preview" ref={frame} role="group" aria-label="Preview. Drag the pictures and the words, or use the arrow keys.">
              {clip.coverUrl ? <img className="cr-ed__cover" src={clip.coverUrl} alt="" draggable={false} /> : null}
              <span className="cr-ed__zone" style={{ left: pct(areas.captions.x - areas.captions.w / 2), top: pct(areas.captions.y - areas.captions.h / 2), width: pct(areas.captions.w), height: pct(areas.captions.h) }} aria-hidden="true" />
              {areas.facecam ? (
                <span className="cr-ed__zone" style={{ left: pct(areas.facecam.x - areas.facecam.w / 2), top: pct(areas.facecam.y - areas.facecam.h / 2), width: pct(areas.facecam.w), height: pct(areas.facecam.h) }} aria-hidden="true" />
              ) : null}
              {shown.map((l, i) => {
                const b = lBoxes[i]!;
                const warn = warns[i] ?? null;
                return (
                  <div
                    key={l.layerId}
                    className={`cr-ed__item cr-ed__logo${warn ? " is-warn" : ""}${pick === l.layerId ? " is-chosen" : ""}`}
                    style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w) }}
                    tabIndex={0}
                    role="img"
                    aria-label={`${shown.length > 1 ? `Picture ${i + 1}` : W.logo}. Drag it, or use the arrow keys.`}
                    aria-describedby={warn && pick === l.layerId ? warnId : undefined}
                    data-edit-logo=""
                    onPointerDown={(e) => down(l.layerId, e)}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerCancel={up}
                    onFocus={() => setChosen(l.layerId)}
                    onKeyDown={(e) => key(l.layerId, e)}
                  >
                    <img src={logoOf(l).url} alt="" draggable={false} />
                  </div>
                );
              })}
              {hasText ? (
                <div
                  className={`cr-ed__item cr-ed__text${textWarn ? " is-warn" : ""}${pick === TEXT ? " is-chosen" : ""}`}
                  style={{ left: pct(tBox.x), top: pct(tBox.y), fontSize: `${((textPx(text.trim(), textSize) / FRAME_W) * 100).toFixed(3)}cqw` }}
                  tabIndex={0}
                  role="img"
                  aria-label={`Words: ${text.trim()}. Drag them, or use the arrow keys.`}
                  aria-describedby={textWarn && pick === TEXT ? warnId : undefined}
                  data-edit-text=""
                  onPointerDown={(e) => down(TEXT, e)}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                  onFocus={() => setChosen(TEXT)}
                  onKeyDown={(e) => key(TEXT, e)}
                >
                  {text.trim()}
                </div>
              ) : null}
            </div>
            {shown.length || hasText ? (
              <div className="cr-chips" ref={chips} role="group" aria-label="Pictures and words on the clip" data-edit-chips="">
                <Glide active=".cr-chip.is-on" className="cr-chips__glide" />
                {shown.map((l, i) => {
                  const warn = warns[i] ?? null;
                  const on = pick === l.layerId;
                  return (
                    <div key={l.layerId} className={`cr-chip${on ? " is-on" : ""}`} data-chip={l.layerId}>
                      <button
                        type="button"
                        className="cr-chip__pick"
                        aria-pressed={on}
                        aria-label={`Picture ${i + 1}${warn ? `. ${warn}` : ""}`}
                        data-chip-picture=""
                        onClick={() => setChosen(l.layerId)}
                        onKeyDown={(e) => {
                          if (e.key === "Delete" || e.key === "Backspace") {
                            e.preventDefault();
                            removeLayer(l.layerId);
                          }
                        }}
                      >
                        <img src={logoOf(l).url} alt="" draggable={false} />
                        {warn ? <span className="cr-chip__dot" data-chip-dot="" aria-hidden="true" /> : null}
                      </button>
                      <button type="button" className="cr-chip__x" aria-label={L.remove} title={L.remove} onClick={() => removeLayer(l.layerId)}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  );
                })}
                {hasText ? (
                  <div className={`cr-chip cr-chip--text${pick === TEXT ? " is-on" : ""}`} data-chip={TEXT}>
                    <button
                      type="button"
                      className="cr-chip__pick"
                      aria-pressed={pick === TEXT}
                      aria-label={textWarn ? `${W.text}. ${textWarn}` : W.text}
                      data-chip-text=""
                      onClick={() => setChosen(TEXT)}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          removeText();
                        }
                      }}
                    >
                      <span className="cr-chip__label" aria-hidden="true">
                        {W.text}
                      </span>
                      {textWarn ? <span className="cr-chip__dot" data-chip-dot="" aria-hidden="true" /> : null}
                    </button>
                    <button type="button" className="cr-chip__x" aria-label={L.removeText} title={L.removeText} onClick={removeText}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {warning ? (
              <p className="cr-ed__warn" id={warnId} role="status" data-edit-warning="">
                <Icon name="alert" size={18} />
                {warning}
              </p>
            ) : (
              <p className="cr-ed__warn cr-ed__warn--none" id={warnId} role="status" />
            )}
          </div>

          <div className="cr-ed__controls">
            {campaigns.length ? (
              <div className="field" data-help="cr-for-campaign">
                <span className="field__label" id={`${id}-camp`}>
                  {W.forCampaign}
                </span>
                <Dropdown
                  labelledBy={`${id}-camp`}
                  value={campaignId}
                  placeholder={W.noCampaign}
                  disabled={picking}
                  options={[{ value: "", label: W.noCampaign }, ...campaigns.map((c) => ({ value: c.campaignId, label: c.name }))]}
                  onChange={(v) => void pickCampaign(v)}
                />
              </div>
            ) : null}

            <LogoLibrary lib={lib} used={new Set(shown.map((l) => l.logoId))} full={full} onPick={addLayer} />

            <div className="field">
              <label className="field__label" htmlFor={`${id}-text`}>
                {W.text}
              </label>
              <input
                id={`${id}-text`}
                className="input"
                type="text"
                maxLength={TEXT_MAX}
                placeholder="Words or #hashtags"
                value={text}
                onFocus={() => hasText && setChosen(TEXT)}
                onChange={(e) => {
                  // The first letters make the Text chip, and it is the chosen one while the words are typed.
                  if (!hasText && e.target.value.trim()) setChosen(TEXT);
                  setText(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                data-help="cr-text"
              />
            </div>

            {pick ? (
              <div className="cr-ed__row" data-edit-chosen={pick === TEXT ? TEXT : "picture"}>
                <Corners label={`${pick === TEXT ? W.text : W.logo} place`} onPick={(c) => corner(pick, c)} />
                {pickedLayer ? (
                  <label className="cr-ed__size">
                    <span className="field__label">Size</span>
                    <input
                      type="range"
                      min={Math.round(LOGO_SIZE_MIN * 100)}
                      max={Math.round(LOGO_SIZE_MAX * 100)}
                      step={1}
                      value={Math.round(pickedLayer.size * 100)}
                      aria-label="Logo size"
                      aria-valuetext={`${Math.round(pickedLayer.size * 100)} percent of the width`}
                      onChange={(e) => resizeLayer(pickedLayer, Number(e.target.value) / 100)}
                    />
                  </label>
                ) : (
                  <Segmented<OverlayTextSize> label="Text size" value={textSize} options={TEXT_SIZES} onChange={setTextSize} />
                )}
              </div>
            ) : null}

            <div className="field cr-ed__when">
              <span className="field__label">When</span>
              <p className="cr-ed__whole">
                <Icon name="clock" size={18} />
                {when.part && whenTiming && Number.isFinite(whenTiming.startSec) && Number.isFinite(whenTiming.endSec) ? `${whenTiming.startSec}–${whenTiming.endSec} s` : when.part ? W.part : W.whole}
              </p>
              <details key={pick ?? "none"} className="cr-fold" open={when.part} onToggle={(e) => pick && setWhen({ part: (e.currentTarget as HTMLDetailsElement).open })}>
                <summary className="cr-fold__q" onClick={(e) => !pick && e.preventDefault()} aria-disabled={!pick || undefined}>
                  <span style={{ flex: 1, minWidth: 0 }}>{W.part}</span>
                  <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
                </summary>
                <div className="cr-fold__body cr-ed__times">
                  <label>
                    <span className="field__label">From (seconds)</span>
                    <input className="input" inputMode="decimal" value={when.from} onChange={(e) => setWhen({ from: e.target.value })} />
                  </label>
                  <label>
                    <span className="field__label">To (seconds)</span>
                    <input className="input" inputMode="decimal" value={when.to} onChange={(e) => setWhen({ to: e.target.value })} />
                  </label>
                </div>
              </details>
            </div>
          </div>
        </div>

        {error ? (
          <p className="callout callout--bad" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
        <footer className="tt-sheet__actions cr-ed__actions">
          {before ? (
            <Button variant="ghost" icon="undo" act="undo" disabled={busy !== null} loading={busy === "reset"} onClick={() => void reset()}>
              {W.reset}
            </Button>
          ) : null}
          <Button variant="primary" size="lg" icon="check" act="save" data-help="cr-make" disabled={!!problem || noPicture || busy === "reset"} loading={busy === "make"} onClick={() => void make()} title={problem ?? undefined}>
            {busy === "make" ? W.making : W.make}
          </Button>
        </footer>
        <DropOverlay drop={drop} scope="element" words={{ file: "Drop to add a logo" }} icon={<Icon name="image" size={40} />} />
      </div>
    </div>,
    document.body,
  );
}

/** Four corner buttons, each a tiny picture of the frame with the corner lit. */
function Corners({ label, onPick }: { label: string; onPick: (c: Corner) => void }) {
  return (
    <div className="cr-corners" role="group" aria-label={label}>
      {CORNERS.map((c) => (
        <button key={c} type="button" className={`cr-corner cr-corner--${c}`} aria-label={CORNER_LABEL[c]} title={CORNER_LABEL[c]} onClick={() => onPick(c)}>
          <span aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
