// Every branch of the settings tree except Skills and Sounds (they have their own files). Each branch page is a
// few glass panels of apples; the words (names and leaves) come from lib/settingsTree.ts.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Platform } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { GetAppPanel } from "../../components/GetApp.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Pill, Skeleton, Stepper } from "../../components/ui.tsx";
import { X_MONTHLY_USD } from "../../lib/metrics.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { setPrefs, shrinkImage, usePrefs } from "../../lib/prefs.ts";
import { APP_VERSION, checkForUpdate, updateState } from "../../lib/update.ts";
import { Apple, AppleSwitch, Panel } from "./parts.tsx";

const PLATFORMS: Platform[] = ["youtube", "instagram", "facebook", "tiktok", "x"];

/**
 * The platform the owner just came back from connecting (the hooks API sends them to
 * /settings?account={platform}&status=coming_soon until connecting arrives, docs/CONTRACTS.md §14.3), or null.
 */
export function comingSoonPlatform(search: string): Platform | null {
  const q = new URLSearchParams(search);
  const p = q.get("account") as Platform | null;
  return q.get("status") === "coming_soon" && p && PLATFORMS.includes(p) ? p : null;
}

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
  const hasCookies = (me?.settings.hasYoutubeCookies ?? false) && !removing;

  async function uploadCookies(f: File) {
    if (f.size > 1024 ** 2) return toast.error("That file is too big to be cookies.txt. Export cookies.txt again and pick that file.");
    setBusy(true);
    try {
      const up = await api().createCookiesUpload(f.name);
      await putFile(up, f);
      await refresh();
      toast.success("YouTube cookies saved. Retry any job YouTube blocked.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  function removeCookies() {
    setRemoving(true);
    toast.undo("YouTube cookies removed.", {
      onUndo: () => setRemoving(false),
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
          <Button size="sm" icon="upload" loading={busy} onClick={() => file.current?.click()}>
            {hasCookies ? "Replace" : "Add cookies.txt"}
          </Button>
          {hasCookies ? (
            <Button size="sm" variant="ghost" icon="trash" onClick={removeCookies}>
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

export function AccountsBranch() {
  const { data } = useLoad(() => api().listAccounts());
  const toast = useToast();
  const [soon] = useState(() => comingSoonPlatform(typeof location === "undefined" ? "" : location.search));
  return (
    <Panel>
      <Apple id="accounts" wide>
        {soon ? (
          <p className="callout callout--info" role="status">
            <Icon name="info" size={18} />
            <span>Connecting {PLATFORM_LABEL[soon]} arrives soon.</span>
          </p>
        ) : null}
        <ul className="account-grid">
          {PLATFORMS.map((p) => {
            const acc = data?.find((a) => a.platform === p);
            const connected = acc?.status === "connected";
            return (
              <li key={p} className="account">
                <span className={`account__mark is-${p}`}>
                  <PlatformMark platform={p} size={24} />
                </span>
                <span className="account__text">
                  <span className="account__name">{PLATFORM_LABEL[p]}</span>
                  <span className="account__status">
                    {!data ? "Checking…" : connected ? (acc?.handle ?? "Connected") : acc?.status === "needs_reconnect" ? "Needs reconnecting" : "Not connected"}
                  </span>
                </span>
                <Button
                  size="sm"
                  disabled
                  aria-label={`Connect ${PLATFORM_LABEL[p]}: coming soon`}
                  className="account__btn"
                  // Switched off, so it plays the "deny" sound; the toast says why.
                  onClickCapture={() => toast.info("Connecting accounts is coming in a later update. Your kept clips will wait.")}
                >
                  Coming soon
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="callout callout--info account-note" id="x-cost">
          <Icon name="info" size={18} />
          <span>
            X charges a little for every number check. Clip Factory stops at ${X_MONTHLY_USD} a month.
          </span>
        </p>
      </Apple>
    </Panel>
  );
}

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
                <label key={p} className={`check-chip${on ? " is-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    aria-disabled={last || undefined}
                    onChange={() => {
                      if (last) return toast.info("Keep at least one place. Pick another place first, then turn this one off.");
                      void saveSettings({ platforms: on ? s.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || s.platforms.includes(x)) });
                    }}
                  />
                  <PlatformMark platform={p} size={18} />
                  <span>{PLATFORM_LABEL[p]}</span>
                </label>
              );
            })}
          </div>
        )}
      </Apple>
    </Panel>
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

  async function pickBackground(f: File) {
    if (!f.type.startsWith("image/")) return toast.error("That is not a picture. Tap Choose a picture and pick a JPG or PNG.");
    setBusy(true);
    try {
      const url = await shrinkImage(f);
      if (!setPrefs({ background: url })) toast.error("That picture is too big for this device. Pick a smaller one.");
      else toast.success("Background set on this device.");
    } catch {
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
              <Button size="sm" icon="image" loading={busy} onClick={() => file.current?.click()}>
                {prefs.background ? "Change picture" : "Choose a picture"}
              </Button>
              {prefs.background ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  onClick={() => {
                    const before = prefs.background;
                    setPrefs({ background: null });
                    toast.undo("Picture removed.", { onUndo: () => setPrefs({ background: before }), onCommit: () => undefined });
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
    // A quick answer still shows the spinner for a moment, so the tap clearly did something.
    await Promise.all([checkForUpdate(), new Promise((r) => setTimeout(r, 450))]);
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
        <Button size="sm" icon="retry" loading={checking} onClick={() => void check()}>
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
        <Button size="sm" variant="ghost" icon="logout" onClick={signOut}>
          Sign out
        </Button>
      </Apple>
    </Panel>
  );
}
