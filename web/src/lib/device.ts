// Which device is this, is Clip Factory already installed on it, and what should "Get the app" offer.
// Pure functions take their inputs as arguments so they can be tested without a browser (docs/CONTRACTS.md §12.1).

export type DeviceOs = "mac" | "windows" | "linux" | "chromeos" | "ios" | "android" | "unknown";

export interface DeviceInput {
  userAgent: string;
  /** navigator.userAgentData?.platform (Chromium only). */
  platform?: string | undefined;
  /** navigator.maxTouchPoints: iPads report a Mac user agent but have touch. */
  maxTouchPoints?: number | undefined;
}

export function detectOs({ userAgent, platform, maxTouchPoints = 0 }: DeviceInput): DeviceOs {
  const ua = userAgent || "";
  const p = (platform ?? "").toLowerCase();
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS 13+ asks for the desktop site and says "Macintosh"; only touch gives it away.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua) || p === "android") return "android";
  if (/CrOS/i.test(ua) || p === "chrome os" || p === "chromeos") return "chromeos";
  if (p === "macos" || /Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (p === "windows" || /Windows/i.test(ua)) return "windows";
  if (p === "linux" || /Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

/** On iPhone and iPad only Safari can add a page to the Home Screen reliably. */
export function isIosSafari(userAgent: string): boolean {
  if (!/iPhone|iPad|iPod|Macintosh/i.test(userAgent)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|musical_ly/i.test(userAgent)) return false;
  return /Safari/i.test(userAgent) && /Version\//i.test(userAgent);
}

export interface InstalledInput {
  /** Answers a media query, like window.matchMedia(q).matches. */
  matches: (query: string) => boolean;
  /** navigator.standalone (iOS Safari only). */
  iosStandalone?: boolean | undefined;
  /** window.__CF_DESKTOP__, injected by the desktop wrapper. */
  desktopFlag?: unknown;
  userAgent: string;
  /** localStorage cf.installed, written after the appinstalled event. */
  installedFlag?: string | null | undefined;
}

/** True when the page runs inside an installed copy of the app, or the owner already installed it here. */
export function isInstalled(i: InstalledInput): boolean {
  if (i.matches("(display-mode: standalone)")) return true;
  if (i.matches("(display-mode: window-controls-overlay)")) return true;
  if (i.iosStandalone === true) return true;
  if (i.desktopFlag === true) return true;
  if (/ClipFactoryDesktop/i.test(i.userAgent)) return true;
  if (i.installedFlag === "1") return true;
  return false;
}

export interface DownloadFile {
  path: string;
  size?: number;
}
export interface DownloadManifest {
  version?: string;
  files: { mac?: DownloadFile; windows?: DownloadFile; linux?: DownloadFile };
}

/** Accepts only same-site download paths under /downloads/, so a bad manifest can never send people elsewhere. */
export function parseManifest(body: unknown): DownloadManifest {
  const files: DownloadManifest["files"] = {};
  const raw = (body as { files?: Record<string, unknown> } | null)?.files;
  if (raw && typeof raw === "object") {
    for (const key of ["mac", "windows", "linux"] as const) {
      const f = raw[key] as { path?: unknown; size?: unknown } | undefined;
      if (f && typeof f.path === "string" && /^\/downloads\/[\w.-]+$/.test(f.path)) {
        files[key] = { path: f.path, ...(typeof f.size === "number" && f.size > 0 ? { size: f.size } : {}) };
      }
    }
  }
  const version = (body as { version?: unknown } | null)?.version;
  return { ...(typeof version === "string" ? { version } : {}), files };
}

export type GetAppPlan =
  | { kind: "download"; os: "mac" | "windows" | "linux"; file: DownloadFile; label: string; firstOpenHint: string | null }
  | { kind: "prompt"; os: DeviceOs }
  | { kind: "ios-steps"; inSafari: boolean }
  | { kind: "android-steps" }
  | { kind: "browser-steps"; os: DeviceOs };

const DOWNLOAD_LABEL = { mac: "Download for Mac", windows: "Download for Windows", linux: "Download for Linux" } as const;

/** Builds are not signed yet, so the first open needs one extra click (§12.3). */
const FIRST_OPEN_HINT = {
  mac: "If your Mac says it can't open it: System Settings, Privacy & Security, Open Anyway.",
  windows: "If Windows warns you, choose More info, then Run anyway.",
  linux: null,
} as const;

/**
 * What the big button does on this device. A desktop file is only offered when the manifest lists it,
 * so there is never a dead link; otherwise the browser's own install is used.
 */
export function planFor(os: DeviceOs, manifest: DownloadManifest | null, canPrompt: boolean, userAgent: string): GetAppPlan {
  if (os === "ios") return { kind: "ios-steps", inSafari: isIosSafari(userAgent) };
  if (os === "mac" || os === "windows" || os === "linux") {
    const file = manifest?.files[os];
    if (file) return { kind: "download", os, file, label: DOWNLOAD_LABEL[os], firstOpenHint: FIRST_OPEN_HINT[os] };
  }
  if (canPrompt) return { kind: "prompt", os };
  if (os === "android") return { kind: "android-steps" };
  return { kind: "browser-steps", os };
}

export const OS_NAME: Record<DeviceOs, string> = {
  mac: "Mac",
  windows: "Windows",
  linux: "Linux",
  chromeos: "Chromebook",
  ios: "iPhone",
  android: "Android",
  unknown: "this device",
};

/** Real-browser inputs for the pure functions above. */
export function currentOs(): DeviceOs {
  if (typeof navigator === "undefined") return "unknown";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return detectOs({ userAgent: navigator.userAgent, platform: data?.platform, maxTouchPoints: navigator.maxTouchPoints });
}

export function installedHere(): boolean {
  if (typeof window === "undefined") return false;
  let flag: string | null;
  try {
    flag = localStorage.getItem("cf.installed");
  } catch {
    flag = null;
  }
  return isInstalled({
    matches: (q) => typeof matchMedia === "function" && matchMedia(q).matches,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    desktopFlag: (window as Window & { __CF_DESKTOP__?: unknown }).__CF_DESKTOP__,
    userAgent: navigator.userAgent,
    installedFlag: flag,
  });
}

/**
 * Where an old desktop app (one that cannot update itself, §12.6) gets the new installer: the Mac or Windows download
 * for this computer, or null anywhere else.
 *
 * The host is written with a trailing dot (`https://example.cloudfront.net./downloads/...`). It is the same server,
 * but to the old app it is another site, so the app sends the link to the system browser, which downloads the file.
 * The same address without the dot would stay inside the old app's window, which cannot save a download (it has no
 * download handler), so nothing would happen. Plain http does not help: the page's CSP (upgrade-insecure-requests)
 * and HSTS turn it back into https on the same site first.
 */
export function oldAppDownloadUrl(os: DeviceOs, host: string): string | null {
  const file = os === "mac" ? "Clip-Factory.dmg" : os === "windows" ? "Clip-Factory-Setup.exe" : null;
  if (!file || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const [name, port] = host.split(":") as [string, string | undefined];
  return `https://${name.replace(/\.$/, "")}.${port ? `:${port}` : ""}/downloads/${file}`;
}
