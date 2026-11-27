// Every branch of the settings tree except Skills and Sounds (they have their own files). Each branch page is a
// few glass panels of apples; the words (names and leaves) come from lib/settingsTree.ts.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Platform } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { BUSY_WORDS, DropOverlay } from "../../components/DropOverlay.tsx";
import { GetAppPanel } from "../../components/GetApp.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, ActGlyph, Button, LinkButton, Pill, Segmented, Skeleton, Stepper } from "../../components/ui.tsx";
import { Glide } from "../../components/Glide.tsx";
import { Icon } from "../../components/Icon.tsx";
import { checkCookies, COOKIES_STEPS, COOKIES_TIP, COOKIES_WORDS } from "../../lib/cookiesFile.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { useAction } from "../../lib/motion.ts";
import { setPrefs, shrinkImage, usePrefs } from "../../lib/prefs.ts";
import {
  BACKGROUND_MODES,
  MAX_COLOURS,
  SWATCHES,
  SOFT_COLOURS_NOTE,
  SOFT_COLOURS_VEIL,
  colourName,
  coloursVeils,
  normaliseColours,
  seeThroughNote,
  swatchTickIsDark,
  type BackgroundMode,
  type GlassStrength,
} from "../../lib/background.ts";
import { currentOs, oldAppDownloadUrl } from "../../lib/device.ts";
import { CLIP_MODELS, currentClipModel } from "../../lib/models.ts";
import { TAKE_STYLE_MAX, tidyTakeStyle } from "../../lib/take.ts";
import { desktopAppCantUpdate, inDesktopApp, nativeGlass, oldDesktopApp } from "../../lib/look.ts";
import { APP_VERSION, checkForUpdate, updateState } from "../../lib/update.ts";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import { Apple, AppleSwitch, Panel, usePickAction } from "./parts.tsx";

const PLATFORMS: readonly Platform[] = PLATFORM_ORDER;

// ---------- Clip making ----------

export function ClipsBranch() {
  const { me, saveSettings } = useSession();
  const s = me?.settings;
  // Absent on old servers: Your take is on, and said out loud.
  const takeOn = s?.takeOn ?? true;
  return (
    <>
      <Panel>
        <Apple id="clip-count">
          {!s ? (
            <Skeleton className="line-skel" />
          ) : (
            <div className="stepper-pair">
              <div className="stepper-pair__item">
                <span className="stepper-pair__label">Fewest</span>
                <Stepper label="Fewest clips" value={s.clipMin} min={1} max={s.clipMax} onChange={(n) => void saveSettings({ clipMin: n })} />
              </div>
              <div className="stepper-pair__item">
                <span className="stepper-pair__label">Most</span>
                <Stepper label="Most clips" value={s.clipMax} min={s.clipMin} max={10} onChange={(n) => void saveSettings({ clipMax: n })} />
              </div>
            </div>
          )}
        </Apple>
        <Apple id="longest-video">
          {!s ? (
            <Skeleton className="line-skel" />
          ) : (
            <div className="stepper-pair__item">
              <Stepper
                label="Longest video in hours"
                value={s.maxSourceHours}
                min={1}
                max={12}
                onChange={(n) => void saveSettings({ maxSourceHours: n })}
              />
              <span className="stepper-pair__label">hours</span>
            </div>
          )}
        </Apple>
        <Apple id="ai-model" wide>
          {!s ? (
            <Skeleton className="line-skel" />
          ) : (
            <ModelPicks value={currentClipModel(s.clipModel)} onChange={(key) => void saveSettings({ clipModel: key })} />
          )}
        </Apple>
      </Panel>
      {/* Your take (owner request, 2026-11-27). Off: the voice and the style line go away, as nothing uses them. */}
      <Panel>
        <Apple id="your-take">
          {!s ? <Skeleton className="line-skel" /> : <AppleSwitch apple="your-take" checked={takeOn} onChange={(v) => void saveSettings({ takeOn: v })} />}
        </Apple>
        {s && takeOn ? (
          <>
            <Apple id="take-voice">
              <AppleSwitch apple="take-voice" checked={s.takeVoice ?? true} onChange={(v) => void saveSettings({ takeVoice: v })} />
            </Apple>
            <Apple id="take-style" wide>
              <TakeStyle saved={s.takeStyle ?? ""} onSave={async (text) => (await saveSettings({ takeStyle: text })) !== null} />
            </Apple>
          </>
        ) : null}
      </Panel>
    </>
  );
}

/** How long after the last key "How you talk" saves by itself. */
const TAKE_STYLE_SAVE_MS = 800;

/**
 * "How you talk": one line of the owner's own words with a count. It saves when you leave the field and a moment
 * after you stop typing, tidied like the server stores it (single spaces, none at the ends). `onSave` answers whether
 * the words were saved: when they were not, the words stay in the field (never typed twice), and leaving the field
 * again tries once more.
 */
function TakeStyle({ saved, onSave }: { saved: string; onSave: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(saved);
  const typing = useRef(false);
  // The words this field sent last, until that save worked or the owner types again. While it is set, a saved
  // text that is something else is the old one coming back after a failed save: it must not wipe the field.
  const sent = useRef<string | null>(null);
  // What the next save reads, so the timer, a blur and leaving the page all save the newest words, once.
  const latest = useRef({ draft, saved, onSave });
  useEffect(() => {
    latest.current = { draft, saved, onSave };
  });
  // The words whose save failed last: the timer never sends those again by itself, only leaving the field does.
  const failed = useRef<string | null>(null);
  const [save] = useState(() => (byTimer = false) => {
    const now = latest.current;
    const text = tidyTakeStyle(now.draft);
    if (text === now.saved) return;
    if (byTimer && text === failed.current) return;
    // Marked as saved at once, so a blur right after the timer does not send the same words twice.
    latest.current = { ...now, saved: text };
    sent.current = text;
    void now.onSave(text).then(
      (ok) => {
        failed.current = ok ? null : text;
        if (!ok || sent.current !== text) return;
        sent.current = null;
        // The server's own tidied copy, when it already came back while the save was still marked as going.
        if (!typing.current) setDraft(latest.current.saved);
      },
      () => {
        failed.current = text;
      },
    );
  });

  // The saved words win only while nobody is typing here (another device, or the server's tidied answer), and
  // never over words whose own save just failed.
  useEffect(() => {
    if (typing.current) return;
    if (sent.current !== null && saved !== sent.current) return;
    setDraft(saved);
  }, [saved]);
  // Only new words start the timer: a save that failed is not sent again and again by itself.
  useEffect(() => {
    const timer = window.setTimeout(() => save(true), TAKE_STYLE_SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, save]);
  // Leaving the page with words not saved yet saves them.
  useEffect(() => () => save(), [save]);

  return (
    <div className="take-style" data-help-dodge="">
      <input
        className="input user-text"
        type="text"
        autoComplete="off"
        maxLength={TAKE_STYLE_MAX}
        placeholder="funny, honest, a bit cheeky"
        aria-labelledby="take-style-name"
        aria-describedby="take-style-leaf take-style-count"
        value={draft}
        onFocus={() => {
          typing.current = true;
        }}
        onChange={(e) => {
          sent.current = null;
          setDraft(e.target.value.slice(0, TAKE_STYLE_MAX));
        }}
        onBlur={() => {
          typing.current = false;
          // The newest words: a blur can come before the effect that copies them has run.
          latest.current = { ...latest.current, draft };
          save();
          setDraft(tidyTakeStyle(draft));
        }}
      />
      <span className="counter take-style__count" id="take-style-count">
        {draft.length} / {TAKE_STYLE_MAX}
      </span>
    </div>
  );
}

/** The AI models from config/models.json, one row each with a plain line; the glide slides to the one in use. */
function ModelPicks({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const name = useId();
  return (
    <div className="model-picks" role="radiogroup" aria-labelledby="ai-model-name" data-help-dodge="">
      <Glide active=".model-pick.is-on" className="glide--tile" />
      {CLIP_MODELS.map((m) => {
        const on = m.key === value;
        return (
          <label key={m.key} className={`model-pick${on ? " is-on" : ""}`} data-help={`ai-model-${m.key}`}>
            <input type="radio" name={name} value={m.key} checked={on} onChange={() => onChange(m.key)} />
            <span className="model-pick__text">
              <span className="model-pick__name">{m.label}</span>
              <span className="model-pick__line">{m.line}</span>
            </span>
            {on ? (
              <span className="model-pick__mark">
                <Icon name="check" size={16} />
                In use
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

/** What a settings drop zone says while a file is dragged over it (§45.40). */
const DROP_WORDS = { file: "Drop it here", busy: "Still uploading. Wait a moment." } as const;
const COOKIES_TOO_BIG = "That file is too big to be cookies.txt. Export cookies.txt again and pick that file.";
const NOT_A_PICTURE = "That is not a picture. Tap Choose a picture and pick a JPG or PNG.";

/** A file dropped on the cookies panel: null to take it (its words are checked after), else why it is not cookies.txt. */
export function cookiesDropCheck(f: File): string | null {
  if (!/\.txt$/i.test(f.name) && f.type !== "text/plain") return COOKIES_WORDS.notCookies;
  return f.size > 1024 ** 2 ? COOKIES_TOO_BIG : null;
}

/** A file dropped on the background picture card: null for a picture, else the line. */
export function pictureDropCheck(f: File): string | null {
  return f.type.startsWith("image/") ? null : NOT_A_PICTURE;
}

export function YoutubeBranch() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const pick = usePickAction("upload");
  // Kept here, not on the button: the button goes while the Undo is up, and comes back rewinding on Undo.
  const removeAct = useAction("delete");
  const hasCookies = (me?.settings.hasYoutubeCookies ?? false) && !removing;
  const guideId = useId();
  // A cookies.txt dropped anywhere on the panel is checked and saved like the picker's (§45.40). Clip Factory's own
  // account only: Clips Funded never reads it.
  const drop = useFileDrop({ scope: "element", checkFile: cookiesDropCheck, onFiles: ([f]) => void uploadCookies(f!), busy: busy ? DROP_WORDS.busy : null });

  async function uploadCookies(f: File) {
    pick.play();
    if (f.size > 1024 ** 2) {
      pick.fail({ sound: false });
      return toast.error(COOKIES_TOO_BIG);
    }
    // Checked here, in the browser, before upload (§29.6); the text is never logged or kept.
    const verdict = checkCookies(await f.text(), Date.now() / 1000);
    if (verdict !== "ok") {
      pick.fail({ sound: false });
      if (file.current) file.current.value = "";
      return toast.error(COOKIES_WORDS[verdict]);
    }
    setBusy(true);
    try {
      const up = await api().createCookiesUpload(f.name);
      await putFile(up, f);
      await refresh();
      toast.success("YouTube cookies saved. Tap Try again on any job YouTube stopped.");
    } catch (e) {
      pick.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  function removeCookies() {
    setRemoving(true);
    toast.undo("YouTube cookies removed.", {
      onUndo: () => {
        setRemoving(false);
        removeAct.rewind();
      },
      onCommit: () => {
        api()
          .deleteCookies()
          .then(() => refresh())
          .catch((e) => toast.error(`${friendlyMessage(e)} Your cookies are still saved.`))
          .finally(() => setRemoving(false));
      },
    });
  }

  return (
    // The panel (parts.tsx Panel's own markup) is the drop zone.
    <div className="apple-panel glass drop-host" {...drop.bind}>
      <Apple id="youtube-cookies" aside={hasCookies ? <Pill tone="success" icon="check">Saved</Pill> : null}>
        <div className="row-actions">
          <input
            ref={file}
            type="file"
            accept=".txt,text/plain"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadCookies(f);
            }}
          />
          <Button size="sm" variant="action" icon="upload" act={pick} playOnClick={false} loading={busy} onClick={() => file.current?.click()}>
            {hasCookies ? "Replace" : "Add cookies.txt"}
          </Button>
          {hasCookies ? (
            <Button size="sm" variant="ghost" icon="trash" act={removeAct} onClick={removeCookies}>
              Remove
            </Button>
          ) : null}
        </div>
      </Apple>
      {hasCookies ? <p className="apple-panel__note">They are only used to download YouTube videos.</p> : null}
      {/* The how-to is only for when YouTube blocks a video: one fold, shut until tapped. */}
      <section className="cookie-guide" aria-labelledby={guideId}>
        <details className="cr-fold">
          <summary className="cr-fold__q">
            <Icon name="info" size={18} />
            {/* Still a heading (its section is named by it), in the fold's own place for the words. */}
            <h3 className="cookie-guide__title" id={guideId} style={{ flex: 1, minWidth: 0 }}>
              How to get cookies
            </h3>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <div className="cr-fold__body">
            <ol className="cookie-guide__steps">
              {COOKIES_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="cookie-guide__tip">{COOKIES_TIP}</p>
          </div>
        </details>
      </section>
      <DropOverlay drop={drop} scope="element" words={DROP_WORDS} />
    </div>
  );
}

// ---------- Posting ----------

export function WhereBranch() {
  const { me, saveSettings } = useSession();
  const toast = useToast();
  const s = me?.settings;
  return (
    <Panel>
      <Apple id="post-to" wide>
        {!s ? (
          <Skeleton className="line-skel" />
        ) : (
          <div className="check-chips" role="group" aria-labelledby="post-to-name">
            {PLATFORMS.map((p) => {
              const on = s.platforms.includes(p);
              const last = on && s.platforms.length === 1;
              return (
                <PostToChip
                  key={p}
                  platform={p}
                  on={on}
                  onChange={() => {
                    if (last) {
                      toast.info("Keep at least one place. Pick another place first, then turn this one off.");
                      return null;
                    }
                    return saveSettings({ platforms: on ? s.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || s.platforms.includes(x)) });
                  }}
                  last={last}
                />
              );
            })}
          </div>
        )}
      </Apple>
    </Panel>
  );
}

/**
 * One "Post to" check-chip. Turning a place on ticks its mark (`tick`, §20.11); turning it off is the press only. A
 * save the server refuses puts the chip back and plays the failure.
 */
function PostToChip({
  platform,
  on,
  last,
  onChange,
}: {
  platform: Platform;
  on: boolean;
  last: boolean;
  /** Saves the change: the save (null when it failed), or null when nothing was saved. */
  onChange: () => Promise<unknown> | null;
}) {
  const tick = useAction("tick");
  return (
    <label className={`check-chip${on ? " is-on" : ""}`} data-act="tick">
      <input
        type="checkbox"
        checked={on}
        aria-disabled={last || undefined}
        onChange={() => {
          const saving = onChange();
          if (!saving || on) return;
          tick.play();
          void saving.then((saved) => {
            if (saved === null) tick.fail({ sound: false });
          });
        }}
      />
      <ActGlyph act={tick}>
        <PlatformMark platform={platform} size={18} />
      </ActGlyph>
      <span>{PLATFORM_LABEL[platform]}</span>
    </label>
  );
}

// ---------- Look & feel (Sounds is in SoundsBranch.tsx) ----------

export function MotionBranch() {
  const { me, saveSettings } = useSession();
  const prefs = usePrefs();
  return (
    <Panel>
      <Apple id="reduce-motion">
        <AppleSwitch apple="reduce-motion" checked={me?.settings.reduceMotion ?? prefs.reduceMotion} onChange={(v) => void saveSettings({ reduceMotion: v })} />
      </Apple>
    </Panel>
  );
}

const MODE_LABEL: Record<BackgroundMode, string> = { "see-through": "See-through", picture: "Picture", colours: "Colours" };

/**
 * Settings › Look & feel › Background (§22.5): what sits behind the glass. The choice is a glide bar of three
 * preview tiles; under it, one apple per choice. Using any of them (a strength, a picture, a colour) also picks it.
 */
export function BackgroundBranch() {
  const prefs = usePrefs();
  const { me, saveSettings } = useSession();
  const mode = me?.settings.backgroundMode ?? prefs.backgroundMode;
  const strength = me?.settings.glassStrength ?? prefs.glassStrength;
  const colours = normaliseColours(me?.settings.backgroundColours ?? prefs.backgroundColours);
  const glass = nativeGlass();
  const os = currentOs();
  const desktopApp = inDesktopApp();
  // An app from before the see-through window cannot say what glass it has: it only needs the new one (§12.6).
  const oldApp = oldDesktopApp();
  // Any app that can't update itself (no version named) gets the new installer's button under the note.
  const updateUrl = desktopAppCantUpdate() && typeof location !== "undefined" ? oldAppDownloadUrl(os, location.host) : null;
  const note = mode === "see-through" ? seeThroughNote(glass, desktopApp, os === "ios" || os === "android", oldApp) : null;
  // "Get the app" only where the app can show see-through: a Mac or Windows computer not already in the app.
  const offerApp = !desktopApp && (os === "mac" || os === "windows");
  const choose = (next: BackgroundMode) => (next === mode ? null : saveSettings({ backgroundMode: next }));

  return (
    <>
      <Panel>
        <Apple id="background-kind" wide>
          <BackgroundModes mode={mode} picture={prefs.background} colours={colours} onChange={(m) => void choose(m)} />
          {note ? (
            <p className="bg-note" data-help="see-through-note">
              <Icon name="info" size={18} />
              <span>
                {note}
                {offerApp ? (
                  <>
                    {" "}
                    <A href="/get-app" className="text-link bg-note__link">
                      Get the app
                    </A>
                  </>
                ) : null}
              </span>
            </p>
          ) : null}
          {note && updateUrl ? (
            <LinkButton href={updateUrl} variant="primary" size="lg" icon="download" className="bg-note__update">
              Update the app
            </LinkButton>
          ) : null}
        </Apple>
      </Panel>
      <Panel className="bg-options">
        <Apple id="glass-strength" aside={mode === "see-through" ? <Pill tone="success">In use</Pill> : null}>
          <Segmented<GlassStrength>
            label="Glass strength"
            value={strength}
            options={[
              { value: "clear", label: "Clear", help: "glass-clear" },
              { value: "frosted", label: "Frosted", help: "glass-frosted" },
            ]}
            onChange={(v) => void saveSettings({ glassStrength: v, backgroundMode: "see-through" })}
          />
        </Apple>
        <PictureApple inUse={mode === "picture"} onPicked={() => void choose("picture")} />
        <ColoursApple inUse={mode === "colours"} colours={colours} onChange={(next) => void saveSettings({ backgroundColours: next, backgroundMode: "colours" })} />
      </Panel>
    </>
  );
}

/** The three choices as tiles that each show what you get; the glide slides to the chosen one. */
function BackgroundModes({
  mode,
  picture,
  colours,
  onChange,
}: {
  mode: BackgroundMode;
  picture: string | null;
  colours: string[];
  onChange: (m: BackgroundMode) => void;
}) {
  const name = useId();
  return (
    <div className="bg-modes" role="radiogroup" aria-labelledby="background-kind-name" data-help-dodge="">
      <Glide active=".bg-mode.is-on" className="glide--tile" />
      {BACKGROUND_MODES.map((m) => (
        <label key={m} className={`bg-mode${m === mode ? " is-on" : ""}`} data-help={`background-${m}`}>
          <input type="radio" name={name} value={m} checked={m === mode} onChange={() => onChange(m)} />
          <span className={`bg-tile bg-tile--${m}`} aria-hidden="true" style={m === "colours" ? colourPreviewStyle(colours) : undefined}>
            {m === "see-through" ? <SeeThroughArt /> : m === "picture" ? picture ? <img src={picture} alt="" /> : <Icon name="image" size={26} /> : null}
          </span>
          <span className="bg-mode__name">{MODE_LABEL[m]}</span>
        </label>
      ))}
    </div>
  );
}

/** The colours as they will really look between the panels: blended, under the page veil the backdrop gets (`--preview-veil`). */
function colourPreviewStyle(colours: string[]): CSSProperties {
  const [c1, c2 = c1, c3 = c2] = colours;
  return {
    background: `radial-gradient(circle at 25% 25%, ${c1} 0, transparent 70%), radial-gradient(circle at 80% 70%, ${c3} 0, transparent 70%), linear-gradient(140deg, ${c1}, ${c2}, ${c3})`,
    "--preview-veil": String(coloursVeils(colours).pageVeil),
  } as CSSProperties;
}

/** A desktop behind frosted glass: a wallpaper of soft hills with a window on it. You can guess shapes, not read them. */
function SeeThroughArt() {
  return (
    <>
      <svg className="bg-tile__scene" viewBox="0 0 120 90" preserveAspectRatio="xMidYMid slice">
        <rect width="120" height="90" fill="#7cc4f2" />
        <circle cx="94" cy="22" r="11" fill="#f6c945" />
        <path d="M0 62c14-16 28-20 42-8 12-18 30-22 46-6 10-8 22-8 32 2v40H0z" fill="#5c7a4a" />
        <path d="M0 74c20-10 44-10 64 0 18-8 38-8 56 0v16H0z" fill="#3f5a34" />
        <rect x="16" y="18" width="46" height="32" rx="5" fill="#0f372b" fillOpacity="0.73" />
        <rect x="16" y="18" width="46" height="8" rx="4" fill="#0a2820" />
        <rect x="21" y="32" width="28" height="3" rx="1.5" fill="#efe7da" />
        <rect x="21" y="39" width="20" height="3" rx="1.5" fill="#efe7da" />
      </svg>
      <span className="bg-tile__frost" />
    </>
  );
}

function PictureApple({ inUse, onPicked }: { inUse: boolean; onPicked: () => void }) {
  const prefs = usePrefs();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = usePickAction("upload");
  // Kept here: "Remove picture" goes with the picture and comes back rewinding on Undo.
  const remove = useAction("undo");
  // A picture dropped on the card is set like the picker's (§45.40).
  const drop = useFileDrop({ scope: "element", checkFile: pictureDropCheck, onFiles: ([f]) => void pickBackground(f!), busy: busy ? BUSY_WORDS : null });

  async function pickBackground(f: File) {
    pick.play();
    if (!f.type.startsWith("image/")) {
      pick.fail({ sound: false });
      return toast.error(NOT_A_PICTURE);
    }
    setBusy(true);
    try {
      const url = await shrinkImage(f);
      if (!setPrefs({ background: url })) {
        pick.fail({ sound: false });
        toast.error("That picture is too big for this device. Pick a smaller one.");
      } else {
        onPicked();
        toast.success("Background set on this device.");
      }
    } catch {
      pick.fail({ sound: false });
      toast.error("That picture could not be opened. Pick a JPG or PNG.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <Apple id="background-picture" wide aside={inUse ? <Pill tone="success">In use</Pill> : null}>
      <div className="bg-picker drop-host drop-host--round" {...drop.bind}>
        <span className="bg-picker__preview" aria-hidden="true">
          {prefs.background ? <img src={prefs.background} alt="" /> : <span className="bg-picker__mesh" />}
        </span>
        <div className="bg-picker__text">
          <span className="muted small">{prefs.background ? "Your picture is ready." : "No picture yet. You see the Clip Factory colours."}</span>
          <div className="row-actions">
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickBackground(f);
              }}
            />
            <Button size="sm" variant="action" icon="image" act={pick} playOnClick={false} loading={busy} onClick={() => file.current?.click()}>
              {prefs.background ? "Change picture" : "Choose a picture"}
            </Button>
            {prefs.background ? (
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                act={remove}
                onClick={() => {
                  const before = prefs.background;
                  setPrefs({ background: null });
                  toast.undo("Picture removed.", {
                    onUndo: () => {
                      setPrefs({ background: before });
                      remove.rewind();
                    },
                    onCommit: () => undefined,
                  });
                }}
              >
                Remove picture
              </Button>
            ) : null}
          </div>
        </div>
        <DropOverlay drop={drop} scope="element" words={{ file: DROP_WORDS.file }} icon={<Icon name="image" size={40} />} />
      </div>
    </Apple>
  );
}

/** Up to three colours from the swatches, or your own from the colour picker. They blend behind the glass. */
function ColoursApple({ inUse, colours, onChange }: { inUse: boolean; colours: string[]; onChange: (next: string[]) => void }) {
  const toast = useToast();
  const own = useRef<HTMLInputElement>(null);
  const latest = useRef({ colours, onChange });
  latest.current = { colours, onChange };

  const add = (hex: string) => {
    const { colours: now, onChange: save } = latest.current;
    if (now.includes(hex)) return save(now);
    if (now.length >= MAX_COLOURS) {
      toast.info("You can mix 3 colours. Tap one of yours to take it off first.");
      return;
    }
    save([...now, hex]);
  };
  const toggle = (hex: string) => {
    if (!colours.includes(hex)) return add(hex);
    if (colours.length === 1) {
      // Tapping the only colour just picks Colours; there is always at least one.
      if (!inUse) onChange(colours);
      else toast.info("Keep at least one colour. Pick another one first.");
      return;
    }
    onChange(colours.filter((c) => c !== hex));
  };

  // The colour picker reports every drag step as "input"; only the final pick ("change") is saved.
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    const done = () => add(el.value.toLowerCase());
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const custom = colours.filter((c) => !SWATCHES.some((s) => s.hex === c));
  return (
    <Apple id="background-colours" wide aside={inUse ? <Pill tone="success">In use</Pill> : null}>
      <div className="bg-colours">
        <span className="bg-colours__mix" aria-hidden="true" style={colourPreviewStyle(colours)} />
        <div className="swatches" role="group" aria-label="Colours">
          {[...SWATCHES.map((s) => s.hex), ...custom].map((hex) => {
            const on = colours.includes(hex);
            return (
              <button
                key={hex}
                type="button"
                className={`swatch${on ? " is-on" : ""}${swatchTickIsDark(hex) ? " is-light" : ""}`}
                style={{ "--swatch": hex } as CSSProperties}
                aria-pressed={on}
                aria-label={colourName(hex)}
                title={colourName(hex)}
                onClick={() => toggle(hex)}
              >
                {on ? <Icon name="check" size={20} /> : null}
              </button>
            );
          })}
          <label className="swatch swatch--own" title="Your own colour">
            <input ref={own} type="color" defaultValue="#7fd8be" aria-label="Your own colour" />
            <Icon name="plus" size={20} />
          </label>
        </div>
        <span className="muted small">
          {colours.length === 1 ? "1 colour picked." : `${colours.length} colours picked.`} Tap one to add or remove it.
          {coloursVeils(colours).pageVeil > SOFT_COLOURS_VEIL ? <span className="bg-colours__soft"> {SOFT_COLOURS_NOTE}</span> : null}
        </span>
      </div>
    </Apple>
  );
}

// ---------- App & account ----------

export function GetAppBranch() {
  // The card carries the #get-app anchor itself.
  return <GetAppPanel installedNote title="For this device" />;
}

export const UPDATE_CHECK_FAILED = "Couldn't check. Check your internet and tap Check for updates again.";

export function UpdatesBranch() {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  async function check() {
    setChecking(true);
    // The arrow's turn (act="refresh") shows the tap did something; the answer is not held back for it (§20.4).
    const found = await checkForUpdate();
    if (!alive.current) return;
    setChecking(false);
    if (updateState().available) toast.info("A new version is ready. Tap Reload at the bottom of the screen.");
    // A check that did not get an answer never says "newest": it says how to try again.
    else if (found === "failed") toast.error(UPDATE_CHECK_FAILED);
    else toast.success("You have the newest version.");
  }

  return (
    <Panel>
      <Apple id="this-version">
        <Pill tone="success" icon="check">
          {APP_VERSION === "dev" ? "Test version" : `Version ${APP_VERSION}`}
        </Pill>
      </Apple>
      <Apple id="check-updates">
        <Button size="sm" variant="action" icon="retry" act="refresh" loading={checking} onClick={() => void check()}>
          Check for updates
        </Button>
      </Apple>
    </Panel>
  );
}

export function AccountBranch() {
  const { me, signOut } = useSession();
  return (
    <Panel>
      <Apple id="signed-in">
        <span className="apple__value user-text">{me ? me.user.email : "Checking…"}</span>
      </Apple>
      <Apple id="sign-out">
        <Button size="sm" variant="ghost" icon="logout" act="disconnect" onClick={signOut}>
          Sign out
        </Button>
      </Apple>
    </Panel>
  );
}
