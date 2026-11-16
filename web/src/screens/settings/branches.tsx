// Every branch of the settings tree except Skills and Sounds (they have their own files). Each branch page is a
// few glass panels of apples; the words (names and leaves) come from lib/settingsTree.ts.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Platform } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { GetAppPanel } from "../../components/GetApp.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { ActGlyph, Button, Pill, Skeleton, Stepper } from "../../components/ui.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { useAction } from "../../lib/motion.ts";
import { setPrefs, shrinkImage, usePrefs } from "../../lib/prefs.ts";
import { APP_VERSION, checkForUpdate, updateState } from "../../lib/update.ts";
import { Apple, AppleSwitch, Panel, usePickAction } from "./parts.tsx";

const PLATFORMS: readonly Platform[] = PLATFORM_ORDER;

// ---------- Clip making ----------

export function ClipsBranch() {
  const { me, saveSettings } = useSession();
  const s = me?.settings;
  return (
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
    </Panel>
  );
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

  async function uploadCookies(f: File) {
    pick.play();
    if (f.size > 1024 ** 2) {
      pick.fail({ sound: false });
      return toast.error("That file is too big to be cookies.txt. Export cookies.txt again and pick that file.");
    }
    setBusy(true);
    try {
      const up = await api().createCookiesUpload(f.name);
      await putFile(up, f);
      await refresh();
      toast.success("YouTube cookies saved. Retry any job YouTube blocked.");
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
    <Panel>
      <Apple id="youtube-cookies" aside={hasCookies ? <Pill tone="sage" icon="check">Saved</Pill> : null}>
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
          <Button size="sm" icon="upload" act={pick} playOnClick={false} loading={busy} onClick={() => file.current?.click()}>
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
    </Panel>
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

export function BackgroundBranch() {
  const prefs = usePrefs();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = usePickAction("upload");
  // Kept here: "Use the colours" goes with the picture and comes back rewinding on Undo.
  const colours = useAction("undo");

  async function pickBackground(f: File) {
    pick.play();
    if (!f.type.startsWith("image/")) {
      pick.fail({ sound: false });
      return toast.error("That is not a picture. Tap Choose a picture and pick a JPG or PNG.");
    }
    setBusy(true);
    try {
      const url = await shrinkImage(f);
      if (!setPrefs({ background: url })) {
        pick.fail({ sound: false });
        toast.error("That picture is too big for this device. Pick a smaller one.");
      } else toast.success("Background set on this device.");
    } catch {
      pick.fail({ sound: false });
      toast.error("That picture could not be opened. Pick a JPG or PNG.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <Panel>
      <Apple id="background-picture" wide>
        <div className="bg-picker">
          <span className="bg-picker__preview" aria-hidden="true">
            {prefs.background ? <img src={prefs.background} alt="" /> : <span className="bg-picker__mesh" />}
          </span>
          <div className="bg-picker__text">
            <span className="muted small">{prefs.background ? "Using your picture." : "Using the Clip Factory colours."}</span>
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
              <Button size="sm" icon="image" act={pick} playOnClick={false} loading={busy} onClick={() => file.current?.click()}>
                {prefs.background ? "Change picture" : "Choose a picture"}
              </Button>
              {prefs.background ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  act={colours}
                  onClick={() => {
                    const before = prefs.background;
                    setPrefs({ background: null });
                    toast.undo("Picture removed.", {
                      onUndo: () => {
                        setPrefs({ background: before });
                        colours.rewind();
                      },
                      onCommit: () => undefined,
                    });
                  }}
                >
                  Use the colours
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </Apple>
    </Panel>
  );
}

// ---------- App & account ----------

export function GetAppBranch() {
  // The card carries the #get-app anchor itself.
  return <GetAppPanel installedNote title="For this device" />;
}

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
    await checkForUpdate();
    if (!alive.current) return;
    setChecking(false);
    if (updateState().available) toast.info("A new version is ready. Tap Reload at the bottom of the screen.");
    else toast.success("You have the newest version.");
  }

  return (
    <Panel>
      <Apple id="this-version">
        <Pill tone="sage" icon="check">
          {APP_VERSION === "dev" ? "Test version" : `Version ${APP_VERSION}`}
        </Pill>
      </Apple>
      <Apple id="check-updates">
        <Button size="sm" icon="retry" act="refresh" loading={checking} onClick={() => void check()}>
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
