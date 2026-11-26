// "Edit for campaign" (docs/CONTRACTS.md §53 C2, C3, C6): a glass sheet over the Review card. The clip's cover is the
// 9:16 preview; the logo and one line of words sit on it where the owner drags them (or taps a corner), and Make it
// sends the edit. Only a logo and text, nothing else. One short warning line when either covers the captions or the
// facecam (the areas are the renderer's own, lib/overlayAreas.ts).
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Logo, OverlayBody, OverlayTextSize } from "../../api/types.ts";
import { DropOverlay } from "../../components/DropOverlay.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Segmented } from "../../components/ui.tsx";
import { useCr } from "../../lib/contentRewards.ts";
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
  overlaps,
  textBox,
  textPx,
  type Box,
  type Corner,
} from "../../lib/overlayAreas.ts";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import { LogoLibrary, useLogos } from "./LogoLibrary.tsx";

interface Pos {
  x: number;
  y: number;
}
type Which = "logo" | "text";

const TEXT_SIZES: { value: OverlayTextSize; label: string }[] = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
];
const round = (n: number) => Math.round(n * 10000) / 10000;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
/** Seconds as typed ("12", "12.5"): a number, or NaN. */
const secs = (v: string) => (v.trim() === "" ? Number.NaN : Number(v.replace(",", ".")));

export function CampaignEdit({ clip, onClose, onClip, onMade }: { clip: Clip; onClose: () => void; onClip: (c: Clip) => void; onMade: (c: Clip) => void }) {
  const id = useId();
  const toast = useToast();
  const dialog = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const cr = useCr();
  const before = clip.overlay;

  // What is picked (the logo), where things sit (null: the default corner), and the words.
  const [logoId, setLogoId] = useState<string | null>(before?.logo?.logoId ?? null);
  const [logoPos, setLogoPos] = useState<Pos | null>(before?.logo ? { x: before.logo.x, y: before.logo.y } : null);
  const [logoSize, setLogoSize] = useState(before?.logo?.size ?? LOGO_SIZE_DEFAULT);
  const [text, setText] = useState(before?.text?.text ?? "");
  const [textPos, setTextPos] = useState<Pos | null>(before?.text ? { x: before.text.x, y: before.text.y } : null);
  const [textSize, setTextSize] = useState<OverlayTextSize>(before?.text?.size ?? "m");
  const [part, setPart] = useState(!!before?.timing);
  const [from, setFrom] = useState(before?.timing ? String(before.timing.startSec) : "0");
  const [to, setTo] = useState(before?.timing ? String(before.timing.endSec) : String(Math.floor(clip.durationSec)));
  const [campaignId, setCampaignId] = useState(clip.cr?.campaignId ?? "");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"make" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lib = useLogos({
    onAdded: (l) => {
      setLogoId(l.logoId);
      setLogoPos(null);
    },
    onRemoved: (removed) => setLogoId((now) => (now === removed ? null : now)),
  });
  const logo: Logo | undefined = lib.logos?.find((l) => l.logoId === logoId);
  // A logo that is no longer in the library (deleted since) is not drawn; the edit keeps the copy it already has.
  const hasLogo = !!logo;
  const hasText = text.trim().length > 0;

  // ---------- The boxes, in fractions of the frame ----------
  const sized = logoBox(0.5, 0.5, logoSize, logo?.width ?? 1, logo?.height ?? 1);
  const lAt: Pos = logoPos ?? cornerCentre("tr", sized.w, sized.h);
  const lBox: Box = { ...sized, ...keepInside(lAt.x, lAt.y, sized.w, sized.h) };
  const tSized = textBox(0.5, 0.5, text.trim() || " ", textSize);
  // Until it is moved, the words start at the top left, under the logo when the logo is there.
  const tCorner = cornerCentre("tl", tSized.w, tSized.h);
  const tUnder = hasLogo && overlaps({ ...tSized, ...tCorner }, lBox) ? { x: tCorner.x, y: lBox.y + lBox.h / 2 + tSized.h / 2 + 0.01 } : tCorner;
  const tAt: Pos = textPos ?? tUnder;
  const tBox: Box = { ...tSized, ...keepInside(tAt.x, tAt.y, tSized.w, tSized.h) };
  const campaignClip = !!clip.campaignId;
  const logoWarn = hasLogo ? overlapWarning(lBox, clip.layout, campaignClip) : null;
  const textWarn = hasText ? overlapWarning(tBox, clip.layout, campaignClip) : null;
  const warning = logoWarn ?? textWarn;
  const areas = areasOf(clip.layout, campaignClip);

  // ---------- Dragging ----------
  const drag = useRef<{ which: Which; px: number; py: number; at: Pos; box: Box } | null>(null);
  function down(which: Which, e: ReactPointerEvent<HTMLElement>) {
    const box = which === "logo" ? lBox : tBox;
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
    (d.which === "logo" ? setLogoPos : setTextPos)({ x: round(next.x), y: round(next.y) });
  }
  function up() {
    drag.current = null;
  }
  function key(which: Which, e: ReactKeyboardEvent<HTMLElement>) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = moves[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const box = which === "logo" ? lBox : tBox;
    const next = keepInside(box.x + d[0], box.y + d[1], box.w, box.h);
    (which === "logo" ? setLogoPos : setTextPos)({ x: round(next.x), y: round(next.y) });
  }
  function corner(which: Which, c: Corner) {
    const box = which === "logo" ? lBox : tBox;
    const at = cornerCentre(c, box.w, box.h);
    (which === "logo" ? setLogoPos : setTextPos)({ x: round(at.x), y: round(at.y) });
  }
  function resizeLogo(size: number) {
    setLogoSize(size);
    if (logoPos) {
      const b = logoBox(0.5, 0.5, size, logo?.width ?? 1, logo?.height ?? 1);
      const next = keepInside(logoPos.x, logoPos.y, b.w, b.h);
      setLogoPos({ x: round(next.x), y: round(next.y) });
    }
  }

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
        setLogoId(logoRes.value.logoId);
        setLogoPos(null);
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
  const timing = part ? { startSec: secs(from), endSec: secs(to) } : undefined;
  const body: OverlayBody = {
    ...(hasLogo && logo ? { logo: { logoId: logo.logoId, x: round(lBox.x), y: round(lBox.y), size: round(logoSize) } } : {}),
    ...(hasText ? { text: { text: text.trim(), x: round(tBox.x), y: round(tBox.y), size: textSize } } : {}),
    ...(timing ? { timing } : {}),
  };
  const problem = bodyProblem(body, clip.durationSec);
  // A picked logo whose picture is not read yet would be left out of the edit: wait for the library.
  const noPicture = lib.uploading.length > 0 || (!!logoId && lib.logos === null && !lib.error);

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
            <div className="cr-ed__preview" ref={frame} role="group" aria-label="Preview. Drag the logo and the words, or use the arrow keys.">
              {clip.coverUrl ? <img className="cr-ed__cover" src={clip.coverUrl} alt="" draggable={false} /> : null}
              <span className="cr-ed__zone" style={{ left: pct(areas.captions.x - areas.captions.w / 2), top: pct(areas.captions.y - areas.captions.h / 2), width: pct(areas.captions.w), height: pct(areas.captions.h) }} aria-hidden="true" />
              {areas.facecam ? (
                <span className="cr-ed__zone" style={{ left: pct(areas.facecam.x - areas.facecam.w / 2), top: pct(areas.facecam.y - areas.facecam.h / 2), width: pct(areas.facecam.w), height: pct(areas.facecam.h) }} aria-hidden="true" />
              ) : null}
              {hasLogo && logo ? (
                <div
                  className={`cr-ed__item cr-ed__logo${logoWarn ? " is-warn" : ""}`}
                  style={{ left: pct(lBox.x), top: pct(lBox.y), width: pct(lBox.w) }}
                  tabIndex={0}
                  role="img"
                  aria-label="Logo. Drag it, or use the arrow keys."
                  aria-describedby={logoWarn ? warnId : undefined}
                  data-edit-logo=""
                  onPointerDown={(e) => down("logo", e)}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                  onKeyDown={(e) => key("logo", e)}
                >
                  <img src={logo.url} alt="" draggable={false} />
                </div>
              ) : null}
              {hasText ? (
                <div
                  className={`cr-ed__item cr-ed__text${textWarn ? " is-warn" : ""}`}
                  style={{ left: pct(tBox.x), top: pct(tBox.y), fontSize: `${((textPx(text.trim(), textSize) / FRAME_W) * 100).toFixed(3)}cqw` }}
                  tabIndex={0}
                  role="img"
                  aria-label={`Words: ${text.trim()}. Drag them, or use the arrow keys.`}
                  aria-describedby={textWarn ? warnId : undefined}
                  data-edit-text=""
                  onPointerDown={(e) => down("text", e)}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                  onKeyDown={(e) => key("text", e)}
                >
                  {text.trim()}
                </div>
              ) : null}
            </div>
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

            <LogoLibrary lib={lib} picked={logoId} onPick={(v) => (setLogoId(v), setLogoPos(null))} />
            {hasLogo ? (
              <div className="cr-ed__row">
                <Corners label={`${W.logo} place`} onPick={(c) => corner("logo", c)} />
                <label className="cr-ed__size">
                  <span className="field__label">Size</span>
                  <input
                    type="range"
                    min={Math.round(LOGO_SIZE_MIN * 100)}
                    max={Math.round(LOGO_SIZE_MAX * 100)}
                    step={1}
                    value={Math.round(logoSize * 100)}
                    aria-label="Logo size"
                    aria-valuetext={`${Math.round(logoSize * 100)} percent of the width`}
                    onChange={(e) => resizeLogo(Number(e.target.value) / 100)}
                  />
                </label>
              </div>
            ) : null}

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
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                data-help="cr-text"
              />
            </div>
            {hasText ? (
              <div className="cr-ed__row">
                <Corners label={`${W.text} place`} onPick={(c) => corner("text", c)} />
                <Segmented<OverlayTextSize> label="Text size" value={textSize} options={TEXT_SIZES} onChange={setTextSize} />
              </div>
            ) : null}

            <div className="field cr-ed__when">
              <span className="field__label">When</span>
              <p className="cr-ed__whole">
                <Icon name="clock" size={18} />
                {part && timing && Number.isFinite(timing.startSec) && Number.isFinite(timing.endSec) ? `${timing.startSec}–${timing.endSec} s` : part ? W.part : W.whole}
              </p>
              <details className="cr-fold" open={part} onToggle={(e) => setPart((e.currentTarget as HTMLDetailsElement).open)}>
                <summary className="cr-fold__q">
                  <span style={{ flex: 1, minWidth: 0 }}>{W.part}</span>
                  <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
                </summary>
                <div className="cr-fold__body cr-ed__times">
                  <label>
                    <span className="field__label">From (seconds)</span>
                    <input className="input" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </label>
                  <label>
                    <span className="field__label">To (seconds)</span>
                    <input className="input" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} />
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
