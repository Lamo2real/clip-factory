// "Get the app" (docs/CONTRACTS.md §12.1): one big button that fits this device, picture steps where a
// download is impossible (iPhone), and nothing at all once the app is installed.
import { useEffect, useId, useState, type ReactNode } from "react";
import { currentOs, OS_NAME, planFor, type DeviceOs, type DownloadManifest, type GetAppPlan } from "../lib/device.ts";
import { bytes } from "../lib/format.ts";
import { bannerSnoozed, downloadStarted, loadDownloads, promptInstall, rememberDownloaded, snoozeBanner, useInstall } from "../lib/pwa.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { useToast } from "./Toasts.tsx";
import { Button, LinkButton } from "./ui.tsx";

function useManifest(): DownloadManifest | null | undefined {
  const [m, setM] = useState<DownloadManifest | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadDownloads().then((v) => live && setM(v));
    return () => {
      live = false;
    };
  }, []);
  return m;
}

const PICK: { os: DeviceOs; label: string; icon: IconName }[] = [
  { os: "mac", label: "Mac", icon: "monitor" },
  { os: "windows", label: "Windows", icon: "monitor" },
  { os: "ios", label: "iPhone or iPad", icon: "phone" },
  { os: "android", label: "Android", icon: "phone" },
];

/**
 * The whole "Get the app" panel. Renders nothing when the app is already installed here, unless `installedNote`
 * asks for a friendly "you already have it" line instead (the /get-app page, so it is never a dead end).
 */
export function GetAppPanel({
  headingLevel = 2,
  installedNote = false,
  title,
}: {
  headingLevel?: 1 | 2;
  installedNote?: boolean;
  /** Replaces "Get the app" where the page heading already says it (the Settings branch). */
  title?: ReactNode;
}) {
  const { installed, canPrompt } = useInstall();
  const manifest = useManifest();
  const detected = currentOs();
  const [os, setOs] = useState<DeviceOs>(detected);
  const [started, setStarted] = useState(downloadStarted);
  const toast = useToast();
  const id = useId();
  const H = headingLevel === 1 ? "h1" : "h2";

  if (installed) {
    if (!installedNote) return null;
    return (
      <section className="getapp glass" aria-labelledby={`${id}-t`} id="get-app">
        <span className="getapp__badge" aria-hidden="true">
          <Icon name="checkCircle" size={28} />
        </span>
        <H className="getapp__title" id={`${id}-t`}>
          You have the <em>app</em>
        </H>
        <p className="getapp__lede">Clip Factory is already installed here. Updates arrive by themselves.</p>
        <div className="getapp__actions">
          <LinkButton href="/" variant="primary" size="lg" icon="home">
            Go home
          </LinkButton>
        </div>
      </section>
    );
  }

  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  // When the owner picks another device, show that device's way even though this browser cannot prompt for it.
  const plan = planFor(os, manifest ?? null, canPrompt && os === detected, os === detected ? ua : "");
  const guess = os === detected && detected !== "unknown";

  async function install() {
    if (await promptInstall()) toast.success("Installed. Find Clip Factory with your other apps.");
  }

  return (
    <section className="getapp glass" aria-labelledby={`${id}-t`} id="get-app">
      <div className="getapp__head">
        <span className="getapp__badge" aria-hidden="true">
          <Icon name="download" size={26} />
        </span>
        <div className="getapp__text">
          <H className="getapp__title" id={`${id}-t`}>
            {title ?? (
              <>
                Get the <em>app</em>
              </>
            )}
          </H>
          <p className="getapp__lede">
            {guess ? `Looks like you are on ${articleFor(os)}${OS_NAME[os]}. ` : ""}
            {plan.kind === "ios-steps" || plan.kind === "android-steps"
              ? "Put Clip Factory on your home screen in three taps."
              : "Open Clip Factory like any other app, in its own window."}
          </p>
        </div>
      </div>

      {manifest === undefined && (os === "mac" || os === "windows" || os === "linux") ? (
        <div className="getapp__actions">
          <Button variant="primary" size="lg" loading block>
            Checking downloads
          </Button>
        </div>
      ) : (
        <PlanView plan={plan} started={started} onStart={() => setStarted(true)} onInstall={install} canPrompt={canPrompt && os === detected} />
      )}

      <div className="getapp__other">
        <span className="getapp__other-label" id={`${id}-pick`}>
          {guess ? "Not right? Pick your device:" : "Pick your device:"}
        </span>
        <div className="getapp__chips" role="group" aria-labelledby={`${id}-pick`}>
          {PICK.map((p) => (
            <button
              key={p.os}
              type="button"
              className={`chip getapp__chip${os === p.os ? " is-on" : ""}`}
              aria-pressed={os === p.os}
              onClick={() => {
                setOs(p.os);
                setStarted(false);
              }}
            >
              <Icon name={p.icon} size={18} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function articleFor(os: DeviceOs) {
  return os === "ios" ? "an " : os === "mac" || os === "chromeos" ? "a " : "";
}

function PlanView({
  plan,
  started,
  onStart,
  onInstall,
  canPrompt,
}: {
  plan: GetAppPlan;
  started: boolean;
  onStart: () => void;
  onInstall: () => void;
  canPrompt: boolean;
}) {
  switch (plan.kind) {
    case "download":
      return (
        <div className="getapp__plan">
          <div className="getapp__actions">
            <a
              className="btn btn--primary btn--lg getapp__download"
              href={plan.file.path}
              download
              onClick={() => {
                rememberDownloaded();
                onStart();
              }}
            >
              <Icon name="download" size={20} />
              <span className="btn__label">{plan.label}</span>
            </a>
            {canPrompt ? (
              <button type="button" className="text-link getapp__alt" onClick={onInstall}>
                or install from this browser
              </button>
            ) : null}
          </div>
          <p className="getapp__meta">
            {plan.os === "mac" ? "The Mac app" : plan.os === "windows" ? "The Windows app" : "The Linux app (AppImage)"}
            {plan.file.size ? ` · ${bytes(plan.file.size)}` : ""}
          </p>
          {plan.firstOpenHint ? (
            <p className={`getapp__hint${started ? " is-now" : ""}`} role={started ? "status" : undefined}>
              <Icon name="info" size={18} />
              <span>
                {started ? "Downloading. Open the file when it finishes. " : "First time only: "}
                {plan.firstOpenHint}
              </span>
            </p>
          ) : started ? (
            <p className="getapp__hint is-now" role="status">
              <Icon name="info" size={18} />
              <span>Downloading. Open the file when it finishes.</span>
            </p>
          ) : null}
        </div>
      );
    case "prompt":
      return (
        <div className="getapp__actions">
          <Button variant="primary" size="lg" icon="download" onClick={onInstall}>
            Install app
          </Button>
        </div>
      );
    case "ios-steps":
      return (
        <div className="getapp__plan">
          {!plan.inSafari ? (
            <p className="getapp__safari">
              <Icon name="compass" size={22} />
              <span>
                <strong>Open this page in Safari first.</strong> Only Safari can put apps on the Home Screen. Copy the link,
                open Safari, and paste it.
              </span>
            </p>
          ) : null}
          {!plan.inSafari ? <CopyLink /> : null}
          <ol className="steps">
            <Step n={1} title="Tap Share" art={<ShareArt />}>
              It is at the bottom of Safari (on iPad, at the top).
            </Step>
            <Step n={2} title="Tap Add to Home Screen" art={<MenuArt icon="plusSquare" label="Add to Home Screen" />}>
              Scroll down a little if you do not see it.
            </Step>
            <Step n={3} title="Tap Add" art={<AddArt />}>
              Clip Factory is now on your Home Screen.
            </Step>
          </ol>
        </div>
      );
    case "android-steps":
      return (
        <ol className="steps">
          <Step n={1} title="Tap the menu" art={<MenuDotsArt />}>
            The three dots at the top right of Chrome.
          </Step>
          <Step n={2} title="Tap Install app" art={<MenuArt icon="download" label="Install app" />}>
            Some phones say Add to Home screen.
          </Step>
          <Step n={3} title="Tap Install" art={<AddArt label="Install" />}>
            Clip Factory is now with your other apps.
          </Step>
        </ol>
      );
    case "browser-steps":
      return (
        <ol className="steps steps--two">
          <Step n={1} title="Find the install button" art={<MenuArt icon="download" label="Install Clip Factory" />}>
            It is at the right end of the address bar, or in the browser menu.
          </Step>
          <Step n={2} title="Tap Install" art={<AddArt label="Install" />}>
            Clip Factory opens in its own window.
          </Step>
        </ol>
      );
  }
}

function CopyLink() {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <div className="getapp__actions">
      <Button
        variant="primary"
        size="lg"
        icon={done ? "check" : "link"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(location.origin + "/get-app");
            setDone(true);
          } catch {
            toast.info("Copy the address at the top of the screen instead.");
          }
        }}
      >
        {done ? "Link copied" : "Copy the link"}
      </Button>
    </div>
  );
}

function Step({ n, title, art, children }: { n: number; title: string; art: ReactNode; children: ReactNode }) {
  return (
    <li className="step">
      <span className="step__art" aria-hidden="true">
        {art}
        <span className="step__n">{n}</span>
      </span>
      <span className="step__text">
        <strong className="step__title">{title}</strong>
        <span className="step__desc">{children}</span>
      </span>
    </li>
  );
}

/** A tiny Safari toolbar with the real Share icon, highlighted. */
function ShareArt() {
  return (
    <span className="art art--bar">
      <Icon name="chevronLeft" size={16} />
      <Icon name="chevronRight" size={16} />
      <span className="art__hit">
        <Icon name="shareIos" size={22} />
      </span>
      <Icon name="library" size={16} />
    </span>
  );
}

function MenuArt({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="art art--menu">
      <span className="art__row art__row--dim" />
      <span className="art__row art__hit">
        <span className="art__label">{label}</span>
        <Icon name={icon} size={18} />
      </span>
      <span className="art__row art__row--dim" />
    </span>
  );
}

function MenuDotsArt() {
  return (
    <span className="art art--bar art--end">
      <span className="art__url" />
      <span className="art__hit">
        <Icon name="dotsVertical" size={22} strokeWidth={3} />
      </span>
    </span>
  );
}

function AddArt({ label = "Add" }: { label?: string }) {
  return (
    <span className="art art--add">
      <span className="art__icon">
        <span className="brand__mark">
          C<span className="brand__dot" />
        </span>
      </span>
      <span className="art__pill">{label}</span>
    </span>
  );
}

/**
 * Phones only, on Home, until "Not now" (30 days) or the app is installed: one line and a button to the steps.
 */
export function GetAppBanner() {
  const { installed } = useInstall();
  const [hidden, setHidden] = useState(() => bannerSnoozed());
  if (installed || hidden) return null;
  return (
    <aside className="getapp-banner glass" aria-label="Get the app">
      <span className="getapp-banner__icon" aria-hidden="true">
        <Icon name="phone" size={22} />
      </span>
      <p className="getapp-banner__text">
        <strong>Get the app.</strong> Open Clip Factory from your home screen.
      </p>
      <div className="getapp-banner__actions">
        <LinkButton
          href="/get-app"
          size="sm"
          icon="download"
          onClick={() => snoozeBanner()}
        >
          Show me
        </LinkButton>
        <Button
          size="sm"
          variant="ghost"
          icon="x"
          onClick={() => {
            snoozeBanner();
            setHidden(true);
          }}
        >
          Not now
        </Button>
      </div>
    </aside>
  );
}
