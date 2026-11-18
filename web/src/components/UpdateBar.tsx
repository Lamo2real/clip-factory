// The glass bar that says a new version is ready, names what changed, and runs the Reload progress. In a desktop app
// too old to update itself (§12.6) the same bar offers the new app instead, until a web update needs it.
import { useEffect, useRef, useState } from "react";
import { burst, centerOf } from "../lib/confetti.ts";
import { currentOs, oldAppDownloadUrl } from "../lib/device.ts";
import { oldDesktopApp } from "../lib/look.ts";
import { prefersReducedMotion } from "../lib/prefs.ts";
import { dismissUpdate, finishedAt, prepareUpdate, PROGRESS, progressAt, reloadInto, useUpdate, type VersionInfo } from "../lib/update.ts";
import { Icon } from "./Icon.tsx";
import { Button, LinkButton } from "./ui.tsx";

/** The new installer for an old desktop app, or null (a browser, a phone, or an app that updates itself). */
function oldAppUpdateUrl(): string | null {
  return oldDesktopApp() && typeof location !== "undefined" ? oldAppDownloadUrl(currentOs(), location.host) : null;
}

export function UpdateBar() {
  const { available, dismissed } = useUpdate();
  const [running, setRunning] = useState(false);
  const [appUrl] = useState(oldAppUpdateUrl);
  const [appLater, setAppLater] = useState(false);
  const web = !!available && (!dismissed || running);
  const app = !web && !!appUrl && !appLater;
  const show = web || app;

  const bar = useRef<HTMLDivElement>(null);

  // Lets the page leave room at the bottom (and lift the toasts) while the bar is up.
  useEffect(() => {
    document.documentElement.classList.toggle("has-update-bar", show);
    return () => document.documentElement.classList.remove("has-update-bar");
  }, [show]);

  // --update-bar-h on <html>: the bar's height, 0 while hidden, so Ask Clip Factory's launcher sits above it (§19.8).
  useEffect(() => {
    const root = document.documentElement;
    const el = bar.current;
    const set = (h: number) => root.style.setProperty("--update-bar-h", `${Math.round(h)}px`);
    if (!show || !el) {
      set(0);
      return;
    }
    set(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return () => set(0);
    const ro = new ResizeObserver(() => set(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => {
      ro.disconnect();
      set(0);
    };
  }, [show]);

  if (app && appUrl) {
    return (
      <div ref={bar} className="update-bar glass glass--strong" role="region" aria-label="Update the app">
        <AppOffer url={appUrl} onLater={() => setAppLater(true)} />
      </div>
    );
  }
  if (!available || !show) return null;
  return (
    <div ref={bar} className="update-bar glass glass--strong" role="region" aria-label="New version">
      {running ? <Updating info={available} /> : <Offer info={available} onReload={() => setRunning(true)} />}
    </div>
  );
}

/** An old desktop app: the short label and one big button that downloads the new app. Later hides it until next time. */
function AppOffer({ url, onLater }: { url: string; onLater: () => void }) {
  return (
    <div className="update-bar__row">
      <span className="update-bar__spark" aria-hidden="true">
        <Icon name="download" size={22} />
      </span>
      <div className="update-bar__text">
        <p className="update-bar__title">Update the app</p>
      </div>
      <div className="update-bar__actions">
        <Button variant="ghost" size="sm" icon="clock" className="update-bar__later" onClick={onLater}>
          Later
        </Button>
        <LinkButton href={url} variant="primary" size="sm" icon="download" className="update-bar__get-app">
          Update
        </LinkButton>
      </div>
    </div>
  );
}

function Offer({ info, onReload }: { info: VersionInfo; onReload: () => void }) {
  return (
    <div className="update-bar__row">
      <span className="update-bar__spark" aria-hidden="true">
        <Icon name="sparkle" size={22} />
      </span>
      <div className="update-bar__text">
        <p className="update-bar__title">New version ready</p>
        <ul className="update-bar__areas" aria-label="What changed">
          {info.areas.map((a) => (
            <li key={a} className="update-bar__pill">
              {a}
            </li>
          ))}
        </ul>
      </div>
      <div className="update-bar__actions">
        <Button variant="ghost" size="sm" icon="clock" className="update-bar__later" onClick={dismissUpdate}>
          Later
        </Button>
        <Button variant="primary" size="sm" icon="retry" act="refresh" className="update-bar__reload" onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}

/**
 * The fun part: rush to ~75 % (slow in, fast middle, slow out), creep while the new version installs, then glide
 * to 100 %, sparkle, and reload. Capped at 10 s. With reduced motion the bar simply fills, with no confetti.
 */
function Updating({ info }: { info: VersionInfo }) {
  const [value, setValue] = useState(0);
  const [done, setDone] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const latest = useRef(info);
  latest.current = info;
  const version = info.version;

  // Runs once per version: a re-check that hands over a new object for the same build must not restart the bar
  // (§12.2: the progress never moves backwards).
  useEffect(() => {
    const reduced = prefersReducedMotion();
    const start = performance.now();
    let readyAt: number | null = null;
    let raf = 0;
    let finished = false;
    let leave: ReturnType<typeof setTimeout> | undefined;

    void prepareUpdate().then(() => {
      readyAt = performance.now() - start;
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      setValue(1);
      setDone(true);
      if (!reduced) burst(centerOf(status.current ?? bar.current), 70);
      leave = setTimeout(() => reloadInto(latest.current), reduced ? 150 : 650);
    };

    const frame = () => {
      const t = performance.now() - start;
      if (reduced) {
        // Simple fill: jump to where the work is, no easing curves.
        setValue(readyAt === null ? Math.min(0.9, PROGRESS.rushTo) : 1);
        if (readyAt !== null || t >= PROGRESS.capMs) return finish();
      } else {
        setValue(progressAt(t, readyAt));
        if (t >= finishedAt(readyAt)) return finish();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Backstop in case animation frames stop (a hidden tab): never wait longer than the cap.
    const cap = setTimeout(finish, PROGRESS.capMs + PROGRESS.finishMs);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(cap);
      clearTimeout(leave);
    };
  }, [version]);

  const pct = Math.round(value * 100);
  return (
    <div className="update-bar__row update-bar__row--busy">
      <span className={`update-bar__spark${done ? " is-done" : " is-spinning"}`} aria-hidden="true">
        <Icon name={done ? "checkCircle" : "sparkle"} size={22} />
      </span>
      <div className="update-bar__text">
        <p className="update-bar__title">
          <span ref={status}>{done ? "All set!" : "Getting the new version"}</span>
          <span className="update-bar__pct" aria-hidden="true">
            {pct}%
          </span>
        </p>
        <div
          ref={bar}
          className={`update-bar__progress${done ? " is-done" : ""}`}
          role="progressbar"
          aria-label="Update progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span className="update-bar__fill" style={{ transform: `scaleX(${value})` }} />
        </div>
      </div>
    </div>
  );
}
