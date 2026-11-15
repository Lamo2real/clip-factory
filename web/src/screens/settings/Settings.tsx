import { useId, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Platform } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, PageHeader, Skeleton, Stepper, Toggle } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { setPrefs, shrinkImage, usePrefs } from "../../lib/prefs.ts";
import { useInstall } from "../../lib/pwa.ts";
import { GetAppPanel } from "../../components/GetApp.tsx";
import { SkillsSection } from "./SkillsSection.tsx";

const PLATFORMS: Platform[] = ["youtube", "instagram", "facebook", "tiktok", "x"];

const SECTIONS = [
  { id: "skills", label: "Skills" },
  { id: "accounts", label: "Accounts" },
  { id: "clips", label: "Clips" },
  { id: "appearance", label: "Appearance" },
  { id: "app", label: "App" },
];

export function Settings() {
  const { installed } = useInstall();
  const sections = installed ? SECTIONS : [{ id: "get-app", label: "Get the app" }, ...SECTIONS];
  return (
    <div className="page settings">
      <PageHeader
        title={
          <>
            Make it <em>yours</em>.
          </>
        }
        lede="How your clips are made, where they go, and how the app looks and sounds."
      />
      <nav className="chips" aria-label="Settings sections">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="chip">
            {s.label}
          </a>
        ))}
      </nav>
      <GetAppPanel />
      <SkillsSection />
      <AccountsSection />
      <ClipsSection />
      <AppearanceSection />
      <AppSection />
    </div>
  );
}

function AccountsSection() {
  const { data } = useLoad(() => api().listAccounts());
  const toast = useToast();
  const id = useId();
  return (
    <section className="settings-section glass" id="accounts" aria-labelledby={`${id}-t`}>
      <div className="settings-section__head">
        <div>
          <h2 className="settings-section__title" id={`${id}-t`}>
            Accounts
          </h2>
          <p className="muted">Clips you keep are posted to the accounts you connect here. Connecting is coming in a later update.</p>
        </div>
      </div>
      <ul className="account-grid">
        {PLATFORMS.map((p) => {
          const acc = data?.find((a) => a.platform === p);
          const connected = acc?.status === "connected";
          return (
            <li key={p} className="account glass">
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
    </section>
  );
}

function ClipsSection() {
  const { me, saveSettings } = useSession();
  const id = useId();
  const s = me?.settings;
  return (
    <section className="settings-section glass" id="clips" aria-labelledby={`${id}-t`}>
      <div className="settings-section__head">
        <div>
          <h2 className="settings-section__title" id={`${id}-t`}>
            Clip preferences
          </h2>
          <p className="muted">What Clip Factory does when you tap Make clips. You can still pick an exact number each time.</p>
        </div>
      </div>
      {!s ? (
        <Skeleton className="line-skel" />
      ) : (
        <div className="pref-grid">
          <div className="pref">
            <span className="pref__label" id={`${id}-min`}>
              Fewest clips
            </span>
            <Stepper label="Fewest clips" value={s.clipMin} min={1} max={s.clipMax} onChange={(n) => void saveSettings({ clipMin: n })} />
          </div>
          <div className="pref">
            <span className="pref__label">Most clips</span>
            <Stepper label="Most clips" value={s.clipMax} min={s.clipMin} max={10} onChange={(n) => void saveSettings({ clipMax: n })} />
          </div>
          <div className="pref">
            <span className="pref__label">Longest source</span>
            <Stepper
              label="Longest source in hours"
              value={s.maxSourceHours}
              min={1}
              max={12}
              onChange={(n) => void saveSettings({ maxSourceHours: n })}
            />
            <span className="pref__hint">hours. For longer streams, only the first part is used.</span>
          </div>
          <fieldset className="pref pref--wide">
            <legend className="pref__label">Post confirmed clips to</legend>
            <div className="check-chips">
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
                        if (last) return;
                        void saveSettings({ platforms: on ? s.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || s.platforms.includes(x)) });
                      }}
                    />
                    <PlatformMark platform={p} size={18} />
                    <span>{PLATFORM_LABEL[p]}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      )}
    </section>
  );
}

function AppearanceSection() {
  const { me, saveSettings } = useSession();
  const prefs = usePrefs();
  const toast = useToast();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const sound = me?.settings.soundEnabled ?? prefs.soundEnabled;
  const motion = me?.settings.reduceMotion ?? prefs.reduceMotion;

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
    <section className="settings-section glass" id="appearance" aria-labelledby={`${id}-t`}>
      <div className="settings-section__head">
        <div>
          <h2 className="settings-section__title" id={`${id}-t`}>
            Appearance
          </h2>
          <p className="muted">Sound and motion follow you to every device. The background picture stays on this one.</p>
        </div>
      </div>
      <div className="toggles">
        <Toggle
          label="Sounds"
          description="A soft tick when you tap, a low thud when something can't be done."
          checked={sound}
          onChange={(v) => void saveSettings({ soundEnabled: v })}
        />
        <Toggle
          label="Reduce motion"
          description="Turns off confetti, page transitions and the moving background."
          checked={motion}
          onChange={(v) => void saveSettings({ reduceMotion: v })}
        />
      </div>
      <div className="bg-picker">
        <span className="bg-picker__preview" aria-hidden="true">
          {prefs.background ? <img src={prefs.background} alt="" /> : <span className="bg-picker__mesh" />}
        </span>
        <div className="bg-picker__text">
          <span className="pref__label">Background picture</span>
          <span className="muted small">
            Use your own wallpaper behind the glass. {prefs.background ? "Using your picture." : "Using the Clip Factory colours."}
          </span>
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
    </section>
  );
}

function AppSection() {
  const { me, refresh, signOut } = useSession();
  const toast = useToast();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"cookies" | null>(null);
  const [removing, setRemoving] = useState(false);
  const hasCookies = (me?.settings.hasYoutubeCookies ?? false) && !removing;

  async function uploadCookies(f: File) {
    if (f.size > 1024 ** 2) return toast.error("That file is too big to be cookies.txt. Export cookies.txt again and pick that file.");
    setBusy("cookies");
    try {
      const up = await api().createCookiesUpload(f.name);
      await putFile(up, f);
      await refresh();
      toast.success("YouTube cookies saved. Retry any job YouTube blocked.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(null);
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
    <section className="settings-section glass" id="app" aria-labelledby={`${id}-t`}>
      <div className="settings-section__head">
        <div>
          <h2 className="settings-section__title" id={`${id}-t`}>
            App
          </h2>
          <p className="muted">Help with YouTube downloads, and signing out.</p>
        </div>
      </div>
      <div className="app-rows">
        <div className="app-row">
          <span className="app-row__icon" aria-hidden="true">
            <Icon name="cookie" />
          </span>
          <div className="app-row__text">
            <span className="pref__label">YouTube cookies</span>
            <span className="muted small">
              {hasCookies
                ? "Saved. They are only used to download YouTube videos."
                : "You can skip this. If YouTube blocks a video, export cookies.txt from your browser and add it here."}
            </span>
          </div>
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
            <Button size="sm" icon="upload" loading={busy === "cookies"} onClick={() => file.current?.click()}>
              {hasCookies ? "Replace" : "Add cookies.txt"}
            </Button>
            {hasCookies ? (
              <Button size="sm" variant="ghost" icon="trash" onClick={removeCookies}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>

        <div className="app-row">
          <span className="app-row__icon" aria-hidden="true">
            <Icon name="logout" />
          </span>
          <div className="app-row__text">
            <span className="pref__label">Sign out</span>
            <span className="muted small user-text">{me ? `Signed in as ${me.user.email}.` : "Signed in."}</span>
          </div>
          <Button size="sm" variant="ghost" icon="logout" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </section>
  );
}
